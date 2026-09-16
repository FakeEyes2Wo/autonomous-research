import { performance } from 'node:perf_hooks'
import type { Catalog, SourceSpan } from './contracts.js'
import { authorizedDocuments, validateScope, visibilityAllows, type AccessScope } from './access.js'
import { getGeneration, loadGenerationManifest } from './index-generation.js'
import { readGenerationSpans, searchLexical } from './lexical.js'
import { readObject } from './objects.js'
import { getRetrievalReceipt, literatureError, saveRetrievalReceipt, type RetrievalReceipt } from './receipts.js'

export interface RetrievalRequest extends AccessScope {
  query: string; generationId: string; purpose: 'survey' | 'baseline' | 'revision' | 'citation'
  requiredSpanIds?: string[]; maxResults: number; maxChars: number
}
export interface RetrievalHit { span: SourceSpan; rank: number; score: number; route: 'lexical' | 'dense' | 'hybrid' }

/** Admission and first pin share a transaction with publication's active/retired state. */
async function admitGeneration(catalog: Catalog, generationId: string, runId: string): Promise<void> {
  const [, rows = []] = await catalog.transact([
    { sql: `INSERT OR IGNORE INTO generation_pins(run_id,generation_id,created_at)
        SELECT ?,id,? FROM index_generations WHERE id=? AND status='active'`,
      params: [runId, new Date().toISOString(), generationId] },
    { sql: `SELECT g.status, EXISTS(SELECT 1 FROM generation_pins p WHERE p.generation_id=g.id AND p.run_id=?) AS pinned
        FROM index_generations g WHERE g.id=?`, params: [runId, generationId] },
  ])
  const generation = rows[0]
  if (!generation) throw literatureError('INDEX_GENERATION_NOT_FOUND', 'generation not found')
  if (generation.status !== 'active' && generation.status !== 'retired') throw literatureError('INDEX_GENERATION_NOT_READABLE')
  if (generation.pinned !== 1) throw literatureError('INDEX_GENERATION_NOT_PINNED', 'run does not pin the retired generation')
}

async function accessForGeneration(catalog: Catalog, root: string, request: RetrievalRequest) {
  const generation = await getGeneration(catalog, request.generationId)
  if (!generation) throw literatureError('INDEX_GENERATION_NOT_FOUND', 'generation not found')
  const manifest = await loadGenerationManifest(root, request.generationId)
  if (manifest.manifestHash !== generation.manifestHash) throw literatureError('INDEX_MANIFEST_MISMATCH')
  const partitions = manifest.corpus.partitionScopes.filter(({ partitionId, scope }) => visibilityAllows({
    projectId: scope.projectId, partitionId, roles: scope.roles, policyHash: scope.policyHash,
    ...(scope.runId === null ? {} : { runId: scope.runId }), ...(scope.split === null ? {} : { split: scope.split }),
  }, request)).map(p => p.partitionId)
  const visibleDocuments = await authorizedDocuments(catalog, request)
  const documents = visibleDocuments.filter(document => {
    const bound = manifest.corpus.documents.find(d => d.id === document.id)
    return bound?.rawHash === document.rawHash && bound.workId === document.workId && partitions.includes(document.visibility.partitionId)
  })
  const [failedReports = []] = await catalog.transact([{ sql: "SELECT document_id FROM parse_reports WHERE json_extract(body,'$.status')='failed'", params: [] }])
  const parseFailed = failedReports.some(row => visibleDocuments.some(document => document.id === row.document_id))
  return { manifest, partitions, documents, parseFailed }
}

