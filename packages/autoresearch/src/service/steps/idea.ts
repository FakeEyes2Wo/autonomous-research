import { join } from 'node:path'
import { AutoResearchError, newId, writeText, type Logger } from '../../core/utils.js'
import { recordResult, transition } from '../../core/state.js'
import type { FalsifiabilityReport, IdeaDraft, IdeaPackage, SkepticReport, ValidationPlan } from '../../domain/idea.js'
import { freezeRubric, readRubric, writeRubric } from '../../domain/files.js'
import { blockingEvidence, lightHardGate, preGate, structuralCheck } from '../../domain/idea-gate.js'
import type { RoleRunner } from '../agent-runner.js'
import type { RunSession } from '../run-session.js'
import type { ResearchRunnerOptions } from '../types.js'

export interface IdeaGenerationRequest {
  session: RunSession
  idea: string
  profile: string
  failureDirections?: string
  insight?: string
  feedback?: string
}

interface EnsureRubricRequest {
  session: RunSession
  idea: string
  profile: string
  feedback?: string
}

interface IdeaReviewerRequest {
  session: RunSession
  pkg: IdeaPackage
  perspective: 'combined' | 'methodology' | 'statistics'
}

export class IdeaSteps {
  constructor(
    private readonly roleRunner: RoleRunner,
    private readonly logger: Logger,
    private readonly options: ResearchRunnerOptions,
  ) {}

  private assurance(): 'draft' | 'submission' {
    const { assurance, effort } = this.options.paperOptions ?? {}
    if (assurance === 'draft' || assurance === 'submission') return assurance
    return effort === 'max' || effort === 'beast' ? 'submission' : 'draft'
  }

  async ensureRubric({ session, idea, profile, feedback }: EnsureRubricRequest): Promise<void> {
    await transition(session.state, 'rubric', 'rubric-generate')
    const treeSummary = this.roleRunner.treeSummary(session.tree)
    const previousRubric = await readRubric(session.runDir).catch(() => '')
    const generated = await this.roleRunner.run('rubric-generator', {
      runDir: session.runDir,
      idea,
      profile,
      treeSummary,
      ...(feedback ? { plan: `Human review feedback:\n${feedback}\n\nCurrent rubric to revise:\n${previousRubric}` } : {}),
    }, session.context, feedback ? 'revise rubric from human feedback' : 'generate rubric')
    let rubricText = this.roleRunner.structuredText(generated.structured, 'rubric') ?? generated.text
    if (!feedback) {
      try {
        const onDisk = await readRubric(session.runDir)
        if (onDisk.trim().length > rubricText.trim().length + 100) {
          rubricText = onDisk
        }
      } catch {
        // no file on disk; keep structured text
      }
    }
    await writeRubric(session.runDir, rubricText)

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await transition(session.state, 'rubric', `rubric-review-${attempt}`)
      const review = await this.roleRunner.run('rubric-reviewer', {
        runDir: session.runDir,
        idea,
        profile,
        rubric: rubricText,
        treeSummary,
      }, session.context, `review rubric attempt ${attempt}`)
      const reviewValue = review.structured as { ok?: boolean; revised?: string } | undefined
      const ok = reviewValue?.ok ?? false
      if (ok) {
        await freezeRubric(session.runDir)
        return
      }
      const revised = reviewValue?.revised
      if (revised && revised !== rubricText) {
        rubricText = revised
        await writeRubric(session.runDir, revised)
        continue
      }
      break
    }
    if (this.assurance() === 'submission') {
      throw new AutoResearchError('rubric review did not pass after three rounds', 'AGENT_FAILED')
    }
    this.logger.warn('rubric review did not pass after three rounds; continuing with warning')
    await writeText(join(session.runDir, 'RUBRIC_REVIEW_WARNING.md'), `# Rubric Review Warning\n\nRubric did not pass review after 3 rounds.\n\nFinal rubric:\n\n${rubricText}\n`)
    await freezeRubric(session.runDir)
  }

  async runIdeaGeneration({ session, idea, profile, failureDirections, insight, feedback }: IdeaGenerationRequest): Promise<void> {
    await transition(session.state, 'ideation', 'idea-generate')
    const result = await this.roleRunner.run('idea-generator', {
      runDir: session.runDir,
      idea,
      profile,
      treeSummary: this.roleRunner.treeSummary(session.tree),
      ...(failureDirections ? { failureDirections } : {}),
      ...(insight ? { insight } : {}),
      ...(feedback ? { plan: `Human review feedback on the previous idea generation:\n${feedback}` } : {}),
    }, session.context, 'generate ideas')
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
      const falsifiability = await this.runFalsifiability({ session, pkg })
      const pre = preGate(structural, falsifiability)
      if (pre.verdict !== 'PASS') {
        rejections.push(`pre_gate ${pkg.idea_id}: ${pre.blocking_factor} - ${blockingEvidence(pre)}`)
        continue
      }

      const reviews = [await this.runIdeaReviewer({ session, pkg, perspective: 'combined' })]
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
      session.tree.add('hypothesis', pkg.statement, { status: 'proposed', artifacts: pkg.sources })
    }
    await session.tree.save()
    await recordResult(session.state, 'idea-generate', { generated: drafts.length, kept: kept.length, rejections })
    this.logger.info(`idea generation generated=${drafts.length} kept=${kept.length} rejections=${rejections.length}`)
  }

  private async runFalsifiability({ session, pkg }: { session: RunSession; pkg: IdeaPackage }): Promise<FalsifiabilityReport> {
    const result = await this.roleRunner.run('idea-falsifiability', {
      runDir: session.runDir,
      ideaPackage: JSON.stringify(pkg, null, 2),
    }, session.context, `falsifiability ${pkg.idea_id}`)
    const value = result.structured as { testable_implication?: string; unobservable_variables?: string[]; is_falsifiable?: boolean } | undefined
    return {
      idea_id: pkg.idea_id,
      testable_implication: value?.testable_implication ?? '',
      unobservable_variables: value?.unobservable_variables ?? [],
      is_falsifiable: value?.is_falsifiable ?? false,
    }
  }

  private async runIdeaReviewer({ session, pkg, perspective }: IdeaReviewerRequest): Promise<SkepticReport> {
    const result = await this.roleRunner.run('idea-reviewer', {
      runDir: session.runDir,
      ideaPackage: JSON.stringify({ ...pkg, review_perspective: perspective }, null, 2),
    }, session.context, `review ${pkg.idea_id} ${perspective}`)
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

  async runHypothesisRevision(session: RunSession): Promise<void> {
    await transition(session.state, 'hypothesis_revision', `hypothesis-revise-${session.state.cycle}`)
    const result = await this.roleRunner.run('hypothesis-reviser', {
      runDir: session.runDir,
      cycle: session.state.cycle,
      treeSummary: this.roleRunner.treeSummary(session.tree),
    }, session.context, `revise hypotheses cycle ${session.state.cycle}`)
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
      if (h.id && session.tree.query({ id: h.id }).length > 0) {
        session.tree.update(h.id, { status: h.status, content: h.statement, artifacts: h.sources })
      } else {
        session.tree.add('hypothesis', h.statement, {
          status: h.status,
          artifacts: h.sources,
        })
      }
    }
    await session.tree.save()
    await recordResult(session.state, `hypothesis-revise-${session.state.cycle}`, { revised: hypotheses.length })
    this.logger.info(`hypothesis revision updated=${hypotheses.length}`)
  }
}
