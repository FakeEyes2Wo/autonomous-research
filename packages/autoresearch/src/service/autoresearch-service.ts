import { createLogger, DEFAULT_MAX_CYCLES } from '../core/utils.js'
import { ResearchTree } from '../core/research-tree.js'
import { createInitialState, loadState, saveState } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { ensureDir } from '../core/utils.js'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import type { HumanReviewer, ReviewGateId } from '../core/human-review.js'
import type { HumanReviewMode } from '../session/auto-mode.js'
import { writeFailureReport } from '../domain/files.js'
import { writeLastRun } from '../session/last-run.js'
import { ResearchRunner } from './runner.js'
import type { PaperOptions } from '../paper/pipeline.js'

export interface ResearchRunOptions {
  runDir: string
  candidatePath?: string
  profilePath?: string
  maxCycles?: number
  paper?: PaperOptions
  humanReview?: HumanReviewMode
  idea?: string
  brainstorm?: HumanReviewMode
}

export type ResearchRunContext = RoleExecutionContext

export interface AutoResearchServiceOptions {
  reviewer?: HumanReviewer
  reviewGates?: ReviewGateId[]
}

export class AutoResearchService {
  private readonly provider: RoleAgentProvider
  private readonly options: AutoResearchServiceOptions

  constructor(provider: RoleAgentProvider, options: AutoResearchServiceOptions = {}) {
    this.provider = provider
    this.options = options
  }

  async run(options: ResearchRunOptions, context: ResearchRunContext): Promise<RunState> {
    const runDir = options.runDir
    const logger = createLogger(runDir)
    logger.info(`AutoResearchService.run start runDir=${runDir}`)
    await ensureDir(runDir)
    const existing = await loadState(runDir)
    const state = existing ?? await createInitialState(runDir)
    if (state.status === 'COMPLETED' || state.status === 'FAILED') {
      logger.info(`run already terminal status=${state.status}`)
      return state
    }
    state.status = 'RUNNING'
    await saveState(runDir, state)
    const tree = await ResearchTree.load(runDir)
    const runner = new ResearchRunner({
      provider: this.provider,
      maxCycles: options.maxCycles ?? DEFAULT_MAX_CYCLES,
      paperOptions: options.paper,
      reviewer: this.options.reviewer,
      reviewGates: this.options.reviewGates,
      humanReviewOverride: options.humanReview,
      idea: options.idea,
      brainstorm: options.brainstorm,
    })
    try {
      const result = await runner.run(runDir, state, tree, context)
      await writeLastRun(runDir)
      logger.info(`AutoResearchService.run done status=${result.status}`)
      return result
    } catch (error) {
      logger.error('AutoResearchService.run failed', error)
      await writeLastRun(runDir)
      state.status = 'FAILED'
      state.phase = 'failed'
      state.lastError = String(error)
      await saveState(runDir, state)
      await writeFailureReport(runDir, `# FAILURE_REPORT\n\n${String(error)}\n`)
      throw error
    }
  }

  async status(runDir: string): Promise<RunState | undefined> {
    return loadState(runDir)
  }

  async resume(options: ResearchRunOptions, context: ResearchRunContext): Promise<RunState> {
    return this.run(options, context)
  }
}
