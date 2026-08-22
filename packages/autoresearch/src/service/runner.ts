import { join } from 'node:path'
import type { RoleAgentProvider, RoleExecutionContext, RoleInput, RoleName } from '../agents/types.js'
import { DEFAULT_MAX_CYCLES, WORK_DIR } from '../core/constants.js'
import { AutoResearchError } from '../core/utils.js'
import { HypothesisPool } from '../core/hypothesis-pool.js'
import { createLogger, type Logger } from '../core/logger.js'
import { ResearchTree } from '../core/research-tree.js'
import { saveState, writeDecision } from '../core/state.js'
import type { ActionResult, ResearchDecision, RunState } from '../core/types.js'
import { ensureDir, newId, readText, safeResolve, writeText } from '../core/utils.js'
import { readCandidate } from '../domain/candidate.js'
import { parseDecision } from '../domain/guards.js'
import { blockingEvidence, lightHardGate, preGate, structuralCheck } from '../domain/idea-gate.js'
import type { FalsifiabilityReport, IdeaDraft, IdeaPackage, SkepticReport, ValidationPlan } from '../domain/idea.js'
import { freezeRubric, readPlan, readRubric, writeFailureReport, writePlan, writeRubric } from '../domain/files.js'
import { exportEvidenceChain } from '../export/evidence-chain.js'
import { PaperPipeline, type PaperOptions } from '../paper/pipeline.js'
import { recordDecision, recordResult, transition, withRetry } from './utils.js'

export interface ResearchRunnerOptions {
  provider: RoleAgentProvider
  maxCycles?: number
  paperOptions?: PaperOptions
}

export class ResearchRunner {
  private readonly provider: RoleAgentProvider
  private readonly maxCycles: number
  private readonly paperOptions?: PaperOptions
  private logger: Logger = createLogger()

  constructor(options: ResearchRunnerOptions) {
    this.provider = options.provider
    this.maxCycles = options.maxCycles ?? DEFAULT_MAX_CYCLES
    this.paperOptions = options.paperOptions
  }

  private assurance(): 'draft' | 'submission' {
    const { assurance, effort } = this.paperOptions ?? {}
    if (assurance === 'draft' || assurance === 'submission') return assurance
    return effort === 'max' || effort === 'beast' ? 'submission' : 'draft'
  }

  async run(runDir: string, state: RunState, tree: ResearchTree, context: RoleExecutionContext): Promise<RunState> {
    this.logger = createLogger(runDir)
    this.logger.info(`run started runDir=${runDir} runId=${state.runId} status=${state.status} cycle=${state.cycle}`)
    const candidate = await readCandidate(runDir)
    const profile = await this.readProfile(runDir)
    this.logger.info(`intake done direction=${candidate.direction.slice(0, 80)}`)

    // Resume support: if the run was interrupted during the paper phase (e.g. a
    // transient failure after the final decision), continue straight to paper
    // generation instead of replaying the research cycle.
    if (state.phase === 'paper') {
      this.logger.info(`resuming at paper phase cycle=${state.cycle}`)
      await this.runPaper(runDir, state, tree, context)
      state.status = 'COMPLETED'
      state.phase = 'paper'
      await saveState(runDir, state)
      this.logger.info('run completed (resumed from paper phase)')
      return state
    }

    // Intake: create root hypothesis if missing.
    if (tree.query({ kind: 'hypothesis' }).length === 0) {
      tree.add('hypothesis', candidate.direction, { status: 'proposed' })
      await tree.save()
    }

    const pool = await HypothesisPool.load(runDir)

    // Idea generation first: expand/rewrite the candidate into falsifiable hypotheses.
    if (tree.query({ kind: 'hypothesis' }).length <= 1) {
      await this.runIdeaGeneration(runDir, state, tree, candidate.raw, profile, context)
    }
    pool.syncFromTree(tree, state.runId)
    await pool.save()

    // Rubric is generated after idea generation, so it can judge the expanded hypotheses.
    await this.ensureRubric(runDir, state, candidate.raw, profile, tree, context)

    while (state.status === 'RUNNING' && state.cycle <= this.maxCycles) {
      const cycle = state.cycle
      const planVersion = state.planVersion
      this.logger.info(`cycle ${cycle} start phase=${state.phase} planVersion=${planVersion}`)

      // Plan
      if (state.phase === 'plan' || state.phase === 'intake' || state.phase === 'decide') {
        await transition(state, 'plan', `plan-${cycle}`)
        const plan = await this.runPlanner(runDir, state, tree, candidate.raw, profile, context)
        const planFile = await writePlan(runDir, planVersion, plan)
        state.planVersion = planVersion
        await saveState(runDir, state)
        await recordResult(state, `plan-${cycle}`, { planFile })
        this.logger.info(`plan written ${planFile}`)
      }

      // Work
      await transition(state, 'work', `work-${cycle}`)
      const workDir = safeResolve(runDir, WORK_DIR, `cycle-${String(cycle).padStart(2, '0')}`)
      await ensureDir(workDir)
      const planText = await this.readPlanText(runDir, state.planVersion)
      const actionResult = await this.runWorker(runDir, state, tree, workDir, planText, context)
      await recordResult(state, `work-${cycle}`, actionResult as unknown as Record<string, unknown>)
      this.logger.info(`work done status=${actionResult.status} artifacts=${actionResult.artifacts.length}`)

      // Evidence
      await transition(state, 'evidence', `evidence-${cycle}`)
      await this.runEvidenceAgent(runDir, state, tree, workDir, planText, context)
      this.logger.info(`evidence done cycle=${cycle}`)

      // Reload the tree from disk: worker/evidence agents mutate it through tools.
      tree = await ResearchTree.load(runDir)

      // Sync hypothesis pool from evidence, then re-run idea generation to explore new hypotheses.
      pool.syncFromTree(tree, state.runId)
      await pool.save()
      await this.runIdeaGeneration(runDir, state, tree, candidate.raw, profile, context)
      pool.syncFromTree(tree, state.runId)
      await pool.save()
      tree = await ResearchTree.load(runDir)

      // Decide
      await transition(state, 'decide', `decide-${cycle}`)
      const decision = await this.runSupervisor(runDir, state, tree, planText, context)
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
        tree = await ResearchTree.load(runDir)
        await this.runPaper(runDir, state, tree, context)
        state.status = 'COMPLETED'
        state.phase = 'paper'
        await saveState(runDir, state)
        this.logger.info('run completed')
        return state
      }

      // fail
      this.logger.warn(`cycle ${cycle} -> fail: ${decision.reason}`)
      state.status = 'FAILED'
      state.phase = 'failed'
      await saveState(runDir, state)
      await writeFailureReport(runDir, `# FAILURE_REPORT\n\n${decision.reason}\n`)
      return state
    }

