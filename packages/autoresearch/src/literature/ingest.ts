import { readFile } from 'node:fs/promises'
import { assertDocumentVersion, assertVisibility, assertWork, type Catalog, type DocumentVersion, type SourceSpan, type Work } from './contracts.js'
import { acquire, type AcquireOptions } from './acquisition.js'
import { registerWork } from './import.js'
import { putObject, readObject } from './objects.js'
import { parseText } from './parsers/text.js'
import { parseHtml } from './parsers/html.js'
import { parsePdf } from './parsers/pdf.js'
import type { ParseResult } from './parsing.js'
import type { resolveMetadata } from './metadata.js'
import { literatureError, receiptHash } from './receipts.js'
import { compareCodeUnits } from './order.js'

export type IngestSource = { kind: 'text'; text: string; mediaType?: string } |
  { kind: 'url'; url: string } | { kind: 'file'; path: string; mediaType: string } |
  { kind: 'registered'; documentId: string }
export interface IngestDocumentInput {
  workId: string; source: IngestSource; visibility: DocumentVersion['visibility']; sourceKind: DocumentVersion['sourceKind']
  versionLabel?: string; publicationDate?: string; updatedAt?: string; license?: string
}
export interface IngestOptions {
  /** Only trusted local callers such as the CLI may opt into paths. */
  allowLocalFiles?: boolean; fetch?: typeof fetch; signal?: AbortSignal; maxBytes?: number; timeoutMs?: number
}
export interface IngestResult { document: DocumentVersion; spans: SourceSpan[]; report: ParseResult }
export interface SearchReceiptInput {
  provider: string; query: string; createdAt: string; rawResponse: string; resultWorkIds: string[]
}
export interface SearchReceipt {
  id: string; provider: string; query: string; createdAt: string; rawHash: string; resultWorkIds: string[]
}
export interface IngestManifest {
  works?: Work[]; documents: IngestDocumentInput[]; searchReceipts?: SearchReceiptInput[]
}

/** Explicit key order and set-valued roles make source identity independent of manifest formatting. */
function canonicalVisibility(value: DocumentVersion['visibility']): DocumentVersion['visibility'] {
  const visibility = assertVisibility(value)
  return {
    projectId: visibility.projectId,
    partitionId: visibility.partitionId,
    roles: [...new Set(visibility.roles)].sort(compareCodeUnits),
    policyHash: visibility.policyHash,
    ...(visibility.runId === undefined ? {} : { runId: visibility.runId }),
    ...(visibility.split === undefined ? {} : { split: visibility.split }),
  }
}

/** Explicit supplied provenance only; this orchestration never performs a discovery search. */
export async function ingestManifest(catalog: Catalog, root: string, manifest: IngestManifest, options: IngestOptions = {}): Promise<{
  documents: IngestResult[]; searchReceipts: SearchReceipt[]
}> {
  if (!manifest || !Array.isArray(manifest.documents) || manifest.documents.length > 10000 ||
    (manifest.works !== undefined && !Array.isArray(manifest.works)) ||
    (manifest.searchReceipts !== undefined && !Array.isArray(manifest.searchReceipts))) throw new TypeError('invalid ingestion manifest')
  for (const work of manifest.works ?? []) {
    if (work.status !== 'candidate') throw literatureError('MANIFEST_METADATA_UNVERIFIED', 'use registerMetadata for verified resolver evidence')
    await registerWork(catalog, work)
  }
  const searchReceipts: SearchReceipt[] = []
  for (const input of manifest.searchReceipts ?? []) {
    if (!input || typeof input.provider !== 'string' || !input.provider.trim() || typeof input.query !== 'string' || !input.query.trim() ||
      !Number.isFinite(Date.parse(input.createdAt)) || typeof input.rawResponse !== 'string' || input.rawResponse.length > 1024 * 1024 ||
      !Array.isArray(input.resultWorkIds) || input.resultWorkIds.some(id => typeof id !== 'string' || !id)) throw new TypeError('invalid search receipt')
    const rawHash = await putObject(root, new TextEncoder().encode(input.rawResponse))
    const bodyInput = { provider: input.provider, query: input.query, createdAt: input.createdAt, rawHash, resultWorkIds: input.resultWorkIds }
    const receipt = { id: `search_${receiptHash(JSON.stringify(bodyInput))}`, ...bodyInput }
    const body = JSON.stringify(receipt)
    await catalog.transact([{ sql: `INSERT INTO search_receipts(id,body,body_hash) VALUES(?,?,?) ON CONFLICT(id)
      DO UPDATE SET body=CASE WHEN search_receipts.body=excluded.body AND search_receipts.body_hash=excluded.body_hash THEN search_receipts.body ELSE NULL END`,
      params: [receipt.id, body, receiptHash(body)] }])
    searchReceipts.push(receipt)
  }
  const documents: IngestResult[] = []
  for (const input of manifest.documents) documents.push(await ingestDocument(catalog, root, input, options))
  return { documents, searchReceipts }
}

