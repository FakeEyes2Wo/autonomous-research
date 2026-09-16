import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openCatalog } from '../../dist/literature/catalog.js'
import { registerMetadata, ingestDocument, ingestManifest } from '../../dist/literature/ingest.js'
import { resolveMetadata } from '../../dist/literature/metadata.js'
import { registerWork } from '../../dist/literature/import.js'
import { readObject } from '../../dist/literature/objects.js'
import { buildGeneration, publishGeneration } from '../../dist/literature/index-generation.js'
import { retrieve } from '../../dist/literature/retrieve.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
test('metadata evidence is persisted before verified work registration and absent evidence fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metadata-ingest-')), catalog = await openCatalog(root)
  try {
    const result = await resolveMetadata({ title: 'Verified paper', doi: '10.1234/example' }, {
      fetch: async () => new Response(JSON.stringify({ message: { DOI: '10.1234/example', title: ['Verified paper'] } })), signal: new AbortController().signal,
    })
    assert.equal(result.work.status, 'verified_metadata')
    const checked = { close: () => catalog.close(), transact: async (statements: any[]) => {
      if (statements.some(s => /INSERT INTO works/.test(s.sql))) {
        for (const rawHash of result.work.metadataSources) await readObject(root, rawHash)
        const [receipts] = await catalog.transact([{ sql: 'SELECT * FROM metadata_receipts', params: [] }])
        assert.equal(receipts.length, 1)
      }
      return catalog.transact(statements)
    } }
    assert.equal((await registerMetadata(checked, root, result)).status, 'verified_metadata')
    await assert.rejects(registerMetadata(catalog, root, { ...result, rawResponses: [] }), /SOURCE_MISSING|SOURCE_REQUIRED/)
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('ingestion is idempotent and rejects paths by default while persisting URL failure receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'document-ingest-')), catalog = await openCatalog(root)
  try {
    await registerWork(catalog, { id: 'work', title: 'Paper', authors: null, aliases: [], metadataSources: [], status: 'candidate' })
    const input = { workId: 'work', source: { kind: 'text' as const, text: 'Actual complete source paragraph.' }, sourceKind: 'full_text' as const,
      visibility: { projectId: 'p', partitionId: 'main', roles: ['researcher'], policyHash: hash('policy') } }
    const first = await ingestDocument(catalog, root, input)
    assert.deepEqual(await ingestDocument(catalog, root, input), first)
    assert.deepEqual(await ingestDocument(catalog, root, { ...input, source: { kind: 'registered', documentId: first.document.id } }), first)
    await assert.rejects(ingestDocument(catalog, root, { ...input, source: { kind: 'file', path: 'secret.txt', mediaType: 'text/plain' } }), /LOCAL_PATH_FORBIDDEN/)
    await assert.rejects(ingestDocument(catalog, root, { ...input, source: { kind: 'url', url: 'https://example.test/missing' } }, {
      fetch: async () => new Response('', { status: 404 }),
    }), /SOURCE_UNAVAILABLE/)
    const [receipts] = await catalog.transact([{ sql: 'SELECT body FROM acquisition_receipts', params: [] }])
    assert.equal(JSON.parse(String(receipts[0].body)).status, 404)
    const [counts] = await catalog.transact([{ sql: 'SELECT COUNT(*) AS count FROM documents', params: [] }])
    assert.equal(counts[0].count, 1)
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('manifest imports supplied search provenance without network discovery or metadata promotion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manifest-ingest-')), catalog = await openCatalog(root)
  try {
    const manifest = { works: [{ id: 'candidate', title: 'Candidate', authors: null, aliases: [], metadataSources: [], status: 'candidate' as const }],
      documents: [], searchReceipts: [{ provider: 'manual-export', query: 'experiment', createdAt: '2026-09-16T00:00:00.000Z',
        rawResponse: '{"results":["Candidate"]}', resultWorkIds: ['candidate'] }] }
    const first = await ingestManifest(catalog, root, manifest, { fetch: async () => { throw new Error('unexpected network') } })
    const again = await ingestManifest(catalog, root, manifest)
    assert.deepEqual(first, again)
    assert.equal(first.searchReceipts.length, 1)
    assert.equal(new TextDecoder().decode(await readObject(root, first.searchReceipts[0].rawHash)), manifest.searchReceipts[0].rawResponse)
    const [works] = await catalog.transact([{ sql: 'SELECT body FROM works WHERE id=?', params: ['candidate'] }])
    assert.equal(JSON.parse(String(works[0].body)).status, 'candidate')
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('idempotent ingestion rejects changed parser reports instead of returning invented evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'immutable-ingest-')), catalog = await openCatalog(root)
  try {
    await registerWork(catalog, { id: 'work', title: 'Paper', authors: null, aliases: [], metadataSources: [], status: 'candidate' })
    const input = { workId: 'work', source: { kind: 'text' as const, text: 'The preserved original source.' }, sourceKind: 'full_text' as const,
      visibility: { projectId: 'p', partitionId: 'main', roles: ['researcher'], policyHash: hash('policy') } }
    const first = await ingestDocument(catalog, root, input)
    const forged = { ...first.report, spans: first.spans.map(span => ({ ...span, evidenceText: 'Forged conclusion.' })) }
    await catalog.transact([{ sql: 'UPDATE parse_reports SET body=? WHERE document_id=?', params: [JSON.stringify(forged), first.document.id] }])
    await assert.rejects(ingestDocument(catalog, root, input), /INGESTION_CORRUPT/)
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('equivalent visibility JSON and role sets reuse one immutable document and span set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-ingest-')), catalog = await openCatalog(root)
  try {
    await registerWork(catalog, { id: 'work', title: 'Paper', authors: null, aliases: [], metadataSources: [], status: 'candidate' })
    const policyHash = hash('policy')
    const input = { workId: 'work', source: { kind: 'text' as const, text: 'alpha result.' }, sourceKind: 'full_text' as const,
      visibility: { projectId: 'p', partitionId: 'main', runId: 'run', split: 'train', roles: ['researcher', 'reviewer'], policyHash } }
    const first = await ingestDocument(catalog, root, input)
    const reordered = { ...input, visibility: { roles: ['reviewer', 'researcher', 'reviewer'], policyHash,
      split: 'train', partitionId: 'main', runId: 'run', projectId: 'p' } }
    assert.deepEqual(await ingestDocument(catalog, root, reordered), first)
    assert.deepEqual(await ingestDocument(catalog, root, { ...reordered, source: { kind: 'registered', documentId: first.document.id } }), first)
    const [documents, spans] = await catalog.transact([
      { sql: 'SELECT COUNT(*) AS count FROM documents', params: [] }, { sql: 'SELECT COUNT(*) AS count FROM spans', params: [] },
    ])
    assert.equal(documents[0].count, 1)
    assert.equal(spans[0].count, first.spans.length)
    const [spanRecords] = await catalog.transact([{ sql: 'SELECT body FROM spans ORDER BY id', params: [] }])
    const generation = await buildGeneration(catalog, root, spanRecords.map(row => JSON.parse(String(row.body))), { expectedActiveId: null, maxSpans: 100 })
    await publishGeneration(catalog, root, generation.id, null)
    const found = await retrieve(catalog, root, { query: 'alpha', generationId: generation.id, projectId: 'p', runId: 'run',
      role: 'researcher', purpose: 'survey', partitionIds: ['main'], policyHash, split: 'train', maxResults: 10, maxChars: 1000 })
    assert.deepEqual(found.hits.map(hit => hit.span.evidenceText), ['alpha result.'])
    await assert.rejects(ingestDocument(catalog, root, { ...reordered, source: { kind: 'registered', documentId: first.document.id },
      visibility: { ...reordered.visibility, roles: ['reviewer'] } }), /DOCUMENT_CONFLICT/)
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('v2 catalogs migrate additively to receipt and ingestion schema while preserving work records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v2-ingest-'))
  let catalog = await openCatalog(root)
  try {
    await registerWork(catalog, { id: 'existing', title: 'Existing work', authors: null, aliases: [], metadataSources: [], status: 'candidate' })
    await catalog.close()
    const db = new DatabaseSync(join(root, 'catalog.sqlite'))
    try { db.exec(`DROP TABLE exposures; DROP TABLE retrieval_receipts; DROP TABLE acquisition_receipts;
      DROP TABLE metadata_receipts; DROP TABLE search_receipts; DROP TABLE ingestion_records; PRAGMA user_version=2;`) }
    finally { db.close() }
    catalog = await openCatalog(root)
    const [version, works, tables] = await catalog.transact([
      { sql: 'PRAGMA user_version', params: [] }, { sql: 'SELECT id FROM works', params: [] },
      { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('retrieval_receipts','exposures','ingestion_records') ORDER BY name", params: [] },
    ])
    assert.equal(version[0].user_version, 3)
    assert.deepEqual(works.map(row => row.id), ['existing'])
    assert.deepEqual(tables.map(row => row.name), ['exposures', 'ingestion_records', 'retrieval_receipts'])
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})
