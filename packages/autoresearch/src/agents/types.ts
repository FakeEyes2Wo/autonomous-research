export type RoleName =
  | 'rubric-generator'
  | 'rubric-reviewer'
  | 'idea-generator'
  | 'idea-falsifiability'
  | 'idea-reviewer'
  | 'hypothesis-reviser'
  | 'planner'
  | 'minimal-verifier'
  | 'experiment-designer'
  | 'experiment-reflexion'
  | 'model-scout'
  | 'result-reflexion'
  | 'insight-abstractor'
  | 'research-worker'
  | 'evidence-agent'
  | 'supervisor'
  | 'writer'
  | 'paper-planner'
  | 'contract-negotiator'
  | 'contract-reviewer'
  | 'figure-generator'
  | 'figure-reflexion'
  | 'proof-checker'
  | 'claim-auditor'
  | 'citation-auditor'
  | 'kill-argument-reviewer'
  | 'paper-reviewer'
  | 'paper-polisher'
  | 'final-report-writer'
  | 'paper-survey'
  | 'direction-select'
  | 'paper-frontier-miner'
  | 'paper-wiki-writer'
  | 'brainstorm'

export interface ParentAgentLike {
  readonly id: string
  readonly session: { readonly id: string }
}

export interface RoleExecutionContext {
  readonly parent: ParentAgentLike
  readonly signal: AbortSignal
}

/**
 * Fields shared by every role/domain.
 */
export interface CommonRoleInput {
  readonly runDir: string
  readonly cycle?: number
  readonly plan?: string
}

/**
 * Research-loop input fields.
 */
export interface ResearchRoleInput {
  readonly idea?: string
  readonly profile?: string
  readonly rubric?: string
  readonly treeSummary?: string
  readonly ideaPackage?: string
  readonly minimalVerification?: string
  readonly experimentDesign?: string
  readonly reflexion?: string
  readonly failureDirections?: string
  readonly insight?: string
  readonly modelScout?: string
}

/**
 * Brainstorm pre-phase input fields.
 */
export interface BrainstormRoleInput {
  readonly perspective?: string
}

/**
 * Paper-writing input fields.
 */
export interface PaperRoleInput {
  readonly evidenceChainPath?: string
  readonly paperPlan?: string
  readonly paperMatrix?: string
  readonly paperTemplate?: string
  readonly paperContract?: string
  readonly paperFigures?: string
  readonly styleProfile?: string
  readonly venue?: string
  readonly assurance?: string
  readonly paperPath?: string
}

/**
 * Flat input bag shared by all roles. The `sections` list in each role spec
 * controls which fields are rendered for that role, so irrelevant fields never
 * leak into the prompt.
 */
export interface RoleInput extends CommonRoleInput, ResearchRoleInput, BrainstormRoleInput, PaperRoleInput {}

export interface RoleOutput {
  readonly text: string
  readonly structured?: unknown
  readonly stopReason: string
}

export interface RoleAgentProvider {
  run(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput>
}
