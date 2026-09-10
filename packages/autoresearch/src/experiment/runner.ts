import { access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { createInitialState, loadState, recordResult, saveState, transition } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { atomicWriteJson, AutoResearchError, ensureDir, readJson, readOptionalText, safeResolve, writeText } from '../core/utils.js'
import { freezeRubric, writeFailureReport, writePlan, writeRubric } from '../domain/files.js'
import { exportEvidenceChain } from '../export/evidence-chain.js'
import { createRunContext, reloadTree } from '../service/context.js'
import type { ResearchRunnerOptions } from '../service/types.js'
import { loadProjectSettings } from '../settings/project-settings.js'
import { createPolicySnapshot } from '../policy/model-routing.js'
import { openRequestLedger } from '../policy/request-ledger.js'
import type { ProjectSettings } from '../settings/schema.js'
import {
  runEvidenceAgent,
  runExperimentDesign,
  runExperimentReflexion,
  runInsightAbstractor,
  runMinimalVerification,
  runModelScout,
  runPlanner,
  runResultReflexion,
  runSupervisor,
  runWorker,
  runMinimalPlan,
} from './steps.js'

export interface ExperimentDependencies {
  readonly provider: RoleAgentProvider
}

export interface ExperimentRunRequest {
  runDir: string
  projectDir?: string
  task: string
  profile?: string
  maxRounds?: number
  agentContext: RoleExecutionContext
}

export interface ExperimentRunResult {
  runDir: string
  status: 'completed' | 'failed' | 'paused'
  reportPath: string
  evidencePath?: string
  cycles: number
  reason?: string
}

type ExperimentStage = 'plan' | 'design' | 'work' | 'evidence' | 'decision'
const SNAPSHOT_FILE = join('.autoresearch', 'policy-snapshot.json')
const MANIFEST_FILE = join('.autoresearch', 'experiment-manifest.json')

function freezePolicy<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezePolicy(child)
    Object.freeze(value)
  }
  return value
}

async function loadExperimentPolicy(runDir: string, settings: ProjectSettings): Promise<NonNullable<RoleExecutionContext['policySnapshot']>> {
  const file = safeResolve(runDir, SNAPSHOT_FILE)
  try {
    const parsed = await readJson<unknown>(file)
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 2 ||
      !('model' in parsed) || !('modelRouting' in parsed) || !('workflow' in parsed) || !('budget' in parsed)) {
      throw new AutoResearchError(`invalid experiment policy snapshot: ${file}`, 'STATE_CORRUPT')
    }
    return freezePolicy(parsed as NonNullable<RoleExecutionContext['policySnapshot']>)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof Error && /cannot read .*ENOENT/i.test(error.message))) throw error
  }
  const snapshot = { ...createPolicySnapshot(settings), model: structuredClone(settings.model) }
  await atomicWriteJson(file, snapshot)
  return freezePolicy(snapshot)
}

function stageFile(runDir: string, cycle: number, stage: ExperimentStage): string {
  return safeResolve(runDir, '.autoresearch', `experiment-${cycle}-${stage}.json`)
}

interface StageEnvelope<T> { schema: 'autoresearch/experiment-stage/v1'; cycle: number; stage: ExperimentStage; data: T }

async function writeStage<T>(runDir: string, cycle: number, stage: ExperimentStage, data: T): Promise<void> {
  await atomicWriteJson(stageFile(runDir, cycle, stage), { schema: 'autoresearch/experiment-stage/v1', cycle, stage, data } satisfies StageEnvelope<T>)
}

async function readStage<T>(file: string): Promise<T | undefined> {
  try {
    const value = await readJson<unknown>(file)
    if (!value || typeof value !== 'object' || (value as { schema?: unknown }).schema !== 'autoresearch/experiment-stage/v1' || !('data' in value)) {
      throw new AutoResearchError(`invalid experiment stage marker: ${file}`, 'STATE_CORRUPT')
    }
    return (value as StageEnvelope<T>).data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof Error && /cannot read .*ENOENT/i.test(error.message))) return undefined
    throw error
  }
}

function identityHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

