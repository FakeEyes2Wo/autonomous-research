import { join } from 'node:path'
import { issueWorkerRoot } from '../cleanup/registration.js'
import { AutoResearchError, DEFAULT_MAX_CYCLES, readOptionalText, writeText } from '../core/utils.js'
import { recordResult } from '../core/state.js'
import type { ActionResult, ResearchDecision } from '../core/types.js'
import { parseDecision } from '../core/types.js'
import { readRubric } from '../domain/files.js'
import { runAgent, runStage, structuredText, treeSummary } from '../service/agent.js'
import type { RunContext } from '../service/context.js'
import { ExperimentPauseError, DurableExperimentWaitingError } from './errors.js'
import { validateWorkerResult } from './validation.js'
import { resolveModelRoute } from '../policy/model-routing.js'
import type { ProjectSettings } from '../settings/schema.js'
import { captureResearchPlan, freezeResearchCycle, readResearchAttempt, registerResearchAttempt, assessResearchCycle, committedDecision, commitResearchDecision, researchPlanInput } from '../service/research-cycle.js'
import { runtimeCapabilities } from '../service/runtime-capabilities.js'
import { ResearchStore } from '../research/index.js'
import { freezeTaskGraph, loadTaskGraph, tasksFromExecutionPlan } from './task-graph.js'
import { advanceExperimentGraph, writeRuntimeHandoff, rehydrateVerifiedCompletedGraphAction } from './runtime-adapter.js'
import { cyclePath, writeResearchReport } from '../service/research-cycle.js'
import { synchronizeResearchViews } from '../service/research-outputs.js'
import { bindScientificFollowup, completeScientificFollowup } from '../service/continuation.js'

function plannerRuntimeConstraints(ctx: RunContext): string {
  const policy = ctx.policySnapshot
  const maxCycles = ctx.deps.maxCycles ?? DEFAULT_MAX_CYCLES
  const routing = policy.modelRouting
  const resolved = resolveModelRoute(policy as ProjectSettings, { role: 'planner', task: 'planning' })
  const route = resolved.source === 'inherit'
    ? 'inherited; provider and model are unknown to AutoResearch'
    : `${resolved.source} route; tier=${resolved.tier}; provider=${resolved.provider || 'unknown'}; model=${resolved.model || 'unknown'}`
  const review = policy.workflow.mode === 'legacy'
    ? `legacy pre-work design reflexion is required; configured minimal experiment-review policy=${policy.workflow.experimentReview}`
    : `configured minimal experiment-review policy=${policy.workflow.experimentReview}; standalone minimal does not add optional review roles`
  return [
    `- effective outer workflow mode: ${policy.workflow.mode}`,
    `- maximum outer cycles/rounds: ${maxCycles}`,
    `- outer role model routing: ${routing.enabled ? 'enabled' : 'disabled'}; planner route=${route}`,
    `- outer review behavior: ${review}`,
    `- outer LLM budget: maxRunTokens=${policy.budget.maxRunTokens}; maxRoleCalls=${policy.budget.maxRoleCalls}; global maxInputTokens/call=${policy.budget.maxInputTokens}; global maxOutputTokens/call=${policy.budget.maxOutputTokens}; role/tier caps may be lower`,
    '- These outer limits do not limit experiment-internal seeds, episodes, retries, or models. Plan those separately from PROFILE and the frozen experiment protocol; disabled outer model routing does not ban multi-model experiments.',
  ].join('\n')
}

export async function runPlanner(
  ctx: RunContext,
  { idea, profile }: { idea: string; profile: string },
): Promise<string> {
  const rubric = await readRubric(ctx.runDir)
  const feedback = ((await readOptionalText(join(ctx.runDir, 'PLAN_FEEDBACK.md'))) ?? '').trim() || undefined
  if (feedback) await writeText(join(ctx.runDir, 'PLAN_FEEDBACK.md'), '')
  const result = await runAgent(ctx, {
    role: 'planner',
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      idea: await researchPlanInput(ctx, idea),
      profile,
      rubric,
      runtimeConstraints: `${plannerRuntimeConstraints(ctx)}\nRecorded capabilities: ${await runtimeCapabilities(ctx)}`,
      treeSummary: treeSummary(ctx.tree),
      ...(feedback ? { plan: `Human review feedback on the previous plan/evidence:\n${feedback}` } : {}),
    },
    label: `plan cycle ${ctx.state.cycle}`,
  })
  await captureResearchPlan(ctx, result.structured, result.literatureSources)
  return structuredText(result.structured, 'plan') ?? result.text
}

export interface MinimalPlan {
  plan: string
  riskLevel: 'low' | 'medium' | 'high'
}

/**
 * Minimal mode deliberately has one planning call.  The optional risk marker
 * is advisory; local evidence remains authoritative for deciding whether a
 * disabled review gate must pause the run.
 */
