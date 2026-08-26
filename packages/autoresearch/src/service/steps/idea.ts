import { join } from 'node:path'
import { AutoResearchError, newId, readOptionalText, writeText } from '../../core/utils.js'
import { recordResult, transition } from '../../core/state.js'
import type { FalsifiabilityReport, IdeaDraft, IdeaPackage, SkepticReport, ValidationPlan } from '../../domain/idea.js'
import { freezeRubric, readRubric, rubricPath, writeRubric } from '../../domain/files.js'
import { blockingEvidence, lightHardGate, preGate, structuralCheck } from '../../domain/idea-gate.js'
import { runAgent, structuredText, treeSummary } from '../agent.js'
import type { RunContext } from '../context.js'
import type { ResearchRunnerOptions } from '../types.js'

export interface IdeaGenerationInput {
  idea: string
  profile: string
  failureDirections?: string
  insight?: string
  feedback?: string
}

export interface EnsureRubricInput {
  idea: string
  profile: string
  feedback?: string
}

interface IdeaReviewerRequest {
  pkg: IdeaPackage
  perspective: 'combined' | 'methodology' | 'statistics'
}

export async function ensureRubric(ctx: RunContext, { idea, profile, feedback }: EnsureRubricInput): Promise<void> {
  await transition(ctx.state, 'rubric', 'rubric-generate')
  const summary = treeSummary(ctx.tree)
  const previousRubric = (await readOptionalText(rubricPath(ctx.runDir))) ?? ''
  const generated = await runAgent(ctx, {
    role: 'rubric-generator',
    input: {
      runDir: ctx.runDir,
      idea,
      profile,
      treeSummary: summary,
      ...(feedback ? { plan: `Human review feedback:\n${feedback}\n\nCurrent rubric to revise:\n${previousRubric}` } : {}),
    },
    label: feedback ? 'revise rubric from human feedback' : 'generate rubric',
  })
  let rubricText = structuredText(generated.structured, 'rubric') ?? generated.text
  if (!feedback) {
    try {
      const onDisk = await readRubric(ctx.runDir)
      if (onDisk.trim().length > rubricText.trim().length + 100) {
        rubricText = onDisk
      }
    } catch {
      // no file on disk; keep structured text
    }
  }
  await writeRubric(ctx.runDir, rubricText)

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await transition(ctx.state, 'rubric', `rubric-review-${attempt}`)
    const review = await runAgent(ctx, {
      role: 'rubric-reviewer',
      input: {
        runDir: ctx.runDir,
        idea,
        profile,
        rubric: rubricText,
        treeSummary: summary,
      },
      label: `review rubric attempt ${attempt}`,
    })
    const reviewValue = review.structured as { ok?: boolean; revised?: string } | undefined
    const ok = reviewValue?.ok ?? false
    if (ok) {
      await freezeRubric(ctx.runDir)
      return
    }
    const revised = reviewValue?.revised
    if (revised && revised !== rubricText) {
      rubricText = revised
      await writeRubric(ctx.runDir, revised)
      continue
    }
    break
  }
  if (resolveResearchAssurance(ctx.deps.paperOptions) === 'submission') {
    throw new AutoResearchError('rubric review did not pass after three rounds', 'AGENT_FAILED')
  }
  ctx.logger.warn('rubric review did not pass after three rounds; continuing with warning')
  await writeText(join(ctx.runDir, 'RUBRIC_REVIEW_WARNING.md'), `# Rubric Review Warning\n\nRubric did not pass review after 3 rounds.\n\nFinal rubric:\n\n${rubricText}\n`)
  await freezeRubric(ctx.runDir)
}

export async function runIdeaGeneration(ctx: RunContext, { idea, profile, failureDirections, insight, feedback }: IdeaGenerationInput): Promise<void> {
  await transition(ctx.state, 'ideation', 'idea-generate')
  const result = await runAgent(ctx, {
    role: 'idea-generator',
    input: {
      runDir: ctx.runDir,
      idea,
      profile,
      treeSummary: treeSummary(ctx.tree),
      ...(failureDirections ? { failureDirections } : {}),
      ...(insight ? { insight } : {}),
      ...(feedback ? { plan: `Human review feedback on the previous idea generation:\n${feedback}` } : {}),
    },
    label: 'generate ideas',
  })
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
    const falsifiability = await runFalsifiability(ctx, pkg)
    const pre = preGate(structural, falsifiability)
    if (pre.verdict !== 'PASS') {
      rejections.push(`pre_gate ${pkg.idea_id}: ${pre.blocking_factor} - ${blockingEvidence(pre)}`)
      continue
    }

    const reviews = [await runIdeaReviewer(ctx, { pkg, perspective: 'combined' })]
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
    ctx.tree.add('hypothesis', pkg.statement, { status: 'proposed', artifacts: pkg.sources })
  }
  await ctx.tree.save()
  await recordResult(ctx.state, 'idea-generate', { generated: drafts.length, kept: kept.length, rejections })
  ctx.logger.info(`idea generation generated=${drafts.length} kept=${kept.length} rejections=${rejections.length}`)
}

async function runFalsifiability(ctx: RunContext, pkg: IdeaPackage): Promise<FalsifiabilityReport> {
  const result = await runAgent(ctx, {
    role: 'idea-falsifiability',
    input: {
      runDir: ctx.runDir,
      ideaPackage: JSON.stringify(pkg, null, 2),
    },
    label: `falsifiability ${pkg.idea_id}`,
  })
  const value = result.structured as { testable_implication?: string; unobservable_variables?: string[]; is_falsifiable?: boolean } | undefined
  return {
    idea_id: pkg.idea_id,
    testable_implication: value?.testable_implication ?? '',
    unobservable_variables: value?.unobservable_variables ?? [],
    is_falsifiable: value?.is_falsifiable ?? false,
  }
}

async function runIdeaReviewer(ctx: RunContext, { pkg, perspective }: IdeaReviewerRequest): Promise<SkepticReport> {
  const result = await runAgent(ctx, {
    role: 'idea-reviewer',
    input: {
      runDir: ctx.runDir,
      ideaPackage: JSON.stringify({ ...pkg, review_perspective: perspective }, null, 2),
    },
    label: `review ${pkg.idea_id} ${perspective}`,
  })
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

export async function runHypothesisRevision(ctx: RunContext): Promise<void> {
  await transition(ctx.state, 'hypothesis_revision', `hypothesis-revise-${ctx.state.cycle}`)
  const result = await runAgent(ctx, {
    role: 'hypothesis-reviser',
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      treeSummary: treeSummary(ctx.tree),
    },
    label: `revise hypotheses cycle ${ctx.state.cycle}`,
  })
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
    if (h.id && ctx.tree.query({ id: h.id }).length > 0) {
      ctx.tree.update(h.id, { status: h.status, content: h.statement, artifacts: h.sources })
    } else {
      ctx.tree.add('hypothesis', h.statement, {
        status: h.status,
        artifacts: h.sources,
      })
    }
  }
  await ctx.tree.save()
  await recordResult(ctx.state, `hypothesis-revise-${ctx.state.cycle}`, { revised: hypotheses.length })
  ctx.logger.info(`hypothesis revision updated=${hypotheses.length}`)
}

function resolveResearchAssurance(
  options: ResearchRunnerOptions['paperOptions'],
): 'draft' | 'submission' {
  const { assurance, effort } = options ?? {}
  if (assurance === 'draft' || assurance === 'submission') return assurance
  return effort === 'max' || effort === 'beast' ? 'submission' : 'draft'
}
