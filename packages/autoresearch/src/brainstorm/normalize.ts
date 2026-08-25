import type {
  FrontierPaper,
  FrontierRole,
  PaperMeta,
  PaperRecord,
  SurveyPaper,
  SurveyRole,
} from './paper-record.js'
import { paperKey } from './paper-record.js'

/**
 * Raw shapes returned by the LLM roles. These are intentionally loose: the
 * role prompts only need to return real paper data, while normalization makes
 * the downstream contract strict.
 */
export interface RawSurveyPaper extends Partial<PaperMeta> {
  clusterId?: string
  clusterIds?: string[]
  role?: string
  isSurvey?: boolean
  sourceSurveyIds?: string[]
  oneLiner?: string
  keyFinding?: string
  weakness?: string
  implication?: string
  surveyScope?: string
  taxonomy?: string[]
  openQuestions?: string[]
  recommendedDirections?: string[]
}

export interface RawSurveyInfo extends Partial<PaperMeta> {
  scope?: string
  taxonomy?: string[]
  openQuestions?: string[]
  recommendedDirections?: string[]
}

export interface RawCluster {
  id?: string
  name?: string
  summary?: string
  sourceSurveyIds?: string[]
  openQuestions?: string[]
}

export interface RawSurvey {
  overview?: string
  surveys?: RawSurveyInfo[]
  clusters?: RawCluster[]
  papers?: RawSurveyPaper[]
}

export interface RawFrontierPaper extends Partial<PaperMeta> {
  directionId?: string
  role?: string
  whyLatest?: string
  novelty?: string
  sourceSurveyIds?: string[]
  oneLiner?: string
  keyFinding?: string
  weakness?: string
  implication?: string
}

export interface RawFrontier {
  papers?: RawFrontierPaper[]
  expectedMin?: number
}

const SURVEY_ROLES: readonly SurveyRole[] = ['survey', 'landmark', 'method', 'critique', 'edge']
const FRONTIER_ROLES: readonly FrontierRole[] = ['A', 'B', 'C']

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned || undefined
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.map((item) => cleanString(item)).filter((item): item is string => Boolean(item))
  return out.length > 0 ? out : undefined
}

function cleanNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function toMeta(raw: Partial<PaperMeta>, fallbackId: string): PaperMeta {
  return {
    id: cleanString(raw.id) ?? fallbackId,
    title: cleanString(raw.title) ?? 'Untitled paper',
    arxivId: cleanString(raw.arxivId),
    doi: cleanString(raw.doi),
    url: cleanString(raw.url),
    year: cleanString(raw.year),
    venue: cleanString(raw.venue),
    citations: cleanNumber(raw.citations),
    abstract: cleanString(raw.abstract),
  }
}

function asSurveyRole(value: unknown, isSurvey?: boolean): SurveyRole {
  const raw = cleanString(value)
  if (raw && (SURVEY_ROLES as readonly string[]).includes(raw)) return raw as SurveyRole
  return isSurvey ? 'survey' : 'method'
}

function asFrontierRole(value: unknown): FrontierRole {
  const raw = cleanString(value)?.toUpperCase()
  if (raw && (FRONTIER_ROLES as readonly string[]).includes(raw)) return raw as FrontierRole
  return 'B'
}

function surveyInsight(paper: RawSurveyPaper): {
  oneLiner: string
  keyFinding: string
  weakness: string
  implication: string
} {
  return {
    oneLiner: cleanString(paper.oneLiner) ?? cleanString(paper.abstract) ?? '',
    keyFinding: cleanString(paper.keyFinding) ?? cleanString(paper.abstract) ?? '',
    weakness: cleanString(paper.weakness) ?? '',
    implication: cleanString(paper.implication) ?? '',
  }
}

/**
 * Convert Stage 1 raw survey output into strict SurveyPaper[].
 *
 * Survey metadata is appended as PaperRecord if the role did not already put
 * the survey paper in `papers` with isSurvey=true.
 */
