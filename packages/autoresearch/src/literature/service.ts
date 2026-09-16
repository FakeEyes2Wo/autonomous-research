import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openCatalog } from './catalog.js'
import { assertDocumentVersion, type Catalog, type SourceSpan } from './contracts.js'
import { authorizedDocuments, canonicalLiteratureProjectId, resolveLiteratureRoot, visibilityAllows, type AccessScope } from './access.js'
import { buildGeneration, getActiveGeneration, getGeneration, loadGenerationManifest, pinGeneration, publishGeneration } from './index-generation.js'
import { readGenerationSpans } from './lexical.js'
import { ingestManifest, readIngestedDocument, type IngestManifest } from './ingest.js'
import { readObject } from './objects.js'
import { retrieve, type RetrievalHit } from './retrieve.js'
import { getExposure, getRetrievalReceipt, literatureError, receiptHash } from './receipts.js'
import { listPapers, projectPaperHeader, type PaperRow } from './views.js'

interface ProjectRequest { root: string; projectId: string }
export const PROJECT_LIBRARY_ROLES = ['reader', 'researcher', 'paper-survey', 'paper-frontier-miner', 'idea-generator', 'idea-reflexion',
  'planner', 'experiment-designer', 'research-worker', 'supervisor', 'hypothesis-reviser', 'writer', 'paper-writer', 'citation-auditor', 'paper-auditor', 'evidence-auditor'] as const
export interface LiteratureServiceOptions { role?: string; runId?: string; policyHash?: string; split?: string; ingestRoles?: string[] }
export interface LiteratureOperation {
  id: string; kind: 'import' | 'index'; status: 'queued' | 'running' | 'completed' | 'failed'
  createdAt: string; updatedAt: string; result?: unknown; error?: string
}
const activeOperations = new Set<string>()
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Server-owned bridge. Registry labels never grant access to a project or partition. */
export class LiteratureService {
  constructor(private readonly options: LiteratureServiceOptions = {}) {}

  private async catalog(request: ProjectRequest): Promise<Catalog | null> {
    const root = resolveLiteratureRoot(request.root)
    try { await access(join(root, 'catalog.sqlite')) } catch (error) { if (absent(error)) return null; throw error }
    return openCatalog(root)
  }

  private async scope(catalog: Catalog, request: ProjectRequest): Promise<AccessScope> {
    const projectId = canonicalLiteratureProjectId(request.root)
    const role = this.options.role ?? 'reader', runId = this.options.runId ?? 'web-reader'
    const [rows = []] = await catalog.transact([{ sql: 'SELECT body FROM documents', params: [] }])
    const visible = rows.map(row => assertDocumentVersion(JSON.parse(String(row.body))).visibility)
      .filter(v => v.projectId === projectId && v.roles.includes(role) && (v.runId === undefined || v.runId === runId) &&
        (v.split === undefined || v.split === this.options.split))
    const policies = [...new Set(visible.map(v => v.policyHash))]
    if (!this.options.policyHash && policies.length > 1) throw literatureError('AMBIGUOUS_ACCESS_POLICY')
    const policyHash = this.options.policyHash ?? policies[0] ?? receiptHash('autoresearch:project-library-policy:v1')
    return { projectId, role, runId, policyHash, partitionIds: [...new Set(visible.filter(v => v.policyHash === policyHash).map(v => v.partitionId))],
      ...(this.options.split === undefined ? {} : { split: this.options.split }) }
  }

