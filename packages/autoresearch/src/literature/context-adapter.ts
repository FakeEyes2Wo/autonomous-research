import { randomUUID } from 'node:crypto'
import { access, link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ResearchStore } from '../research/store.js'
import type { SourceRef } from '../research/contracts.js'
import { ContextInsufficientError, sealContextRecord, canonicalContextJson, type ContextRecord, type ResearchContextPackage, type ResearchContextRequest } from '../research-context/index.js'
import type { ProjectSettings } from '../settings/schema.js'
import { assertDocumentVersion, assertSourceSpan, type Catalog, type SourceSpan } from './contracts.js'
import { canonicalLiteratureProjectId, resolveLiteratureRoot } from './access.js'
import { openCatalog } from './catalog.js'
import { getActiveGeneration, getGeneration, loadGenerationManifest, pinGeneration } from './index-generation.js'
import { retrieve, replay, type RetrievalRequest } from './retrieve.js'
import { literatureError, receiptHash, recordExposure, type ExposureReceipt, type RetrievalReceipt } from './receipts.js'

export interface LiteratureContextBinding { root: string; receipt: RetrievalReceipt; spans: SourceSpan[] }
export interface LiteratureRunBinding { runId: string; projectId: string; generationId: string; policyHash: string; createdAt: string }
export interface RegisteredLiteratureSource { spanId: string; sourceRef: SourceRef }
export interface LiteratureContextInput {
  projectDir: string; runDir: string; runId: string; role: string; query: string; stage: string
  settings?: ProjectSettings['literature']; branchId?: string; split?: string
  requiredSpanIds?: string[]; allowedSpanIds?: string[]; reviewSpanIds?: string[]
}
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
const bindingPath = (runDir: string) => join(runDir, 'literature', 'binding.json')

async function readBinding(runDir: string): Promise<LiteratureRunBinding | undefined> {
  try {
    const { binding, hash } = JSON.parse(await readFile(bindingPath(runDir), 'utf8')) as { binding: LiteratureRunBinding; hash: string }
    if (receiptHash(JSON.stringify(binding)) !== hash) throw literatureError('LITERATURE_BINDING_CORRUPT')
    return binding
  } catch (error) { if (absent(error)) return undefined; throw error }
}

