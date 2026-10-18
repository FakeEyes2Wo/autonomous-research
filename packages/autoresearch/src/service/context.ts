import type { RoleExecutionContext } from '../agents/types.js'
import { ResearchTree } from '../core/research-tree.js'
import type { RunState } from '../core/types.js'
import { createLogger, type Logger } from '../core/utils.js'
import type { ResearchRunnerOptions } from './types.js'
import { DEFAULT_PROJECT_SETTINGS } from '../settings/schema.js'
import { createPolicySnapshot } from '../policy/model-routing.js'

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
  const sourceSettings = deps.projectSettings ?? defaults
  const policySnapshot = context.policySnapshot ?? deps.policySnapshot ?? { ...createPolicySnapshot(sourceSettings), model: structuredClone(sourceSettings.model) }
  const effectiveContext: RoleExecutionContext = { ...context, projectDir, policySnapshot, ...(deps.discovery?.sourceStore ? { discoverySourceStore: deps.discovery.sourceStore } : {}) }
  return { deps, runDir, state, tree, context: effectiveContext, logger: createLogger(runDir), projectDir, policySnapshot }
}

export async function reloadTree(ctx: RunContext): Promise<void> {
  ctx.tree = await ResearchTree.load(ctx.runDir)
}
