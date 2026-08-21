import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { DEFAULT_MAX_CYCLES, WORK_DIR } from '../core/constants.js'
import { AutoResearchError } from '../core/errors.js'
import { ResearchTree } from '../core/research-tree.js'
import { saveState, writeDecision } from '../core/state.js'
import type { ActionResult, ResearchDecision, RunState } from '../core/types.js'
import { ensureDir, readText, safeResolve } from '../core/utils.js'
import { readCandidate } from '../domain/candidate.js'
import { parseDecision } from '../domain/decision.js'
import { writeFailureReport, writeFinalReport, writePaperDraft } from '../domain/paper.js'
import { readPlan, writePlan } from '../domain/plan.js'
import { freezeRubric, readRubric, writeRubric } from '../domain/rubric.js'
import { exportEvidenceChain } from '../export/evidence-chain.js'
import { withRetry } from './recovery.js'
import { recordDecision, recordResult, transition } from './lifecycle.js'

export interface ResearchRunnerOptions {
  provider: RoleAgentProvider
  maxCycles?: number
}

export class ResearchRunner {
  private readonly provider: RoleAgentProvider
  private readonly maxCycles: number

  constructor(options: ResearchRunnerOptions) {
    this.provider = options.provider
    this.maxCycles = options.maxCycles ?? DEFAULT_MAX_CYCLES
  }

  async run(runDir: string, state: RunState, tree: ResearchTree, context: RoleExecutionContext): Promise<RunState> {
    const candidate = await readCandidate(runDir)
    const profile = await this.readProfile(runDir)

    // Intake: create root hypothesis if missing.
    if (tree.query({ kind: 'hypothesis' }).length === 0) {
      tree.add('hypothesis', candidate.direction, { status: 'proposed' })
      await tree.save()
    }

    // Rubric is generated once and frozen.
    await this.ensureRubric(runDir, state, candidate.raw, profile, context)

    while (state.status === 'RUNNING' && state.cycle <= this.maxCycles) {
      const cycle = state.cycle
      const planVersion = state.planVersion

      // Plan
      if (state.phase === 'plan' || state.phase === 'intake' || state.phase === 'decide') {
        await transition(state, 'plan', `plan-${cycle}`)
        const plan = await this.runPlanner(runDir, state, tree, candidate.raw, profile, context)
        const planFile = await writePlan(runDir, planVersion, plan)
        state.planVersion = planVersion
        await saveState(runDir, state)
        await recordResult(state, `plan-${cycle}`, { planFile })
      }

      // Work
      await transition(state, 'work', `work-${cycle}`)
      const workDir = safeResolve(runDir, WORK_DIR, `cycle-${String(cycle).padStart(2, '0')}`)
      await ensureDir(workDir)
      const planText = await this.readPlanText(runDir, state.planVersion)
      const actionResult = await this.runWorker(runDir, state, tree, workDir, planText, context)
      await recordResult(state, `work-${cycle}`, actionResult as unknown as Record<string, unknown>)

      // Evidence
      await transition(state, 'evidence', `evidence-${cycle}`)
      await this.runEvidenceAgent(runDir, state, tree, workDir, planText, context)

      // Reload the tree from disk: worker/evidence agents mutate it through tools.
      tree = await ResearchTree.load(runDir)

      // Decide
      await transition(state, 'decide', `decide-${cycle}`)
      const decision = await this.runSupervisor(runDir, state, tree, planText, context)
      await writeDecision(runDir, `# Decision\n\n- action: ${decision.action}\n- reason: ${decision.reason}\n`)
      await recordDecision(state, `decide-${cycle}`, decision as unknown as Record<string, unknown>)

      if (decision.action === 'continue') {
        state.cycle += 1
        state.phase = 'work'
        await saveState(runDir, state)
        continue
      }

      if (decision.action === 'revise') {
        state.planVersion += 1
        state.cycle += 1
        state.phase = 'plan'
        await saveState(runDir, state)
        continue
      }

      if (decision.action === 'finish') {
        state.status = 'RUNNING'
        state.phase = 'paper'
        await saveState(runDir, state)
        tree = await ResearchTree.load(runDir)
        await this.runPaper(runDir, state, tree, context)
        state.status = 'COMPLETED'
        state.phase = 'paper'
        await saveState(runDir, state)
        return state
      }

      // fail
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

  private async ensureRubric(runDir: string, state: RunState, candidateRaw: string, profile: string, context: RoleExecutionContext): Promise<void> {
    await transition(state, 'rubric', 'rubric-generate')
    const generated = await withRetry(
      () => this.provider.run('rubric-generator', { runDir, candidate: candidateRaw, profile }, context),
      'rubric-generator',
    )
    let rubricText = this.structuredText(generated.structured, 'rubric') ?? generated.text
    await writeRubric(runDir, rubricText)

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await transition(state, 'rubric', `rubric-review-${attempt}`)
      const review = await withRetry(
        () => this.provider.run('rubric-reviewer', { runDir, candidate: candidateRaw, profile, rubric: rubricText }, context),
        'rubric-reviewer',
      )
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
    throw new AutoResearchError('rubric review did not pass after two rounds', 'AGENT_FAILED')
  }

  private async runPlanner(runDir: string, state: RunState, tree: ResearchTree, candidateRaw: string, profile: string, context: RoleExecutionContext): Promise<string> {
    const rubric = await readRubric(runDir)
    const result = await withRetry(
      () => this.provider.run('planner', {
        runDir,
        cycle: state.cycle,
        candidate: candidateRaw,
        profile,
        rubric,
        treeSummary: this.treeSummary(tree),
      }, context),
      'planner',
    )
    return this.structuredText(result.structured, 'plan') ?? result.text
  }

  private async runWorker(runDir: string, state: RunState, tree: ResearchTree, workDir: string, planText: string, context: RoleExecutionContext): Promise<ActionResult> {
    const result = await withRetry(
      () => this.provider.run('research-worker', {
        runDir,
        cycle: state.cycle,
        plan: planText,
        treeSummary: this.treeSummary(tree),
      }, context),
      'research-worker',
    )
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
    const result = await withRetry(
      () => this.provider.run('evidence-agent', {
        runDir,
        cycle: state.cycle,
        plan: planText,
        treeSummary: this.treeSummary(tree),
      }, context),
      'evidence-agent',
    )
    await recordResult(state, `evidence-${state.cycle}`, { summary: result.text })
  }

  private async runSupervisor(runDir: string, state: RunState, tree: ResearchTree, planText: string, context: RoleExecutionContext): Promise<ResearchDecision> {
    const rubric = await readRubric(runDir)
    const result = await withRetry(
      () => this.provider.run('supervisor', {
        runDir,
        cycle: state.cycle,
        rubric,
        plan: planText,
        treeSummary: this.treeSummary(tree),
      }, context),
      'supervisor',
    )
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
    const result = await withRetry(
      () => this.provider.run('writer', { runDir, evidenceChainPath: evidencePath, treeSummary: this.treeSummary(tree) }, context),
      'writer',
    )
    const content = result.text
    await writePaperDraft(runDir, content)
    await writeFinalReport(runDir, `# FINAL_REPORT\n\n${content}\n`)
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
