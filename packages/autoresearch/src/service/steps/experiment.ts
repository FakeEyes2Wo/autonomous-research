import { join } from 'node:path'
import { AutoResearchError, readText, writeText, type Logger } from '../../core/utils.js'
import { recordResult } from '../../core/state.js'
import type { ActionResult, ResearchDecision } from '../../core/types.js'
import { parseDecision } from '../../core/types.js'
import { readRubric } from '../../domain/files.js'
import type { RoleRunner } from '../agent-runner.js'
import type { RunSession } from '../run-session.js'

export class ExperimentSteps {
  constructor(
    private readonly roleRunner: RoleRunner,
    private readonly logger: Logger,
  ) {}

  async runPlanner({ session, idea, profile }: { session: RunSession; idea: string; profile: string }): Promise<string> {
    const rubric = await readRubric(session.runDir)
    const feedback = (await readText(join(session.runDir, 'PLAN_FEEDBACK.md')).catch(() => '')).trim() || undefined
    if (feedback) await writeText(join(session.runDir, 'PLAN_FEEDBACK.md'), '')
    const result = await this.roleRunner.run('planner', {
      runDir: session.runDir,
      cycle: session.state.cycle,
      idea,
      profile,
      rubric,
      treeSummary: this.roleRunner.treeSummary(session.tree),
      ...(feedback ? { plan: `Human review feedback on the previous plan/evidence:\n${feedback}` } : {}),
    }, session.context, `plan cycle ${session.state.cycle}`)
    return this.roleRunner.structuredText(result.structured, 'plan') ?? result.text
  }

  async runMinimalVerification({ session, planText }: { session: RunSession; planText: string }): Promise<string> {
    return this.roleRunner.runStage({
      session,
      phase: 'minimal_verification',
      stepId: `minimal-verify-${session.state.cycle}`,
      role: 'minimal-verifier',
      label: `minimal verify cycle ${session.state.cycle}`,
      input: {
        runDir: session.runDir,
        cycle: session.state.cycle,
        plan: planText,
        treeSummary: this.roleRunner.treeSummary(session.tree),
      },
      outputFile: 'MINIMAL_VERIFICATION.md',
    })
  }

  async runModelScout({ session, planText }: { session: RunSession; planText: string }): Promise<string> {
    return this.roleRunner.runStage({
      session,
      phase: 'experiment_design',
      stepId: `model-scout-${session.state.cycle}`,
      role: 'model-scout',
      label: `model scout cycle ${session.state.cycle}`,
      input: {
        runDir: session.runDir,
        cycle: session.state.cycle,
        plan: planText,
        treeSummary: this.roleRunner.treeSummary(session.tree),
      },
      outputFile: 'MODEL_SCOUT.md',
    })
  }

  async runExperimentDesign({ session, planText, minimalVerification, modelScout, feedback }: { session: RunSession; planText: string; minimalVerification: string; modelScout: string; feedback?: string }): Promise<string> {
    return this.roleRunner.runStage({
      session,
      phase: 'experiment_design',
      stepId: `experiment-design-${session.state.cycle}`,
      role: 'experiment-designer',
      label: feedback ? `experiment redesign cycle ${session.state.cycle}` : `experiment design cycle ${session.state.cycle}`,
      input: {
        runDir: session.runDir,
        cycle: session.state.cycle,
        plan: planText,
        minimalVerification,
        modelScout,
        treeSummary: this.roleRunner.treeSummary(session.tree),
        ...(feedback ? { reflexion: `Human review feedback on the previous experiment design:\n${feedback}` } : {}),
      },
      outputFile: 'EXPERIMENT_DESIGN.md',
    })
  }

