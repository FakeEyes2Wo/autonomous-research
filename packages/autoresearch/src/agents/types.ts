export type RoleName =
  | 'rubric-generator'
  | 'rubric-reviewer'
  | 'planner'
  | 'research-worker'
  | 'evidence-agent'
  | 'supervisor'
  | 'writer'

export interface ParentAgentLike {
  readonly id: string
  readonly session: { readonly id: string }
}

export interface RoleExecutionContext {
  readonly parent: ParentAgentLike
  readonly signal: AbortSignal
}

export interface RoleInput {
  readonly runDir: string
  readonly cycle?: number
  readonly candidate?: string
  readonly profile?: string
  readonly rubric?: string
  readonly plan?: string
  readonly treeSummary?: string
  readonly evidenceChainPath?: string
}

export interface RoleOutput {
  readonly text: string
  readonly structured?: unknown
  readonly stopReason: string
}

export interface RoleAgentProvider {
  run(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput>
}
