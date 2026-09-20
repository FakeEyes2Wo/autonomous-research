import { access, link, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { createInitialState, loadState, recordResult, saveState, transition } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { atomicWriteJson, AutoResearchError, ensureDir, readJson, readOptionalText, safeResolve, writeText } from '../core/utils.js'
import { freezeRubric, writeFailureReport, writePlan } from '../domain/files.js'
import { exportEvidenceChain } from '../export/evidence-chain.js'
import { createRunContext, reloadTree } from '../service/context.js'
import type { ResearchRunnerOptions } from '../service/types.js'
import { loadProjectSettings } from '../settings/project-settings.js'
import { createPolicySnapshot, frozenLiteratureSettings } from '../policy/model-routing.js'
import { openRequestLedger } from '../policy/request-ledger.js'
import type { ProjectSettings } from '../settings/schema.js'
import { isExperimentPauseError, DurableExperimentWaitingError } from './errors.js'
import { assertFailureImportTarget, importResearchFailure, type FailureReportImport } from '../service/failure-import.js'
import { bindResearchOutputs } from '../service/research-outputs.js'
import { bindRunProject } from '../service/project-paper.js'
import { advanceCleanupQueue, finalizeDirectionRetirement, isDirectionRetired } from '../cleanup/index.js'
import { ResearchStore } from '../research/store.js'
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
  failureReport?: FailureReportImport
  runDir: string
  projectDir?: string
  /** Required for a new run; a verified request snapshot supplies it on resume. */
  task?: string
  profile?: string
  maxRounds?: number
  agentContext: RoleExecutionContext
}

export interface ExperimentRunResult {
  runDir: string
  status: 'completed' | 'failed' | 'paused' | 'waiting'
  reportPath: string
  evidencePath?: string
  cycles: number
  reason?: string
}

type ExperimentStage = 'plan' | 'design' | 'work' | 'evidence' | 'decision'
const SNAPSHOT_FILE = join('.autoresearch', 'policy-snapshot.json')
const MANIFEST_FILE = join('.autoresearch', 'experiment-manifest.json')
const REQUEST_FILE = join('.autoresearch', 'experiment-request.json')

interface ExperimentRequestSnapshot {
  version: 1
  task: string
  profile: string
  maxRounds: number
}

function freezePolicy<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezePolicy(child)
    Object.freeze(value)
  }
  return value
}

async function loadExperimentPolicy(runDir: string, settings: ProjectSettings, existing: boolean): Promise<NonNullable<RoleExecutionContext['policySnapshot']>> {
  const file = safeResolve(runDir, SNAPSHOT_FILE)
  try {
    const parsed = await readJson<unknown>(file)
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 2 ||
      !('model' in parsed) || !('modelRouting' in parsed) || !('workflow' in parsed) || !('budget' in parsed)) {
      throw new AutoResearchError(`invalid experiment policy snapshot: ${file}`, 'STATE_CORRUPT')
    }
    return freezePolicy({ ...parsed, literature: frozenLiteratureSettings((parsed as { literature?: unknown }).literature) } as NonNullable<RoleExecutionContext['policySnapshot']>)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof Error && /cannot read .*ENOENT/i.test(error.message))) throw error
  }
  const snapshot = { ...createPolicySnapshot(settings), model: structuredClone(settings.model) }
  if (existing) snapshot.literature = frozenLiteratureSettings(undefined)
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

function cachedActionResult(stageData: unknown): unknown {
  if (!stageData || typeof stageData !== 'object' || Array.isArray(stageData)) return stageData
  return (stageData as { actionResult?: unknown }).actionResult
}

function identityHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

function isExperimentRequestSnapshot(value: unknown): value is ExperimentRequestSnapshot {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { task?: unknown }).task === 'string' &&
    (value as { task: string }).task.trim().length > 0 &&
    typeof (value as { profile?: unknown }).profile === 'string' &&
    Number.isSafeInteger((value as { maxRounds?: unknown }).maxRounds) &&
    ((value as { maxRounds: number }).maxRounds > 0))
}

async function readExperimentRequest(runDir: string): Promise<ExperimentRequestSnapshot | undefined> {
  const file = safeResolve(runDir, REQUEST_FILE)
  try {
    const value = await readJson<unknown>(file)
    if (!isExperimentRequestSnapshot(value)) throw new AutoResearchError(`invalid experiment request: ${file}`, 'STATE_CORRUPT')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof Error && /cannot read .*ENOENT/i.test(error.message))) return undefined
    throw error
  }
}