async function bindingFor(catalog: Catalog, input: LiteratureContextInput): Promise<LiteratureRunBinding | undefined> {
  const projectId = canonicalLiteratureProjectId(input.projectDir)
  const existing = await readBinding(input.runDir)
  if (existing) {
    if (existing.projectId !== projectId || existing.runId !== input.runId) throw literatureError('LITERATURE_BINDING_SCOPE_MISMATCH')
    return existing
  }
  const generation = await getActiveGeneration(catalog)
  if (!generation) return undefined
  const [rows = []] = await catalog.transact([{ sql: 'SELECT body FROM documents', params: [] }])
  // This is the trusted project library policy, independent of model and budget settings.
  const policies = [...new Set(rows.map(row => assertDocumentVersion(JSON.parse(String(row.body))).visibility)
    .filter(v => v.projectId === projectId && (v.runId === undefined || v.runId === input.runId) && (v.split === undefined || v.split === input.split))
    .map(v => v.policyHash))]
  if (policies.length > 1) throw literatureError('AMBIGUOUS_ACCESS_POLICY')
  if (!policies.length) return undefined
  const binding: LiteratureRunBinding = { runId: input.runId, projectId, generationId: generation.id, policyHash: policies[0]!, createdAt: new Date().toISOString() }
  await pinGeneration(catalog, input.runId, generation.id)
  await mkdir(join(input.runDir, 'literature'), { recursive: true })
  const temp = `${bindingPath(input.runDir)}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify({ binding, hash: receiptHash(JSON.stringify(binding)) }), { flag: 'wx' })
  try { await link(temp, bindingPath(input.runDir)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  finally { await unlink(temp) }
  return bindingFor(catalog, input)
}

export function literaturePurpose(role: string): RetrievalRequest['purpose'] | undefined {
  if (['survey', 'deep-dive', 'paper-survey', 'paper-frontier-miner', 'brainstorm', 'direction-select', 'idea-generator', 'idea-reflexion'].includes(role)) return 'survey'
  if (['planner', 'experiment-designer', 'research-worker'].includes(role)) return 'baseline'
  if (['hypothesis-reviser', 'supervisor'].includes(role)) return 'revision'
  if (['writer', 'paper-writer', 'citation-auditor', 'paper-auditor', 'evidence-auditor'].includes(role)) return 'citation'
  return undefined
}

export function toLiteratureRecords(spans: SourceSpan[], receipt: RetrievalReceipt): ContextRecord[] {
  return spans.map(span => {
    assertSourceSpan(span)
    const binding = receipt.spanBindings.find(b => b.spanId === span.id)
    if (!receipt.selectedSpanIds.includes(span.id) || binding?.documentId !== span.documentId || binding.rawHash !== span.locator.sourceHash || receiptHash(span.evidenceText) !== span.contentHash) throw literatureError('LITERATURE_SPAN_RECEIPT_MISMATCH', span.id)
    return sealContextRecord({ id: span.id, version: 1, layer: 3, kind: 'artifact', scope: { visibility: 'project', projectId: receipt.request.projectId },
      required: receipt.request.requiredSpanIds?.includes(span.id) ?? false, accessRoles: [receipt.request.role], polarity: 'neutral', lifecycle: 'candidate',
      payload: { origin: 'author_reported', workId: span.workId, documentVersion: span.documentId, sourceKind: span.sourceKind, evidenceText: span.evidenceText,
        locator: span.locator, contentHash: span.contentHash, parserFingerprint: span.parserFingerprint, retrievalReceiptId: receipt.id },
      source: { recordType: 'literature-span' } })
  })
}

export async function retrieveLiteratureContext(input: LiteratureContextInput): Promise<ResearchContextRequest | undefined> {
  const purpose = literaturePurpose(input.role)
  if (input.settings?.mode !== 'lexical' || !purpose || (input.role === 'research-worker' && !input.allowedSpanIds?.length)) return undefined
  const root = resolveLiteratureRoot(input.projectDir)
  const requiredSpanIds = [...new Set(input.role === 'research-worker' ? input.allowedSpanIds : input.requiredSpanIds ?? [])]
  try { await access(join(root, 'catalog.sqlite')) }
  catch (error) { if (!absent(error)) throw error; if (requiredSpanIds.length) throw new ContextInsufficientError(`REQUIRED_SOURCE_UNAVAILABLE: ${requiredSpanIds.join(', ')}`); return undefined }
  const catalog = await openCatalog(root)
  try {
    const binding = await bindingFor(catalog, input)
    if (!binding) { if (requiredSpanIds.length) throw new ContextInsufficientError(`REQUIRED_SOURCE_UNAVAILABLE: ${requiredSpanIds.join(', ')}`); return undefined }
    const [events = []] = await catalog.transact([{ sql: "SELECT body FROM source_events WHERE json_extract(body,'$.kind') IN ('retraction','correction')", params: [] }])
    if (input.reviewSpanIds?.length && events.length) {
      const affected = new Set(events.map(row => (JSON.parse(String(row.body)) as { documentId: string }).documentId))
      const manifest = await loadGenerationManifest(root, binding.generationId)
      for (const id of input.reviewSpanIds) if (!requiredSpanIds.includes(id) && manifest.corpus.spans.some(span => span.id === id && affected.has(span.documentId))) requiredSpanIds.push(id)
    }
    const [rows = []] = await catalog.transact([{ sql: 'SELECT body FROM documents', params: [] }])
    const partitionIds = [...new Set(rows.map(row => assertDocumentVersion(JSON.parse(String(row.body))).visibility)
      .filter(v => v.projectId === binding.projectId && v.policyHash === binding.policyHash && v.roles.includes(input.role)).map(v => v.partitionId))]
    const result = await retrieve(catalog, root, { ...binding, role: input.role, partitionIds, purpose, query: input.query || 'research',
      maxResults: input.role === 'research-worker' ? requiredSpanIds.length : input.settings.maxResults, maxChars: input.settings.maxContextChars,
      requiredSpanIds, ...(input.split ? { split: input.split } : {}) })
    const records = toLiteratureRecords(result.hits.map(hit => hit.span), result.receipt).map(record => {
      const source = result.hits.find(hit => hit.span.id === record.id)!.span
      const notices = events.map(row => JSON.parse(String(row.body)) as { documentId: string }).filter(event => event.documentId === source.documentId)
      const { contentHash: _hash, ...body } = record
      return notices.length ? sealContextRecord({ ...body, required: true, payload: { ...(record.payload as object), reviewStatus: 're_review_required', sourceEvents: notices } }) : record
    })
    return { stage: input.stage, scope: { projectId: binding.projectId, branchId: input.branchId ?? 'pre-snapshot', runId: input.runId, ...(input.split ? { split: input.split } : {}) },
      records, requiredRecordIds: requiredSpanIds, queryTerms: [input.query], literature: { root, receipt: result.receipt, spans: result.hits.map(hit => hit.span) } }
  } catch (error) {
    if (['REQUIRED_SOURCE_UNAVAILABLE', 'LITERATURE_CONTEXT_INSUFFICIENT'].includes(String((error as { code?: string }).code))) throw new ContextInsufficientError(`${(error as Error).message}: ${requiredSpanIds.join(', ')}`)
    throw error
  } finally { await catalog.close() }
}

/** An explicit update has a durable event before the binding commit; ordinary retrieval never changes generations. */
export async function updateLiteratureKnowledge(input: LiteratureContextInput & { nextGenerationId: string; reason: string; sourceEventIds: string[] }): Promise<void> {
  if (!input.reason.trim()) throw literatureError('KNOWLEDGE_UPDATE_REASON_REQUIRED')
  const directory = join(input.runDir, 'literature')
  await mkdir(directory, { recursive: true })
  const lock = await open(join(directory, 'update.lock'), 'wx').catch(() => { throw literatureError('KNOWLEDGE_UPDATE_IN_PROGRESS') })
  let catalog: Catalog | undefined
  try {
    catalog = await openCatalog(resolveLiteratureRoot(input.projectDir))
    const previous = await readBinding(input.runDir)
    if (!previous || previous.runId !== input.runId || previous.projectId !== canonicalLiteratureProjectId(input.projectDir)) throw literatureError('LITERATURE_BINDING_SCOPE_MISMATCH')
    const next = await getGeneration(catalog, input.nextGenerationId)
    if (next?.status !== 'active') throw literatureError('INDEX_GENERATION_NOT_ACTIVE')
    for (const id of input.sourceEventIds) {
      const [events = []] = await catalog.transact([{ sql: 'SELECT id FROM source_events WHERE id=?', params: [id] }])
      if (!events.length) throw literatureError('SOURCE_EVENT_NOT_FOUND', id)
    }
    await pinGeneration(catalog, input.runId, next.id)
    const event = { previousGenerationId: previous.generationId, nextGenerationId: next.id, reason: input.reason, sourceEventIds: input.sourceEventIds, createdAt: new Date().toISOString() }
    await writeFile(join(directory, `update-${receiptHash(JSON.stringify(event))}.json`), JSON.stringify(event), { flag: 'wx' })
    const binding = { ...previous, generationId: next.id }
    const temp = `${bindingPath(input.runDir)}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify({ binding, hash: receiptHash(JSON.stringify(binding)) }), { flag: 'wx' })
    await rename(temp, bindingPath(input.runDir))
  } finally {
    try { await catalog?.close() }
    finally { try { await lock.close() } finally { await unlink(join(directory, 'update.lock')) } }
  }
}