export async function runMinimalPlan(
  ctx: RunContext,
  { idea, profile }: { idea: string; profile: string },
): Promise<MinimalPlan> {
  const result = await runAgent(ctx, {
    role: 'planner',
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      idea: await researchPlanInput(ctx, idea),
      profile,
      runtimeConstraints: `${plannerRuntimeConstraints(ctx)}\nRecorded capabilities: ${await runtimeCapabilities(ctx)}`,
      treeSummary: treeSummary(ctx.tree),
    },
    label: `minimal plan cycle ${ctx.state.cycle}`,
  })
  const structured = (result.structured ?? {}) as { plan?: unknown; riskLevel?: unknown }
  await captureResearchPlan(ctx, result.structured, result.literatureSources)
  const plan = typeof structured.plan === 'string' && structured.plan.trim() ? structured.plan : result.text
  const riskLevel = structured.riskLevel === 'high' || structured.riskLevel === 'medium' ? structured.riskLevel : 'low'
  return { plan, riskLevel }
}

export async function runMinimalVerification(
  ctx: RunContext,
  { planText }: { planText: string },
): Promise<string> {
  return runStage(ctx, {
    phase: 'minimal_verification',
    stepId: `minimal-verify-${ctx.state.cycle}`,
    role: 'minimal-verifier',
    label: `minimal verify cycle ${ctx.state.cycle}`,
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      plan: planText,
      treeSummary: treeSummary(ctx.tree),
    },
    outputFile: 'MINIMAL_VERIFICATION.md',
  })
}

export async function runModelScout(
  ctx: RunContext,
  { planText }: { planText: string },
): Promise<string> {
  return runStage(ctx, {
    phase: 'experiment_design',
    stepId: `model-scout-${ctx.state.cycle}`,
    role: 'model-scout',
    label: `model scout cycle ${ctx.state.cycle}`,
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      plan: planText,
      treeSummary: treeSummary(ctx.tree),
    },
    outputFile: 'MODEL_SCOUT.md',
  })
}

export async function runExperimentDesign(
  ctx: RunContext,
  { planText, minimalVerification, modelScout, feedback }: {
    planText: string
    minimalVerification: string
    modelScout: string
    feedback?: string
  },
): Promise<string> {
  const previousDesign = feedback ? await readOptionalText(join(ctx.runDir, 'EXPERIMENT_DESIGN.md')) : undefined
  return runStage(ctx, {
    phase: 'experiment_design',
    stepId: `experiment-design-${ctx.state.cycle}`,
    role: 'experiment-designer',
    label: feedback ? `experiment redesign cycle ${ctx.state.cycle}` : `experiment design cycle ${ctx.state.cycle}`,
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      plan: planText,
      minimalVerification,
      modelScout,
      treeSummary: treeSummary(ctx.tree),
      ...(previousDesign ? { experimentDesign: previousDesign } : {}),
      ...(feedback ? { reflexion: `Human review feedback on the previous experiment design:\n${feedback}` } : {}),
    },
    outputFile: 'EXPERIMENT_DESIGN.md',
  })
}

export async function runExperimentReflexion(
  ctx: RunContext,
  { planText, minimalVerification, modelScout, initialDesign, maxRedesigns = 2 }: {
    planText: string
    minimalVerification: string
    modelScout: string
    initialDesign: string
    maxRedesigns?: number
  },
): Promise<string> {
  let design = initialDesign
  const redesignCap = Math.max(0, Math.min(2, maxRedesigns))
  for (let review = 1; review <= redesignCap + 1; review += 1) {
    const reflexText = await runStage(ctx, {
      phase: 'experiment_reflexion',
      stepId: `experiment-reflexion-${ctx.state.cycle}`,
      role: 'experiment-reflexion',
      label: `experiment reflexion cycle ${ctx.state.cycle} review ${review}`,
      input: {
        runDir: ctx.runDir,
        cycle: ctx.state.cycle,
        plan: planText,
        minimalVerification,
        modelScout,
        experimentDesign: design,
        treeSummary: treeSummary(ctx.tree),
      },
      outputFile: 'EXPERIMENT_REFLEXION.md',
    })
    let verdict: unknown
    try { verdict = (JSON.parse(reflexText) as { verdict?: unknown }).verdict } catch { verdict = undefined }
    if (verdict === 'proceed') return design
    if (verdict !== 'revise') throw new ExperimentPauseError(`experiment review returned invalid verdict for design review ${review}`)
    if (review > redesignCap) {
      throw new ExperimentPauseError(`experiment design was not accepted after ${review} review${review === 1 ? '' : 's'}; latest verdict requires revision`)
    }
    design = await runStage(ctx, {
      phase: 'experiment_design',
      stepId: `experiment-redesign-${ctx.state.cycle}`,
      role: 'experiment-designer',
      label: `experiment redesign cycle ${ctx.state.cycle} revision ${review}`,
      input: {
        runDir: ctx.runDir,
        cycle: ctx.state.cycle,
        plan: planText,
        minimalVerification,
        modelScout,
        experimentDesign: design,
        reflexion: reflexText,
        treeSummary: treeSummary(ctx.tree),
      },
      outputFile: 'EXPERIMENT_DESIGN.md',
    })
  }
  throw new ExperimentPauseError('experiment design review ended without explicit acceptance')
}

