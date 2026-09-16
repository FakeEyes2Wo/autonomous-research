import { assertWork, assertDocumentVersion, assertAnalysisCard, type AnalysisCard, type Catalog, type DocumentVersion, type Work } from './contracts.js'

export type PaperHeaderStatus = 'verified' | 'unverified' | 'unknown' | 'unread'
export type PaperHeaderOrigin = 'system' | 'source_metadata' | 'author_reported' | 'agent_analysis' | 'mixed'

export interface PaperHeaderCell {
  values: string[]
  display: string
  status: PaperHeaderStatus
  origin: PaperHeaderOrigin
}

/** The 15 directory columns from the literature design, kept separate from raw catalog records. */
export interface PaperHeaderProjection {
  paperId: PaperHeaderCell
  title: PaperHeaderCell
  authors: PaperHeaderCell
  yearVersion: PaperHeaderCell
  publicationStatus: PaperHeaderCell
  researchQuestion: PaperHeaderCell
  methods: PaperHeaderCell
  experimentTaskData: PaperHeaderCell
  coreResults: PaperHeaderCell
  limitationsCounterevidence: PaperHeaderCell
  currentResearchRelationship: PaperHeaderCell
  baselineFit: PaperHeaderCell
  readingCoverage: PaperHeaderCell
  sourceLocation: PaperHeaderCell
  ingestionStatus: PaperHeaderCell
}

export interface PaperRow {
  work: Work; versions: DocumentVersion[]; cards: AnalysisCard[]
  acquisition: 'metadata_only' | 'abstract_only' | 'acquired' | 'unavailable'
  parse: 'pending' | 'partial' | 'complete' | 'failed'
  index: 'not_indexed' | 'indexed'; exposureReceiptIds: string[]
  header: PaperHeaderProjection
}

function headerCell(values: string[], status: PaperHeaderStatus, origin: PaperHeaderOrigin): PaperHeaderCell {
  const unique = [...new Set(values.map(value => value.trim()).filter(Boolean))]
  return { values: unique, display: unique.length > 0 ? unique.join('; ') : status, status, origin }
}

function primitives(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)]
  if (Array.isArray(value)) return value.flatMap(primitives)
  return []
}

function analysisCell(cards: AnalysisCard[], fields: readonly { key: string; label?: string }[]): PaperHeaderCell {
  const values: string[] = []
  const contributors: AnalysisCard[] = []
  for (const card of cards) {
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(card.text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      record = parsed as Record<string, unknown>
    } catch { continue }
    const before = values.length
    for (const field of fields) {
      for (const value of primitives(record[field.key])) values.push(field.label === undefined ? value : `${field.label}:${value}`)
    }
    if (values.length > before) contributors.push(card)
  }
  if (contributors.length === 0) return headerCell([], 'unknown', 'system')
  const origins = [...new Set(contributors.map(card => card.origin))]
  const origin: PaperHeaderOrigin = origins.length === 1 ? origins[0]! : 'mixed'
  const status: PaperHeaderStatus = contributors.every(card => card.verification === 'reviewed') ? 'verified' : 'unverified'
  return headerCell(values, status, origin)
}

function metadataCardCell(cards: AnalysisCard[], fields: readonly { key: string; label?: string }[]): PaperHeaderCell {
  const cell = analysisCell(cards, fields)
  return cell.status === 'unknown' ? cell : { ...cell, origin: 'source_metadata' }
}

