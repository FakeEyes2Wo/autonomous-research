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
import { loadProjectSecrets, loadProjectSettings } from '../settings/project-settings.js'

export interface ResearchRunOptions {
  runDir: string
  projectDir?: string
  candidatePath?: string
  profilePath?: string
  maxCycles?: number
  paper?: PaperOptions
  humanReview?: HumanReviewMode
  brainstorm?: HumanReviewMode
}

export type ResearchRunContext = RoleExecutionContext

export interface AutoResearchServiceOptions {
  reviewer?: HumanReviewer
  reviewGates?: ReviewGateId[]
}

export class AutoResearchService {
  private readonly deps: Readonly<{ provider: RoleAgentProvider; options: AutoResearchServiceOptions }>

  constructor(provider: RoleAgentProvider, options: AutoResearchServiceOptions = {}) {
    this.deps = { provider, options }
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
    const projectDir = options.projectDir ?? runDir
    const projectSettings = await loadProjectSettings(projectDir)
    const projectSecrets = await loadProjectSecrets(projectDir)
    const paperOptions: PaperOptions = {
      ...(options.paper ?? {}),
      ...(projectSettings.figureApi.enabled
        ? {
            figureApi: {
              ...projectSettings.figureApi,
              apiKey: projectSecrets.figureApiKey,
            },
          }
        : {}),
    }
    const runner = new ResearchRunner({
      provider: this.deps.provider,
      maxCycles: options.maxCycles ?? DEFAULT_MAX_CYCLES,
      paperOptions,
      reviewer: this.deps.options.reviewer,
      reviewGates: this.deps.options.reviewGates,
      humanReviewOverride: options.humanReview,
      brainstorm: options.brainstorm,
      projectSettings,
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
