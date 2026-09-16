import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RoleExecutionContext } from '../agents/types.js'
import { DEFAULT_MAX_CYCLES, EVENTS_FILE, IDEA_FILE, INPUT_DIR, WORK_DIR, ensureDir, readOptionalText, safeResolve, writeText } from '../core/utils.js'
import { HypothesisPool } from '../core/hypothesis-pool.js'
import { ResearchTree } from '../core/research-tree.js'
import { recordDecision, recordResult, saveState, transition, writeDecision } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { planPath, readCandidate, readRubric, writeFailureReport, writePlan } from '../domain/files.js'
import { runBrainstorm } from '../brainstorm/pipeline.js'
import { runInitialDeepDive } from '../brainstorm/deep-dive.js'
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
  runMinimalPlan,
  runModelScout,
  runPlanner,
  runResultReflexion,
  runSupervisor,
  runWorker,
} from '../experiment/steps.js'
import { runPaper } from './steps/paper.js'
import type { ResearchRunnerOptions } from './types.js'
import { isExperimentPauseError } from '../experiment/errors.js'
import { validateWorkerResult } from '../experiment/validation.js'

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

    // A paper checkpoint owns the remaining work. Prelude roles are paid work
    // and must not be dispatched again when resuming either workflow mode.
    if (state.phase === 'paper') {
      ctx.logger.info(`resuming at paper phase cycle=${state.cycle}`)
      await runPaper(ctx)
      state.status = 'COMPLETED'
      await saveState(runDir, state)
      return state
    }

    // Minimal mode is an intentionally small path.  Keep it before the
    // legacy brainstorm/deep-dive gates so optional roles cannot leak into a
    // run whose settings explicitly disabled them.
    if (ctx.policySnapshot.workflow.mode === 'minimal') {
      let candidate = await readCandidate(runDir)
      const profile = await this.readProfile(runDir)
      // Minimal mode skips optional prelude work for auto/never.  An explicit
      // enabled setting is honored so the UI never stores a silently ignored
      // switch; its output is folded into the single minimal plan input.
      if (ctx.policySnapshot.workflow.brainstorm === 'enabled') {
        const brainstormOptions = this.deps.projectSettings ? {
          surveyMinSurveys: this.deps.projectSettings.paperExploration.minSurveys,
          surveyMinClusters: this.deps.projectSettings.paperExploration.minClusters,
          latestWindowYears: this.deps.projectSettings.paperExploration.latestWindowYears,
          latestPerDirection: this.deps.projectSettings.paperExploration.latestPerDirection,
          maxSelectedDirections: this.deps.projectSettings.paperExploration.maxSelectedDirections,
        } : {}
        await runBrainstorm({ provider: this.deps.provider, options: brainstormOptions }, { runDir, agentContext: context })
        candidate = await readCandidate(runDir)
      }
      if (ctx.policySnapshot.workflow.deepDive === 'enabled') {
        const deepDive = await runInitialDeepDive(
          { provider: this.deps.provider, topN: this.deps.deepDiveTopN },
          { runDir, idea: candidate.raw, profile, agentContext: context },
        )
        const contextText = [deepDive.relatedPapers, deepDive.baselines].filter((value) => value.trim()).join('\n\n')
        if (contextText) candidate = { ...candidate, raw: `${candidate.raw}\n\n## Explicit deep-dive context\n${contextText}` }
      }
      return this.runMinimal(ctx, candidate.raw, profile)
    }

    const shouldBrainstorm = this.shouldBrainstorm(runDir)
    if (shouldBrainstorm) {
      await transition(state, 'brainstorm', 'brainstorm-pipeline')
      const brainstormOptions = {
        ...(this.deps.projectSettings ? {
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

    let deepDive = { relatedPapers: '', baselines: '' }
    if (!shouldBrainstorm && this.deps.deepDiveEnabled !== false) {
      try {
        deepDive = await runInitialDeepDive(
          { provider: this.deps.provider, topN: this.deps.deepDiveTopN },
          { runDir, idea: candidate.raw, profile, agentContext: context },
        )
        ctx.logger.info('initial deep-dive done')
      } catch (error) {
        ctx.logger.warn(`initial deep-dive failed; continuing with self-designed baseline: ${String(error)}`)
        deepDive = { relatedPapers: '', baselines: 'No external baseline found. We will design a baseline ourselves.' }
      }
    }

    if (tree.query({ kind: 'hypothesis' }).length === 0) {
      tree.add('hypothesis', candidate.direction, { status: 'proposed' })
      await tree.save()
    }

    const pool = await HypothesisPool.load(runDir)

    if (tree.query({ kind: 'hypothesis' }).length <= 1) {
      await runIdeaGeneration(ctx, { idea: candidate.raw, profile, relatedPapers: deepDive.relatedPapers, baselines: deepDive.baselines })
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
      await runIdeaGeneration(ctx, { idea: candidate.raw, profile, relatedPapers: deepDive.relatedPapers, baselines: deepDive.baselines, feedback: ideaVerdict.feedback })
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

      if (state.phase === 'plan' || state.phase === 'intake' || state.phase === 'decide' || !(await this.readPlanText(runDir, state.planVersion)).trim()) {
        await transition(state, 'plan', `plan-${cycle}`)
        const plan = await runPlanner(ctx, { idea: candidate.raw, profile })
        const planFile = await writePlan(runDir, planVersion, plan)
        state.planVersion = planVersion
        await saveState(runDir, state)
        await recordResult(state, `plan-${cycle}`, { planFile })
        ctx.logger.info(`plan written ${planFile}`)
      }

      const planText = await this.readPlanText(runDir, state.planVersion)
      const [minimalVerification, modelScout] = await Promise.all([
        runMinimalVerification(ctx, { planText }),
        runModelScout(ctx, { planText }),
      ])
      let experimentDesign = await runExperimentDesign(ctx, { planText, minimalVerification, modelScout })
      try {
        experimentDesign = await runExperimentReflexion(ctx, { planText, minimalVerification, modelScout, initialDesign: experimentDesign })
      } catch (error) {
        if (isExperimentPauseError(error)) return this.pauseRun(ctx, error.message)
        throw error
      }

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
        try {
          experimentDesign = await runExperimentReflexion(ctx, { planText, minimalVerification, modelScout, initialDesign: experimentDesign })
        } catch (error) {
          if (isExperimentPauseError(error)) return this.pauseRun(ctx, error.message)
          throw error
        }
        experimentVerdict = await reviewGate(ctx, {
          gate: 'experiment',
          title: 'Revised experiment design is ready?',
          detail: experimentDesign,
        })
        if (experimentVerdict.verdict === 'reject') {
          return this.failRun(ctx, `human rejected revised experiment design: ${experimentVerdict.feedback ?? 'no feedback'}`)
        }
        if (experimentVerdict.verdict === 'revise') {
          return this.pauseRun(ctx, `revised experiment design still needs human revision: ${experimentVerdict.feedback ?? 'no feedback'}`)
        }
      }

      await transition(state, 'work', `work-${cycle}`)
      const workDir = safeResolve(runDir, WORK_DIR, `cycle-${String(cycle).padStart(2, '0')}`)
      await ensureDir(workDir)
      let actionResult
      try {
        actionResult = await validateWorkerResult(runDir, await runWorker(ctx, { workDir, planText, experimentDesign, minimalVerification }))
      } catch (error) {
        if (isExperimentPauseError(error)) return this.pauseRun(ctx, error.message)
        throw error
      }
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

      await runIdeaGeneration(ctx, { idea: candidate.raw, profile, relatedPapers: deepDive.relatedPapers, baselines: deepDive.baselines, failureDirections, insight })
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
        if (ctx.policySnapshot.workflow.paper === 'never') {
          state.status = 'COMPLETED'
          await saveState(runDir, state)
          return state
        }
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

    state.status = 'PAUSED'
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

  private async pauseRun(ctx: RunContext, reason: string): Promise<RunState> {
    ctx.logger.warn(`run paused: ${reason}`)
    ctx.state.status = 'PAUSED'
    ctx.state.lastError = reason
    await saveState(ctx.runDir, ctx.state)
    await writeFailureReport(ctx.runDir, `# PAUSED\n\n${reason}\n`)
    return ctx.state
  }

  private shouldRunPaper(ctx: RunContext, idea: string): boolean {
    const toggle = ctx.policySnapshot.workflow.paper
    if (toggle === 'enabled') return true
    if (toggle === 'never') return false
    return /(?:\b(?:write|produce|draft|submit|prepare)\s+(?:a\s+)?paper\b|明确论文|论文报告|论文稿|latex\s+(?:paper|manuscript)|pdf\s+(?:deliverable|report)|submission\s+(?:draft|package))/i.test(idea)
  }

  private async runMinimal(ctx: RunContext, idea: string, profile: string): Promise<RunState> {
    const cycle = ctx.state.cycle
    if (ctx.tree.query({ kind: 'hypothesis' }).length === 0) {
      ctx.tree.add('hypothesis', idea, { status: 'proposed' })
      await ctx.tree.save()
    }
    const planMarker = safeResolve(ctx.runDir, `MINIMAL_PLAN-${cycle}.json`)
    const workMarker = safeResolve(ctx.runDir, `MINIMAL_WORK-${cycle}.json`)
    let plan: { plan: string; riskLevel: 'low' | 'medium' | 'high'; planFile?: string }

    const savedPlan = await readOptionalText(planMarker)
    if (savedPlan) {
      try {
        const value = JSON.parse(savedPlan) as Partial<typeof plan>
        if (typeof value.plan !== 'string' || value.plan.trim().length === 0) throw new Error('empty plan')
        if (value.riskLevel !== undefined && value.riskLevel !== 'low' && value.riskLevel !== 'medium' && value.riskLevel !== 'high') throw new Error('invalid risk level')
        plan = {
          plan: value.plan,
          riskLevel: value.riskLevel === 'high' || value.riskLevel === 'medium' ? value.riskLevel : 'low',
          ...(typeof value.planFile === 'string' ? { planFile: value.planFile } : {}),
        }
      } catch {
        throw new Error(`invalid minimal plan checkpoint: ${planMarker}`)
      }
    } else {
      await transition(ctx.state, 'plan', `minimal-plan-${cycle}`)
      plan = await runMinimalPlan(ctx, { idea, profile })
      const planFile = await writePlan(ctx.runDir, ctx.state.planVersion, plan.plan)
      plan.planFile = planFile
      await writeText(planMarker, JSON.stringify({ ...plan, planFile }, null, 2))
      await recordResult(ctx.state, `minimal-plan-${cycle}`, { planFile, riskLevel: plan.riskLevel })
    }
    if (!(await resultRecorded(ctx.runDir, `minimal-plan-${cycle}`))) {
      await recordResult(ctx.state, `minimal-plan-${cycle}`, { ...(plan.planFile ? { planFile: plan.planFile } : {}), riskLevel: plan.riskLevel })
    }

    const review = ctx.policySnapshot.workflow.experimentReview
    const pauseForEvidence = async (reason = 'worker evidence is insufficient or unsafe; supervisor cannot override the evidence gate'): Promise<RunState> => {
      ctx.state.status = 'PAUSED'
      ctx.state.lastError = reason
      await saveState(ctx.runDir, ctx.state)
      await writeFailureReport(ctx.runDir, `# PAUSED\n\n${ctx.state.lastError}.\n`)
      return ctx.state
    }
    if (review === 'never' && plan.riskLevel !== 'low') {
      return pauseForEvidence('independent review disabled for a non-low-risk plan; worker was not started')
    }

    let actionResult: { status: 'completed' | 'failed'; summary: string; artifacts: string[] }
    const savedWork = await readOptionalText(workMarker)
    try {
      if (savedWork) {
        let value: unknown
        try { value = JSON.parse(savedWork) } catch { throw new Error(`invalid JSON in cached work result: ${workMarker}`) }
        actionResult = await validateWorkerResult(ctx.runDir, value)
      } else {
        await transition(ctx.state, 'work', `minimal-work-${cycle}`)
        const workDir = safeResolve(ctx.runDir, WORK_DIR, `cycle-${String(cycle).padStart(2, '0')}`)
        await ensureDir(workDir)
        actionResult = await validateWorkerResult(ctx.runDir, await runWorker(ctx, {
          workDir,
          planText: plan.plan,
          experimentDesign: plan.plan,
          minimalVerification: '',
        }))
        await writeText(workMarker, JSON.stringify(actionResult, null, 2))
        await recordResult(ctx.state, `minimal-work-${cycle}`, actionResult)
      }
    } catch (error) {
      if (isExperimentPauseError(error)) return pauseForEvidence(error.message)
      if (savedWork) return pauseForEvidence(error instanceof Error ? error.message : String(error))
      throw error
    }
    if (!(await resultRecorded(ctx.runDir, `minimal-work-${cycle}`))) {
      await recordResult(ctx.state, `minimal-work-${cycle}`, actionResult)
    }

    await reloadTree(ctx)
    const actions = ctx.tree.query({ kind: 'action' })
    const evidenceNodes = ctx.tree.query({ kind: 'evidence' })
    const validActions = actions.length > 0 && actions.every((action) => action.status === 'completed' && action.content.trim().length > 0)
    const localRisk = actionResult.status !== 'completed' ? 'high' : 'low'
    const risk = plan.riskLevel === 'high' || localRisk === 'high' ? 'high' : plan.riskLevel === 'medium' ? 'medium' : 'low'
    const evidence = `local evidence: ${actions.length} action node(s), ${evidenceNodes.length} recorded evidence node(s); worker status=${actionResult.status}; artifacts=valid; risk=${risk}`
    await transition(ctx.state, 'evidence', `minimal-evidence-${cycle}`)
    await writeText(safeResolve(ctx.runDir, `MINIMAL_EVIDENCE-${cycle}.md`), `# Minimal evidence\n\n${evidence}\n`)
    ctx.state.evidencePath = safeResolve(ctx.runDir, `MINIMAL_EVIDENCE-${cycle}.md`)
    if (!(await resultRecorded(ctx.runDir, `minimal-evidence-${cycle}`))) {
      await recordResult(ctx.state, `minimal-evidence-${cycle}`, { evidence, risk })
    }

    if (review === 'enabled' || (review === 'auto' && risk !== 'low')) {
      try {
        await runExperimentReflexion(ctx, {
          planText: plan.plan,
          minimalVerification: evidence,
          modelScout: '',
          initialDesign: plan.plan,
          maxRedesigns: 0,
        })
      } catch (error) {
        if (isExperimentPauseError(error)) return pauseForEvidence(`post-work review did not accept the executed protocol: ${error.message}`)
        throw error
      }
    } else if (review === 'never' && risk !== 'low') {
      return pauseForEvidence('independent review disabled while critical risk remains')
    }

    if (ctx.policySnapshot.workflow.modelScout === 'enabled' || (ctx.policySnapshot.workflow.modelScout === 'auto' && risk !== 'low')) {
      await runModelScout(ctx, { planText: plan.plan })
    }
    if (ctx.policySnapshot.workflow.postResultSynthesis === 'enabled' || (ctx.policySnapshot.workflow.postResultSynthesis === 'auto' && risk !== 'low')) {
      await runResultReflexion(ctx, { planText: plan.plan, experimentDesign: plan.plan })
    }
    if (localRisk === 'high') return pauseForEvidence()

    await transition(ctx.state, 'decide', `minimal-decide-${cycle}`)
    const decision = await runSupervisor(ctx, { planText: plan.plan, evidence })
    await writeDecision(ctx.runDir, `# Decision\n\n- action: ${decision.action}\n- reason: ${decision.reason}\n`)
    await recordDecision(ctx.state, `minimal-decide-${cycle}`, decision as unknown as Record<string, unknown>)
    if (decision.action === 'finish') {
      if (this.shouldRunPaper(ctx, idea)) {
        ctx.state.phase = 'paper'
        await saveState(ctx.runDir, ctx.state)
        await runPaper(ctx)
      }
      ctx.state.status = 'COMPLETED'
      await saveState(ctx.runDir, ctx.state)
      return ctx.state
    }
    if (decision.action === 'fail') {
      ctx.state.status = 'FAILED'
      ctx.state.phase = 'failed'
      ctx.state.lastError = decision.reason
      await saveState(ctx.runDir, ctx.state)
      await writeFailureReport(ctx.runDir, `# FAILURE_REPORT\n\n${decision.reason}\n`)
      return ctx.state
    }
    const maxCycles = this.deps.maxCycles ?? DEFAULT_MAX_CYCLES
    if (ctx.context.signal.aborted || ctx.state.status !== 'RUNNING') return ctx.state
    if (ctx.state.cycle >= maxCycles) {
      ctx.state.status = 'PAUSED'
      ctx.state.lastError = `max cycles reached (${maxCycles})`
      await saveState(ctx.runDir, ctx.state)
      await writeFailureReport(ctx.runDir, `# FAILURE_REPORT\n\n${ctx.state.lastError}.\n`)
      return ctx.state
    }
    ctx.state.cycle += 1
    ctx.state.planVersion += decision.action === 'revise' ? 1 : 0
    ctx.state.phase = decision.action === 'revise' ? 'plan' : 'work'
    await saveState(ctx.runDir, ctx.state)
    return this.runMinimal(ctx, idea, profile)
  }

  private async readProfile(runDir: string): Promise<string> {
    return (await readOptionalText(safeResolve(runDir, 'PROFILE.md'))) ?? ''
  }

  private async readPlanText(runDir: string, version: number): Promise<string> {
    return (await readOptionalText(planPath(runDir, version))) ?? ''
  }
}

async function resultRecorded(runDir: string, stepId: string): Promise<boolean> {
  const text = await readOptionalText(safeResolve(runDir, EVENTS_FILE))
  if (!text) return false
  return text.split(/\r?\n/).filter(Boolean).some((line) => {
    const event = JSON.parse(line) as { type?: unknown; stepId?: unknown }
    return event.type === 'result' && event.stepId === stepId
  })
}
