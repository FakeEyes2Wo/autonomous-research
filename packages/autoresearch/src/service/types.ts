import type { RoleAgentProvider } from '../agents/types.js'
import type { HumanReviewer, ReviewGateId } from '../core/human-review.js'
import type { HumanReviewMode } from '../session/auto-mode.js'
import type { PaperOptions } from '../paper/pipeline.js'
import type { ProjectSettings } from '../settings/project-settings.js'
import type { RoleExecutionContext } from '../agents/types.js'
import type { DiscoveryClock, DiscoveryProvider, DiscoverySourceStore, QueryPlannerCallback, SimilarityReviewerCallback } from '../literature/discovery/contracts.js'

export interface DiscoveryRuntimeOptions {
  providers?: readonly DiscoveryProvider[]
  sourceStore?: DiscoverySourceStore
  clock?: DiscoveryClock
  queryPlanner?: QueryPlannerCallback
  reviewer?: SimilarityReviewerCallback
  fetch?: typeof globalThis.fetch
  semanticScholarApiKey?: string
}

export interface ResearchRunnerOptions {
  acceptance?: import('../research/continuation.js').AcceptanceInput
  continuationResume?: boolean
  provider: RoleAgentProvider
  maxCycles?: number
  paperOptions?: PaperOptions
  reviewer?: HumanReviewer
  reviewGates?: ReviewGateId[]
  humanReviewOverride?: HumanReviewMode
  brainstorm?: HumanReviewMode
  deepDiveEnabled?: boolean
  deepDiveTopN?: number
  projectSettings?: ProjectSettings
  policySnapshot?: RoleExecutionContext['policySnapshot']
  discovery?: DiscoveryRuntimeOptions
}