    // Max cycles reached without a terminal decision.
    state.status = 'FAILED'
    state.phase = 'failed'
    state.lastError = `max cycles reached (${this.maxCycles})`
    await saveState(runDir, state)
    await writeFailureReport(runDir, `# FAILURE_REPORT\n\nMax cycles reached: ${this.maxCycles}\n`)
    return state
  }

  private async ensureRubric(runDir: string, state: RunState, candidateRaw: string, profile: string, tree: ResearchTree, context: RoleExecutionContext): Promise<void> {
    await transition(state, 'rubric', 'rubric-generate')
    const treeSummary = this.treeSummary(tree)
    const generated = await this.runRole('rubric-generator', { runDir, candidate: candidateRaw, profile, treeSummary }, context, 'generate rubric')
    let rubricText = this.structuredText(generated.structured, 'rubric') ?? generated.text
    // The generator agent may have written RUBRIC.md itself and returned only a
    // summary in structured output. Prefer the on-disk document when it exists
    // and is materially richer than the structured text, so the reviewer always
    // sees the full pre-registration document.
    try {
      const onDisk = await readRubric(runDir)
      if (onDisk.trim().length > rubricText.trim().length + 100) {
        rubricText = onDisk
      }
    } catch {
      // no file on disk; keep structured text
    }
    await writeRubric(runDir, rubricText)

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await transition(state, 'rubric', `rubric-review-${attempt}`)
      const review = await this.runRole('rubric-reviewer', { runDir, candidate: candidateRaw, profile, rubric: rubricText, treeSummary }, context, `review rubric attempt ${attempt}`)
      const reviewValue = review.structured as { ok?: boolean; revised?: string } | undefined
      const ok = reviewValue?.ok ?? false
      if (ok) {
        await freezeRubric(runDir)
        return
      }
      const revised = reviewValue?.revised
      if (revised && revised !== rubricText) {
        rubricText = revised
        await writeRubric(runDir, revised)
        continue
      }
      break
    }
    if (this.assurance() === 'submission') {
      throw new AutoResearchError('rubric review did not pass after three rounds', 'AGENT_FAILED')
    }
    this.logger.warn('rubric review did not pass after three rounds; continuing with warning')
    await writeText(join(runDir, 'RUBRIC_REVIEW_WARNING.md'), `# Rubric Review Warning\n\nRubric did not pass review after 3 rounds.\n\nFinal rubric:\n\n${rubricText}\n`)
    await freezeRubric(runDir)
  }

  private async runIdeaGeneration(runDir: string, state: RunState, tree: ResearchTree, candidateRaw: string, profile: string, context: RoleExecutionContext): Promise<void> {
    await transition(state, 'ideation', 'idea-generate')
    const result = await this.runRole('idea-generator', {
      runDir,
      candidate: candidateRaw,
      profile,
      treeSummary: this.treeSummary(tree),
    }, context, 'generate ideas')
    const structured = result.structured as { hypotheses?: IdeaDraft[] } | undefined
    const drafts = structured?.hypotheses ?? []
    const rejections: string[] = []
    const kept: IdeaPackage[] = []

    for (const draft of drafts.slice(0, 5)) {
      const pkg: IdeaPackage = {
        ...draft,
        idea_id: newId('idea'),
        generation_strategy: 'candidate_grounded',
        lineage_op: 'generate',
      }
      const structural = structuralCheck(pkg)
      const falsifiability = await this.runFalsifiability(runDir, state, pkg, context)
      const pre = preGate(structural, falsifiability)
      if (pre.verdict !== 'PASS') {
        rejections.push(`pre_gate ${pkg.idea_id}: ${pre.blocking_factor} - ${blockingEvidence(pre)}`)
        continue
      }

      const reviews = [await this.runIdeaReviewer(runDir, state, pkg, 'combined', context)]
      const validation: ValidationPlan = {
        idea_id: pkg.idea_id,
        minimal_test: pkg.intervention,
        verifier: 'ablation_replication',
        decision_rule: 'compare metric before/after intervention',
      }
      const decision = lightHardGate(structural, falsifiability, reviews, validation)
      if (decision.verdict === 'PASS' || decision.verdict === 'EXPLORATORY') {
        kept.push(pkg)
      } else {
        rejections.push(`${decision.verdict} ${pkg.idea_id}: ${decision.blocking_factor} - ${blockingEvidence(decision)}`)
      }
    }

    for (const pkg of kept) {
      tree.add('hypothesis', pkg.statement, { status: 'proposed', artifacts: pkg.sources })
    }
    await tree.save()
    await recordResult(state, 'idea-generate', { generated: drafts.length, kept: kept.length, rejections })
    this.logger.info(`idea generation generated=${drafts.length} kept=${kept.length} rejections=${rejections.length}`)
  }

  private async runFalsifiability(runDir: string, state: RunState, pkg: IdeaPackage, context: RoleExecutionContext): Promise<FalsifiabilityReport> {
    const result = await this.runRole('idea-falsifiability', {
      runDir,
      ideaPackage: JSON.stringify(pkg, null, 2),
    }, context, `falsifiability ${pkg.idea_id}`)
    const value = result.structured as { testable_implication?: string; unobservable_variables?: string[]; is_falsifiable?: boolean } | undefined
    return {
      idea_id: pkg.idea_id,
      testable_implication: value?.testable_implication ?? '',
      unobservable_variables: value?.unobservable_variables ?? [],
      is_falsifiable: value?.is_falsifiable ?? false,
    }
  }

  private async runIdeaReviewer(runDir: string, state: RunState, pkg: IdeaPackage, perspective: 'combined' | 'methodology' | 'statistics', context: RoleExecutionContext): Promise<SkepticReport> {
    const result = await this.runRole('idea-reviewer', {
      runDir,
      ideaPackage: JSON.stringify({ ...pkg, review_perspective: perspective }, null, 2),
    }, context, `review ${pkg.idea_id} ${perspective}`)
    const value = result.structured as { perspective?: string; critique?: string; unaddressed_risks?: string[]; fatal_flaw_found?: boolean } | undefined
    return {
      idea_id: pkg.idea_id,
      perspective: value?.perspective ?? perspective,
      critique: value?.critique ?? '',
      unaddressed_risks: value?.unaddressed_risks ?? [],
      fatal_flaw_found: value?.fatal_flaw_found ?? false,
      failed: false,
    }
  }

  private async runHypothesisRevision(runDir: string, state: RunState, tree: ResearchTree, context: RoleExecutionContext): Promise<void> {
    await transition(state, 'hypothesis_revision', `hypothesis-revise-${state.cycle}`)
    const result = await this.runRole('hypothesis-reviser', {
      runDir,
      cycle: state.cycle,
      treeSummary: this.treeSummary(tree),
    }, context, `revise hypotheses cycle ${state.cycle}`)
    const structured = result.structured as {
      hypotheses?: Array<{
        id?: string
        statement: string
        intervention: string
        expected_effect: string
        status: string
        predicted_observations?: string[]
        disconfirming_observations?: string[]
        sources?: string[]
      }>
    } | undefined
    const hypotheses = structured?.hypotheses ?? []
    for (const h of hypotheses) {
      if (h.id && tree.query({ id: h.id }).length > 0) {
        tree.update(h.id, { status: h.status, content: h.statement, artifacts: h.sources })
      } else {
        tree.add('hypothesis', h.statement, {
          status: h.status,
          artifacts: h.sources,
        })
      }
    }
    await tree.save()
    await recordResult(state, `hypothesis-revise-${state.cycle}`, { revised: hypotheses.length })
    this.logger.info(`hypothesis revision updated=${hypotheses.length}`)
  }

  private async runPlanner(runDir: string, state: RunState, tree: ResearchTree, candidateRaw: string, profile: string, context: RoleExecutionContext): Promise<string> {
    const rubric = await readRubric(runDir)
    const result = await this.runRole('planner', {
      runDir,
      cycle: state.cycle,
      candidate: candidateRaw,
      profile,
      rubric,
      treeSummary: this.treeSummary(tree),
    }, context, `plan cycle ${state.cycle}`)
    return this.structuredText(result.structured, 'plan') ?? result.text
  }

  private async runWorker(runDir: string, state: RunState, tree: ResearchTree, workDir: string, planText: string, context: RoleExecutionContext): Promise<ActionResult> {
    const result = await this.runRole('research-worker', {
      runDir,
      cycle: state.cycle,
      plan: planText,
      treeSummary: this.treeSummary(tree),
    }, context, `work cycle ${state.cycle}`)
    const structured = result.structured as Partial<ActionResult> | undefined
    if (structured && (structured.status === 'completed' || structured.status === 'failed')) {
      return {
        status: structured.status,
        summary: structured.summary ?? result.text,
        artifacts: structured.artifacts ?? [],
      }
    }
    return { status: 'completed', summary: result.text, artifacts: [] }
  }

  private async runEvidenceAgent(runDir: string, state: RunState, tree: ResearchTree, workDir: string, planText: string, context: RoleExecutionContext): Promise<void> {
    const result = await this.runRole('evidence-agent', {
      runDir,
      cycle: state.cycle,
      plan: planText,
      treeSummary: this.treeSummary(tree),
    }, context, `evidence cycle ${state.cycle}`)
    await recordResult(state, `evidence-${state.cycle}`, { summary: result.text })
  }

  private async runSupervisor(runDir: string, state: RunState, tree: ResearchTree, planText: string, context: RoleExecutionContext): Promise<ResearchDecision> {
    const rubric = await readRubric(runDir)
    const result = await this.runRole('supervisor', {
      runDir,
      cycle: state.cycle,
      rubric,
      plan: planText,
      treeSummary: this.treeSummary(tree),
    }, context, `decide cycle ${state.cycle}`)
    if (result.structured === undefined) {
      throw new AutoResearchError('supervisor did not return structured decision', 'AGENT_FAILED')
    }
    return parseDecision(result.structured)
  }

  private async runPaper(runDir: string, state: RunState, tree: ResearchTree, context: RoleExecutionContext): Promise<void> {
    if (tree.query({ kind: 'evidence' }).length === 0) {
      await writeFailureReport(runDir, '# FAILURE_REPORT\n\nNo evidence recorded; cannot write a paper.\n')
      throw new AutoResearchError('no evidence recorded before paper generation', 'AGENT_FAILED')
    }
    const evidencePath = await exportEvidenceChain(runDir, state.runId, tree)
    state.evidencePath = evidencePath
    await saveState(runDir, state)

    const pipeline = new PaperPipeline(this.provider, this.paperOptions ?? {})
    const result = await pipeline.run(runDir, tree, evidencePath, context)
    this.logger.info(`paper pipeline done plan=${result.planFile} compileOk=${result.compileOk} audits=${Object.keys(result.audits).length}`)
  }

  private async runRole(role: RoleName, input: RoleInput, context: RoleExecutionContext, label: string) {
    this.logger.info(`[agent:${role}] start ${label}`)
    const started = Date.now()
    try {
      const result = await withRetry(() => this.provider.run(role, input, context), role)
      this.logger.info(`[agent:${role}] done ${label} in ${Date.now() - started}ms`)
      return result
    } catch (error) {
      this.logger.error(`[agent:${role}] failed ${label}`, error)
      throw error
    }
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

  private structuredText(structured: unknown, key: string): string | undefined {
    if (typeof structured !== 'object' || structured === null) return undefined
    const value = (structured as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : undefined
  }

  private treeSummary(tree: ResearchTree): string {
    return JSON.stringify(tree.toJSON(), null, 2)
  }
}
