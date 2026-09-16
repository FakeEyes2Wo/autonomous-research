import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openCatalog } from '../../dist/literature/catalog.js'
import { ingestDocument } from '../../dist/literature/ingest.js'
import { registerWork } from '../../dist/literature/import.js'
import { buildGeneration, publishGeneration, pinGeneration, generationDirectory, loadGenerationManifest } from '../../dist/literature/index-generation.js'
import { retrieve, replay } from '../../dist/literature/retrieve.js'
import { recordExposure } from '../../dist/literature/receipts.js'
import { recordSourceEvent } from '../../dist/literature/source-events.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const policyHash = hash('policy')
async function fixture(fn: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'retrieval-'))
  const catalog = await openCatalog(root)
  try {
    const docs = []
    for (const [id, projectId, partitionId, text] of [
      ['one', 'p', 'p-main', '反证 alpha result.\n\nUnrelated required counterexample.'],
      ['two', 'other', 'other-main', '反证 alpha hidden.'],
      ['three', 'p', 'p-main', 'alpha alternative result.'],
    ]) {
      await registerWork(catalog, { id, title: id, authors: null, aliases: [], metadataSources: [], status: 'candidate' })
      docs.push(await ingestDocument(catalog, root, { workId: id, source: { kind: 'text', text }, sourceKind: 'full_text',
        visibility: { projectId, partitionId, roles: ['researcher'], policyHash } }))
    }
    const generation = await buildGeneration(catalog, root, docs.flatMap(d => d.spans), { expectedActiveId: null, maxSpans: 100 })
    await publishGeneration(catalog, root, generation.id, null)
    const request = { query: '反证', generationId: generation.id, projectId: 'p', runId: 'run', role: 'researcher',
      purpose: 'survey', partitionIds: ['p-main', 'other-main'], policyHash, maxResults: 10, maxChars: 10000 }
    await fn({ root, catalog, docs, generation, request })
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
}

test('retrieval isolates projects and saves replayable immutable source selections', async () => fixture(async f => {
  const result = await retrieve(f.catalog, f.root, f.request)
  assert.equal(result.hits.length, 1)
  assert.ok(result.hits.every((h: any) => h.span.visibility.projectId === 'p'))
  assert.deepEqual(result.receipt.selectedSpanIds, result.hits.map((h: any) => h.span.id))
  assert.equal((await replay(f.catalog, f.root, result.receipt.id)).manifestHash, result.receipt.manifestHash)
  assert.equal(result.receipt.modelCost, 0)
  assert.deepEqual((await retrieve(f.catalog, f.root, f.request)).hits, result.hits)
  assert.equal((await retrieve(f.catalog, f.root, { ...f.request, query: 'nonexistenttoken' })).receipt.outcome, 'no_match')
  await retrieve(f.catalog, f.root, { ...f.request, query: 'alpha OR NOT NEAR(*)' })
  await assert.rejects(retrieve(f.catalog, f.root, { ...f.request, generationId: 'missing' }), /generation/i)
}))

test('required spans load outside keyword top-k and close the complete span budget', async () => fixture(async f => {
  const required = f.docs[0].spans[1]
  const result = await retrieve(f.catalog, f.root, { ...f.request, maxResults: 1, requiredSpanIds: [required.id] })
  assert.deepEqual(result.receipt.selectedSpanIds, [required.id])
  assert.ok(result.receipt.candidateSpanIds.includes(required.id))
  await assert.rejects(retrieve(f.catalog, f.root, { ...f.request, requiredSpanIds: [required.id], maxChars: 1 }), /LITERATURE_CONTEXT_INSUFFICIENT/)
  await assert.rejects(retrieve(f.catalog, f.root, { ...f.request, requiredSpanIds: [f.docs[1].spans[0].id] }), /REQUIRED_SOURCE_UNAVAILABLE/)
  const small = await retrieve(f.catalog, f.root, { ...f.request, maxChars: 1 })
  assert.equal(small.receipt.outcome, 'budget_exhausted')
  assert.equal(small.hits.length, 0)
}))

