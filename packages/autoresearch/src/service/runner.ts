import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RoleExecutionContext } from '../agents/types.js'
import { AutoResearchError, DEFAULT_MAX_CYCLES, IDEA_FILE, INPUT_DIR, WORK_DIR } from '../core/utils.js'
import { HypothesisPool } from '../core/hypothesis-pool.js'
import { ResearchTree } from '../core/research-tree.js'
import { recordDecision, recordResult, saveState, transition, writeDecision } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { createLogger, ensureDir, readText, safeResolve, writeText, type Logger } from '../core/utils.js'
import { appendHumanReview, DEFAULT_REVIEW_GATES, type HumanReviewAnswer, type ReviewGateId } from '../core/human-review.js'
import { humanReviewEnabled } from '../session/auto-mode.js'
import { freezeRubric, readCandidate, readPlan, readRubric, writeFailureReport, writePlan, writeRubric } from '../domain/files.js'
import { BrainstormPipeline } from '../brainstorm/pipeline.js'
import { RoleRunner } from './agent-runner.js'
import { createRunContext } from './context.js'
import { ResearchSteps } from './research-steps.js'
import { reloadSessionTree, type RunSession } from './run-session.js'
import type { ResearchRunnerOptions } from './types.js'

export type { ResearchRunnerOptions } from './types.js'
export type { StageRequest } from './agent-runner.js'
export type { IdeaGenerationRequest } from './research-steps.js'

export interface ReviewGateRequest {
  session: RunSession
  gate: ReviewGateId
  title: string
  detail: string
}

export class ResearchRunner {
  private readonly options: ResearchRunnerOptions
  private roleRunner: RoleRunner
  private steps: ResearchSteps
  private logger: Logger

  constructor(options: ResearchRunnerOptions) {
    this.options = options
    this.logger = createLogger()
    this.roleRunner = new RoleRunner(options.provider, this.logger)
    this.steps = new ResearchSteps(this.roleRunner, this.logger, options)
  }

  private shouldBrainstorm(runDir: string): boolean {
    if (this.options.brainstorm === 'off') return false
    if (this.options.brainstorm === 'on') return true
    return !existsSync(safeResolve(runDir, INPUT_DIR, IDEA_FILE))
  }