async function assertExperimentIdentity(runDir: string, task: string, profile: string): Promise<void> {
  const file = safeResolve(runDir, MANIFEST_FILE)
  const expected = { schema: 'autoresearch/experiment-manifest/v1', taskHash: identityHash(task), profileHash: identityHash(profile) }
  let current: typeof expected | undefined
  try {
    const value = await readJson<unknown>(file)
    if (!value || typeof value !== 'object' || (value as { schema?: unknown }).schema !== expected.schema ||
      typeof (value as { taskHash?: unknown }).taskHash !== 'string' || typeof (value as { profileHash?: unknown }).profileHash !== 'string') {
      throw new AutoResearchError(`invalid experiment manifest: ${file}`, 'STATE_CORRUPT')
    }
    current = value as typeof expected
  } catch (error) {
    if (!((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof Error && /cannot read .*ENOENT/i.test(error.message)))) throw error
  }
  if (!current) {
    await atomicWriteJson(file, expected)
    return
  }
  if (current.schema !== expected.schema || current.taskHash !== expected.taskHash || current.profileHash !== expected.profileHash) {
    throw new AutoResearchError('run directory belongs to a different experiment task/profile; use a new runDir', 'INVALID_ARGUMENT')
  }
}

function isBudgetPause(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'BUDGET_EXHAUSTED')
}

export const DEFAULT_EXPERIMENT_MAX_ROUNDS = 1

/**
 * Run a standalone, task-driven experiment loop.
 *
 * This is intentionally decoupled from the full research/paper pipeline: the
 * user supplies a task requirement and the runner plans, designs, executes,
 * collects evidence, reflects, and writes an experiment report without
 * brainstorming, ideation, or paper writing.
 */
