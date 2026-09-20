import type { RoleAgentProvider } from '../agents/types.js'
import type { HumanReviewer, ReviewGateId } from '../core/human-review.js'
import type { HumanReviewMode } from '../session/auto-mode.js'
import type { PaperOptions } from '../paper/pipeline.js'
import type { ProjectSettings } from '../settings/project-settings.js'
import type { RoleExecutionContext } from '../agents/types.js'

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
}
