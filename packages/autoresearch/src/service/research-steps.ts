import type { Logger } from '../core/utils.js'
import { ensureRubric, runHypothesisRevision, runIdeaGeneration, type EnsureRubricInput, type IdeaGenerationInput } from './steps/idea.js'
import {
  runEvidenceAgent,
  runExperimentDesign,
  runExperimentReflexion,
  runInsightAbstractor,
  runMinimalVerification,
  runModelScout,
  runPlanner,
  runResultReflexion,
  runSupervisor,
  runWorker,
} from './steps/experiment.js'
import { PaperSteps } from './steps/paper.js'
import type { RunSession } from './run-session.js'
import type { ResearchRunnerOptions } from './types.js'
import type { ActionResult, ResearchDecision } from '../core/types.js'

export interface IdeaGenerationRequest extends IdeaGenerationInput {
  session: RunSession
}

interface EnsureRubricRequest extends EnsureRubricInput {
  session: RunSession
}

type ExperimentRequest<T> = T & { session: RunSession }

/**
 * Domain-step facade. ResearchRunner talks to this single object; each domain's
 * implementation lives in steps/idea.ts, steps/experiment.ts, steps/paper.ts.
 */
export class ResearchSteps {
  private readonly paper: PaperSteps

  constructor(
    _legacyRoleRunner: unknown,
    logger: Logger,
    options: ResearchRunnerOptions,
  ) {
    this.paper = new PaperSteps(logger, options)
  }

  async ensureRubric({ session, ...input }: EnsureRubricRequest): Promise<void> {
    return ensureRubric(session, input)
  }

  async runIdeaGeneration({ session, ...input }: IdeaGenerationRequest): Promise<void> {
    return runIdeaGeneration(session, input)
  }

  async runHypothesisRevision(session: RunSession): Promise<void> {
    return runHypothesisRevision(session)
  }

  async runPlanner({ session, ...input }: ExperimentRequest<Parameters<typeof runPlanner>[1]>): Promise<string> {
    return runPlanner(session, input)
  }

  async runMinimalVerification({ session, ...input }: ExperimentRequest<Parameters<typeof runMinimalVerification>[1]>): Promise<string> {
    return runMinimalVerification(session, input)
  }

  async runModelScout({ session, ...input }: ExperimentRequest<Parameters<typeof runModelScout>[1]>): Promise<string> {
    return runModelScout(session, input)
  }

  async runExperimentDesign({ session, ...input }: ExperimentRequest<Parameters<typeof runExperimentDesign>[1]>): Promise<string> {
    return runExperimentDesign(session, input)
  }

  async runExperimentReflexion({ session, ...input }: ExperimentRequest<Parameters<typeof runExperimentReflexion>[1]>): Promise<string> {
    return runExperimentReflexion(session, input)
  }

  async runResultReflexion({ session, ...input }: ExperimentRequest<Parameters<typeof runResultReflexion>[1]>): Promise<string> {
    return runResultReflexion(session, input)
  }

  async runInsightAbstractor({ session, ...input }: ExperimentRequest<Parameters<typeof runInsightAbstractor>[1]>): Promise<string> {
    return runInsightAbstractor(session, input)
  }

  async runWorker({ session, ...input }: ExperimentRequest<Parameters<typeof runWorker>[1]>): Promise<ActionResult> {
    return runWorker(session, input)
  }

  async runEvidenceAgent({ session, ...input }: ExperimentRequest<Parameters<typeof runEvidenceAgent>[1]>): Promise<void> {
    return runEvidenceAgent(session, input)
  }

  async runSupervisor({ session, ...input }: ExperimentRequest<Parameters<typeof runSupervisor>[1]>): Promise<ResearchDecision> {
    return runSupervisor(session, input)
  }

  async runPaper(session: RunSession): Promise<void> {
    return this.paper.runPaper(session)
  }
}
