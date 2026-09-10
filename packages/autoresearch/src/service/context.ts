import type { RoleExecutionContext } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import type { RunState } from '../core/types.js'
import { createLogger, type Logger } from '../core/utils.js'
import type { ResearchRunnerOptions } from './types.js'
import { DEFAULT_PROJECT_SETTINGS } from '../settings/schema.js'

export type PolicySnapshot = NonNullable<RoleExecutionContext['policySnapshot']>

export interface RunContext {
  readonly deps: Readonly<ResearchRunnerOptions>
  readonly runDir: string
  readonly state: RunState
  tree: ResearchTree
  readonly context: RoleExecutionContext
  readonly logger: Logger
  readonly projectDir: string
  readonly policySnapshot: PolicySnapshot
}

export function createRunContext(
  deps: Readonly<ResearchRunnerOptions>,
  runDir: string,
  state: RunState,
  tree: ResearchTree,
  context: RoleExecutionContext,
): RunContext {
  const projectDir = context.projectDir ?? runDir
  const defaults = structuredClone(DEFAULT_PROJECT_SETTINGS)
  const policySnapshot = context.policySnapshot ?? deps.policySnapshot ?? {
    version: defaults.version,
    model: defaults.model,
    modelRouting: defaults.modelRouting,
    workflow: defaults.workflow,
    budget: defaults.budget,
  }
  const effectiveContext: RoleExecutionContext = { ...context, projectDir, policySnapshot }
  return { deps, runDir, state, tree, context: effectiveContext, logger: createLogger(runDir), projectDir, policySnapshot }
}

export async function reloadTree(ctx: RunContext): Promise<void> {
  ctx.tree = await ResearchTree.load(ctx.runDir)
}
