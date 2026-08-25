import type { Logger } from '../core/utils.js'
import { IdeaSteps } from './steps/idea.js'
import { ExperimentSteps } from './steps/experiment.js'
import { PaperSteps } from './steps/paper.js'
import type { RoleRunner } from './agent-runner.js'
import type { RunSession } from './run-session.js'
import type { ResearchRunnerOptions } from './types.js'
import type { ActionResult, ResearchDecision } from '../core/types.js'

export type { IdeaGenerationRequest } from './steps/idea.js'

/**
 * Domain-step facade. ResearchRunner talks to this single object; each domain's
 * implementation lives in steps/idea.ts, steps/experiment.ts, steps/paper.ts.
 */
export class ResearchSteps {
  private readonly idea: IdeaSteps
  private readonly experiment: ExperimentSteps
  private readonly paper: PaperSteps

  constructor(
    roleRunner: RoleRunner,
    logger: Logger,
    options: ResearchRunnerOptions,
  ) {
    this.idea = new IdeaSteps(roleRunner, logger, options)
    this.experiment = new ExperimentSteps(roleRunner, logger)
    this.paper = new PaperSteps(logger, options)
  }

  async ensureRubric(request: Parameters<IdeaSteps['ensureRubric']>[0]): Promise<void> {
    return this.idea.ensureRubric(request)
  }

  async runIdeaGeneration(request: Parameters<IdeaSteps['runIdeaGeneration']>[0]): Promise<void> {
    return this.idea.runIdeaGeneration(request)
  }

  async runHypothesisRevision(session: RunSession): Promise<void> {
    return this.idea.runHypothesisRevision(session)
  }

  async runPlanner(request: Parameters<ExperimentSteps['runPlanner']>[0]): Promise<string> {
    return this.experiment.runPlanner(request)
  }

  async runMinimalVerification(request: Parameters<ExperimentSteps['runMinimalVerification']>[0]): Promise<string> {
    return this.experiment.runMinimalVerification(request)
  }

  async runModelScout(request: Parameters<ExperimentSteps['runModelScout']>[0]): Promise<string> {
    return this.experiment.runModelScout(request)
  }

  async runExperimentDesign(request: Parameters<ExperimentSteps['runExperimentDesign']>[0]): Promise<string> {
    return this.experiment.runExperimentDesign(request)
  }

  async runExperimentReflexion(request: Parameters<ExperimentSteps['runExperimentReflexion']>[0]): Promise<string> {
    return this.experiment.runExperimentReflexion(request)
  }

  async runResultReflexion(request: Parameters<ExperimentSteps['runResultReflexion']>[0]): Promise<string> {
    return this.experiment.runResultReflexion(request)
  }

  async runInsightAbstractor(request: Parameters<ExperimentSteps['runInsightAbstractor']>[0]): Promise<string> {
    return this.experiment.runInsightAbstractor(request)
  }

  async runWorker(request: Parameters<ExperimentSteps['runWorker']>[0]): Promise<ActionResult> {
    return this.experiment.runWorker(request)
  }

  async runEvidenceAgent(request: Parameters<ExperimentSteps['runEvidenceAgent']>[0]): Promise<void> {
    return this.experiment.runEvidenceAgent(request)
  }

  async runSupervisor(request: Parameters<ExperimentSteps['runSupervisor']>[0]): Promise<ResearchDecision> {
    return this.experiment.runSupervisor(request)
  }

  async runPaper(session: RunSession): Promise<void> {
    return this.paper.runPaper(session)
  }
}
