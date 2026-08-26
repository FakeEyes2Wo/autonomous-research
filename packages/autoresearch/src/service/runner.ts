import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RoleExecutionContext } from '../agents/types.js'
import { DEFAULT_MAX_CYCLES, IDEA_FILE, INPUT_DIR, WORK_DIR, ensureDir, readOptionalText, safeResolve, writeText } from '../core/utils.js'
import { HypothesisPool } from '../core/hypothesis-pool.js'
import { ResearchTree } from '../core/research-tree.js'
import { recordDecision, recordResult, saveState, transition, writeDecision } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { planPath, readCandidate, readRubric, writeFailureReport, writePlan } from '../domain/files.js'
import { runBrainstorm } from '../brainstorm/pipeline.js'
import { treeSummary } from './agent.js'
import { createRunContext, reloadTree, type RunContext } from './context.js'
import { reviewGate } from './review.js'
import { ensureRubric, runIdeaGeneration } from './steps/idea.js'
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
} from '../experiment/steps.js'
import { runPaper } from './steps/paper.js'
import type { ResearchRunnerOptions } from './types.js'

export type { ResearchRunnerOptions } from './types.js'

export class ResearchRunner {
  constructor(private readonly deps: Readonly<ResearchRunnerOptions>) {}

  private shouldBrainstorm(runDir: string): boolean {
    if (this.deps.brainstorm === 'off') return false
    if (this.deps.brainstorm === 'on') return true
    return !existsSync(safeResolve(runDir, INPUT_DIR, IDEA_FILE))
  }

