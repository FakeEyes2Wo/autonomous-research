import type { HumanReviewMode } from '../session/auto-mode.js'
import type { PaperOptions } from '../paper/pipeline.js'
import type { ResearchRunOptions } from '../service/autoresearch-service.js'
import type { FailureReportImport } from '../service/failure-import.js'
import { parseAcceptance, parseRecovery } from '../research/continuation.js'

export function toFailureReportImport(value: unknown): FailureReportImport | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || typeof (value as FailureReportImport).sourceRunId !== 'string' || typeof (value as FailureReportImport).sourcePath !== 'string') throw new TypeError('failureReport requires sourceRunId and sourcePath')
  return { sourceRunId: (value as FailureReportImport).sourceRunId, sourcePath: (value as FailureReportImport).sourcePath }
}

/**
 * Tool-facing paper options. The tool schema exposes a few extra UI-only
 * switches (illustration, autoProceed, humanCheckpoint) that are not part of
 * PaperOptions; this type keeps the tool's contract explicit without leaking
 * those unknown fields into the service layer.
 */
export interface PaperToolOptions {
  templateDir?: string
  templateFile?: string
  layoutProfile?: PaperOptions['layoutProfile']
  layoutInspection?: boolean
  supportsImageInput?: boolean
  reviewBudget?: PaperOptions['reviewBudget']
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
  for (const key of ['templateDir', 'templateFile'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new TypeError(`paper ${key} must be a nonempty path`)
      paper[key] = raw[key]
    }
  }
  for (const key of ['layoutInspection', 'supportsImageInput'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'boolean') throw new TypeError(`paper ${key} must be boolean`)
      paper[key] = raw[key]
    }
  }
  if (raw.reviewBudget !== undefined) {
    if (!raw.reviewBudget || typeof raw.reviewBudget !== 'object' || Array.isArray(raw.reviewBudget)) throw new TypeError('paper reviewBudget must be an object')
    const budget = raw.reviewBudget as Record<string, unknown>
    paper.reviewBudget = {}
    for (const key of ['maxRequests', 'maxRounds'] as const) if (budget[key] !== undefined) {
      if (!Number.isSafeInteger(budget[key]) || Number(budget[key]) < (key === 'maxRequests' ? 1 : 0) || Number(budget[key]) > (key === 'maxRequests' ? 1000 : 50)) throw new TypeError(`paper reviewBudget.${key} is invalid`)
      paper.reviewBudget[key] = Number(budget[key])
    }
  }
  if (raw.layoutProfile !== undefined) {
    if (!raw.layoutProfile || typeof raw.layoutProfile !== 'object' || Array.isArray(raw.layoutProfile)) throw new TypeError('paper layoutProfile must be an object')
    const profile = raw.layoutProfile as Record<string, unknown>
    const numeric = (value: unknown, keys: string[]): Record<string, number> => {
      if (!value || typeof value !== 'object') throw new TypeError('paper layoutProfile has missing geometry')
      return Object.fromEntries(keys.map(key => {
        const n = (value as Record<string, unknown>)[key]
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new TypeError('paper layoutProfile has invalid geometry')
        return [key, n]
      }))
    }
    const page = profile.page as Record<string, unknown> | undefined
    const clean = { page: { ...numeric(page, ['widthPt', 'heightPt']), marginPt: numeric(page?.marginPt, ['top', 'right', 'bottom', 'left']) }, columns: numeric(profile.columns, ['count', 'widthPt', 'gutterPt']), ...(profile.typography ? { typography: numeric(profile.typography, ['bodyPt', 'captionPt', ...(typeof (profile.typography as Record<string, unknown>).lineHeightPt === 'number' ? ['lineHeightPt'] : [])]) } : {}) } as unknown as NonNullable<PaperOptions['layoutProfile']>
    if (profile.figure !== undefined) {
      const figure = profile.figure as Record<string, unknown>
      if (!figure || !Array.isArray(figure.allowedFormats) || !figure.allowedFormats.every(f => typeof f === 'string')) throw new TypeError('paper layoutProfile has invalid figure formats')
      clean.figure = { ...numeric(figure, ['maxWidthPt', 'captionWidthPt', ...(figure.maxHeightPt !== undefined ? ['maxHeightPt'] : [])]), allowedFormats: [...figure.allowedFormats] } as NonNullable<typeof clean.figure>
    }
    paper.layoutProfile = clean
  }
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

export function toPaperOptions(value: unknown): PaperOptions | undefined {
  const toolOptions = toPaperToolOptions(value)
  if (!toolOptions) return undefined

  const paper: PaperOptions = {}
  for (const key of ['templateDir', 'templateFile', 'layoutProfile', 'layoutInspection', 'supportsImageInput', 'reviewBudget'] as const) {
    if (toolOptions[key] !== undefined) Object.assign(paper, { [key]: toolOptions[key] })
  }
  if (toolOptions.venue !== undefined) paper.venue = toolOptions.venue
  if (toolOptions.assurance !== undefined) paper.assurance = toolOptions.assurance
  if (toolOptions.effort !== undefined) paper.effort = toolOptions.effort
  if (toolOptions.styleRef !== undefined) paper.styleRef = toolOptions.styleRef
  if (toolOptions.maxImprovementRounds !== undefined) paper.maxImprovementRounds = toolOptions.maxImprovementRounds

  return Object.keys(paper).length > 0 ? paper : undefined
}

export function toResearchRunOptions(args: Record<string, unknown>): ResearchRunOptions {
  return {
    ...(args.acceptance !== undefined ? { acceptance: parseAcceptance(args.acceptance) } : {}),
    ...(args.recovery !== undefined ? { recovery: parseRecovery(args.recovery) } : {}),
    runDir: String(args.runDir),
    projectDir: asString(args.projectDir),
    candidatePath: asString(args.candidatePath),
    profilePath: asString(args.profilePath),
    maxCycles: asNumber(args.maxCycles),
    humanReview: asHumanReviewMode(args.humanReview),
    brainstorm: asHumanReviewMode(args.brainstorm),
    paper: toPaperOptions(args.paper),
    failureReport: toFailureReportImport(args.failureReport),
  }
}
