import { assertWork, assertDocumentVersion, assertAnalysisCard, type AnalysisCard, type Catalog, type DocumentVersion, type Work } from './contracts.js'

export interface PaperRow {
  work: Work; versions: DocumentVersion[]; cards: AnalysisCard[]
  acquisition: 'metadata_only' | 'abstract_only' | 'acquired' | 'unavailable'
  parse: 'pending' | 'partial' | 'complete' | 'failed'
  index: 'not_indexed' | 'indexed'; exposureReceiptIds: string[]
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
    rows.push({ work, versions, cards: cards.map(c => assertAnalysisCard(JSON.parse(String(c.body)))),
      acquisition: versions.some(d => d.sourceKind === 'full_text') ? 'acquired' : versions.length ? 'abstract_only' : 'metadata_only',
      // A span alone cannot prove every page was parsed or read. Later service reports refine this.
      parse: Number(spanCounts[0]?.count ?? 0) > 0 ? 'partial' : 'pending',
      index: 'not_indexed', exposureReceiptIds: [],
    })
  }
  return { rows, nextId: records.length > input.limit ? rows.at(-1)!.work.id : null }
}
