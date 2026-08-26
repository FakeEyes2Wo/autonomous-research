import type { HumanReviewMode } from '../session/auto-mode.js'
import type { PaperOptions } from '../paper/pipeline.js'
import type { ResearchRunOptions } from '../service/autoresearch-service.js'

/**
 * Tool-facing paper options. The tool schema exposes a few extra UI-only
 * switches (illustration, autoProceed, humanCheckpoint) that are not part of
 * PaperOptions; this type keeps the tool's contract explicit without leaking
 * those unknown fields into the service layer.
 */
export interface PaperToolOptions {
  venue?: string
  assurance?: 'draft' | 'submission'
  effort?: 'lite' | 'balanced' | 'max' | 'beast'
  illustration?: string
  styleRef?: string
  autoProceed?: boolean
  maxImprovementRounds?: number
  humanCheckpoint?: boolean
}

function asHumanReviewMode(value: unknown): HumanReviewMode | undefined {
  return typeof value === 'string' ? value as HumanReviewMode : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function toPaperToolOptions(value: unknown): PaperToolOptions | undefined {
  if (typeof value !== 'object' || value === null) return undefined

  const raw = value as Record<string, unknown>
  const paper: PaperToolOptions = {}
  const venue = asString(raw.venue)
  const assurance = asString(raw.assurance)
  const effort = asString(raw.effort)
  const illustration = asString(raw.illustration)
  const styleRef = asString(raw.styleRef)
  const autoProceed = asBoolean(raw.autoProceed)
  const maxImprovementRounds = asNumber(raw.maxImprovementRounds)
  const humanCheckpoint = asBoolean(raw.humanCheckpoint)

  if (venue !== undefined) paper.venue = venue
  if (assurance !== undefined) paper.assurance = assurance as PaperToolOptions['assurance']
  if (effort !== undefined) paper.effort = effort as PaperToolOptions['effort']
  if (illustration !== undefined) paper.illustration = illustration
  if (styleRef !== undefined) paper.styleRef = styleRef
  if (autoProceed !== undefined) paper.autoProceed = autoProceed
  if (maxImprovementRounds !== undefined) paper.maxImprovementRounds = maxImprovementRounds
  if (humanCheckpoint !== undefined) paper.humanCheckpoint = humanCheckpoint

  return Object.keys(paper).length > 0 ? paper : undefined
}

function toPaperOptions(value: unknown): PaperOptions | undefined {
  const toolOptions = toPaperToolOptions(value)
  if (!toolOptions) return undefined

  const paper: PaperOptions = {}
  if (toolOptions.venue !== undefined) paper.venue = toolOptions.venue
  if (toolOptions.assurance !== undefined) paper.assurance = toolOptions.assurance
  if (toolOptions.effort !== undefined) paper.effort = toolOptions.effort
  if (toolOptions.styleRef !== undefined) paper.styleRef = toolOptions.styleRef
  if (toolOptions.maxImprovementRounds !== undefined) paper.maxImprovementRounds = toolOptions.maxImprovementRounds

  return Object.keys(paper).length > 0 ? paper : undefined
}

export function toResearchRunOptions(args: Record<string, unknown>): ResearchRunOptions {
  return {
    runDir: String(args.runDir),
    projectDir: asString(args.projectDir),
    candidatePath: asString(args.candidatePath),
    profilePath: asString(args.profilePath),
    maxCycles: asNumber(args.maxCycles),
    humanReview: asHumanReviewMode(args.humanReview),
    brainstorm: asHumanReviewMode(args.brainstorm),
    paper: toPaperOptions(args.paper),
  }
}
