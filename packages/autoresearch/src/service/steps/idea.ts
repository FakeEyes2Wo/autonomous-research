import { newId, readOptionalText } from '../../core/utils.js'
import { recordResult, transition } from '../../core/state.js'
import type { FalsifiabilityReport, IdeaDraft, IdeaPackage, SkepticReport, ValidationPlan } from '../../domain/idea.js'
import { freezeRubric, rubricPath, writeRubric } from '../../domain/files.js'
import { writeFailureReflexion } from '../../core/failure-reflexion.js'
import { blockingEvidence, lightHardGate, preGate, structuralCheck } from '../../domain/idea-gate.js'
import { runAgent, structuredText, treeSummary } from '../agent.js'
import { runReflexion } from '../agent-loop.js'
import type { RunContext } from '../context.js'

export interface IdeaGenerationInput {
  idea: string
  profile: string
  relatedPapers?: string
  baselines?: string
  failureDirections?: string
  insight?: string
  feedback?: string
}

export interface EnsureRubricInput {
  idea: string
  profile: string
  feedback?: string
}

export async function ensureRubric(ctx: RunContext, { idea, profile, feedback }: EnsureRubricInput): Promise<void> {
  await transition(ctx.state, 'rubric', 'rubric-generate')
  const summary = treeSummary(ctx.tree)
  const previousRubric = (await readOptionalText(rubricPath(ctx.runDir))) ?? ''

  await runReflexion<string>(
    (role, input, label) => runAgent(ctx, { role, input, label }),
    'rubric-generator',
    {
      reflexion: (rubric, round) =>
        `Self-reflexion round ${round}: review the current rubric below. Identify weaknesses and rewrite an improved rubric.\n\nCurrent rubric:\n${rubric}`,
      buildInput: (current, _round, reflexion) => ({
        runDir: ctx.runDir,
        idea,
        profile,
        treeSummary: summary,
        ...(current ? { plan: reflexion } : {}),
        ...(!current && feedback ? { plan: `Human review feedback:\n${feedback}\n\nCurrent rubric to revise:\n${previousRubric}` } : {}),
      }),
      parse: (result) => structuredText(result.structured, 'rubric') ?? result.text,
      apply: async (rubric, round) => {
        await writeRubric(ctx.runDir, rubric)
        if (round > 0) await transition(ctx.state, 'rubric', `rubric-self-reflexion-${round}`)
      },
      onAbnormalExit: async (info) => {
        await writeFailureReflexion(ctx.runDir, {
          role: info.role,
          stage: 'rubric',
          round: info.round,
          stopReason: info.stopReason,
          error: info.error instanceof Error ? info.error.message : info.error === undefined ? undefined : String(info.error),
          context: { runDir: ctx.runDir, idea, profile },
          result: info.result,
        })
      },
      rounds: ctx.policySnapshot.workflow.reflexionRounds,
    },
  )

  await freezeRubric(ctx.runDir)
}