  async run(runDir: string, state: RunState, tree: ResearchTree, context: RoleExecutionContext): Promise<RunState> {
    const session: RunSession = createRunContext(this.options, runDir, state, tree, context)
    this.logger = session.logger
    this.roleRunner = new RoleRunner(this.options.provider, this.logger)
    this.steps = new ResearchSteps(this.roleRunner, this.logger, this.options)
    this.logger.info(`run started runDir=${runDir} runId=${state.runId} status=${state.status} cycle=${state.cycle}`)

    if (this.shouldBrainstorm(runDir)) {
      await transition(state, 'brainstorm', 'brainstorm-pipeline')
      const ideaFile = await new BrainstormPipeline(this.options.provider, {
        idea: this.options.idea,
        reviewer: this.options.reviewer,
        humanReviewOverride: this.options.humanReviewOverride,
      }).run(runDir, context)
      this.logger.info(`brainstorm done idea=${ideaFile}`)
    }

    const candidate = await readCandidate(runDir)
    const profile = await this.readProfile(runDir)
    this.logger.info(`intake done direction=${candidate.direction.slice(0, 80)}`)

    if (state.phase === 'paper') {
      this.logger.info(`resuming at paper phase cycle=${state.cycle}`)
      await this.steps.runPaper(session)
      state.status = 'COMPLETED'
      state.phase = 'paper'
      await saveState(runDir, state)
      this.logger.info('run completed (resumed from paper phase)')
      return state
    }

    if (tree.query({ kind: 'hypothesis' }).length === 0) {
      tree.add('hypothesis', candidate.direction, { status: 'proposed' })
      await tree.save()
    }

    const pool = await HypothesisPool.load(runDir)

    if (tree.query({ kind: 'hypothesis' }).length <= 1) {
      await this.steps.runIdeaGeneration({ session, idea: candidate.raw, profile })
    }
    pool.syncFromTree(session.tree, state.runId)
    await pool.save()
    await reloadSessionTree(session)

    const ideaVerdict = await this.reviewGate({ session, gate: 'idea', title: 'Ideas are ready to proceed?', detail: this.roleRunner.treeSummary(session.tree) })
    if (ideaVerdict.verdict === 'reject') {
      return this.failRun({ session, reason: `human rejected ideas: ${ideaVerdict.feedback ?? 'no feedback'}` })
    }
    if (ideaVerdict.verdict === 'revise') {
      this.logger.info('human requested idea revision; re-running idea generation')
      await this.steps.runIdeaGeneration({ session, idea: candidate.raw, profile, feedback: ideaVerdict.feedback })
      pool.syncFromTree(session.tree, state.runId)
      await pool.save()
      await reloadSessionTree(session)
    }

    await this.steps.ensureRubric({ session, idea: candidate.raw, profile })
    const rubricVerdict = await this.reviewGate({ session, gate: 'rubric', title: 'Rubric is ready to freeze?', detail: await readRubric(runDir) })
    if (rubricVerdict.verdict === 'reject') {
      return this.failRun({ session, reason: `human rejected rubric: ${rubricVerdict.feedback ?? 'no feedback'}` })
    }
    if (rubricVerdict.verdict === 'revise') {
      this.logger.info('human requested rubric revision; re-running rubric generation')
      await this.steps.ensureRubric({ session, idea: candidate.raw, profile, feedback: rubricVerdict.feedback })
    }

    while (state.status === 'RUNNING' && state.cycle <= (this.options.maxCycles ?? DEFAULT_MAX_CYCLES)) {
      const cycle = state.cycle
      const planVersion = state.planVersion
      this.logger.info(`cycle ${cycle} start phase=${state.phase} planVersion=${planVersion}`)

      if (state.phase === 'plan' || state.phase === 'intake' || state.phase === 'decide') {
        await transition(state, 'plan', `plan-${cycle}`)
        const plan = await this.steps.runPlanner({ session, idea: candidate.raw, profile })
        const planFile = await writePlan(runDir, planVersion, plan)
        state.planVersion = planVersion
        await saveState(runDir, state)
        await recordResult(state, `plan-${cycle}`, { planFile })
        this.logger.info(`plan written ${planFile}`)
      }

      const planText = await this.readPlanText(runDir, state.planVersion)
      const minimalVerification = await this.steps.runMinimalVerification({ session, planText })
      const modelScout = await this.steps.runModelScout({ session, planText })
      let experimentDesign = await this.steps.runExperimentDesign({ session, planText, minimalVerification, modelScout })
      await this.steps.runExperimentReflexion({ session, planText, minimalVerification, modelScout, initialDesign: experimentDesign })

      let experimentVerdict = await this.reviewGate({ session, gate: 'experiment', title: 'Experiment design is ready to execute?', detail: experimentDesign })
      if (experimentVerdict.verdict === 'reject') {
        return this.failRun({ session, reason: `human rejected experiment design: ${experimentVerdict.feedback ?? 'no feedback'}` })
      }
      if (experimentVerdict.verdict === 'revise') {
        this.logger.info('human requested experiment design revision; re-running design')
        experimentDesign = await this.steps.runExperimentDesign({ session, planText, minimalVerification, modelScout, feedback: experimentVerdict.feedback })
        await this.steps.runExperimentReflexion({ session, planText, minimalVerification, modelScout, initialDesign: experimentDesign })
        experimentVerdict = await this.reviewGate({ session, gate: 'experiment', title: 'Revised experiment design is ready?', detail: experimentDesign })
        if (experimentVerdict.verdict === 'reject') {
          return this.failRun({ session, reason: `human rejected revised experiment design: ${experimentVerdict.feedback ?? 'no feedback'}` })
        }
      }

      await transition(state, 'work', `work-${cycle}`)
      const workDir = safeResolve(runDir, WORK_DIR, `cycle-${String(cycle).padStart(2, '0')}`)
      await ensureDir(workDir)
      const actionResult = await this.steps.runWorker({ session, workDir, planText, experimentDesign, minimalVerification })
      await recordResult(state, `work-${cycle}`, actionResult as unknown as Record<string, unknown>)
      this.logger.info(`work done status=${actionResult.status} artifacts=${actionResult.artifacts.length}`)

      await transition(state, 'evidence', `evidence-${cycle}`)
      await this.steps.runEvidenceAgent({ session, planText })
      this.logger.info(`evidence done cycle=${cycle}`)

      await reloadSessionTree(session)

      pool.syncFromTree(session.tree, state.runId)
      await pool.save()
      const failureDirections = await this.steps.runResultReflexion({ session, planText, experimentDesign })
      const insight = await this.steps.runInsightAbstractor({ session, planText, experimentDesign, failureDirections })

      await this.steps.runIdeaGeneration({ session, idea: candidate.raw, profile, failureDirections, insight })
      pool.syncFromTree(session.tree, state.runId)
      await pool.save()
      await reloadSessionTree(session)

      const evidenceVerdict = await this.reviewGate({ session, gate: 'evidence', title: 'Evidence supports a decision?', detail: [
        `## Result reflexion\n\n${failureDirections}`,
        `## Insight\n\n${insight}`,
        `## Tree\n\n${this.roleRunner.treeSummary(session.tree)}`,
      ].join('\n\n') })
      if (evidenceVerdict.verdict === 'reject') {
        return this.failRun({ session, reason: `human rejected evidence: ${evidenceVerdict.feedback ?? 'no feedback'}` })
      }
      if (evidenceVerdict.verdict === 'revise') {
        this.logger.info('human requested plan revision after evidence review; starting next cycle with feedback')
        state.planVersion += 1
        state.cycle += 1
        state.phase = 'plan'
        await saveState(runDir, state)
        await writeText(join(runDir, 'PLAN_FEEDBACK.md'), `# Plan feedback from human review\n\n${evidenceVerdict.feedback ?? ''}\n`)
        continue
      }

      await transition(state, 'decide', `decide-${cycle}`)
      const decision = await this.steps.runSupervisor({ session, planText })
      await writeDecision(runDir, `# Decision\n\n- action: ${decision.action}\n- reason: ${decision.reason}\n`)
      await recordDecision(state, `decide-${cycle}`, decision as unknown as Record<string, unknown>)
      this.logger.info(`decision ${decision.action}: ${decision.reason}`)

      if (decision.action === 'continue') {
        this.logger.info(`cycle ${cycle} -> continue to cycle ${cycle + 1}`)
        state.cycle += 1
        state.phase = 'work'
        await saveState(runDir, state)
        continue
      }

      if (decision.action === 'revise') {
        this.logger.info(`cycle ${cycle} -> revise to plan v${state.planVersion + 1}`)
        state.planVersion += 1
        state.cycle += 1
        state.phase = 'plan'
        await saveState(runDir, state)
        continue
      }

      if (decision.action === 'finish') {
        this.logger.info(`cycle ${cycle} -> finish, entering paper phase`)
        state.status = 'RUNNING'
        state.phase = 'paper'
        await saveState(runDir, state)
        await reloadSessionTree(session)
        await this.steps.runPaper(session)
        state.status = 'COMPLETED'
        state.phase = 'paper'
        await saveState(runDir, state)
        this.logger.info('run completed')
        return state
      }

      this.logger.warn(`cycle ${cycle} -> fail: ${decision.reason}`)
      state.status = 'FAILED'
      state.phase = 'failed'
      await saveState(runDir, state)
      await writeFailureReport(runDir, `# FAILURE_REPORT\n\n${decision.reason}\n`)
      return state
    }

    state.status = 'FAILED'
    state.phase = 'failed'
    state.lastError = `max cycles reached (${this.options.maxCycles ?? DEFAULT_MAX_CYCLES})`
    await saveState(runDir, state)
    await writeFailureReport(runDir, `# FAILURE_REPORT\n\nMax cycles reached: ${this.options.maxCycles ?? DEFAULT_MAX_CYCLES}\n`)
    return state
  }