export async function runResultReflexion(
  ctx: RunContext,
  { planText, experimentDesign }: { planText: string; experimentDesign: string },
): Promise<string> {
  return runStage(ctx, {
    phase: 'result_reflexion',
    stepId: `result-reflexion-${ctx.state.cycle}`,
    role: 'result-reflexion',
    label: `result reflexion cycle ${ctx.state.cycle}`,
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      plan: planText,
      experimentDesign,
      treeSummary: treeSummary(ctx.tree),
    },
    outputFile: 'REFLEXION.md',
  })
}

export async function runInsightAbstractor(
  ctx: RunContext,
  { planText, experimentDesign, failureDirections }: {
    planText: string
    experimentDesign: string
    failureDirections: string
  },
): Promise<string> {
  return runStage(ctx, {
    phase: 'result_reflexion',
    stepId: `insight-${ctx.state.cycle}`,
    role: 'insight-abstractor',
    label: `insight abstract cycle ${ctx.state.cycle}`,
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      plan: planText,
      experimentDesign,
      failureDirections,
      treeSummary: treeSummary(ctx.tree),
    },
    outputFile: 'INSIGHT.md',
  })
}

export async function runWorker(
  ctx: RunContext,
  { workDir, planText, experimentDesign, minimalVerification, cachedStage }: {
    workDir: string
    cachedStage?: { result: unknown }
    planText: string
    experimentDesign: string
    minimalVerification: string
  },
): Promise<ActionResult> {
  if (ctx.context.signal.aborted) throw new ExperimentPauseError('execution cancelled before worker dispatch')
  const assignment = await bindScientificFollowup(ctx, { cycle: ctx.state.cycle, planVersion: ctx.state.planVersion, graphId: `cycle-${ctx.state.cycle}` })
  if (assignment && (assignment.cycle !== ctx.state.cycle || assignment.planVersion !== ctx.state.planVersion || assignment.graphId !== `cycle-${ctx.state.cycle}`)) throw new ExperimentPauseError('scientific follow-up execution assignment mismatch')
  const { cached, frozen } = await (async () => {
    try {
      const cached = await readResearchAttempt(ctx)
      const frozenMarker = await readOptionalText(cyclePath(ctx, 'frozen.json'))
      if ((cached || cachedStage) && !frozenMarker) throw new ExperimentPauseError('cached worker missing frozen boundary proof; no redispatch')
      const frozen = (cached || cachedStage) && frozenMarker
        ? await new ResearchStore(ctx.runDir).loadSnapshot(JSON.parse(frozenMarker).snapshotId)
        : await freezeResearchCycle(ctx, planText, experimentDesign)
      return { cached, frozen }
    } catch (error) {
      if (error instanceof ExperimentPauseError) throw error
      throw new ExperimentPauseError(`worker ownership proof unreadable; no redispatch: ${String(error)}`)
    }
  })()
  const graphId = `cycle-${ctx.state.cycle}`
  let graph = await loadTaskGraph(ctx.runDir, graphId)
  const planner = JSON.parse((await readOptionalText(cyclePath(ctx, 'planner-output.json'))) ?? '{}')
  if (graph || planner.taskGraph !== undefined) {
    try {
      graph ??= await freezeTaskGraph({ runDir: ctx.runDir, id: graphId, goal: planText, snapshot: frozen, tasks: tasksFromExecutionPlan(planner.taskGraph, ctx.runDir, graphId, frozen) })
      const verified = await rehydrateVerifiedCompletedGraphAction(ctx.runDir, graph)
      if (verified) { await acknowledgeDurableFollowup(ctx, verified, graph.protocolHash); return verified }
      if (cachedStage) throw new ExperimentPauseError('cached durable stage lacks completed host proof')
      if (!ctx.context.experimentRuntime) { await writeRuntimeHandoff(ctx.runDir, graph); throw new ExperimentPauseError('DURABLE_AUTHORITY_REQUIRED: configure the trusted host localExperiments project/executable permissions before resuming; no job dispatched.') }
      const result = await advanceExperimentGraph({ runDir: ctx.runDir, graph, runtime: ctx.context.experimentRuntime })
      const snapshot = (await new ResearchStore(ctx.runDir).loadCurrent())!
      await writeResearchReport(ctx, snapshot)
      ctx.tree = await synchronizeResearchViews(ctx.runDir, snapshot)
      if (result.status === 'waiting') throw new DurableExperimentWaitingError(result.reason)
      if (result.status === 'paused') throw new ExperimentPauseError(result.reason)
      const action = await rehydrateVerifiedCompletedGraphAction(ctx.runDir, graph)
      if (!action) throw new ExperimentPauseError('completed graph lacks verified host proof')
      await registerResearchAttempt(ctx, 'completed', action)
      await acknowledgeDurableFollowup(ctx, action, graph.protocolHash)
      return action
    } catch (error) {
      if (error instanceof ExperimentPauseError) throw error
      throw new ExperimentPauseError(`durable graph paused: ${String(error)}`)
    }
  }
  if (cached?.status === 'unknown') throw new ExperimentPauseError('worker execution outcome is unknown; verify backend receipt before redispatch')
  if (cachedStage && cached?.status !== 'completed') throw new ExperimentPauseError('cached worker stage lacks completed attempt ownership proof; no redispatch')
  if (cachedStage || cached?.status === 'completed' && cached.result) {
    const result = await validateWorkerResult(ctx.runDir, workDir, cachedStage ? cachedStage.result : cached!.result)
    await assessResearchCycle(ctx, result, undefined, false, true)
    return result
  }
  await issueWorkerRoot(ctx.runDir, ctx.state.cycle, workDir)
  await registerResearchAttempt(ctx, 'unknown')
  try {
  const result = await runAgent(ctx, {
    role: 'research-worker',
    input: {
      runDir: ctx.runDir,
      workDir,
      cycle: ctx.state.cycle,
      plan: planText,
      experimentDesign,
      minimalVerification,
      treeSummary: treeSummary(ctx.tree),
    },
    label: `work cycle ${ctx.state.cycle}`,
  })
  // Only validated ownership may be captured or published as a completed attempt.
  const action = await validateWorkerResult(ctx.runDir, workDir, result.structured)
  await assessResearchCycle(ctx, action)
  await registerResearchAttempt(ctx, 'completed', action)
  await runtimeCapabilities(ctx, 'passed')
  return action
  } catch (error) {
    await runtimeCapabilities(ctx, error instanceof ExperimentPauseError ? 'failed' : 'unknown')
    if (error instanceof ExperimentPauseError) {
      await registerResearchAttempt(ctx, 'failed')
      await assessResearchCycle(ctx, { status: 'failed', summary: error.message, artifacts: [] }, error.message)
    } else {
      await assessResearchCycle(ctx, { status: 'failed', summary: String(error), artifacts: [] }, String(error), true)
    }
    throw error
  }
}

