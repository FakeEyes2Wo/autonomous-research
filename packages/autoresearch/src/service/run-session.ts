import { reloadTree, type RunContext } from './context.js'

export type { RunContext as RunSession } from './context.js'

/**
 * Central tree refresh point. Use this everywhere the session tree needs to be
 * reloaded from disk so callers cannot forget to update `session.tree`.
 */
export async function reloadSessionTree(session: RunContext): Promise<void> {
  await reloadTree(session)
}
