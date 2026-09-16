import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { LiteratureService } from '../../dist/literature/service.js'
import { openCatalog } from '../../dist/literature/catalog.js'
import { registerWork, importLegacy } from '../../dist/literature/import.js'
import { ingestDocument } from '../../dist/literature/ingest.js'
import { resolveLiteratureRoot, canonicalLiteratureProjectId } from '../../dist/literature/access.js'
import { recordSourceEvent } from '../../dist/literature/source-events.js'
import { buildGeneration, getActiveGeneration, publishGeneration } from '../../dist/literature/index-generation.js'
import { retrieveLiteratureContext } from '../../dist/literature/context-adapter.js'

async function completed(service: LiteratureService, request: { root: string; projectId: string }, operationId: string) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const operation = await service.getOperation({ ...request, operationId })
    if (operation && ['completed', 'failed'].includes(operation.status)) return operation
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('operation did not settle')
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const policyHash = hash('library-policy')
async function fixture(fn: (root: string, library: string, service: LiteratureService) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'literature-service-'))
  try { await fn(root, resolveLiteratureRoot(root), new LiteratureService()) }
  finally { await rm(root, { recursive: true, force: true }) }
}
async function seed(root: string, library: string, projectId = canonicalLiteratureProjectId(root)) {
  const catalog = await openCatalog(library)
  try {
    await registerWork(catalog, { id: 'work', title: 'Source', authors: null, aliases: [], metadataSources: [], status: 'candidate' })
    return await ingestDocument(catalog, library, { workId: 'work', source: { kind: 'text', text: '<h1>Method</h1><p>反证 alpha</p><script>doNotExecute()</script>', mediaType: 'text/html' }, sourceKind: 'full_text', visibility: { projectId, partitionId: 'public', roles: ['reader'], policyHash } })
  } finally { await catalog.close() }
}

test('empty read-only library views do not create a catalog or start work', async () => fixture(async (root, library, service) => {
  const request = { root, projectId: 'registry-id' }
  assert.deepEqual((await service.listPapers({ ...request, limit: 10 })).rows, [])
  assert.equal((await service.search({ ...request, query: '反证' })).status, 'not_indexed')
  await assert.rejects(access(join(library, 'catalog.sqlite')))
}))

test('project-owned metadata-only imports remain visible without implying acquisition or reading', async () => fixture(async (root, library, service) => {
  const catalog = await openCatalog(library)
  try { await registerWork(catalog, { id: 'metadata-only', title: 'Candidate citation', authors: null, aliases: [], metadataSources: [], status: 'candidate' }) }
  finally { await catalog.close() }
  const result = await service.listPapers({ root, projectId: 'registry-id', limit: 10 })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]!.acquisition, 'metadata_only')
  assert.equal(result.rows[0]!.parse, 'pending')
  assert.equal(result.rows[0]!.index, 'not_indexed')
  assert.equal(result.rows[0]!.header.readingCoverage.status, 'unread')
}))

test('acquiring an authorized source retains metadata year and venue without claiming it was read', async () => fixture(async (root, library, service) => {
  const catalog = await openCatalog(library)
  const request = { root, projectId: 'registry-id', limit: 10 }
  try {
    await importLegacy(catalog, library, { bytes: Buffer.from(JSON.stringify([{ id: 'paper', title: 'Paper', year: 2024, venue: 'Test Venue' }])), runId: 'legacy-import' })
    const before = (await service.listPapers(request)).rows[0]!
    assert.match(before.header.yearVersion.display, /2024/)
    await ingestDocument(catalog, library, { workId: before.work.id, source: { kind: 'text', text: 'An acquired abstract.' }, sourceKind: 'abstract', visibility: { projectId: canonicalLiteratureProjectId(root), partitionId: 'public', roles: ['reader'], policyHash } })
    const after = (await service.listPapers(request)).rows[0]!
    assert.equal(after.header.yearVersion.display, before.header.yearVersion.display)
    assert.equal(after.header.publicationStatus.display, before.header.publicationStatus.display)
    assert.equal(after.header.readingCoverage.status, 'unread')
    assert.equal(after.acquisition, 'abstract_only')
  } finally { await catalog.close() }
}))

test('browser imports replace supplied permission grants and reject local sources', async () => fixture(async (root, library, service) => {
  const request = { root, projectId: 'opaque-id' }
  const manifest = {
    works: [{ id: 'new-work', title: 'New', authors: null, aliases: [], metadataSources: [], status: 'candidate' as const }],
    documents: [{ workId: 'new-work', source: { kind: 'text' as const, text: 'alpha source' }, sourceKind: 'full_text' as const,
      visibility: { projectId: 'attacker-project', policyHash: hash('attacker'), partitionId: 'private', roles: ['administrator'] } }],
  }
  const operation = await completed(service, request, (await service.importSources({ ...request, manifest })).operationId)
  assert.equal(operation.status, 'completed')
  const catalog = await openCatalog(library)
  try {
    const [rows] = await catalog.transact([{ sql: 'SELECT body FROM documents', params: [] }])
    const visibility = JSON.parse(String(rows![0]!.body)).visibility
    assert.equal(visibility.projectId, canonicalLiteratureProjectId(root))
    assert.ok(visibility.roles.includes('reader'))
    assert.ok(visibility.roles.includes('planner'))
    assert.ok(visibility.roles.includes('supervisor'))
    assert.ok(!visibility.roles.includes('administrator'))
    assert.notEqual(visibility.policyHash, hash('attacker'))
  } finally { await catalog.close() }
  await assert.rejects(service.importSources({ ...request, manifest: { documents: [{ ...manifest.documents[0]!, source: { kind: 'file', path: 'secret', mediaType: 'text/plain' } }] } }), /LOCAL_PATH_FORBIDDEN/)
  assert.equal((await completed(service, request, (await service.buildIndex(request)).operationId)).status, 'completed')
  const context = await retrieveLiteratureContext({ projectDir: root, runDir: join(root, 'research-run'), runId: 'research-run',
    role: 'planner', stage: 'plan', query: 'alpha', settings: { mode: 'lexical', maxResults: 8, maxContextChars: 12000 } })
  assert.equal(context?.literature?.spans[0]?.evidenceText, 'alpha source')
}))