/** Called with the final selected context and the exact prompt at the transport boundary. */
export async function prepareLiteratureExposure(input: { runDir: string; binding: LiteratureContextBinding; context: ResearchContextPackage; prompt: string; role: string; repair?: boolean }): Promise<{ prepared: ExposureReceipt; sources: RegisteredLiteratureSource[] }> {
  const current = await readBinding(input.runDir)
  if (!current || current.generationId !== input.binding.receipt.request.generationId || current.policyHash !== input.binding.receipt.request.policyHash) throw new ContextInsufficientError('LITERATURE_BINDING_CHANGED: rebuild context before dispatch')
  const catalog = await openCatalog(input.binding.root)
  try {
    const { spans } = await replay(catalog, input.binding.root, input.binding.receipt.id)
    const selected = input.context.selection.selected.filter(entry => entry.record.source.recordType === 'literature-span').map(entry => entry.record.id)
    const store = new ResearchStore(input.runDir)
    const sources = await Promise.all(selected.map(async spanId => {
      const span = spans.find(s => s.id === spanId)
      if (!span) throw literatureError('EXPOSURE_NOT_SELECTED', spanId)
      const record = input.context.selection.selected.find(entry => entry.record.id === spanId)!.record
      const payload = record.payload as Record<string, unknown>
      const rendered = input.repair ? promptContainsSpan(input.prompt, span.evidenceText) : input.prompt.includes(canonicalContextJson(record))
      if (payload.evidenceText !== span.evidenceText || payload.contentHash !== span.contentHash || canonicalContextJson(payload.locator) !== canonicalContextJson(span.locator)
        || !rendered) throw literatureError('LITERATURE_RENDERED_SOURCE_MISMATCH', spanId)
      return { spanId, sourceRef: await store.captureBytes(span.evidenceText, span.id) }
    }))
    const prepared: ExposureReceipt = { id: `exposure-${randomUUID()}`, previousId: null, retrievalReceiptId: input.binding.receipt.id, callId: `${input.context.manifest.callId}-${randomUUID()}`,
      actor: input.role, spanIds: selected, renderedHash: receiptHash(input.prompt), status: 'prepared' }
    const manifest = { retrieval: input.binding.receipt, context: input.context.manifest, spanSources: sources, promptSource: await store.captureBytes(input.prompt, `literature-prompt:${prepared.callId}`), exposure: prepared }
    await store.captureBytes(JSON.stringify(manifest), `literature-manifest:${prepared.callId}`)
    await mkdir(join(input.runDir, 'literature', 'calls'), { recursive: true })
    await writeFile(join(input.runDir, 'literature', 'calls', `${prepared.id}.json`), JSON.stringify(manifest), { flag: 'wx' })
    await recordExposure(catalog, prepared)
    return { prepared, sources }
  } finally { await catalog.close() }
}

export function promptContainsSpan(prompt: string, evidenceText: string): boolean {
  return prompt.includes(evidenceText) || prompt.includes(JSON.stringify(evidenceText).slice(1, -1))
}

export async function finishLiteratureExposure(root: string, prepared: ExposureReceipt, status: 'sent' | 'unknown'): Promise<void> {
  const catalog = await openCatalog(root)
  try { await recordExposure(catalog, { ...prepared, id: `${prepared.id}-${status}`, previousId: prepared.id, status }) }
  finally { await catalog.close() }
}