async function resolveExperimentRequest(
  request: ExperimentRunRequest,
  runDir: string,
  settings: ProjectSettings,
  existingState: boolean,
  legacyManifest: boolean,
): Promise<{ value: ExperimentRequestSnapshot; persisted: boolean }> {
  const saved = await readExperimentRequest(runDir)
  if (saved) {
    if (request.task !== undefined && request.task !== saved.task) throw new AutoResearchError('run directory belongs to a different experiment task/profile; use a new runDir', 'INVALID_ARGUMENT')
    if (request.profile !== undefined && request.profile !== saved.profile) throw new AutoResearchError('run directory belongs to a different experiment task/profile; use a new runDir', 'INVALID_ARGUMENT')
    if (request.maxRounds !== undefined && request.maxRounds !== saved.maxRounds) throw new AutoResearchError('experiment maxRounds is frozen for resume; use a new runDir', 'INVALID_ARGUMENT')
    return { value: saved, persisted: false }
  }

  // A legacy manifest is the only recoverable input source for an identityless
  // existing run. Its hashes can validate explicit task/profile arguments, but
  // cannot recover either value when the caller omits it.
  if (existingState && legacyManifest && (request.task === undefined || request.profile === undefined)) {
    throw new AutoResearchError('legacy experiment resume requires explicit task and profile', 'INVALID_ARGUMENT')
  }
  if (request.task === undefined || request.task.trim().length === 0) throw new TypeError('task must be a non-empty string')
  const maxRounds = request.maxRounds ?? settings.experiment.maxRounds ?? DEFAULT_EXPERIMENT_MAX_ROUNDS
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) throw new TypeError('maxRounds must be a positive finite integer')
  const profile = request.profile ?? (settings.experiment.profile || '# PROFILE\n\n- Allowed: local experiments, public data, public literature.\n')
  return { value: { version: 1, task: request.task, profile, maxRounds }, persisted: true }
}

async function persistExperimentRequest(runDir: string, value: ExperimentRequestSnapshot): Promise<void> {
  await publishIdentityJson(safeResolve(runDir, REQUEST_FILE), value, (current): current is ExperimentRequestSnapshot => isExperimentRequestSnapshot(current) &&
    current.task === value.task && current.profile === value.profile && current.maxRounds === value.maxRounds)
}