test('historical browsing requires an existing pin and still honors revocation', async () => fixture(async (root, library, service) => {
  const document = await seed(root, library), request = { root, projectId: 'p' }
  assert.equal((await completed(service, request, (await service.buildIndex(request)).operationId)).status, 'completed')
  const first = await service.listPapers({ ...request, limit: 10 })
  const catalog = await openCatalog(library)
  try {
    const active = await getActiveGeneration(catalog)
    const other = await ingestDocument(catalog, library, { workId: 'work', source: { kind: 'text', text: 'other source' }, sourceKind: 'full_text',
      visibility: { projectId: canonicalLiteratureProjectId(root), partitionId: 'public', roles: ['reader'], policyHash } })
    const next = await buildGeneration(catalog, library, other.spans, { expectedActiveId: active!.id, maxSpans: 100 })
    await publishGeneration(catalog, library, next.id, active!.id)
  } finally { await catalog.close() }
  const spanRequest = { ...request, generationId: first.generationId!, spanId: document.spans[0]!.id }
  assert.equal((await service.getSpan(spanRequest))?.id, document.spans[0]!.id)
  await assert.rejects(new LiteratureService({ runId: 'unregistered-browse' }).getSpan(spanRequest), { code: 'INDEX_GENERATION_NOT_PINNED' })
  const reopened = await openCatalog(library)
  try { await recordSourceEvent(reopened, { id: 'revoked-history', documentId: document.document.id, kind: 'access_revoked', createdAt: new Date().toISOString(), sourceHash: document.document.rawHash, reason: 'revoked' }) }
  finally { await reopened.close() }
  assert.equal(await service.getSpan(spanRequest), null)
}))

test('source reads enforce canonical project identity and return extracted safe HTML text', async () => fixture(async (root, library, service) => {
  const document = await seed(root, library)
  const source = await service.getSource({ root, projectId: 'opaque-registry-id', documentId: document.document.id })
  assert.equal(source?.mediaType, 'text/plain')
  assert.match(new TextDecoder().decode(source!.bytes), /反证 alpha/)
  assert.doesNotMatch(new TextDecoder().decode(source!.bytes), /script|doNotExecute/)
  const catalog = await openCatalog(library)
  try { await recordSourceEvent(catalog, { id: 'revoked', documentId: document.document.id, kind: 'access_revoked', createdAt: new Date().toISOString(), sourceHash: document.document.rawHash, reason: 'owner revoked access' }) }
  finally { await catalog.close() }
  assert.equal(await service.getSource({ root, projectId: 'opaque-registry-id', documentId: document.document.id }), null)
  assert.equal((await service.listPapers({ root, projectId: 'opaque-registry-id', limit: 10 })).rows.length, 0)
}))

test('cross-project documents in a catalog cannot be served through the current registry root', async () => fixture(async (root, library, service) => {
  const document = await seed(root, library, 'another-project')
  assert.equal(await service.getSource({ root, projectId: 'p', documentId: document.document.id }), null)
}))

test('explicit indexing exposes persistent progress, located search and truthful unread status', async () => fixture(async (root, library, service) => {
  const document = await seed(root, library)
  const request = { root, projectId: 'registry-id' }
  const started = await service.buildIndex(request)
  let operation = await service.getOperation({ ...request, operationId: started.operationId })
  const deadline = Date.now() + 10000
  while (operation && !['completed', 'failed'].includes(operation.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
    operation = await service.getOperation({ ...request, operationId: started.operationId })
  }
  assert.equal(operation?.status, 'completed', JSON.stringify(operation))
  const papers = await service.listPapers({ ...request, limit: 10 })
  assert.equal(papers.rows[0].parse, 'complete')
  assert.equal(papers.rows[0].index, 'indexed')
  assert.equal(papers.rows[0].header.readingCoverage.status, 'unread')
  const found = await service.search({ ...request, query: '反证', generationId: papers.generationId! })
  assert.equal(found.hits[0].span.id, document.spans[0].id)
  assert.equal((await service.getSpan({ ...request, generationId: papers.generationId!, spanId: document.spans[0].id }))?.id, document.spans[0].id)
  const reopened = new LiteratureService()
  assert.equal((await reopened.getOperation({ ...request, operationId: started.operationId }))?.status, 'completed')
  await assert.rejects(service.getOperation({ ...request, operationId: '../outside' }), /INVALID_OPERATION_ID/)
}))