export async function retrieve(catalog: Catalog, root: string, request: RetrievalRequest): Promise<{ hits: RetrievalHit[]; receipt: RetrievalReceipt }> {
  // Freeze request input across asynchronous authorization and persistence.
  request = structuredClone(request)
  validateScope(request)
  if (typeof request.query !== 'string' || !['survey', 'baseline', 'revision', 'citation'].includes(request.purpose)) throw new TypeError('invalid retrieval request')
  if (!Number.isSafeInteger(request.maxResults) || request.maxResults < 1 || !Number.isSafeInteger(request.maxChars) || request.maxChars < 0) throw new RangeError('invalid retrieval budget')
  if (request.requiredSpanIds !== undefined && (!Array.isArray(request.requiredSpanIds) || request.requiredSpanIds.some(id => typeof id !== 'string' || !id))) throw new TypeError('invalid requiredSpanIds')
  const started = performance.now()
  await admitGeneration(catalog, request.generationId, request.runId)
  const { manifest, partitions, documents, parseFailed } = await accessForGeneration(catalog, root, request)
  const documentIds = new Set<string>()
  let sourceUnavailable = false
  for (const document of documents) {
    try { await readObject(root, document.rawHash); documentIds.add(document.id) }
    catch { sourceUnavailable = true }
  }
  const requiredIds = [...new Set(request.requiredSpanIds ?? [])]
  const requiredBindings = requiredIds.map(id => manifest.corpus.spans.find(span => span.id === id))
  if (requiredBindings.some(span => !span || !documentIds.has(span.documentId) || !partitions.includes(span.partitionId))) throw literatureError('REQUIRED_SOURCE_UNAVAILABLE')
  const lexical = await searchLexical(catalog, root, { generationId: request.generationId, runId: request.runId, query: request.query,
    authorizedPartitionIds: partitions, authorizedDocumentIds: [...documentIds], maxResults: Math.max(request.maxResults * 4, requiredIds.length, 1) })
  const candidateSpanIds = [...new Set([...requiredIds, ...lexical.map(hit => hit.spanId)])]
  const spans = await readGenerationSpans(catalog, root, request.generationId, candidateSpanIds, partitions, request.runId)
  const required = new Set(requiredIds)
  if (spans.some(span => required.has(span.id) && (!visibilityAllows(span.visibility, request) || !documentIds.has(span.documentId)))) throw literatureError('REQUIRED_SOURCE_UNAVAILABLE')
  const mustUse = spans.filter(span => required.has(span.id))
  let used = mustUse.reduce((sum, span) => sum + span.evidenceText.length, 0)
  if (used > request.maxChars || mustUse.length > request.maxResults) throw literatureError('LITERATURE_CONTEXT_INSUFFICIENT')
  const selected = [...mustUse]
  const hashes = new Set(selected.map(span => `${span.documentId}:${span.contentHash}`))
  for (const span of spans) {
    if (required.has(span.id) || !visibilityAllows(span.visibility, request) || !documentIds.has(span.documentId)) continue
    const key = `${span.documentId}:${span.contentHash}`
    if (hashes.has(key) || selected.length >= request.maxResults || used + span.evidenceText.length > request.maxChars) continue
    selected.push(span); hashes.add(key); used += span.evidenceText.length
  }
  // Raw bytes are necessary for the promised locators, including on historical replay.
  for (const id of new Set(selected.map(span => span.documentId))) {
    try { await readObject(root, documents.find(document => document.id === id)!.rawHash) }
    catch { throw literatureError(requiredIds.some(id => selected.some(s => s.id === id)) ? 'REQUIRED_SOURCE_UNAVAILABLE' : 'SOURCE_UNAVAILABLE') }
  }
  const hits: RetrievalHit[] = selected.map((span, index) => ({ span, rank: index + 1, score: lexical.find(hit => hit.spanId === span.id)?.score ?? 0, route: 'lexical' }))
  const receipt = await saveRetrievalReceipt(catalog, { request, candidateSpanIds, selectedSpanIds: selected.map(span => span.id),
    spanBindings: selected.map(span => ({ spanId: span.id, documentId: span.documentId, rawHash: span.locator.sourceHash })),
    manifestHash: manifest.manifestHash, createdAt: new Date().toISOString(), elapsedMs: performance.now() - started, modelCost: 0,
    outcome: selected.length ? 'ok' : candidateSpanIds.length ? 'budget_exhausted' : sourceUnavailable ? 'source_unavailable' : parseFailed ? 'parse_failed' : 'no_match' })
  return { hits, receipt }
}

export async function replay(catalog: Catalog, root: string, receiptId: string): Promise<{ spans: SourceSpan[]; manifestHash: string }> {
  const receipt = await getRetrievalReceipt(catalog, receiptId)
  validateScope(receipt.request)
  const { manifest, partitions, documents } = await accessForGeneration(catalog, root, receipt.request)
  if (manifest.manifestHash !== receipt.manifestHash) throw literatureError('RECEIPT_CORRUPT')
  const spans = await readGenerationSpans(catalog, root, receipt.request.generationId, receipt.selectedSpanIds, partitions, receipt.request.runId)
  for (const span of spans) {
    const document = documents.find(d => d.id === span.documentId)
    if (!document || !visibilityAllows(span.visibility, receipt.request)) throw literatureError('SOURCE_UNAVAILABLE')
    try { await readObject(root, document.rawHash) } catch { throw literatureError('SOURCE_UNAVAILABLE') }
  }
  return { spans, manifestHash: receipt.manifestHash }
}