  async runExperimentReflexion({ session, planText, minimalVerification, modelScout, initialDesign }: { session: RunSession; planText: string; minimalVerification: string; modelScout: string; initialDesign: string }): Promise<string> {
    let design = initialDesign
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const reflexText = await this.roleRunner.runStage({
        session,
        phase: 'experiment_reflexion',
        stepId: `experiment-reflexion-${session.state.cycle}`,
        role: 'experiment-reflexion',
        label: `experiment reflexion cycle ${session.state.cycle} attempt ${attempt}`,
        input: {
          runDir: session.runDir,
          cycle: session.state.cycle,
          plan: planText,
          minimalVerification,
          modelScout,
          experimentDesign: design,
          treeSummary: this.roleRunner.treeSummary(session.tree),
        },
        outputFile: 'EXPERIMENT_REFLEXION.md',
      })
      const r = JSON.parse(reflexText) as { verdict?: string }
      if (r?.verdict !== 'revise') break
      design = await this.roleRunner.runStage({
        session,
        phase: 'experiment_design',
        stepId: `experiment-redesign-${session.state.cycle}`,
        role: 'experiment-designer',
        label: `experiment redesign cycle ${session.state.cycle} attempt ${attempt}`,
        input: {
          runDir: session.runDir,
          cycle: session.state.cycle,
          plan: planText,
          minimalVerification,
          modelScout,
          experimentDesign: design,
          reflexion: reflexText,
          treeSummary: this.roleRunner.treeSummary(session.tree),
        },
        outputFile: 'EXPERIMENT_DESIGN.md',
      })
    }
    return design
  }

  async runResultReflexion({ session, planText, experimentDesign }: { session: RunSession; planText: string; experimentDesign: string }): Promise<string> {
    return this.roleRunner.runStage({
      session,
      phase: 'result_reflexion',
      stepId: `result-reflexion-${session.state.cycle}`,
      role: 'result-reflexion',
      label: `result reflexion cycle ${session.state.cycle}`,
      input: {
        runDir: session.runDir,
        cycle: session.state.cycle,
        plan: planText,
        experimentDesign,
        treeSummary: this.roleRunner.treeSummary(session.tree),
      },
      outputFile: 'REFLEXION.md',
    })
  }

  async runInsightAbstractor({ session, planText, experimentDesign, failureDirections }: { session: RunSession; planText: string; experimentDesign: string; failureDirections: string }): Promise<string> {
    return this.roleRunner.runStage({
      session,
      phase: 'result_reflexion',
      stepId: `insight-${session.state.cycle}`,
      role: 'insight-abstractor',
      label: `insight abstract cycle ${session.state.cycle}`,
      input: {
        runDir: session.runDir,
        cycle: session.state.cycle,
        plan: planText,
        experimentDesign,
        failureDirections,
        treeSummary: this.roleRunner.treeSummary(session.tree),
      },
      outputFile: 'INSIGHT.md',
    })
  }

  async runWorker({ session, workDir, planText, experimentDesign, minimalVerification }: { session: RunSession; workDir: string; planText: string; experimentDesign: string; minimalVerification: string }): Promise<ActionResult> {
    const result = await this.roleRunner.run('research-worker', {
      runDir: session.runDir,
      cycle: session.state.cycle,
      plan: planText,
      experimentDesign,
      minimalVerification,
      treeSummary: this.roleRunner.treeSummary(session.tree),
    }, session.context, `work cycle ${session.state.cycle}`)
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

  async runEvidenceAgent({ session, planText }: { session: RunSession; planText: string }): Promise<void> {
    const result = await this.roleRunner.run('evidence-agent', {
      runDir: session.runDir,
      cycle: session.state.cycle,
      plan: planText,
      treeSummary: this.roleRunner.treeSummary(session.tree),
    }, session.context, `evidence cycle ${session.state.cycle}`)
    await recordResult(session.state, `evidence-${session.state.cycle}`, { summary: result.text })
  }

  async runSupervisor({ session, planText }: { session: RunSession; planText: string }): Promise<ResearchDecision> {
    const rubric = await readRubric(session.runDir)
    const result = await this.roleRunner.run('supervisor', {
      runDir: session.runDir,
      cycle: session.state.cycle,
      rubric,
      plan: planText,
      treeSummary: this.roleRunner.treeSummary(session.tree),
    }, session.context, `decide cycle ${session.state.cycle}`)
    if (result.structured === undefined) {
      throw new AutoResearchError('supervisor did not return structured decision', 'AGENT_FAILED')
    }
    return parseDecision(result.structured)
  }
}