export async function runExperimentTask(
  deps: ExperimentDependencies,
  request: ExperimentRunRequest,
): Promise<ExperimentRunResult> {
  const { runDir, task, agentContext } = request
  const projectDir = request.projectDir ?? runDir
  const projectSettings = await loadProjectSettings(projectDir)
  const maxRounds = request.maxRounds ?? projectSettings.experiment.maxRounds ?? DEFAULT_EXPERIMENT_MAX_ROUNDS
  const profile = request.profile ?? (projectSettings.experiment.profile || '# PROFILE\n\n- Allowed: local experiments, public data, public literature.\n')
  const reportPath = join(runDir, 'EXPERIMENT_REPORT.md')

  await ensureDir(runDir)
  await ensureDir(join(runDir, 'input'))
  await assertExperimentIdentity(runDir, task, profile)
  await writeIfMissing(join(runDir, 'input', 'idea.md'), `# IDEA\n\n## Direction\n\n${task}\n`)
  await writeIfMissing(join(runDir, 'PROFILE.md'), profile)
  await writeIfMissing(join(runDir, 'RUBRIC.md'), `# RUBRIC\n\n- Task: ${task}\n- Criteria: produce a reproducible experiment with real evidence.\n`)
  await freezeRubric(runDir)

  const state: RunState = (await loadState(runDir)) ?? await createInitialState(runDir)
  if (state.status === 'COMPLETED' || state.status === 'FAILED') {
    return {
      runDir,
      status: state.status === 'COMPLETED' ? 'completed' : 'failed',
      reportPath,
      evidencePath: state.evidencePath,
      cycles: state.cycle,
      reason: state.lastError,
    }
  }
  state.status = 'RUNNING'
  await saveState(runDir, state)
  const policySnapshot = await loadExperimentPolicy(runDir, projectSettings)
  const requestLedger = agentContext.requestLedger ?? await openRequestLedger({
    runDir,
    runId: state.runId,
    config: {
      maxInputTokens: policySnapshot.budget.maxInputTokens,
      maxOutputTokens: policySnapshot.budget.maxOutputTokens,
      maxRunTokens: policySnapshot.budget.maxRunTokens,
      maxRoleCalls: policySnapshot.budget.maxRoleCalls,
      maxRetriesPerCall: policySnapshot.budget.maxRetriesPerCall,
      maxUpgradesPerTask: policySnapshot.budget.maxUpgradesPerTask,
    },
  })
  if (!agentContext.requestLedger) await requestLedger.recoverPending('interrupted')
  const tree = await ResearchTree.load(runDir)
  if (tree.query({ kind: 'hypothesis' }).length === 0) {
    tree.add('hypothesis', task, { status: 'proposed' })
    await tree.save()
  }

  const researchDeps: ResearchRunnerOptions = {
    provider: deps.provider,
    maxCycles: maxRounds,
    brainstorm: 'off',
  }
  const ctx = createRunContext(researchDeps, runDir, state, tree, {
    ...agentContext,
    projectDir,
    runId: state.runId,
    policySnapshot,
    requestLedger,
  })
  ctx.logger.info(`experiment task started runDir=${runDir} task=${task.slice(0, 80)}`)

  if (policySnapshot.workflow.mode === 'minimal') {
    return runMinimalExperiment(ctx, { task, profile, maxRounds, reportPath })
  }

  let cycles = 0
  let lastReason: string | undefined
  let finished = false

  const firstCycle = Math.max(1, state.cycle)
  try {
  for (let cycle = firstCycle; cycle <= maxRounds; cycle += 1) {
    state.cycle = cycle
    cycles = cycle
    let planText: string
    let planFile: string
    const cachedPlan = await readStage<{ planText: string; planFile: string }>(stageFile(runDir, cycle, 'plan'))
    if (cachedPlan) {
      planText = cachedPlan.planText
      planFile = cachedPlan.planFile
    } else {
      await transition(state, 'plan', `experiment-plan-${cycle}`)
      planText = await runPlanner(ctx, { idea: task, profile })
      planFile = await writePlan(runDir, state.planVersion, planText)
      await saveState(runDir, state)
      await recordResult(state, `experiment-plan-${cycle}`, { planFile })
      await writeStage(runDir, cycle, 'plan', { planText, planFile })
    }
    ctx.logger.info(`experiment plan written ${planFile}`)

    let minimalVerification: string
    let modelScout: string
    let experimentDesign: string
    const cachedDesign = await readStage<{ minimalVerification: string; modelScout: string; experimentDesign: string }>(stageFile(runDir, cycle, 'design'))
    if (cachedDesign) {
      ({ minimalVerification, modelScout, experimentDesign } = cachedDesign)
    } else {
      ;[minimalVerification, modelScout] = await Promise.all([
        runMinimalVerification(ctx, { planText }),
        runModelScout(ctx, { planText }),
      ])
      experimentDesign = await runExperimentDesign(ctx, { planText, minimalVerification, modelScout })
      await runExperimentReflexion(ctx, { planText, minimalVerification, modelScout, initialDesign: experimentDesign })
      await writeStage(runDir, cycle, 'design', { minimalVerification, modelScout, experimentDesign })
    }

    await transition(state, 'work', `experiment-work-${cycle}`)
    const workDir = safeResolve(runDir, 'work', `experiment-cycle-${String(cycle).padStart(2, '0')}`)
    await ensureDir(workDir)
    const cachedWork = await readStage<{ actionResult: Awaited<ReturnType<typeof runWorker>> }>(stageFile(runDir, cycle, 'work'))
    const actionResult = cachedWork?.actionResult ?? await runWorker(ctx, { workDir, planText, experimentDesign, minimalVerification })
    if (!cachedWork) {
      await recordResult(state, `experiment-work-${cycle}`, actionResult as unknown as Record<string, unknown>)
      await writeStage(runDir, cycle, 'work', { actionResult })
    }
    ctx.logger.info(`experiment work done status=${actionResult.status} artifacts=${actionResult.artifacts.length}`)

    await transition(state, 'evidence', `experiment-evidence-${cycle}`)
    if (!(await readStage(stageFile(runDir, cycle, 'evidence')))) {
      await runEvidenceAgent(ctx, { planText })
      await writeStage(runDir, cycle, 'evidence', { done: true })
    }
    await reloadTree(ctx)

    const failureDirections = await runResultReflexion(ctx, { planText, experimentDesign })
    const insight = await runInsightAbstractor(ctx, { planText, experimentDesign, failureDirections })
    const decision = (await readStage<{ action: string; reason: string }>(stageFile(runDir, cycle, 'decision'))) ?? await runSupervisor(ctx, { planText })
    if (!(await readStage(stageFile(runDir, cycle, 'decision')))) await writeStage(runDir, cycle, 'decision', decision)
    ctx.logger.info(`experiment supervisor decision=${decision.action}: ${decision.reason}`)
    if (decision.action === 'fail') {
      lastReason = decision.reason
      state.status = 'FAILED'
      state.phase = 'failed'
      state.lastError = decision.reason
      await saveState(runDir, state)
      await writeFailureReport(runDir, `# FAILURE_REPORT\n\n${decision.reason}\n`)
      await writeText(reportPath, buildExperimentReport(task, profile, cycle, decision.reason, undefined, 'failed', false))
      return { runDir, status: 'failed', reportPath, cycles, reason: decision.reason }
    }
    if (decision.action === 'finish') {
      finished = true
      break
    }
    if (decision.action === 'revise') {
      state.planVersion += 1
      continue
    }
  }
  } catch (error) {
    if (!isBudgetPause(error)) throw error
    const reason = error instanceof Error ? error.message : String(error)
    state.status = 'PAUSED'
    state.lastError = reason
    await saveState(runDir, state)
    await writeText(reportPath, buildExperimentReport(task, profile, cycles, reason, state.evidencePath, 'paused', false))
    return { runDir, status: 'paused', reportPath, evidencePath: state.evidencePath, cycles, reason }
  }

  if (!finished) {
    const reason = `experiment did not finish within maxRounds=${maxRounds}`
    state.status = 'PAUSED'
    state.lastError = reason
    await saveState(runDir, state)
    await writeText(reportPath, buildExperimentReport(task, profile, cycles, reason, state.evidencePath, 'paused', false))
    return { runDir, status: 'paused', reportPath, evidencePath: state.evidencePath, cycles, reason }
  }

  await reloadTree(ctx)
  let evidencePath: string | undefined
  try {
    evidencePath = await exportEvidenceChain(runDir, state.runId, ctx.tree)
    state.evidencePath = evidencePath
  } catch (error) {
    ctx.logger.warn(`experiment evidence export failed: ${String(error)}`)
  }
  state.status = 'COMPLETED'
  state.phase = 'work'
  state.lastError = lastReason
  await saveState(runDir, state)
  await writeText(reportPath, buildExperimentReport(task, profile, cycles, lastReason, evidencePath, 'completed', finished))
  ctx.logger.info(`experiment task completed runDir=${runDir} cycles=${cycles} evidence=${evidencePath ?? 'none'}`)

  return {
    runDir,
    status: 'completed',
    reportPath,
    evidencePath,
    cycles,
    reason: lastReason,
  }
}

