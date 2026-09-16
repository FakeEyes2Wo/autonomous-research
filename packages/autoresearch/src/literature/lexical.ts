import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import { assertSourceSpan, type Catalog, type SourceSpan } from './contracts.js'
import {
  generationDirectory,
  getGeneration,
  loadGenerationManifest,
  type GenerationManifest,
} from './index-generation.js'
import { compareCodeUnits } from './order.js'
import { toFtsQuery } from './tokenize.js'

export interface LexicalSearchRequest {
  generationId: string
  /** Required when reading a retired generation; it must have a matching generation pin. */
  runId?: string
  query: string
  /** Partition IDs already authorized by the server-side policy layer. */
  authorizedPartitionIds: string[]
  maxResults: number
}

export interface LexicalHit {
  spanId: string
  documentId: string
  workId: string
  partitionId: string
  score: number
}

export async function searchLexical(
  catalog: Catalog,
  root: string,
  request: LexicalSearchRequest,
): Promise<LexicalHit[]> {
  validateSearchRequest(request)
  const query = toFtsQuery(request.query)
  const manifest = await readableManifest(catalog, root, request.generationId, request.runId)
  const allowed = new Set(request.authorizedPartitionIds)
  const hits: LexicalHit[] = []

  for (const partition of manifest.partitionFiles) {
    if (!allowed.has(partition.partitionId)) continue
    const database = new DatabaseSync(join(generationDirectory(root, request.generationId), partition.file), {
      readOnly: true,
    })
    try {
      const rows = database.prepare(`SELECT span_id,document_id,work_id,
        bm25(spans_fts,0,0,0,3.0,2.0,1.0) AS score
        FROM spans_fts WHERE spans_fts MATCH ?
        ORDER BY score ASC,span_id ASC LIMIT ?`).all(query, request.maxResults) as {
          span_id: string; document_id: string; work_id: string; score: number
        }[]
      hits.push(...rows.map(row => ({
        spanId: row.span_id,
        documentId: row.document_id,
        workId: row.work_id,
        partitionId: partition.partitionId,
        score: Number(row.score),
      })))
    } finally {
      database.close()
    }
  }
  hits.sort((left, right) => left.score - right.score || compareCodeUnits(left.spanId, right.spanId))
  return hits.slice(0, request.maxResults)
}

/** Read immutable span records from a pinned active/retired generation. */
export async function readGenerationSpans(
  catalog: Catalog,
  root: string,
  generationId: string,
  spanIds: string[],
  authorizedPartitionIds: string[],
  runId?: string,
): Promise<SourceSpan[]> {
  if (!Array.isArray(spanIds) || spanIds.some(id => typeof id !== 'string' || id === '')) {
    throw new TypeError('spanIds must be an array of non-empty strings')
  }
  if (new Set(spanIds).size !== spanIds.length) throw codedError('spanIds contains duplicates', 'INDEX_DUPLICATE_SPAN')
  const manifest = await readableManifest(catalog, root, generationId, runId)
  const partitionBySpan = new Map(manifest.corpus.spans.map(span => [span.id, span.partitionId]))
  const allowed = new Set(authorizedPartitionIds)
  const requestedByPartition = new Map<string, string[]>()
  for (const spanId of spanIds) {
    const partitionId = partitionBySpan.get(spanId)
    if (partitionId === undefined || !allowed.has(partitionId)) {
      throw codedError(`span is unavailable in the authorized generation: ${spanId}`, 'GENERATION_SPAN_UNAVAILABLE')
    }
    const ids = requestedByPartition.get(partitionId) ?? []
    ids.push(spanId)
    requestedByPartition.set(partitionId, ids)
  }

  const records = new Map<string, SourceSpan>()
  for (const [partitionId, ids] of requestedByPartition) {
    const partition = manifest.partitionFiles.find(entry => entry.partitionId === partitionId)!
    const database = new DatabaseSync(join(generationDirectory(root, generationId), partition.file), { readOnly: true })
    try {
      const statement = database.prepare('SELECT body,body_hash FROM span_records WHERE span_id=?')
      for (const id of ids) {
        const row = statement.get(id) as { body?: unknown; body_hash?: unknown } | undefined
        if (typeof row?.body !== 'string' || typeof row.body_hash !== 'string' || sha256(row.body) !== row.body_hash) {
          throw codedError(`immutable span record failed integrity validation: ${id}`, 'GENERATION_SPAN_CORRUPT')
        }
        const span = assertSourceSpan(JSON.parse(row.body))
        const binding = manifest.corpus.spans.find(entry => entry.id === id)
        if (binding === undefined || sha256(row.body) !== binding.recordHash) {
          throw codedError(`immutable span record differs from manifest: ${id}`, 'GENERATION_SPAN_CORRUPT')
        }
        records.set(id, span)
      }
    } finally {
      database.close()
    }
  }
  return spanIds.map(id => records.get(id)!)
}

async function readableManifest(
  catalog: Catalog,
  root: string,
  id: string,
  runId?: string,
): Promise<GenerationManifest> {
  const generation = await getGeneration(catalog, id)
  if (generation === null) throw codedError(`generation not found: ${id}`, 'INDEX_GENERATION_NOT_FOUND')
  if (generation.status !== 'active' && generation.status !== 'retired') {
    throw codedError(`generation is not readable: ${generation.status}`, 'INDEX_GENERATION_NOT_READABLE')
  }
  if (generation.status === 'retired') {
    if (typeof runId !== 'string' || runId.trim() === '') {
      throw codedError('retired generation reads require a pinned run', 'INDEX_GENERATION_NOT_PINNED')
    }
    const [pins = []] = await catalog.transact([{
      sql: 'SELECT 1 AS pinned FROM generation_pins WHERE run_id=? AND generation_id=?',
      params: [runId, id],
    }])
    if (pins.length === 0) throw codedError('run does not pin the retired generation', 'INDEX_GENERATION_NOT_PINNED')
  }
  const manifest = await loadGenerationManifest(root, id)
  if (manifest.manifestHash !== generation.manifestHash) {
    throw codedError('generation manifest differs from catalog', 'INDEX_MANIFEST_MISMATCH')
  }
  return manifest
}

function validateSearchRequest(request: LexicalSearchRequest): void {
  if (typeof request.generationId !== 'string' || request.generationId === '') {
    throw new TypeError('generationId must be a non-empty string')
  }
  if (typeof request.query !== 'string') throw new TypeError('query must be a string')
  if (request.runId !== undefined && (typeof request.runId !== 'string' || request.runId.trim() === '')) {
    throw new TypeError('runId must be a non-empty string when provided')
  }
  if (!Array.isArray(request.authorizedPartitionIds) ||
    request.authorizedPartitionIds.some(id => typeof id !== 'string' || id === '')) {
    throw new TypeError('authorizedPartitionIds must be an array of non-empty strings')
  }
  if (!Number.isSafeInteger(request.maxResults) || request.maxResults < 1) {
    throw new RangeError('maxResults must be a positive integer')
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}