export async function runIdeaGeneration(ctx: RunContext, { idea, profile, relatedPapers, baselines, failureDirections, insight, feedback }: IdeaGenerationInput): Promise<void> {
  await transition(ctx.state, 'ideation', 'idea-generate')
  const result = await runAgent(ctx, {
    role: 'idea-generator',
    input: {
      runDir: ctx.runDir,
      idea,
      profile,
      treeSummary: treeSummary(ctx.tree),
      ...(relatedPapers ? { relatedPapers } : {}),
      ...(baselines ? { baselines } : {}),
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

  const candidateLimit = Math.max(1, Math.floor(ctx.policySnapshot.workflow.candidateLimit))
  for (const draft of drafts.slice(0, candidateLimit)) {
    let pkg: IdeaPackage = {
      ...draft,
      idea_id: newId('idea'),
      generation_strategy: 'candidate_grounded',
      lineage_op: 'generate',
    }
    const reflex = await runIdeaReflexion(ctx, pkg)
    pkg = reflex.pkg
    const structural = structuralCheck(pkg)
    const pre = preGate(structural, reflex.falsifiability)
    if (pre.verdict !== 'PASS') {
      rejections.push(`pre_gate ${pkg.idea_id}: ${pre.blocking_factor} - ${blockingEvidence(pre)}`)
      continue
    }

    const validation: ValidationPlan = {
      idea_id: pkg.idea_id,
      minimal_test: pkg.intervention,
      verifier: 'ablation_replication',
      decision_rule: 'compare metric before/after intervention',
    }
    const decision = lightHardGate(structural, reflex.falsifiability, [reflex.review], validation)
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

function validateIdeaPackage(pkg: IdeaPackage): string[] {
  const missing: string[] = []
  if (!pkg.statement?.trim()) missing.push('statement')
  if (!pkg.intervention?.trim()) missing.push('intervention')
  if (!pkg.expected_effect?.trim()) missing.push('expected_effect')
  if (!Array.isArray(pkg.supported_premises)) missing.push('supported_premises')
  if (!Array.isArray(pkg.predicted_observations)) missing.push('predicted_observations')
  if (!Array.isArray(pkg.disconfirming_observations)) missing.push('disconfirming_observations')
  if (!Array.isArray(pkg.sources)) missing.push('sources')
  return missing
}

function validateIdeaReflexionState(state: IdeaReflexionState): string[] {
  return validateIdeaPackage(state.pkg)
}

interface IdeaReflexionState {
  pkg: IdeaPackage
  falsifiability: FalsifiabilityReport
  review: SkepticReport
}

async function runIdeaReflexion(ctx: RunContext, pkg: IdeaPackage): Promise<IdeaReflexionState> {
  let currentPkg = pkg
  const call = (role: Parameters<typeof runAgent>[1]['role'], input: Parameters<typeof runAgent>[1]['input'], label: string) => runAgent(ctx, { role, input, label })

  return runReflexion<IdeaReflexionState>(call, 'idea-reflexion', {
    reflexion: (state, round) =>
      `Self-reflexion round ${round}: check falsifiability, unobservable variables, risks, and fatal flaws. Return an improved hypothesis if needed.\n\nCurrent hypothesis:\n${JSON.stringify(state.pkg, null, 2)}`,
    buildInput: (current, _round, reflexion) => ({
      runDir: ctx.runDir,
      ideaPackage: JSON.stringify(current?.pkg ?? pkg, null, 2),
      ...(current ? { plan: reflexion, revisedIdeaPackage: JSON.stringify(current.pkg, null, 2) } : {}),
    }),
    parse: (result) => {
      const value = result.structured as {
        is_falsifiable?: boolean
        testable_implication?: string
        unobservable_variables?: string[]
        critique?: string
        unaddressed_risks?: string[]
        fatal_flaw_found?: boolean
        revised?: IdeaPackage
      } | undefined
      if (value?.revised && typeof value.revised === 'object' && !Array.isArray(value.revised)) {
        // Merging (not replacing) keeps required top-level fields (idea_id,
        // supported_premises, predicted/disconfirming_observations, sources, ...)
        // that a partial `revised` payload may omit.
        currentPkg = {
          ...currentPkg,
          ...value.revised,
          idea_id: currentPkg.idea_id,
          generation_strategy: currentPkg.generation_strategy,
          lineage_op: currentPkg.lineage_op,
        }
      }
      return {
        pkg: currentPkg,
        falsifiability: {
          idea_id: currentPkg.idea_id,
          testable_implication: value?.testable_implication ?? '',
          unobservable_variables: value?.unobservable_variables ?? [],
          is_falsifiable: value?.is_falsifiable ?? false,
        },
        review: {
          idea_id: currentPkg.idea_id,
          perspective: 'combined',
          critique: value?.critique ?? '',
          unaddressed_risks: value?.unaddressed_risks ?? [],
          fatal_flaw_found: value?.fatal_flaw_found ?? false,
          failed: false,
        },
      }
    },
    validate: validateIdeaReflexionState,
    maxRetriesPerRound: 2,
    rounds: ctx.policySnapshot.workflow.reflexionRounds,
    onAbnormalExit: async (info) => {
      await writeFailureReflexion(ctx.runDir, {
        role: info.role,
        stage: 'idea',
        round: info.round,
        stopReason: info.stopReason,
        error: info.error instanceof Error ? info.error.message : info.error === undefined ? undefined : String(info.error),
        context: { pkg: currentPkg },
        result: info.result,
      })
    },
  })
}
