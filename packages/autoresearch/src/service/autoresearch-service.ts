import { DEFAULT_MAX_CYCLES } from '../core/constants.js'
import { ResearchTree } from '../core/research-tree.js'
import { createInitialState, loadState, saveState } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { ensureDir } from '../core/utils.js'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { writeFailureReport } from '../domain/paper.js'
import { ResearchRunner } from './runner.js'

export interface ResearchRunOptions {
  runDir: string
  candidatePath?: string
  profilePath?: string
  maxCycles?: number
}

export interface ResearchRunContext extends RoleExecutionContext {}

export class AutoResearchService {
  private readonly provider: RoleAgentProvider

  constructor(provider: RoleAgentProvider) {
    this.provider = provider
  }

  async run(options: ResearchRunOptions, context: ResearchRunContext): Promise<RunState> {
    const runDir = options.runDir
    await ensureDir(runDir)
    const existing = await loadState(runDir)
    const state = existing ?? await createInitialState(runDir)
    if (state.status === 'COMPLETED' || state.status === 'FAILED') {
      return state
    }
    state.status = 'RUNNING'
    await saveState(runDir, state)
    const tree = await ResearchTree.load(runDir)
    const runner = new ResearchRunner({
      provider: this.provider,
      maxCycles: options.maxCycles ?? DEFAULT_MAX_CYCLES,
    })
    try {
      return await runner.run(runDir, state, tree, context)
    } catch (error) {
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
