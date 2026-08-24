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
  | 'paper-miner'
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

export interface RoleInput {
  readonly runDir: string
  readonly cycle?: number
  readonly candidate?: string
  readonly profile?: string
  readonly rubric?: string
  readonly plan?: string
  readonly treeSummary?: string
  readonly evidenceChainPath?: string
  readonly ideaPackage?: string
  readonly paperPlan?: string
  readonly paperMatrix?: string
  readonly paperTemplate?: string
  readonly paperContract?: string
  readonly paperFigures?: string
  readonly styleProfile?: string
  readonly venue?: string
  readonly assurance?: string
  readonly paperPath?: string
  readonly minimalVerification?: string
  readonly experimentDesign?: string
  readonly reflexion?: string
  readonly failureDirections?: string
  readonly insight?: string
  readonly modelScout?: string
  readonly perspective?: string
}

export interface RoleOutput {
  readonly text: string
  readonly structured?: unknown
  readonly stopReason: string
}

export interface RoleAgentProvider {
  run(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput>
}