async function acknowledgeDurableFollowup(ctx: RunContext, action: ActionResult, protocolHash: string): Promise<void> {
  const snapshot = await new ResearchStore(ctx.runDir).loadCurrent()
  const refs = snapshot?.evidence.filter(e => e.protocol_hash === protocolHash).flatMap(e => e.artifacts).filter(ref => ref.path && action.artifacts.includes(ref.path)) ?? []
  // Only evidence already admitted by the verified host graph participates.
  // The runtime owns scientific assessment; this acknowledges execution only.
  await completeScientificFollowup(ctx, refs)
}

export async function runEvidenceAgent(
  ctx: RunContext,
  { planText }: { planText: string },
): Promise<void> {
  const result = await runAgent(ctx, {
    role: 'evidence-agent',
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      plan: planText,
      treeSummary: treeSummary(ctx.tree),
    },
    label: `evidence cycle ${ctx.state.cycle}`,
  })
  await recordResult(ctx.state, `evidence-${ctx.state.cycle}`, { summary: result.text })
}

export async function runSupervisor(
  ctx: RunContext,
  { planText, evidence }: { planText: string; evidence?: string },
): Promise<ResearchDecision> {
  const cached = await committedDecision(ctx)
  if (cached) return cached
  const expectedSnapshot = await new ResearchStore(ctx.runDir).loadCurrent()
  const rubric = (await readOptionalText(join(ctx.runDir, 'RUBRIC.md'))) ?? ''
  const result = await runAgent(ctx, {
    role: 'supervisor',
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      rubric,
      plan: planText,
      ...(evidence ? { reflexion: evidence } : {}),
      treeSummary: treeSummary(ctx.tree),
    },
    label: `decide cycle ${ctx.state.cycle}`,
  })
  if (result.structured === undefined) {
    throw new AutoResearchError('supervisor did not return structured decision', 'AGENT_FAILED')
  }
  return commitResearchDecision(ctx, result.structured, parseDecision(result.structured), expectedSnapshot ? { id: expectedSnapshot.id, hash: expectedSnapshot.content_hash } : undefined, { registeredSpans: result.literatureSources?.map(source => source.sourceRef) })
}