async function publishIdentityJson(file: string, value: unknown, same: (current: unknown) => boolean): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  await ensureDir(dirname(file))
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  try {
    try {
      await link(temporary, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const current = await readJson<unknown>(file)
      if (!same(current)) throw new AutoResearchError(`identity publication conflict: ${file}`, 'INVALID_ARGUMENT')
    }
  } finally {
    try { await unlink(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

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
    await publishIdentityJson(file, expected, value => {
      if (!value || typeof value !== 'object') return false
      const candidate = value as typeof expected
      return candidate.schema === expected.schema && candidate.taskHash === expected.taskHash && candidate.profileHash === expected.profileHash
    })
    return
  }
  if (current.schema !== expected.schema || current.taskHash !== expected.taskHash || current.profileHash !== expected.profileHash) {
    throw new AutoResearchError('run directory belongs to a different experiment task/profile; use a new runDir', 'INVALID_ARGUMENT')
  }
}

function isBudgetPause(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && ['BUDGET_EXHAUSTED', 'CONTEXT_INSUFFICIENT'].includes(String((error as { code?: string }).code)))
}

type ExperimentContext = ReturnType<typeof createRunContext>

async function persistTerminalExperiment(
  ctx: ExperimentContext,
  task: string,
  profile: string,
  reportPath: string,
  cycles: number,
  status: 'failed' | 'paused' | 'waiting',
  reason: string,
  phase?: 'failed',
  failureReport?: string,
): Promise<ExperimentRunResult> {
  ctx.state.status = status === 'failed' ? 'FAILED' : status === 'waiting' ? 'WAITING' : 'PAUSED'
  if (phase) ctx.state.phase = phase
  ctx.state.lastError = reason
  await saveState(ctx.runDir, ctx.state)
  if (failureReport !== undefined) await writeFailureReport(ctx.runDir, failureReport)
  await writeText(reportPath, buildExperimentReport(task, profile, cycles, reason, ctx.state.evidencePath, status, false))
  return {
    runDir: ctx.runDir,
    status,
    reportPath,
    evidencePath: ctx.state.evidencePath,
    cycles,
    reason,
  }
}

type CompletionOptions = { finished: boolean; lastError?: string; updateLastError: boolean; logCompletion: boolean; includeReason: boolean }

async function completeExperiment(
  ctx: ExperimentContext,
  task: string,
  profile: string,
  reportPath: string,
  cycles: number,
  options: CompletionOptions,
): Promise<ExperimentRunResult> {
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
  if (options.updateLastError) ctx.state.lastError = options.lastError
  await saveState(ctx.runDir, ctx.state)
  await writeText(reportPath, buildExperimentReport(task, profile, cycles, options.lastError, evidencePath, 'completed', options.finished))
  if (options.logCompletion) {
    ctx.logger.info(`experiment task completed runDir=${ctx.runDir} cycles=${cycles} evidence=${evidencePath ?? 'none'}`)
  }
  return {
    runDir: ctx.runDir,
    status: 'completed',
    reportPath,
    evidencePath,
    cycles,
    ...(options.includeReason ? { reason: options.lastError } : {}),
  }
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
async function executeExperimentTask(
  deps: ExperimentDependencies,
  request: ExperimentRunRequest,
  onAdmitted?: (projectDir: string) => void,
): Promise<ExperimentRunResult> {
  const { runDir, agentContext } = request
  // Read existing metadata first, then publish the workflow binding before
  // creating any experiment input/state files. This is the admission boundary
  // that keeps research and experiment engines from adopting each other's runs.
  const savedState = await loadState(runDir)
  const savedRequest = await readExperimentRequest(runDir)
  const legacyManifest = savedState !== undefined && await readOptionalText(safeResolve(runDir, MANIFEST_FILE)) !== undefined
  if (savedState !== undefined && !savedRequest && !legacyManifest) {
    throw new AutoResearchError('existing experiment run has no recoverable identity; choose an explicit legacy experiment run', 'INVALID_ARGUMENT')
  }
  if (savedRequest && !legacyManifest) {
    throw new AutoResearchError('existing experiment run is missing its experiment manifest', 'STATE_CORRUPT')
  }
  // Validate an identityless legacy manifest before publishing a new project
  // identity, so a rejected task/profile request leaves the legacy directory
  // untouched and remains eligible for explicit recovery.
  let resolved: { value: ExperimentRequestSnapshot; persisted: boolean } | undefined
  if (legacyManifest) {
    const legacySettings = await loadProjectSettings(request.projectDir ?? runDir)
    resolved = await resolveExperimentRequest(request, runDir, legacySettings, true, true)
    await assertExperimentIdentity(runDir, resolved.value.task, resolved.value.profile)
  }
  const identity = await bindRunProject({ runDir, projectDir: request.projectDir }, 'experiment', savedState !== undefined)
  const projectDir = identity.projectDir
  try { await advanceCleanupQueue(projectDir) } catch (error) { console.error(`[cleanup] queue deferred before experiment: ${String(error)}`) }
  const projectSettings = await loadProjectSettings(projectDir)
  resolved ??= await resolveExperimentRequest(request, runDir, projectSettings, savedState !== undefined, legacyManifest)
  const { task, profile, maxRounds } = resolved.value
  const reportPath = join(runDir, 'EXPERIMENT_REPORT.md')

  await assertExperimentIdentity(runDir, task, profile)
  if (resolved.persisted) await persistExperimentRequest(runDir, resolved.value)
  // From this point onward the workflow, project, and frozen request have all
  // been admitted. Output synchronization is safe even if execution pauses or
  // fails later; pre-admission rejections must leave foreign runs untouched.
  onAdmitted?.(projectDir)
  if (savedState && savedState.status !== 'COMPLETED' && savedState.status !== 'FAILED') {
    const current = await new ResearchStore(runDir).loadCurrent()
    if (current && await isDirectionRetired({ projectDir, runDir, snapshot: current })) {
      savedState.status = 'PAUSED'
      savedState.lastError = 'direction retired; cleanup completed and resume will not redispatch it'
      await saveState(runDir, savedState)
      return { runDir, status: 'paused', reportPath, evidencePath: savedState.evidencePath, cycles: savedState.cycle, reason: savedState.lastError }
    }
  }
  if (savedState && (savedState.status === 'COMPLETED' || savedState.status === 'FAILED')) {
    try {
      const current = await new ResearchStore(runDir).loadCurrent()
      if (current) await finalizeDirectionRetirement({ projectDir, runDir, cycle: savedState.cycle, snapshot: current })
      else await advanceCleanupQueue(projectDir)
    } catch (error) { console.error(`[cleanup] terminal experiment hook deferred: ${String(error)}`) }
    return {
      runDir,
      status: savedState.status === 'COMPLETED' ? 'completed' : 'failed',
      reportPath,
      evidencePath: savedState.evidencePath,
      cycles: savedState.cycle,
      reason: savedState.lastError,
    }
  }

  await ensureDir(runDir)
  await ensureDir(join(runDir, 'input'))
  await writeIfMissing(join(runDir, 'input', 'idea.md'), `# IDEA\n\n## Direction\n\n${task}\n`)
  await writeIfMissing(join(runDir, 'PROFILE.md'), profile)
  await writeIfMissing(join(runDir, 'RUBRIC.md'), `# RUBRIC\n\n- Task: ${task}\n- Criteria: produce a reproducible experiment with real evidence.\n`)
  await freezeRubric(runDir)

  const state: RunState = savedState ?? await createInitialState(runDir)
  await importResearchFailure(runDir, state.runId, request.failureReport)
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
  const policySnapshot = await loadExperimentPolicy(runDir, projectSettings, Boolean(savedState))
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
      experimentDesign = await runExperimentReflexion(ctx, { planText, minimalVerification, modelScout, initialDesign: experimentDesign })
      await writeStage(runDir, cycle, 'design', { minimalVerification, modelScout, experimentDesign })
    }

    await transition(state, 'work', `experiment-work-${cycle}`)
    const workDir = safeResolve(runDir, 'work', `experiment-cycle-${String(cycle).padStart(2, '0')}`)
    await ensureDir(workDir)
    const cachedWork = await readStage<unknown>(stageFile(runDir, cycle, 'work'))
    const actionResult = await runWorker(ctx, { workDir, planText, experimentDesign, minimalVerification, ...(cachedWork === undefined ? {} : { cachedStage: { result: cachedActionResult(cachedWork) } }) })
    if (cachedWork === undefined) {
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
    await runInsightAbstractor(ctx, { planText, experimentDesign, failureDirections })
    const decision = (await readStage<{ action: string; reason: string }>(stageFile(runDir, cycle, 'decision'))) ?? await runSupervisor(ctx, { planText })
    if (!(await readStage(stageFile(runDir, cycle, 'decision')))) await writeStage(runDir, cycle, 'decision', decision)
    ctx.logger.info(`experiment supervisor decision=${decision.action}: ${decision.reason}`)
    if (decision.action === 'fail') {
      lastReason = decision.reason
      return persistTerminalExperiment(
        ctx, task, profile, reportPath, cycles, 'failed', decision.reason, 'failed',
        `# FAILURE_REPORT\n\n${decision.reason}\n`,
      )
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
    if (!isBudgetPause(error) && !isExperimentPauseError(error)) throw error
    const reason = error instanceof Error ? error.message : String(error)
    return persistTerminalExperiment(ctx, task, profile, reportPath, cycles, error instanceof DurableExperimentWaitingError ? 'waiting' : 'paused', reason, undefined, `# PAUSED\n\n${reason}\n`)
  }

  if (!finished) {
    const reason = `experiment did not finish within maxRounds=${maxRounds}`
    return persistTerminalExperiment(ctx, task, profile, reportPath, cycles, 'paused', reason)
  }

  return completeExperiment(ctx, task, profile, reportPath, cycles, { finished, lastError: lastReason, updateLastError: true, logCompletion: true, includeReason: true })
}

export async function runExperimentTask(deps: ExperimentDependencies, request: ExperimentRunRequest): Promise<ExperimentRunResult> {
  const historicalState = await loadState(request.runDir)
  const savedIdentity = await readOptionalText(safeResolve(request.runDir, '.autoresearch', 'project-identity.json'))
  if (historicalState && (historicalState.status === 'COMPLETED' || historicalState.status === 'FAILED') && savedIdentity === undefined) {
    const savedRequest = await readExperimentRequest(request.runDir)
    const manifest = await readOptionalText(safeResolve(request.runDir, MANIFEST_FILE))
    if (manifest !== undefined) {
      const task = request.task ?? savedRequest?.task
      const profile = request.profile ?? savedRequest?.profile
      if (task === undefined || profile === undefined) throw new AutoResearchError('legacy experiment terminal resume requires explicit task and profile', 'INVALID_ARGUMENT')
      if (savedRequest && ((request.task !== undefined && request.task !== savedRequest.task) || (request.profile !== undefined && request.profile !== savedRequest.profile) || (request.maxRounds !== undefined && request.maxRounds !== savedRequest.maxRounds))) {
        throw new AutoResearchError('run directory belongs to a different experiment task/profile or frozen maxRounds; use a new runDir', 'INVALID_ARGUMENT')
      }
      await assertExperimentIdentity(request.runDir, task, profile)
    } else if (savedRequest) {
      throw new AutoResearchError('existing experiment run is missing its experiment manifest', 'STATE_CORRUPT')
    }
    // Historical runs with no experiment metadata are immutable compatibility
    // views. Do not bind, publish, or synchronize anything for them.
    return {
      runDir: request.runDir,
      status: historicalState.status === 'COMPLETED' ? 'completed' : 'failed',
      reportPath: join(request.runDir, 'EXPERIMENT_REPORT.md'),
      evidencePath: historicalState.evidencePath,
      cycles: historicalState.cycle,
      reason: historicalState.lastError,
    }
  }
  // Reject source imports before finalization can mutate the source run.
  await assertFailureImportTarget(request.runDir, request.failureReport)
  let experimentAdmitted = false
  let admittedProjectDir: string | undefined
  try { return await executeExperimentTask(deps, request, (projectDir) => { experimentAdmitted = true; admittedProjectDir = projectDir }) }
  finally {
    if (experimentAdmitted) {
      const state = await loadState(request.runDir)
      if (state) {
        const cleanupProjectDir = admittedProjectDir ?? request.projectDir ?? request.runDir
        // A retired PAUSED resume is a lifecycle pass only. Its cleanup may
        // have tombstoned captured research sources, so rebuilding views here
        // would try to read deleted raw output and could recreate artifacts.
        const current = await new ResearchStore(request.runDir).loadCurrent()
        const retired = current ? await isDirectionRetired({ projectDir: cleanupProjectDir, runDir: request.runDir, snapshot: current }) : false
        if (!retired) await bindResearchOutputs(request.runDir, state.runId)
        try {
          if (current) {
            await finalizeDirectionRetirement({ projectDir: cleanupProjectDir, runDir: request.runDir, cycle: state.cycle, snapshot: current })
          }
          await advanceCleanupQueue(cleanupProjectDir)
        } catch (error) { console.error(`[cleanup] experiment hook deferred: ${String(error)}`) }
      }
    }
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
      const cachedWork = await readStage<unknown>(stageFile(ctx.runDir, cycle, 'work'))
      const actionResult = cachedWork === undefined ? await (async () => {
        await transition(ctx.state, 'work', `experiment-minimal-work-${cycle}`)
        const result = await runWorker(ctx, { workDir, planText, experimentDesign: planText, minimalVerification: 'minimal plan is the verification basis' })
        await writeStage(ctx.runDir, cycle, 'work', { actionResult: result })
        await recordResult(ctx.state, `experiment-minimal-work-${cycle}`, result as unknown as Record<string, unknown>)
        return result
      })() : await runWorker(ctx, { workDir, planText, experimentDesign: planText, minimalVerification: 'minimal plan is the verification basis', cachedStage: { result: cachedActionResult(cachedWork) } })

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
        return persistTerminalExperiment(
          ctx, task, profile, reportPath, cycles, 'failed', decision.reason, 'failed',
          `# FAILURE_REPORT\n\n${decision.reason}\n`,
        )
      }
      if (decision.action === 'finish') {
        finished = true
        break
      }
      if (decision.action === 'revise') ctx.state.planVersion += 1
    }
  } catch (error) {
    if (!isBudgetPause(error) && !isExperimentPauseError(error)) throw error
    const reason = error instanceof Error ? error.message : String(error)
    return persistTerminalExperiment(ctx, task, profile, reportPath, cycles, error instanceof DurableExperimentWaitingError ? 'waiting' : 'paused', reason, undefined, `# PAUSED\n\n${reason}\n`)
  }
  if (!finished) {
    const reason = `experiment did not finish within maxRounds=${maxRounds}`
    return persistTerminalExperiment(ctx, task, profile, reportPath, cycles, 'paused', reason)
  }
  return completeExperiment(ctx, task, profile, reportPath, cycles, { finished: true, updateLastError: false, logCompletion: false, includeReason: false })
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
  status: 'completed' | 'failed' | 'paused' | 'waiting' = reason ? 'failed' : 'completed',
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