export function normalizeSurveyPapers(survey: RawSurvey, clusters: RawCluster[] = survey.clusters ?? []): SurveyPaper[] {
  const papers = (survey.papers ?? []).map((raw, index): SurveyPaper => {
    const meta = toMeta(raw, `s${String(index + 1).padStart(3, '0')}`)
    const isSurvey = raw.isSurvey === true || raw.role === 'survey'
    const role = asSurveyRole(raw.role, isSurvey)
    const clusterIds = cleanStringArray(raw.clusterIds) ?? (raw.clusterId ? [raw.clusterId] : undefined)
    return {
      ...meta,
      ...surveyInsight(raw),
      stage: 'survey',
      role,
      clusterId: cleanString(raw.clusterId),
      clusterIds,
      sourceSurveyIds: cleanStringArray(raw.sourceSurveyIds) ?? [],
      isSurvey,
      surveyScope: cleanString(raw.surveyScope),
      taxonomy: cleanStringArray(raw.taxonomy),
      openQuestions: cleanStringArray(raw.openQuestions),
      recommendedDirections: cleanStringArray(raw.recommendedDirections),
    }
  })

  const existingKeys = new Set(papers.map((paper) => paperKey(paper)))
  const surveyInfos = survey.surveys ?? []
  for (const [index, info] of surveyInfos.entries()) {
    if (existingKeys.has(paperKey(toMeta(info, '')))) continue
    const meta = toMeta(info, `s${String(papers.length + index + 1).padStart(3, '0')}`)
    const sourceIds = clusters
      .filter((cluster) => (cluster.sourceSurveyIds ?? []).includes(meta.id))
      .map((cluster) => cluster.id ?? '')
      .filter(Boolean)
    const clusterIds = sourceIds.length > 0 ? sourceIds : (clusters.map((cluster) => cluster.id).filter((id): id is string => Boolean(id)) ?? [])
    papers.push({
      ...meta,
      oneLiner: cleanString(info.scope) ?? cleanString(info.title) ?? '',
      keyFinding: cleanString(info.scope) ?? '',
      weakness: '',
      implication: '',
      stage: 'survey',
      role: 'survey',
      clusterIds,
      sourceSurveyIds: [],
      isSurvey: true,
      surveyScope: cleanString(info.scope),
      taxonomy: cleanStringArray(info.taxonomy),
      openQuestions: cleanStringArray(info.openQuestions),
      recommendedDirections: cleanStringArray(info.recommendedDirections),
    })
  }

  const seen = new Set<string>()
  const unique: SurveyPaper[] = []
  for (const paper of papers) {
    const key = paperKey(paper)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(paper)
  }
  return unique
}

/**
 * Convert Stage 2 raw frontier output into strict FrontierPaper[].
 */
export function normalizeFrontierPapers(frontier: RawFrontier): FrontierPaper[] {
  return (frontier.papers ?? []).map((raw, index): FrontierPaper => {
    const meta = toMeta(raw, `l${String(index + 1).padStart(3, '0')}`)
    return {
      ...meta,
      oneLiner: cleanString(raw.oneLiner) ?? cleanString(raw.abstract) ?? '',
      keyFinding: cleanString(raw.keyFinding) ?? cleanString(raw.abstract) ?? '',
      weakness: cleanString(raw.weakness) ?? '',
      implication: cleanString(raw.implication) ?? '',
      stage: 'latest',
      role: asFrontierRole(raw.role),
      directionId: cleanString(raw.directionId) ?? 'd1',
      sourceSurveyIds: cleanStringArray(raw.sourceSurveyIds),
      whyLatest: cleanString(raw.whyLatest) ?? '',
      novelty: cleanString(raw.novelty) ?? '',
    }
  })
}

/**
 * Merge survey and frontier records into one deduplicated PaperRecord[].
 *
 * A duplicate with the same bibliographic key keeps the survey entry when it is
 * itself a survey; otherwise the frontier entry wins because it carries the
 * directed latest-context fields.
 */
export function mergePaperRecords(surveyPapers: SurveyPaper[], frontierPapers: FrontierPaper[]): PaperRecord[] {
  const records: PaperRecord[] = []
  const indexByKey = new Map<string, number>()
  for (const paper of [...surveyPapers, ...frontierPapers]) {
    const key = paperKey(paper)
    const existingIndex = indexByKey.get(key)
    if (existingIndex === undefined) {
      indexByKey.set(key, records.length)
      records.push(paper)
      continue
    }
    const existing = records[existingIndex]
    if (!existing) continue
    if (existing.stage === 'survey' && existing.isSurvey) continue
    records[existingIndex] = paper
  }
  return records
}