test('revocation removes documents before scoring and blocks historical replay', async () => fixture(async f => {
  const request = { ...f.request, query: 'alpha' }
  const prior = await retrieve(f.catalog, f.root, request)
  await recordSourceEvent(f.catalog, { id: 'revoke', documentId: f.docs[0].document.id, createdAt: new Date().toISOString(),
    kind: 'access_revoked', sourceHash: f.docs[0].document.rawHash, reason: 'permission revoked' })
  const result = await retrieve(f.catalog, f.root, request)
  assert.deepEqual(result.hits.map((h: any) => h.span.documentId), [f.docs[2].document.id])
  await assert.rejects(replay(f.catalog, f.root, prior.receipt.id), /SOURCE_UNAVAILABLE/)
  const replacement = await buildGeneration(f.catalog, f.root, f.docs[2].spans, { expectedActiveId: f.generation.id, maxSpans: 100 })
  await publishGeneration(f.catalog, f.root, replacement.id, f.generation.id)
  const fresh = await retrieve(f.catalog, f.root, { ...request, generationId: replacement.id })
  assert.equal(result.hits[0].score, fresh.hits[0].score)
  await assert.rejects(retrieve(f.catalog, f.root, { ...request, runId: 'unregistered-run' }), { code: 'INDEX_GENERATION_NOT_PINNED' })
  await pinGeneration(f.catalog, 'run', f.generation.id)
  assert.equal((await retrieve(f.catalog, f.root, request)).hits.length, 1)
}))

test('retrieval pins its receipt generation so publishing a replacement preserves replay', async () => fixture(async f => {
  const prior = await retrieve(f.catalog, f.root, f.request)
  const next = await buildGeneration(f.catalog, f.root, f.docs[2].spans, { expectedActiveId: f.generation.id, maxSpans: 100 })
  await publishGeneration(f.catalog, f.root, next.id, f.generation.id)
  assert.deepEqual((await replay(f.catalog, f.root, prior.receipt.id)).spans, prior.hits.map((hit: any) => hit.span))
}))

for (const stage of ['after admission', 'before lexical search', 'before span loading']) {
  test(`active generation stays readable when publication occurs ${stage}`, async () => fixture(async f => {
    const next = await buildGeneration(f.catalog, f.root, f.docs[2].spans, { expectedActiveId: f.generation.id, maxSpans: 100 })
    let published = false, transactions = 0, generationReads = 0
    const publish = async () => {
      published = true
      await publishGeneration(f.catalog, f.root, next.id, f.generation.id)
    }
    const intercepted = { close: () => f.catalog.close(), transact: async (statements: any[]) => {
      transactions++
      const generationRead = statements.some(statement => statement.sql.includes('SELECT body,status FROM index_generations'))
      if (generationRead) generationReads++
      if (!published && stage === 'before span loading' && generationReads === 3) await publish()
      const result = await f.catalog.transact(statements)
      if (!published && (stage === 'after admission' && transactions === 1 || stage === 'before lexical search' &&
        statements.some(statement => statement.sql.includes('FROM parse_reports') && statement.sql.includes("='failed'")))) await publish()
      return result
    } }
    const result = await retrieve(intercepted, f.root, { ...f.request, runId: `race-${stage}` })
    assert.equal(published, true)
    assert.equal(result.hits.length, 1)
    assert.deepEqual((await replay(f.catalog, f.root, result.receipt.id)).spans, result.hits.map((hit: any) => hit.span))
    await assert.rejects(retrieve(f.catalog, f.root, { ...f.request, runId: 'fresh-retired-run' }), { code: 'INDEX_GENERATION_NOT_PINNED' })
    const [pins] = await f.catalog.transact([{ sql: 'SELECT 1 FROM generation_pins WHERE run_id=? AND generation_id=?', params: ['fresh-retired-run', f.generation.id] }])
    assert.deepEqual(pins, [])
  }))
}

test('receipt tampering is rejected and exposure is an immutable exact-selection chain', async () => fixture(async f => {
  const { receipt } = await retrieve(f.catalog, f.root, { ...f.request, query: 'alpha' })
  const exposure = { id: 'prepared', previousId: null, retrievalReceiptId: receipt.id, callId: 'call', actor: 'researcher',
    spanIds: receipt.selectedSpanIds.slice(0, 1), renderedHash: hash('actual prompt'), status: 'prepared' as const }
  await recordExposure(f.catalog, exposure)
  await recordExposure(f.catalog, { ...exposure, id: 'sent', previousId: 'prepared', status: 'sent' })
  await assert.rejects(recordExposure(f.catalog, { ...exposure, id: 'invalid', previousId: 'prepared', status: 'unknown', spanIds: [] }))
  await assert.rejects(recordExposure(f.catalog, { ...exposure, renderedHash: hash('overwrite') }))
  await assert.rejects(recordExposure(f.catalog, { ...exposure, id: 'hidden', spanIds: [f.docs[1].spans[0].id] }))
  await f.catalog.transact([{ sql: 'UPDATE retrieval_receipts SET body=? WHERE id=?', params: [JSON.stringify({ ...receipt, selectedSpanIds: [] }), receipt.id] }])
  await assert.rejects(replay(f.catalog, f.root, receipt.id), /RECEIPT_CORRUPT/)
}))

