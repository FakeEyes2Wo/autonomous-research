import { join } from 'node:path'
import { AutoResearchError, readOptionalText, writeText } from '../core/utils.js'
import { recordResult } from '../core/state.js'
import type { ActionResult, ResearchDecision } from '../core/types.js'
import { parseDecision } from '../core/types.js'
import { readRubric } from '../domain/files.js'
import { runAgent, runStage, structuredText, treeSummary } from '../service/agent.js'
import type { RunContext } from '../service/context.js'

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
      idea,
      profile,
      rubric,
      treeSummary: treeSummary(ctx.tree),
      ...(feedback ? { plan: `Human review feedback on the previous plan/evidence:\n${feedback}` } : {}),
    },
    label: `plan cycle ${ctx.state.cycle}`,
  })
  return structuredText(result.structured, 'plan') ?? result.text
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
      ...(feedback ? { reflexion: `Human review feedback on the previous experiment design:\n${feedback}` } : {}),
    },
    outputFile: 'EXPERIMENT_DESIGN.md',
  })
}

export async function runExperimentReflexion(
  ctx: RunContext,
  { planText, minimalVerification, modelScout, initialDesign }: {
    planText: string
    minimalVerification: string
    modelScout: string
    initialDesign: string
  },
): Promise<string> {
  let design = initialDesign
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reflexText = await runStage(ctx, {
      phase: 'experiment_reflexion',
      stepId: `experiment-reflexion-${ctx.state.cycle}`,
      role: 'experiment-reflexion',
      label: `experiment reflexion cycle ${ctx.state.cycle} attempt ${attempt}`,
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
    const r = JSON.parse(reflexText) as { verdict?: string }
    if (r?.verdict !== 'revise') break
    design = await runStage(ctx, {
      phase: 'experiment_design',
      stepId: `experiment-redesign-${ctx.state.cycle}`,
      role: 'experiment-designer',
      label: `experiment redesign cycle ${ctx.state.cycle} attempt ${attempt}`,
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
  return design
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
  { workDir: _workDir, planText, experimentDesign, minimalVerification }: {
    workDir: string
    planText: string
    experimentDesign: string
    minimalVerification: string
  },
): Promise<ActionResult> {
  const result = await runAgent(ctx, {
    role: 'research-worker',
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      plan: planText,
      experimentDesign,
      minimalVerification,
      treeSummary: treeSummary(ctx.tree),
    },
    label: `work cycle ${ctx.state.cycle}`,
  })
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
  { planText }: { planText: string },
): Promise<ResearchDecision> {
  const rubric = await readRubric(ctx.runDir)
  const result = await runAgent(ctx, {
    role: 'supervisor',
    input: {
      runDir: ctx.runDir,
      cycle: ctx.state.cycle,
      rubric,
      plan: planText,
      treeSummary: treeSummary(ctx.tree),
    },
    label: `decide cycle ${ctx.state.cycle}`,
  })
  if (result.structured === undefined) {
    throw new AutoResearchError('supervisor did not return structured decision', 'AGENT_FAILED')
  }
  return parseDecision(result.structured)
}
