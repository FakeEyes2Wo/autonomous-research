/**
 * Unified paper records for the two-stage research survey.
 *
 * The LLM roles may return their own raw shapes, but after normalization the
 * pipeline consumes only `PaperRecord`. This keeps paper-wiki writer, knowledge
 * graph builder, deduplication, and index rendering on a single contract.
 */

export type WikiStage = 'survey' | 'latest'

export type SurveyRole =
  | 'survey'      // 综述论文
  | 'landmark'    // 里程碑工作
  | 'method'      // 方法论文
  | 'critique'    // 批判/分析论文
  | 'edge'        // 边缘/后续再看

export type FrontierRole = 'A' | 'B' | 'C'

/** Bibliographic metadata shared by every paper. */
export interface PaperMeta {
  id: string
  title: string
  arxivId?: string
  doi?: string
  url?: string
  year?: string
  venue?: string
  citations?: number
  abstract?: string
}

/** Analysis fields shared by paper-wiki cards and knowledge-graph nodes. */
export interface PaperInsight {
  oneLiner: string
  keyFinding: string
  weakness: string
  implication: string
}

/** Survey-stage fields: location in the field map + survey-specific taxonomy. */
export interface SurveyPaperExtras {
  stage: 'survey'
  role: SurveyRole
  clusterId?: string
  clusterIds?: string[]
  sourceSurveyIds: string[]
  isSurvey?: boolean
  surveyScope?: string
  taxonomy?: string[]
  openQuestions?: string[]
  recommendedDirections?: string[]
}

/** Latest/frontier-stage fields: targeted direction + recency increment. */
export interface FrontierPaperExtras {
  stage: 'latest'
  role: FrontierRole
  directionId: string
  sourceSurveyIds?: string[]
  whyLatest: string
  novelty: string
}

export type SurveyPaper = PaperMeta & PaperInsight & SurveyPaperExtras
export type FrontierPaper = PaperMeta & PaperInsight & FrontierPaperExtras
export type PaperRecord = SurveyPaper | FrontierPaper

export function isSurveyPaper(paper: PaperRecord): paper is SurveyPaper {
  return paper.stage === 'survey'
}

export function isFrontierPaper(paper: PaperRecord): paper is FrontierPaper {
  return paper.stage === 'latest'
}

export function paperKey(paper: Pick<PaperMeta, 'arxivId' | 'doi' | 'url' | 'title'>): string {
  const id = paper.arxivId?.trim() || paper.doi?.trim() || paper.url?.trim() || ''
  return id ? id.toLowerCase() : paper.title.trim().toLowerCase()
}
