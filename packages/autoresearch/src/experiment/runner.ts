import { join } from 'node:path'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import { createInitialState, recordResult, saveState, transition } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { ensureDir, safeResolve, writeText } from '../core/utils.js'
import { freezeRubric, writeFailureReport, writePlan, writeRubric } from '../domain/files.js'
import { exportEvidenceChain } from '../export/evidence-chain.js'
import { createRunContext, reloadTree } from '../service/context.js'
import type { ResearchRunnerOptions } from '../service/types.js'
import { loadProjectSettings } from '../settings/project-settings.js'
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
  status: 'completed' | 'failed'
  reportPath: string
  evidencePath?: string
  cycles: number
  reason?: string
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
  await writeText(join(runDir, 'input', 'idea.md'), `# IDEA\n\n## Direction\n\n${task}\n`)
  await writeText(join(runDir, 'PROFILE.md'), profile)
  await writeRubric(runDir, `# RUBRIC\n\n- Task: ${task}\n- Criteria: produce a reproducible experiment with real evidence.\n`)
  await freezeRubric(runDir)

  const state: RunState = await createInitialState(runDir)
  state.status = 'RUNNING'
  await saveState(runDir, state)
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
  const ctx = createRunContext(researchDeps, runDir, state, tree, agentContext)
  ctx.logger.info(`experiment task started runDir=${runDir} task=${task.slice(0, 80)}`)

  let cycles = 0
  let lastReason: string | undefined
  let finished = false

  for (let cycle = 1; cycle <= maxRounds; cycle += 1) {
    state.cycle = cycle
    await transition(state, 'plan', `experiment-plan-${cycle}`)
    const planText = await runPlanner(ctx, { idea: task, profile })
    const planFile = await writePlan(runDir, state.planVersion, planText)
    state.planVersion = state.planVersion
    await saveState(runDir, state)
    await recordResult(state, `experiment-plan-${cycle}`, { planFile })
    ctx.logger.info(`experiment plan written ${planFile}`)

    const minimalVerification = await runMinimalVerification(ctx, { planText })
    const modelScout = await runModelScout(ctx, { planText })
    const experimentDesign = await runExperimentDesign(ctx, { planText, minimalVerification, modelScout })
    await runExperimentReflexion(ctx, { planText, minimalVerification, modelScout, initialDesign: experimentDesign })

    await transition(state, 'work', `experiment-work-${cycle}`)
    const workDir = safeResolve(runDir, 'work', `experiment-cycle-${String(cycle).padStart(2, '0')}`)
    await ensureDir(workDir)
    const actionResult = await runWorker(ctx, { workDir, planText, experimentDesign, minimalVerification })
    await recordResult(state, `experiment-work-${cycle}`, actionResult as unknown as Record<string, unknown>)
    ctx.logger.info(`experiment work done status=${actionResult.status} artifacts=${actionResult.artifacts.length}`)

    await transition(state, 'evidence', `experiment-evidence-${cycle}`)
    await runEvidenceAgent(ctx, { planText })
    await reloadTree(ctx)

    const failureDirections = await runResultReflexion(ctx, { planText, experimentDesign })
    const insight = await runInsightAbstractor(ctx, { planText, experimentDesign, failureDirections })
    cycles = cycle

    const decision = await runSupervisor(ctx, { planText })
    ctx.logger.info(`experiment supervisor decision=${decision.action}: ${decision.reason}`)
    if (decision.action === 'fail') {
      lastReason = decision.reason
      state.status = 'FAILED'
      state.phase = 'failed'
      state.lastError = decision.reason
      await saveState(runDir, state)
      await writeFailureReport(runDir, `# FAILURE_REPORT\n\n${decision.reason}\n`)
      await writeText(reportPath, buildExperimentReport(task, profile, cycle, decision.reason, undefined))
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
  await writeText(reportPath, buildExperimentReport(task, profile, cycles, lastReason, evidencePath, finished))
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

function buildExperimentReport(
  task: string,
  profile: string,
  cycles: number,
  reason: string | undefined,
  evidencePath: string | undefined,
  finished = true,
): string {
  return `# EXPERIMENT_REPORT

## Task
${task}

## Profile
${profile}

## Result
- status: ${reason ? 'failed' : 'completed'}
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
