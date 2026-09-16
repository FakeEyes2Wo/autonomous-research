import type { RoleName } from './roles/index.js'
import type { ProjectSettings } from '../settings/schema.js'
import type { RequestLedger } from '../policy/request-ledger.js'
import type { ResearchContextRequest } from '../research-context/index.js'
export type { RoleName } from './roles/index.js'

export interface ParentAgentLike {
  readonly id: string
  readonly session: { readonly id: string }
  readonly options?: { readonly provider?: string; readonly model?: string }
}

export interface RoleExecutionContext {
  readonly parent: ParentAgentLike
  readonly signal: AbortSignal
  readonly projectDir?: string
  readonly runId?: string
  readonly policySnapshot?: Pick<ProjectSettings, 'version'|'model'|'modelRouting'|'workflow'|'budget'>
  readonly requestLedger?: RequestLedger
}

/**
 * Fields shared by every role/domain.
 */
export interface CommonRoleInput {
  readonly researchContext?: ResearchContextRequest
  readonly runDir: string
  readonly projectDir?: string
  readonly taskId?: string
  readonly cycle?: number
  readonly plan?: string
  /** Contextual output root; intentionally excluded from role fingerprints. */
  readonly workDir?: string
  /** Bounded, non-secret summary of outer AutoResearch orchestration limits. */
  readonly runtimeConstraints?: string
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
  readonly relatedPapers?: string
  readonly baselines?: string
  readonly revisedIdeaPackage?: string
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
  readonly figureImages?: string[]
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
  readonly childId?: string
}

export interface RoleAgentProvider {
  run(role: RoleName, input: RoleInput, context: RoleExecutionContext): Promise<RoleOutput>
}
