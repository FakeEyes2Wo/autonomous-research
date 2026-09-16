import { createHash } from 'node:crypto'
import { assertHash, type Catalog, type Hash } from './contracts.js'
import type { RetrievalRequest } from './retrieve.js'
import { authorizedDocuments } from './access.js'

export interface RetrievalReceipt {
  id: string; request: RetrievalRequest; candidateSpanIds: string[]; selectedSpanIds: string[]
  /** Authenticated immutable mapping; catalog span rows are not historical evidence. */
  spanBindings: { spanId: string; documentId: string; rawHash: Hash }[]
  manifestHash: Hash; createdAt: string
  outcome: 'ok' | 'no_match' | 'source_unavailable' | 'parse_failed' | 'budget_exhausted'
  elapsedMs: number; modelCost: number | null
}
export interface ExposureReceipt {
  id: string; previousId: string | null; retrievalReceiptId: string; callId: string; actor: string
  spanIds: string[]; renderedHash: Hash; status: 'prepared' | 'sent' | 'unknown'
}
export const receiptHash = (body: string): string => createHash('sha256').update(body).digest('hex')
export const literatureError = (code: string, detail = ''): Error => Object.assign(new Error(`${code}${detail ? ': ' + detail : ''}`), { code })

export async function saveRetrievalReceipt(catalog: Catalog, input: Omit<RetrievalReceipt, 'id'>): Promise<RetrievalReceipt> {
  const id = `retrieval_${receiptHash(JSON.stringify(input))}`
  const receipt = { id, ...input }
  const body = JSON.stringify(receipt)
  await catalog.transact([
    { sql: `INSERT OR IGNORE INTO generation_pins(run_id,generation_id,created_at)
        SELECT ?,id,? FROM index_generations WHERE id=? AND status IN ('active','retired')`,
      params: [input.request.runId, input.createdAt, input.request.generationId] },
    { sql: 'INSERT INTO retrieval_receipts(id,generation_id,body,body_hash) VALUES(?,?,?,?)',
      params: [id, input.request.generationId, body, receiptHash(body)] },
  ])
  return receipt
}

export async function getRetrievalReceipt(catalog: Catalog, id: string): Promise<RetrievalReceipt> {
  const [rows = []] = await catalog.transact([{ sql: 'SELECT body,body_hash FROM retrieval_receipts WHERE id=?', params: [id] }])
  if (!rows[0]) throw literatureError('RECEIPT_NOT_FOUND')
  const body = String(rows[0].body)
  if (receiptHash(body) !== rows[0].body_hash) throw literatureError('RECEIPT_CORRUPT')
  const receipt = JSON.parse(body) as RetrievalReceipt
  const { id: savedId, ...input } = receipt
  if (savedId !== id || id !== `retrieval_${receiptHash(JSON.stringify(input))}`) throw literatureError('RECEIPT_CORRUPT')
  return receipt
}

export async function recordExposure(catalog: Catalog, receipt: ExposureReceipt): Promise<void> {
  assertHash(receipt.renderedHash)
  if (![receipt.id, receipt.retrievalReceiptId, receipt.callId, receipt.actor].every(v => typeof v === 'string' && v.trim()) ||
    !['prepared', 'sent', 'unknown'].includes(receipt.status) || !Array.isArray(receipt.spanIds) ||
    new Set(receipt.spanIds).size !== receipt.spanIds.length) throw literatureError('INVALID_EXPOSURE')
  const retrieval = await getRetrievalReceipt(catalog, receipt.retrievalReceiptId)
  if (receipt.spanIds.some(id => !retrieval.selectedSpanIds.includes(id))) throw literatureError('EXPOSURE_NOT_SELECTED')
  if (receipt.status === 'prepared') {
    if (receipt.previousId !== null) throw literatureError('INVALID_EXPOSURE_CHAIN')
    const allowed = new Map((await authorizedDocuments(catalog, retrieval.request)).map(document => [document.id, document]))
    if (receipt.spanIds.some(id => {
      const binding = retrieval.spanBindings.find(span => span.spanId === id)
      return !binding || allowed.get(binding.documentId)?.rawHash !== binding.rawHash
    })) throw literatureError('SOURCE_UNAVAILABLE')
  } else {
    if (typeof receipt.previousId !== 'string') throw literatureError('INVALID_EXPOSURE_CHAIN')
    const prior = await getExposure(catalog, receipt.previousId)
    if (prior.status !== 'prepared' || prior.retrievalReceiptId !== receipt.retrievalReceiptId ||
      prior.callId !== receipt.callId || prior.actor !== receipt.actor || prior.renderedHash !== receipt.renderedHash ||
      JSON.stringify(prior.spanIds) !== JSON.stringify(receipt.spanIds)) throw literatureError('INVALID_EXPOSURE_CHAIN')
  }
  const body = JSON.stringify(receipt)
  // Exact retries are idempotent; neither ID reuse nor a branched terminal event may overwrite history.
  await catalog.transact([{ sql: `INSERT INTO exposures(id,previous_id,retrieval_receipt_id,body,body_hash) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET body = CASE WHEN exposures.body = excluded.body AND exposures.body_hash = excluded.body_hash THEN exposures.body ELSE NULL END`,
    params: [receipt.id, receipt.previousId, receipt.retrievalReceiptId, body, receiptHash(body)] }])
}

export async function getExposure(catalog: Catalog, id: string): Promise<ExposureReceipt> {
  const [rows = []] = await catalog.transact([{ sql: 'SELECT body,body_hash FROM exposures WHERE id=?', params: [id] }])
  if (!rows[0]) throw literatureError('EXPOSURE_NOT_FOUND')
  if (receiptHash(String(rows[0].body)) !== rows[0].body_hash) throw literatureError('EXPOSURE_CORRUPT')
  const receipt = JSON.parse(String(rows[0].body)) as ExposureReceipt
  if (receipt.id !== id) throw literatureError('EXPOSURE_CORRUPT')
  return receipt
}