export function projectPaperHeader(input: Omit<PaperRow, 'header'>): PaperHeaderProjection {
  const { work, versions, cards } = input
  const versionValues = versions.flatMap(version => [
    ...(version.publicationDate === null ? [] : [`published:${version.publicationDate}`]),
    ...(version.updatedAt === null ? [] : [`updated:${version.updatedAt}`]),
    ...(version.versionLabel === null ? [] : [`version:${version.versionLabel}`]),
  ])
  const yearVersion = versionValues.length > 0
    ? headerCell(versionValues, 'verified', 'source_metadata')
    : metadataCardCell(cards, [{ key: 'year', label: 'year' }, { key: 'arxivId', label: 'version' }])
  const publicationStatus = metadataCardCell(cards, [
    { key: 'publicationType', label: 'type' }, { key: 'publication_type', label: 'type' },
    { key: 'venue', label: 'venue' }, { key: 'updateStatus', label: 'update' }, { key: 'update_status', label: 'update' },
  ])
  const readCards = cards.filter(card => card.coverage !== 'metadata')
  const coverageRank = { abstract: 1, sections: 2, full_text: 3 } as const
  const readingCoverage = readCards.length === 0
    ? headerCell([], 'unread', 'system')
    : headerCell([
      readCards.reduce<'abstract' | 'sections' | 'full_text'>((best, card) =>
        coverageRank[card.coverage as keyof typeof coverageRank] > coverageRank[best]
          ? card.coverage as 'abstract' | 'sections' | 'full_text' : best, 'abstract'),
    ], readCards.every(card => card.verification === 'reviewed') ? 'verified' : 'unverified',
    new Set(readCards.map(card => card.origin)).size === 1 ? readCards[0]!.origin : 'mixed')
  const locations = [
    ...versions.flatMap(version => version.sourceUrl === null ? [] : [version.sourceUrl]),
    ...cards.flatMap(card => card.spanIds.map(spanId => `span:${spanId}`)),
  ]
  return {
    paperId: headerCell([work.id], 'verified', 'system'),
    title: headerCell([work.title], work.status === 'verified_metadata' ? 'verified' : 'unverified',
      'source_metadata'),
    authors: work.authors === null
      ? headerCell([], 'unverified', 'source_metadata')
      : headerCell(work.authors, work.status === 'verified_metadata' ? 'verified' : 'unverified', 'source_metadata'),
    yearVersion,
    publicationStatus,
    researchQuestion: analysisCell(cards, [{ key: 'question' }, { key: 'openQuestions' }]),
    methods: analysisCell(cards, [{ key: 'methods' }]),
    experimentTaskData: analysisCell(cards, [
      { key: 'task', label: 'task' }, { key: 'datasets', label: 'dataset' }, { key: 'split', label: 'split' },
      { key: 'metric', label: 'metric' }, { key: 'budget', label: 'budget' }, { key: 'experiments' },
    ]),
    coreResults: analysisCell(cards, [{ key: 'keyFinding' }, { key: 'reported_findings' }, { key: 'results' }]),
    limitationsCounterevidence: analysisCell(cards, [
      { key: 'author_limitations' }, { key: 'limitations' }, { key: 'our_critique' }, { key: 'weakness' },
    ]),
    currentResearchRelationship: analysisCell(cards, [{ key: 'relevance' }, { key: 'role', label: 'role' }]),
    baselineFit: analysisCell(cards, [{ key: 'baselineFit' }, { key: 'baseline_fit' }]),
    readingCoverage,
    sourceLocation: locations.length === 0
      ? headerCell([], 'unknown', 'source_metadata')
      : headerCell(locations, 'verified', versions.length > 0 && cards.some(card => card.spanIds.length > 0) ? 'mixed' : 'source_metadata'),
    ingestionStatus: headerCell([
      `acquisition:${input.acquisition}`, `parse:${input.parse}`, `index:${input.index}`,
    ], 'verified', 'system'),
  }
}

export async function listPapers(catalog: Catalog, input: { limit: number; afterId?: string }): Promise<{ rows: PaperRow[]; nextId: string | null }> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('INVALID_PAGE_LIMIT')
  const [records = []] = await catalog.transact([{
    sql: 'SELECT body FROM works WHERE id > ? ORDER BY id LIMIT ?', params: [input.afterId ?? '', input.limit + 1],
  }])
  const rows: PaperRow[] = []
  for (const record of records.slice(0, input.limit)) {
    const work = assertWork(JSON.parse(String(record.body)))
    const [documents = [], cards = [], spanCounts = []] = await catalog.transact([
      { sql: 'SELECT body FROM documents WHERE work_id = ? ORDER BY id', params: [work.id] },
      { sql: 'SELECT body FROM cards WHERE work_id = ? ORDER BY id, revision', params: [work.id] },
      { sql: 'SELECT COUNT(*) AS count FROM spans JOIN documents ON documents.id = spans.document_id WHERE documents.work_id = ?', params: [work.id] },
    ])
    const versions = documents.map(d => assertDocumentVersion(JSON.parse(String(d.body))))
    const analysisCards = cards.map(c => assertAnalysisCard(JSON.parse(String(c.body))))
    const rowWithoutHeader: Omit<PaperRow, 'header'> = { work, versions, cards: analysisCards,
      acquisition: versions.some(d => d.sourceKind === 'full_text') ? 'acquired' : versions.length ? 'abstract_only' : 'metadata_only',
      // A span alone cannot prove every page was parsed or read. Later service reports refine this.
      parse: Number(spanCounts[0]?.count ?? 0) > 0 ? 'partial' : 'pending',
      index: 'not_indexed', exposureReceiptIds: [],
    }
    rows.push({ ...rowWithoutHeader, header: projectPaperHeader(rowWithoutHeader) })
  }
  return { rows, nextId: records.length > input.limit ? rows.at(-1)!.work.id : null }
}