test('source loss produces an unavailable receipt and required source loss fails closed', async () => fixture(async f => {
  const rawHash = f.docs[0].document.rawHash
  await rm(join(f.root, 'objects', rawHash.slice(0, 2), rawHash.slice(2)))
  const result = await retrieve(f.catalog, f.root, f.request)
  assert.equal(result.receipt.outcome, 'source_unavailable')
  assert.deepEqual(result.hits, [])
  await assert.rejects(retrieve(f.catalog, f.root, { ...f.request, requiredSpanIds: [f.docs[0].spans[0].id] }), /REQUIRED_SOURCE_UNAVAILABLE/)
}))

test('post-publication lexical tampering cannot influence retrieval scores', async () => fixture(async f => {
  const manifest = await loadGenerationManifest(f.root, f.generation.id)
  const partition = manifest.partitionFiles.find(p => p.partitionId === 'p-main')!
  const db = new DatabaseSync(join(generationDirectory(f.root, f.generation.id), partition.file))
  try { db.prepare('UPDATE spans_fts SET body=? WHERE span_id=?').run('alpha forged forged forged', f.docs[0].spans[0].id) }
  finally { db.close() }
  await assert.rejects(retrieve(f.catalog, f.root, f.request), /LEXICAL_CORRUPT/)
}))

test('prepared exposure rechecks access after retrieval', async () => fixture(async f => {
  const { receipt } = await retrieve(f.catalog, f.root, f.request)
  await recordSourceEvent(f.catalog, { id: 'revoke-exposure', documentId: f.docs[0].document.id, createdAt: new Date().toISOString(),
    kind: 'access_revoked', sourceHash: f.docs[0].document.rawHash, reason: 'permission revoked' })
  await assert.rejects(recordExposure(f.catalog, { id: 'revoked-prepared', previousId: null, retrievalReceiptId: receipt.id,
    callId: 'call', actor: 'researcher', spanIds: receipt.selectedSpanIds, renderedHash: hash('prompt'), status: 'prepared' }), /SOURCE_UNAVAILABLE/)
}))

test('exposure binds immutable selected source identity when catalog span rows disappear', async () => fixture(async f => {
  const { receipt } = await retrieve(f.catalog, f.root, f.request)
  await f.catalog.transact([{ sql: 'DELETE FROM spans WHERE id=?', params: [receipt.selectedSpanIds[0]] }])
  assert.equal((await replay(f.catalog, f.root, receipt.id)).spans.length, 1)
  await recordExposure(f.catalog, { id: 'historical-prepared', previousId: null, retrievalReceiptId: receipt.id,
    callId: 'historical-call', actor: 'researcher', spanIds: receipt.selectedSpanIds, renderedHash: hash('actual prompt'), status: 'prepared' })
}))

test('current document authorization changes remove its contribution before ranking', async () => fixture(async f => {
  const prior = await retrieve(f.catalog, f.root, f.request)
  const changed = { ...f.docs[0].document, visibility: { ...f.docs[0].document.visibility, roles: ['private-reader'] } }
  await f.catalog.transact([{ sql: 'UPDATE documents SET body=? WHERE id=?', params: [JSON.stringify(changed), changed.id] }])
  assert.equal((await retrieve(f.catalog, f.root, f.request)).hits.length, 0)
  await assert.rejects(replay(f.catalog, f.root, prior.receipt.id), /SOURCE_UNAVAILABLE/)
}))

test('parse failures are explicit and only visible documents contribute status', async () => fixture(async f => {
  const input = { workId: 'one', source: { kind: 'text' as const, text: 'invalid pdf bytes', mediaType: 'application/pdf' }, sourceKind: 'full_text' as const,
    visibility: f.docs[0].document.visibility }
  const failed = await ingestDocument(f.catalog, f.root, input)
  assert.equal(failed.report.status, 'failed')
  assert.equal((await retrieve(f.catalog, f.root, { ...f.request, query: 'nomatchword' })).receipt.outcome, 'parse_failed')
}))