/** Persist resolver evidence before a verified work can be registered. */
export async function registerMetadata(catalog: Catalog, root: string, result: Awaited<ReturnType<typeof resolveMetadata>>): Promise<Work> {
  const hashes = new Set<string>()
  for (const bytes of result.rawResponses) hashes.add(await putObject(root, bytes))
  for (const receipt of result.receipts) {
    if (!hashes.has(receipt.rawHash)) throw literatureError('METADATA_RECEIPT_SOURCE_MISSING')
  }
  if (result.work.metadataSources.some(hash => !hashes.has(hash) || !result.receipts.some(r => r.rawHash === hash))) {
    throw literatureError('METADATA_SOURCE_REQUIRED')
  }
  await catalog.transact(result.receipts.map(receipt => {
    const body = JSON.stringify(receipt), hash = receiptHash(body)
    return { sql: 'INSERT INTO metadata_receipts(id,body,body_hash) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING', params: [hash, body, hash] }
  }))
  return registerWork(catalog, result.work)
}

export async function ingestDocument(catalog: Catalog, root: string, input: IngestDocumentInput, options: IngestOptions = {}): Promise<IngestResult> {
  input = { ...input, visibility: canonicalVisibility(input.visibility) }
  if (!['abstract', 'full_text'].includes(input.sourceKind)) throw new TypeError('sourceKind is required')
  options.signal?.throwIfAborted()
  const [works = []] = await catalog.transact([{ sql: 'SELECT body FROM works WHERE id=?', params: [input.workId] }])
  if (!works[0]) throw literatureError('WORK_NOT_FOUND')
  assertWork(JSON.parse(String(works[0].body)))
  if (input.source.kind === 'registered') {
    const result = await readIngestedDocument(catalog, input.source.documentId)
    if (result.document.workId !== input.workId || JSON.stringify(canonicalVisibility(result.document.visibility)) !== JSON.stringify(input.visibility) ||
      result.document.sourceKind !== input.sourceKind) throw literatureError('DOCUMENT_CONFLICT')
    await readObject(root, result.document.rawHash)
    return result
  }
  let bytes: Uint8Array, mediaType: string, rawHash: string, sourceUrl: string | null = null
  if (input.source.kind === 'url') {
    const acquireOptions: AcquireOptions = { fetch: options.fetch ?? fetch, signal: options.signal ?? new AbortController().signal,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }
    const receipt = await acquire(root, input.source.url, acquireOptions)
    const body = JSON.stringify(receipt), hash = receiptHash(body)
    await catalog.transact([{ sql: 'INSERT INTO acquisition_receipts(id,work_id,body,body_hash) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',
      params: [hash, input.workId, body, hash] }])
    if (receipt.error || receipt.rawHash === null) throw literatureError('SOURCE_UNAVAILABLE', receipt.error ?? '')
    rawHash = receipt.rawHash; mediaType = receipt.contentType; sourceUrl = receipt.finalUrl
    bytes = await readObject(root, rawHash)
  } else {
    if (input.source.kind === 'file') {
      if (options.allowLocalFiles !== true) throw literatureError('LOCAL_PATH_FORBIDDEN')
      bytes = await readFile(input.source.path); mediaType = input.source.mediaType
    } else if (input.source.kind === 'text' && typeof input.source.text === 'string') {
      bytes = new TextEncoder().encode(input.source.text); mediaType = input.source.mediaType ?? 'text/plain'
    } else throw new TypeError('unsupported ingestion source')
    if (bytes.length > (options.maxBytes ?? 32 * 1024 * 1024)) throw literatureError('SOURCE_TOO_LARGE')
    rawHash = await putObject(root, bytes)
  }
  if (!['text/plain', 'text/html', 'application/xhtml+xml', 'application/pdf'].includes(mediaType)) throw literatureError('SOURCE_TYPE_UNSUPPORTED')
  const binding = { workId: input.workId, rawHash, sourceUrl, mediaType, visibility: input.visibility, sourceKind: input.sourceKind,
    versionLabel: input.versionLabel ?? null, publicationDate: input.publicationDate ?? null, updatedAt: input.updatedAt ?? null, license: input.license ?? null }
  const id = `doc_${receiptHash(JSON.stringify(binding))}`
  const [previous = []] = await catalog.transact([{ sql: 'SELECT id FROM documents WHERE id=?', params: [id] }])
  if (previous.length) return readIngestedDocument(catalog, id)
  const document = assertDocumentVersion({ id, ...binding, fetchedAt: new Date().toISOString() })
  const parse = mediaType === 'application/pdf' ? parsePdf : mediaType === 'text/plain' ? parseText : parseHtml
  const report = await parse({ document, bytes, ...(options.signal === undefined ? {} : { signal: options.signal }) })
  options.signal?.throwIfAborted()
  const documentHash = await putObject(root, new TextEncoder().encode(JSON.stringify(document)))
  const reportHash = await putObject(root, new TextEncoder().encode(JSON.stringify(report)))
  try {
    await catalog.transact([
      { sql: 'INSERT INTO documents(id,work_id,raw_hash,body) VALUES(?,?,?,?)', params: [id, input.workId, rawHash, JSON.stringify(document)] },
      ...report.spans.map(span => ({ sql: 'INSERT INTO spans(id,document_id,body) VALUES(?,?,?)', params: [span.id, id, JSON.stringify(span)] })),
      { sql: 'INSERT INTO parse_reports(document_id,body) VALUES(?,?)', params: [id, JSON.stringify(report)] },
      { sql: 'INSERT INTO ingestion_records(document_id,document_hash,parse_report_hash) VALUES(?,?,?)', params: [id, documentHash, reportHash] },
    ])
  } catch (error) {
    const [concurrent = []] = await catalog.transact([{ sql: 'SELECT id FROM documents WHERE id=?', params: [id] }])
    if (concurrent.length) return readIngestedDocument(catalog, id)
    throw error
  }
  return { document, spans: report.spans, report }
}

