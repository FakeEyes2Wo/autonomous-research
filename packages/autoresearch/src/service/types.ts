import type { RoleAgentProvider } from '../agents/types.js'
import type { HumanReviewer, ReviewGateId } from '../core/human-review.js'
import type { HumanReviewMode } from '../session/auto-mode.js'
import type { PaperOptions } from '../paper/pipeline.js'
import type { ProjectSettings } from '../settings/project-settings.js'

export interface ResearchRunnerOptions {
  provider: RoleAgentProvider
  maxCycles?: number
  paperOptions?: PaperOptions
  reviewer?: HumanReviewer
  reviewGates?: ReviewGateId[]
  humanReviewOverride?: HumanReviewMode
  brainstorm?: HumanReviewMode
  projectSettings?: ProjectSettings
}