/**
 * Standalone minimal mode intentionally owns only one plan, one worker, local
 * evidence materialization, and one supervisor per cycle. Stage files are
 * durable idempotency markers: a resume never dispatches a completed worker.
 */
async function runMinimalExperiment(
  ctx: ReturnType<typeof createRunContext>,
  input: { task: string; profile: string; maxRounds: number; reportPath: string },
): Promise<ExperimentRunResult> {
  const { task, profile, maxRounds, reportPath } = input
  let cycles = 0
  let finished = false
  try {
    for (let cycle = Math.max(1, ctx.state.cycle); cycle <= maxRounds; cycle += 1) {
      cycles = cycle
      ctx.state.cycle = cycle
      const planStage = await readStage<{ planText: string; planFile: string; riskLevel: string }>(stageFile(ctx.runDir, cycle, 'plan'))
      let planText: string
      if (planStage) {
        planText = planStage.planText
      } else {
        await transition(ctx.state, 'plan', `experiment-minimal-plan-${cycle}`)
        const plan = await runMinimalPlan(ctx, { idea: task, profile })
        const planFile = await writePlan(ctx.runDir, ctx.state.planVersion, plan.plan)
        planText = plan.plan
        await writeStage(ctx.runDir, cycle, 'plan', { planText, planFile, riskLevel: plan.riskLevel })
      }

      const workDir = safeResolve(ctx.runDir, 'work', `experiment-cycle-${String(cycle).padStart(2, '0')}`)
      await ensureDir(workDir)
      const cachedWork = await readStage<{ actionResult: Awaited<ReturnType<typeof runWorker>> }>(stageFile(ctx.runDir, cycle, 'work'))
      const actionResult = cachedWork?.actionResult ?? await (async () => {
        await transition(ctx.state, 'work', `experiment-minimal-work-${cycle}`)
        const result = await runWorker(ctx, { workDir, planText, experimentDesign: planText, minimalVerification: 'minimal plan is the verification basis' })
        await writeStage(ctx.runDir, cycle, 'work', { actionResult: result })
        await recordResult(ctx.state, `experiment-minimal-work-${cycle}`, result as unknown as Record<string, unknown>)
        return result
      })()
      if (actionResult.status !== 'completed') {
        const reason = `minimal worker did not complete: ${actionResult.summary}`
        ctx.state.status = 'PAUSED'
        ctx.state.lastError = reason
        await saveState(ctx.runDir, ctx.state)
        await writeFailureReport(ctx.runDir, `# PAUSED\n\n${reason}\n`)
        await writeText(reportPath, buildExperimentReport(task, profile, cycles, reason, undefined, 'paused', false))
        return { runDir: ctx.runDir, status: 'paused', reportPath, cycles, reason }
      }

      if (!(await readStage(stageFile(ctx.runDir, cycle, 'evidence')))) {
        await transition(ctx.state, 'evidence', `experiment-minimal-evidence-${cycle}`)
        await writeText(join(ctx.runDir, `MINIMAL_EVIDENCE-${cycle}.md`), [
          `# Minimal Evidence ${cycle}`, '',
          `Worker summary: ${actionResult.summary}`,
          `Artifacts: ${actionResult.artifacts.join(', ') || '-'}`,
          '', 'This local record is derived from the completed worker result; no evidence-agent call is required in minimal mode.',
        ].join('\n'))
        await writeStage(ctx.runDir, cycle, 'evidence', { done: true })
      }

      const cachedDecision = await readStage<{ action: string; reason: string }>(stageFile(ctx.runDir, cycle, 'decision'))
      const decision = cachedDecision ?? await (async () => {
        await transition(ctx.state, 'decide', `experiment-minimal-decide-${cycle}`)
        const value = await runSupervisor(ctx, { planText, evidence: await readOptionalText(join(ctx.runDir, `MINIMAL_EVIDENCE-${cycle}.md`)) })
        await writeStage(ctx.runDir, cycle, 'decision', value)
        return value
      })()
      if (decision.action === 'fail') {
        ctx.state.status = 'FAILED'
        ctx.state.phase = 'failed'
        ctx.state.lastError = decision.reason
        await saveState(ctx.runDir, ctx.state)
        await writeFailureReport(ctx.runDir, `# FAILURE_REPORT\n\n${decision.reason}\n`)
        await writeText(reportPath, buildExperimentReport(task, profile, cycle, decision.reason, undefined, 'failed', false))
        return { runDir: ctx.runDir, status: 'failed', reportPath, cycles, reason: decision.reason }
      }
      if (decision.action === 'finish') {
        finished = true
        break
      }
      if (decision.action === 'revise') ctx.state.planVersion += 1
    }
  } catch (error) {
    if (!isBudgetPause(error)) throw error
    const reason = error instanceof Error ? error.message : String(error)
    ctx.state.status = 'PAUSED'
    ctx.state.lastError = reason
    await saveState(ctx.runDir, ctx.state)
    await writeText(reportPath, buildExperimentReport(task, profile, cycles, reason, ctx.state.evidencePath, 'paused', false))
    return { runDir: ctx.runDir, status: 'paused', reportPath, evidencePath: ctx.state.evidencePath, cycles, reason }
  }
  if (!finished) {
    const reason = `experiment did not finish within maxRounds=${maxRounds}`
    ctx.state.status = 'PAUSED'
    ctx.state.lastError = reason
    await saveState(ctx.runDir, ctx.state)
    await writeText(reportPath, buildExperimentReport(task, profile, cycles, reason, ctx.state.evidencePath, 'paused', false))
    return { runDir: ctx.runDir, status: 'paused', reportPath, evidencePath: ctx.state.evidencePath, cycles, reason }
  }
  await reloadTree(ctx)
  let evidencePath: string | undefined
  try {
    evidencePath = await exportEvidenceChain(ctx.runDir, ctx.state.runId, ctx.tree)
    ctx.state.evidencePath = evidencePath
  } catch (error) {
    ctx.logger.warn(`experiment evidence export failed: ${String(error)}`)
  }
  ctx.state.status = 'COMPLETED'
  ctx.state.phase = 'work'
  await saveState(ctx.runDir, ctx.state)
  await writeText(reportPath, buildExperimentReport(task, profile, cycles, undefined, evidencePath, 'completed', true))
  return { runDir: ctx.runDir, status: 'completed', reportPath, evidencePath, cycles }
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await access(file)
  } catch {
    await writeText(file, content)
  }
}

function buildExperimentReport(
  task: string,
  profile: string,
  cycles: number,
  reason: string | undefined,
  evidencePath: string | undefined,
  status: 'completed' | 'failed' | 'paused' = reason ? 'failed' : 'completed',
  finished = true,
): string {
  return `# EXPERIMENT_REPORT

## Task
${task}

## Profile
${profile}

## Result
- status: ${status}
- cycles: ${cycles}
- finished: ${finished ? 'yes' : 'no'}
- reason: ${reason ?? '-'}
- evidence: ${evidencePath ?? '-'}

## Artifacts
- EXPERIMENT_DESIGN.md
- MINIMAL_VERIFICATION.md
- MODEL_SCOUT.md
- REFLEXION.md
- INSIGHT.md
- work/experiment-cycle-*/
`
}
