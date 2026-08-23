import { existsSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createLogger, DEFAULT_MAX_CYCLES, CANDIDATE_FILE, INPUT_DIR, PROFILE_FILE } from '../core/utils.js'
import { ResearchTree } from '../core/research-tree.js'
import { createInitialState, loadState, saveState } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { ensureDir, safeResolve, writeText } from '../core/utils.js'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import type { HumanReviewer, ReviewGateId } from '../core/human-review.js'
import { DEFAULT_REVIEW_GATES } from '../core/human-review.js'
import { writeFailureReport } from '../domain/files.js'
import { writeLastRun } from '../session/last-run.js'
import { ResearchRunner } from './runner.js'
import type { PaperOptions } from '../paper/pipeline.js'

const AUTO_CANDIDATE = `## Direction

Autonomously discover and commit to one specific, falsifiable, high-impact machine-learning research direction by searching recent literature, then formulate testable hypotheses around it.

## A-priori ideas

- Prefer directions where cheap, real-data experiments can produce decisive evidence within one or two cycles.
- Avoid topics that require large-scale pretraining or private datasets.
`

const AUTO_PROFILE = `# PROFILE

- Fully autonomous run: the system chooses its own research direction and freezes it during idea generation.
- Allowed: public literature/web search, local code, statistical analysis, small real-data experiments.
- Forbidden: reading hidden target papers, fabricating citations or results.
- Prefer recent papers, widely used public datasets, and pretrained backbones.
`

async function prepareInputs(runDir: string, candidatePath?: string, profilePath?: string): Promise<void> {
  const candidateFile = safeResolve(runDir, INPUT_DIR, CANDIDATE_FILE)
  const profileFile = safeResolve(runDir, PROFILE_FILE)

  if (candidatePath) {
    await ensureDir(safeResolve(runDir, INPUT_DIR))
    const src = isAbsolute(candidatePath) ? candidatePath : safeResolve(runDir, candidatePath)
    await copyFile(src, candidateFile)
  } else if (!existsSync(candidateFile)) {
    await writeText(candidateFile, AUTO_CANDIDATE)
  }

  if (profilePath) {
    const src = isAbsolute(profilePath) ? profilePath : safeResolve(runDir, profilePath)
    await copyFile(src, profileFile)
  } else if (!existsSync(profileFile)) {
    await writeText(profileFile, AUTO_PROFILE)
  }
}

export interface ResearchRunOptions {
  runDir: string
  candidatePath?: string
  profilePath?: string
  maxCycles?: number
  paper?: PaperOptions
  humanReview?: 'auto' | 'on' | 'off'
}

export interface ResearchRunContext extends RoleExecutionContext {}

export interface AutoResearchServiceOptions {
  reviewer?: HumanReviewer
  reviewGates?: ReviewGateId[]
}

export class AutoResearchService {
  private readonly provider: RoleAgentProvider
  private readonly reviewer?: HumanReviewer
  private readonly reviewGates: ReviewGateId[]

  constructor(provider: RoleAgentProvider, options: AutoResearchServiceOptions = {}) {
    this.provider = provider
    this.reviewer = options.reviewer
    this.reviewGates = options.reviewGates ?? [...DEFAULT_REVIEW_GATES]
  }

  async run(options: ResearchRunOptions, context: ResearchRunContext): Promise<RunState> {
    const runDir = options.runDir
    const logger = createLogger(runDir)
    logger.info(`AutoResearchService.run start runDir=${runDir}`)
    await ensureDir(runDir)
    await prepareInputs(runDir, options.candidatePath, options.profilePath)
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
      reviewer: this.reviewer,
      reviewGates: this.reviewGates,
      humanReviewOverride: options.humanReview,
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
