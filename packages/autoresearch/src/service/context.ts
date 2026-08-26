import type { RoleExecutionContext } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import type { RunState } from '../core/types.js'
import { createLogger, type Logger } from '../core/utils.js'
import type { ResearchRunnerOptions } from './types.js'

export interface RunContext {
  readonly deps: Readonly<ResearchRunnerOptions>
  readonly runDir: string
  readonly state: RunState
  tree: ResearchTree
  readonly context: RoleExecutionContext
  readonly logger: Logger
}

export function createRunContext(
  deps: Readonly<ResearchRunnerOptions>,
  runDir: string,
  state: RunState,
  tree: ResearchTree,
  context: RoleExecutionContext,
): RunContext {
  return { deps, runDir, state, tree, context, logger: createLogger(runDir) }
}

export async function reloadTree(ctx: RunContext): Promise<void> {
  ctx.tree = await ResearchTree.load(ctx.runDir)
}
