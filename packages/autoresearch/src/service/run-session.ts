import type { RoleExecutionContext } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import type { RunState } from '../core/types.js'

export interface RunSession {
  runDir: string
  state: RunState
  tree: ResearchTree
  context: RoleExecutionContext
}

/**
 * Central tree refresh point. Use this everywhere the session tree needs to be
 * reloaded from disk so callers cannot forget to update `session.tree`.
 */
export async function reloadSessionTree(session: RunSession): Promise<void> {
  session.tree = await ResearchTree.load(session.runDir)
}