export async function readIngestedDocument(catalog: Catalog, documentId: string): Promise<IngestResult> {
  const [documents = [], reports = [], bindings = [], spanRows = []] = await catalog.transact([
    { sql: 'SELECT body FROM documents WHERE id=?', params: [documentId] },
    { sql: 'SELECT body FROM parse_reports WHERE document_id=?', params: [documentId] },
    { sql: 'SELECT document_hash,parse_report_hash FROM ingestion_records WHERE document_id=?', params: [documentId] },
    { sql: 'SELECT id,body FROM spans WHERE document_id=?', params: [documentId] },
  ])
  if (!documents[0] || !reports[0]) throw literatureError('DOCUMENT_NOT_INGESTED')
  if (!bindings[0] || receiptHash(String(documents[0].body)) !== bindings[0].document_hash ||
    receiptHash(String(reports[0].body)) !== bindings[0].parse_report_hash) throw literatureError('INGESTION_CORRUPT')
  const document = assertDocumentVersion(JSON.parse(String(documents[0].body)))
  const report = JSON.parse(String(reports[0].body)) as ParseResult
  if (spanRows.length !== report.spans.length || spanRows.some(row => {
    const saved = report.spans.find(span => span.id === row.id)
    return !saved || JSON.stringify(saved) !== row.body
  })) throw literatureError('INGESTION_CORRUPT')
  return { document, report, spans: report.spans }
}