  async run(runDir: string, state: RunState, tree: ResearchTree, context: RoleExecutionContext): Promise<RunState> {
    const ctx = createRunContext(this.deps, runDir, state, tree, context)
    ctx.logger.info(`run started runDir=${runDir} runId=${state.runId} status=${state.status} cycle=${state.cycle}`)

    if (this.shouldBrainstorm(runDir)) {
      await transition(state, 'brainstorm', 'brainstorm-pipeline')
      const brainstormOptions = {
        ...(this.deps.projectSettings ? {
          surveyMinPapers: this.deps.projectSettings.paperExploration.maxPapers,
          surveyMinSurveys: this.deps.projectSettings.paperExploration.minSurveys,
          surveyMinClusters: this.deps.projectSettings.paperExploration.minClusters,
          latestWindowYears: this.deps.projectSettings.paperExploration.latestWindowYears,
          latestPerDirection: this.deps.projectSettings.paperExploration.latestPerDirection,
          maxSelectedDirections: this.deps.projectSettings.paperExploration.maxSelectedDirections,
        } : {}),
      }
      const ideaFile = await runBrainstorm(
        { provider: this.deps.provider, options: brainstormOptions },
        { runDir, agentContext: context },
      )
      ctx.logger.info(`brainstorm done idea=${ideaFile}`)
    }

    const candidate = await readCandidate(runDir)
    const profile = await this.readProfile(runDir)
    ctx.logger.info(`intake done direction=${candidate.direction.slice(0, 80)}`)

    if (state.phase === 'paper') {
      ctx.logger.info(`resuming at paper phase cycle=${state.cycle}`)
      await runPaper(ctx)
      state.status = 'COMPLETED'
      state.phase = 'paper'
      await saveState(runDir, state)
      ctx.logger.info('run completed (resumed from paper phase)')
      return state
    }

    if (tree.query({ kind: 'hypothesis' }).length === 0) {
      tree.add('hypothesis', candidate.direction, { status: 'proposed' })
      await tree.save()
    }

    const pool = await HypothesisPool.load(runDir)

    if (tree.query({ kind: 'hypothesis' }).length <= 1) {
      await runIdeaGeneration(ctx, { idea: candidate.raw, profile })
    }
    pool.syncFromTree(ctx.tree, state.runId)
    await pool.save()
    await reloadTree(ctx)

    const ideaVerdict = await reviewGate(ctx, {
      gate: 'idea',
      title: 'Ideas are ready to proceed?',
      detail: treeSummary(ctx.tree),
    })
    if (ideaVerdict.verdict === 'reject') {
      return this.failRun(ctx, `human rejected ideas: ${ideaVerdict.feedback ?? 'no feedback'}`)
    }
    if (ideaVerdict.verdict === 'revise') {
      ctx.logger.info('human requested idea revision; re-running idea generation')
      await runIdeaGeneration(ctx, { idea: candidate.raw, profile, feedback: ideaVerdict.feedback })
      pool.syncFromTree(ctx.tree, state.runId)
      await pool.save()
      await reloadTree(ctx)
    }

    await ensureRubric(ctx, { idea: candidate.raw, profile })
    const rubricVerdict = await reviewGate(ctx, {
      gate: 'rubric',
      title: 'Rubric is ready to freeze?',
      detail: await readRubric(runDir),
    })
    if (rubricVerdict.verdict === 'reject') {
      return this.failRun(ctx, `human rejected rubric: ${rubricVerdict.feedback ?? 'no feedback'}`)
    }
    if (rubricVerdict.verdict === 'revise') {
      ctx.logger.info('human requested rubric revision; re-running rubric generation')
      await ensureRubric(ctx, { idea: candidate.raw, profile, feedback: rubricVerdict.feedback })
    }

    while (state.status === 'RUNNING' && state.cycle <= (this.deps.maxCycles ?? DEFAULT_MAX_CYCLES)) {
      const cycle = state.cycle
      const planVersion = state.planVersion
      ctx.logger.info(`cycle ${cycle} start phase=${state.phase} planVersion=${planVersion}`)

      if (state.phase === 'plan' || state.phase === 'intake' || state.phase === 'decide') {
        await transition(state, 'plan', `plan-${cycle}`)
        const plan = await runPlanner(ctx, { idea: candidate.raw, profile })
        const planFile = await writePlan(runDir, planVersion, plan)
        state.planVersion = planVersion
        await saveState(runDir, state)
        await recordResult(state, `plan-${cycle}`, { planFile })
        ctx.logger.info(`plan written ${planFile}`)
      }

      const planText = await this.readPlanText(runDir, state.planVersion)
      const minimalVerification = await runMinimalVerification(ctx, { planText })
      const modelScout = await runModelScout(ctx, { planText })
      let experimentDesign = await runExperimentDesign(ctx, { planText, minimalVerification, modelScout })
      await runExperimentReflexion(ctx, { planText, minimalVerification, modelScout, initialDesign: experimentDesign })

      let experimentVerdict = await reviewGate(ctx, {
        gate: 'experiment',
        title: 'Experiment design is ready to execute?',
        detail: experimentDesign,
      })
      if (experimentVerdict.verdict === 'reject') {
        return this.failRun(ctx, `human rejected experiment design: ${experimentVerdict.feedback ?? 'no feedback'}`)
      }
      if (experimentVerdict.verdict === 'revise') {
        ctx.logger.info('human requested experiment design revision; re-running design')
        experimentDesign = await runExperimentDesign(ctx, { planText, minimalVerification, modelScout, feedback: experimentVerdict.feedback })
        await runExperimentReflexion(ctx, { planText, minimalVerification, modelScout, initialDesign: experimentDesign })
        experimentVerdict = await reviewGate(ctx, {
          gate: 'experiment',
          title: 'Revised experiment design is ready?',
          detail: experimentDesign,
        })
        if (experimentVerdict.verdict === 'reject') {
          return this.failRun(ctx, `human rejected revised experiment design: ${experimentVerdict.feedback ?? 'no feedback'}`)
        }
      }

      await transition(state, 'work', `work-${cycle}`)
      const workDir = safeResolve(runDir, WORK_DIR, `cycle-${String(cycle).padStart(2, '0')}`)
      await ensureDir(workDir)
      const actionResult = await runWorker(ctx, { workDir, planText, experimentDesign, minimalVerification })
      await recordResult(state, `work-${cycle}`, actionResult as unknown as Record<string, unknown>)
      ctx.logger.info(`work done status=${actionResult.status} artifacts=${actionResult.artifacts.length}`)

      await transition(state, 'evidence', `evidence-${cycle}`)
      await runEvidenceAgent(ctx, { planText })
      ctx.logger.info(`evidence done cycle=${cycle}`)

      await reloadTree(ctx)

      pool.syncFromTree(ctx.tree, state.runId)
      await pool.save()
      const failureDirections = await runResultReflexion(ctx, { planText, experimentDesign })
      const insight = await runInsightAbstractor(ctx, { planText, experimentDesign, failureDirections })

      await runIdeaGeneration(ctx, { idea: candidate.raw, profile, failureDirections, insight })
      pool.syncFromTree(ctx.tree, state.runId)
      await pool.save()
      await reloadTree(ctx)

      const evidenceVerdict = await reviewGate(ctx, {
        gate: 'evidence',
        title: 'Evidence supports a decision?',
        detail: [
          `## Result reflexion\n\n${failureDirections}`,
          `## Insight\n\n${insight}`,
          `## Tree\n\n${treeSummary(ctx.tree)}`,
        ].join('\n\n'),
      })
      if (evidenceVerdict.verdict === 'reject') {
        return this.failRun(ctx, `human rejected evidence: ${evidenceVerdict.feedback ?? 'no feedback'}`)
      }
      if (evidenceVerdict.verdict === 'revise') {
        ctx.logger.info('human requested plan revision after evidence review; starting next cycle with feedback')
        state.planVersion += 1
        state.cycle += 1
        state.phase = 'plan'
        await saveState(runDir, state)
        await writeText(join(runDir, 'PLAN_FEEDBACK.md'), `# Plan feedback from human review\n\n${evidenceVerdict.feedback ?? ''}\n`)
        continue
      }

      await transition(state, 'decide', `decide-${cycle}`)
      const decision = await runSupervisor(ctx, { planText })
      await writeDecision(runDir, `# Decision\n\n- action: ${decision.action}\n- reason: ${decision.reason}\n`)
      await recordDecision(state, `decide-${cycle}`, decision as unknown as Record<string, unknown>)
      ctx.logger.info(`decision ${decision.action}: ${decision.reason}`)

      if (decision.action === 'continue') {
        ctx.logger.info(`cycle ${cycle} -> continue to cycle ${cycle + 1}`)
        state.cycle += 1
        state.phase = 'work'
        await saveState(runDir, state)
        continue
      }

      if (decision.action === 'revise') {
        ctx.logger.info(`cycle ${cycle} -> revise to plan v${state.planVersion + 1}`)
        state.planVersion += 1
        state.cycle += 1
        state.phase = 'plan'
        await saveState(runDir, state)
        continue
      }

      if (decision.action === 'finish') {
        ctx.logger.info(`cycle ${cycle} -> finish, entering paper phase`)
        state.status = 'RUNNING'
        state.phase = 'paper'
        await saveState(runDir, state)
        await reloadTree(ctx)
        await runPaper(ctx)
        state.status = 'COMPLETED'
        state.phase = 'paper'
        await saveState(runDir, state)
        ctx.logger.info('run completed')
        return state
      }

      ctx.logger.warn(`cycle ${cycle} -> fail: ${decision.reason}`)
      state.status = 'FAILED'
      state.phase = 'failed'
      await saveState(runDir, state)
      await writeFailureReport(runDir, `# FAILURE_REPORT\n\n${decision.reason}\n`)
      return state
    }

    state.status = 'FAILED'
    state.phase = 'failed'
    state.lastError = `max cycles reached (${this.deps.maxCycles ?? DEFAULT_MAX_CYCLES})`
    await saveState(runDir, state)
    await writeFailureReport(runDir, `# FAILURE_REPORT\n\nMax cycles reached: ${this.deps.maxCycles ?? DEFAULT_MAX_CYCLES}\n`)
    return state
  }

  private async failRun(ctx: RunContext, reason: string): Promise<RunState> {
    ctx.logger.warn(`run failed by human review: ${reason}`)
    ctx.state.status = 'FAILED'
    ctx.state.phase = 'failed'
    ctx.state.lastError = reason
    await saveState(ctx.runDir, ctx.state)
    await writeFailureReport(ctx.runDir, `# FAILURE_REPORT\n\n${reason}\n`)
    return ctx.state
  }

  private async readProfile(runDir: string): Promise<string> {
    return (await readOptionalText(safeResolve(runDir, 'PROFILE.md'))) ?? ''
  }

  private async readPlanText(runDir: string, version: number): Promise<string> {
    return (await readOptionalText(planPath(runDir, version))) ?? ''
  }
}
