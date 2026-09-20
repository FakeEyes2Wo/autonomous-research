import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import type { HumanReviewer } from '../core/human-review.js'
import type { HumanReviewMode } from '../session/auto-mode.js'
import type { FigureApiSettings } from '../settings/project-settings.js'
import type { PaperLayoutGeometryInput, PreparedPaperLayout } from './index.js'

export interface PaperOptions {
  venue?: string
  assurance?: 'draft' | 'submission'
  effort?: 'lite' | 'balanced' | 'max' | 'beast'
  styleRef?: string
  maxImprovementRounds?: number
  humanReviewer?: HumanReviewer
  humanReviewOverride?: HumanReviewMode
  figureApi?: FigureApiSettings
  supportsImageInput?: boolean
  templateDir?: string
  templateFile?: string
  layoutProfile?: PaperLayoutGeometryInput
  layoutInspection?: boolean
  reviewBudget?: { maxRequests?: number; maxRounds?: number }
}

export interface PaperDependencies {
  readonly provider: RoleAgentProvider
  readonly options: Readonly<PaperOptions>
}

/**
 * Filesystem locations relevant to the paper-writing pipeline.
 */
export interface PaperPaths {
  runDir: string
  paperDir: string
}

/**
 * In-memory content passed between paper phases. Every field is derived from
 * the run directory so phases can stay free of ad-hoc positional arguments.
 */
export interface PaperContent {
  planText: string
  matrixText: string
  contractText: string
  figuresLatex: string
  styleProfile?: string
  evidencePath: string
}

/**
 * One paper-writing session: stable dependencies, location, already-loaded
 * content, and the agent runtime context.
 */
export interface PaperContext {
  readonly deps: PaperDependencies
  readonly paths: PaperPaths
  readonly content: PaperContent
  readonly agentContext: RoleExecutionContext
  readonly layout?: PreparedPaperLayout
}