  private async reviewGate({ session, gate, title, detail }: ReviewGateRequest): Promise<HumanReviewAnswer> {
    const runDir = session.runDir
    const skipped: HumanReviewAnswer = { verdict: 'approve' }
    const skip = async (reason: string) => {
      this.logger.warn(`human review gate ${gate} skipped: ${reason}`)
      await appendHumanReview(runDir, { time: new Date().toISOString(), gate, verdict: 'skipped', feedback: reason })
      return skipped
    }
    if (!(this.options.reviewGates ?? DEFAULT_REVIEW_GATES).includes(gate)) return skip('gate disabled')
    if (!(await humanReviewEnabled(this.options.humanReviewOverride))) return skip('auto mode')
    if (!this.options.reviewer) return skip('no reviewer available')
    try {
      const answer = await this.options.reviewer.ask({ gate, title, detail }, session.context.signal, session.context.parent)
      await appendHumanReview(runDir, { time: new Date().toISOString(), gate, verdict: answer.verdict, feedback: answer.feedback })
      return answer
    } catch (error) {
      return skip(`ask failed: ${String(error)}`)
    }
  }

  private async failRun({ session, reason }: { session: RunSession; reason: string }): Promise<RunState> {
    this.logger.warn(`run failed by human review: ${reason}`)
    session.state.status = 'FAILED'
    session.state.phase = 'failed'
    session.state.lastError = reason
    await saveState(session.runDir, session.state)
    await writeFailureReport(session.runDir, `# FAILURE_REPORT\n\n${reason}\n`)
    return session.state
  }

  private async readProfile(runDir: string): Promise<string> {
    try {
      const file = safeResolve(runDir, 'PROFILE.md')
      return await readText(file)
    } catch {
      return ''
    }
  }

  private async readPlanText(runDir: string, version: number): Promise<string> {
    try {
      return await readPlan(runDir, version)
    } catch {
      return ''
    }
  }
}