  async listPapers(request: ProjectRequest & { limit: number; afterId?: string }): Promise<{ rows: PaperRow[]; nextId: string | null; generationId: string | null }> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw literatureError('INVALID_PAGE_LIMIT')
    const catalog = await this.catalog(request)
    if (!catalog) return { rows: [], nextId: null, generationId: null }
    try {
      const scope = await this.scope(catalog, request)
      const documents = await authorizedDocuments(catalog, scope)
      const allowed = new Set(documents.map(d => d.id))
      const generation = await getActiveGeneration(catalog)
      if (generation) await pinGeneration(catalog, scope.runId, generation.id)
      const [exposures = []] = await catalog.transact([{ sql: 'SELECT id FROM exposures', params: [] }])
      const exposed = new Map<string, string[]>()
      for (const record of exposures) {
        const exposure = await getExposure(catalog, String(record.id))
        if (exposure.status !== 'sent') continue
        const retrieval = await getRetrievalReceipt(catalog, exposure.retrievalReceiptId)
        for (const binding of retrieval.spanBindings.filter(b => exposure.spanIds.includes(b.spanId) && allowed.has(b.documentId))) {
          exposed.set(binding.documentId, [...(exposed.get(binding.documentId) ?? []), exposure.id])
        }
      }
      const rows: PaperRow[] = []
      let cursor = request.afterId, exhausted = false
      while (rows.length <= request.limit && !exhausted) {
        const page = await listPapers(catalog, { limit: 100, afterId: cursor })
        exhausted = page.nextId === null
        cursor = page.nextId ?? undefined
        for (const row of page.rows) {
          const metadataOnly = row.versions.length === 0
          row.versions = row.versions.filter(d => allowed.has(d.id))
          if (!row.versions.length && !metadataOnly) continue
          if (metadataOnly) {
            // Metadata imports belong to this project-owned catalog. Restricted
            // document-backed works must still pass the document policy above.
            row.cards = row.cards.filter(card => card.coverage === 'metadata' && card.spanIds.length === 0)
            row.header = projectPaperHeader(row)
            rows.push(row)
            if (rows.length > request.limit) break
            continue
          }
          const spanIds = new Set<string>(), statuses: string[] = []
          for (const document of row.versions) {
            try {
              const parsed = await readIngestedDocument(catalog, document.id)
              statuses.push(parsed.report.status)
              parsed.spans.forEach(s => spanIds.add(s.id))
            } catch { statuses.push('pending') }
          }
          row.cards = row.cards.filter(c => (c.coverage === 'metadata' && c.spanIds.length === 0)
            || (c.spanIds.length > 0 && c.spanIds.every(id => spanIds.has(id))))
          row.parse = statuses.every(s => s === 'complete') ? 'complete' : statuses.every(s => s === 'failed') ? 'failed' : statuses.every(s => s === 'pending') ? 'pending' : 'partial'
          row.index = generation && row.versions.every(d => generation.documentIds.includes(d.id)) ? 'indexed' : 'not_indexed'
          row.acquisition = row.versions.some(d => d.sourceKind === 'full_text') ? 'acquired' : 'abstract_only'
          row.exposureReceiptIds = [...new Set(row.versions.flatMap(d => exposed.get(d.id) ?? []))]
          row.header = projectPaperHeader(row)
          rows.push(row)
          if (rows.length > request.limit) break
        }
      }
      return { rows: rows.slice(0, request.limit), nextId: rows.length > request.limit ? rows[request.limit - 1]!.work.id : null, generationId: generation?.id ?? null }
    } finally { await catalog.close() }
  }

  async search(request: ProjectRequest & { query: string; generationId?: string }): Promise<{ status: string; hits: RetrievalHit[]; receiptId?: string }> {
    if (!request.generationId) return { status: 'not_indexed', hits: [] }
    const catalog = await this.catalog(request)
    if (!catalog) return { status: 'not_indexed', hits: [] }
    try {
      const scope = await this.scope(catalog, request)
      if ((await getActiveGeneration(catalog))?.id === request.generationId) await pinGeneration(catalog, scope.runId, request.generationId)
      const result = await retrieve(catalog, resolveLiteratureRoot(request.root), { ...scope, generationId: request.generationId,
        query: request.query, purpose: 'survey', maxResults: 25, maxChars: 50000 })
      return { status: result.receipt.outcome, hits: result.hits, receiptId: result.receipt.id }
    } finally { await catalog.close() }
  }

  async getSpan(request: ProjectRequest & { generationId: string; spanId: string }): Promise<SourceSpan | null> {
    const catalog = await this.catalog(request)
    if (!catalog) return null
    try {
      const scope = await this.scope(catalog, request)
      const generation = await getGeneration(catalog, request.generationId)
      if (!generation) return null
      if (generation.status === 'active') await pinGeneration(catalog, scope.runId, generation.id)
      const root = resolveLiteratureRoot(request.root)
      const manifest = await loadGenerationManifest(root, request.generationId)
      if (manifest.manifestHash !== generation.manifestHash) throw literatureError('INDEX_MANIFEST_MISMATCH')
      const binding = manifest.corpus.spans.find(s => s.id === request.spanId)
      if (!binding || !scope.partitionIds.includes(binding.partitionId)) return null
      const document = (await authorizedDocuments(catalog, scope)).find(d => d.id === binding.documentId)
      if (!document || manifest.corpus.documents.find(d => d.id === document.id)?.rawHash !== document.rawHash) return null
      const [span] = await readGenerationSpans(catalog, root, request.generationId, [request.spanId], scope.partitionIds, scope.runId)
      if (!span || !visibilityAllows(span.visibility, scope)) return null
      await readObject(root, document.rawHash)
      return span
    }
    finally { await catalog.close() }
  }

  async getSource(request: ProjectRequest & { documentId: string }): Promise<{ mediaType: string; bytes: Uint8Array } | null> {
    const catalog = await this.catalog(request)
    if (!catalog) return null
    try {
      const document = (await authorizedDocuments(catalog, await this.scope(catalog, request))).find(d => d.id === request.documentId)
      if (!document) return null
      const bytes = await readObject(resolveLiteratureRoot(request.root), document.rawHash)
      if (document.mediaType === 'application/pdf' || document.mediaType === 'text/plain') return { mediaType: document.mediaType, bytes }
      const parsed = await readIngestedDocument(catalog, document.id)
      return { mediaType: 'text/plain', bytes: new TextEncoder().encode(parsed.spans.map(s => s.evidenceText).join('\n\n')) }
    } finally { await catalog.close() }
  }

  private operationPath(request: ProjectRequest, id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw literatureError('INVALID_OPERATION_ID')
    return join(resolveLiteratureRoot(request.root), 'operations', `${id}.json`)
  }

  async getOperation(request: ProjectRequest & { operationId: string }): Promise<(LiteratureOperation & { interrupted?: boolean }) | null> {
    const path = this.operationPath(request, request.operationId)
    let operation: LiteratureOperation
    try { operation = JSON.parse(await readFile(path, 'utf8')) as LiteratureOperation }
    catch (error) { if (absent(error)) return null; throw error }
    if (operation.id !== request.operationId) throw literatureError('OPERATION_CORRUPT')
    return { ...operation, ...(['queued', 'running'].includes(operation.status) && !activeOperations.has(path) ? { interrupted: true } : {}) }
  }

  private async start(request: ProjectRequest, kind: LiteratureOperation['kind'], work: () => Promise<unknown>): Promise<{ operationId: string; status: 'queued' }> {
    const id = randomUUID(), path = this.operationPath(request, id)
    const operation: LiteratureOperation = { id, kind, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const persist = async () => {
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(operation), { flag: 'wx' })
      await rename(temporary, path)
    }
    await mkdir(join(resolveLiteratureRoot(request.root), 'operations'), { recursive: true })
    await persist()
    activeOperations.add(path)
    void (async () => {
      try {
        operation.status = 'running'; operation.updatedAt = new Date().toISOString(); await persist()
        operation.result = await work(); operation.status = 'completed'
      } catch (error) {
        operation.status = 'failed'
        operation.error = /^[A-Z_]+$/.test(String((error as { code?: string }).code)) ? (error as { code: string }).code : 'LITERATURE_OPERATION_FAILED'
      }
      operation.updatedAt = new Date().toISOString()
      await persist()
    })().catch(() => { /* Interrupted status remains visible when persistence fails. */ }).finally(() => activeOperations.delete(path))
    return { operationId: id, status: 'queued' }
  }

  async buildIndex(request: ProjectRequest): Promise<{ operationId: string; status: 'queued' }> {
    return this.start(request, 'index', async () => {
      const root = resolveLiteratureRoot(request.root), catalog = await openCatalog(root)
      try {
        const documents = await authorizedDocuments(catalog, await this.scope(catalog, request))
        const spans: SourceSpan[] = []
        for (const document of documents) spans.push(...(await readIngestedDocument(catalog, document.id)).spans)
        const active = await getActiveGeneration(catalog)
        const generation = await buildGeneration(catalog, root, spans, { expectedActiveId: active?.id ?? null, maxSpans: 100000 })
        if (generation.id !== active?.id) await publishGeneration(catalog, root, generation.id, active?.id ?? null)
        return { generationId: generation.id, documents: documents.length, spans: spans.length }
      } finally { await catalog.close() }
    })
  }

  async importSources(request: ProjectRequest & { manifest: IngestManifest }): Promise<{ operationId: string; status: 'queued' }> {
    const manifest = structuredClone(request.manifest)
    if (!manifest || !Array.isArray(manifest.documents) || manifest.documents.length > 100) throw literatureError('INVALID_MANIFEST')
    if (manifest.documents.some(d => !d.source || !['text', 'url'].includes(d.source.kind))) throw literatureError('LOCAL_PATH_FORBIDDEN')
    return this.start(request, 'import', async () => {
      const root = resolveLiteratureRoot(request.root), catalog = await openCatalog(root)
      try {
        const scope = await this.scope(catalog, request)
        // Browser input cannot assign permissions, role grants, or another project's identity.
        const roles = [...new Set([scope.role, ...(this.options.ingestRoles ?? PROJECT_LIBRARY_ROLES)])].sort()
        manifest.documents = manifest.documents.map(d => ({ ...d, visibility: { projectId: scope.projectId,
          partitionId: `web-import-${receiptHash(JSON.stringify(roles)).slice(0, 16)}`, roles, policyHash: scope.policyHash,
          ...(scope.split === undefined ? {} : { split: scope.split }) } }))
        const result = await ingestManifest(catalog, root, manifest, { allowLocalFiles: false })
        return { documentIds: result.documents.map(d => d.document.id), searchReceiptIds: result.searchReceipts.map(r => r.id) }
      } finally { await catalog.close() }
    })
  }
}
