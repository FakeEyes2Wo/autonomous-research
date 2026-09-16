import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog } from '../../dist/literature/catalog.js'
import { importLegacy, registerWork } from '../../dist/literature/import.js'
import { listPapers } from '../../dist/literature/views.js'
import { putObject } from '../../dist/literature/objects.js'
import { recordSourceEvent } from '../../dist/literature/source-events.js'

test('legacy imports are idempotent and do not promote summaries or merge equal titles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-import-'))
  const catalog = await openCatalog(root)
  try {
    const bytes = new TextEncoder().encode(JSON.stringify([
      { id: 'a', title: 'Same title', abstract: 'Unverified model summary', methods: ['method A'] },
      { id: 'b', title: 'Same title', abstract: 'Different work' },
    ]))
    const first = await importLegacy(catalog, root, { bytes, runId: 'r1' })
    assert.equal(first.imported, 2)
    assert.equal((await importLegacy(catalog, root, { bytes, runId: 'r1' })).skipped, 2)
    const { rows } = await listPapers(catalog, { limit: 20 })
    assert.equal(rows.length, 2)
    assert.notEqual(rows[0]!.work.id, rows[1]!.work.id)
    assert.ok(rows.every(r => r.work.authors === null && r.versions.length === 0))
    assert.ok(rows.every(r => r.cards.every(c => c.verification === 'legacy_unverified' && c.spanIds.length === 0)))
    const spans = await catalog.transact([{ sql: 'SELECT COUNT(*) AS n FROM spans', params: [] }])
    assert.equal(spans[0]![0]!.n, 0)
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('verified aliases merge only one work and conflicting work aliases roll back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-alias-'))
  const catalog = await openCatalog(root)
  try {
    const base = { title: 'A', authors: ['Author'], metadataSources: ['a'.repeat(64)], status: 'verified_metadata' as const }
    const a = await registerWork(catalog, { ...base, id: 'w-a', aliases: [{ kind: 'doi' as const, value: '10.1234/a' }] })
    const same = await registerWork(catalog, { ...base, id: 'w-alias', aliases: [{ kind: 'doi' as const, value: '10.1234/a' }] })
    assert.equal(same.id, a.id)
    await registerWork(catalog, { ...base, id: 'w-b', aliases: [{ kind: 'arxiv' as const, value: '2401.01234' }] })
    await assert.rejects(registerWork(catalog, { ...base, id: 'w-conflict', aliases: [
      { kind: 'doi', value: '10.1234/a' }, { kind: 'arxiv', value: '2401.01234' },
    ] }), /IDENTITY_CONFLICT/)
    assert.equal((await listPapers(catalog, { limit: 20 })).rows.length, 2)
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('invalid legacy input is rejected before catalog records are added', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-invalid-'))
  const catalog = await openCatalog(root)
  try {
    await assert.rejects(importLegacy(catalog, root, { bytes: new TextEncoder().encode('{"papers":[]}'), runId: 'r' }), /INVALID_LEGACY/)
    assert.equal((await listPapers(catalog, { limit: 20 })).rows.length, 0)
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('concurrent metadata enrichment cannot drop aliases or provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-concurrent-'))
  const catalog = await openCatalog(root)
  try {
    const base = { id: 'w', title: 'A', authors: null, aliases: [], metadataSources: ['a'.repeat(64)], status: 'verified_metadata' as const }
    await registerWork(catalog, base)
    let arrivals = 0
    let release!: () => void
    const bothRead = new Promise<void>(resolve => { release = resolve })
    const coordinated = {
      close: () => catalog.close(),
      transact: async (statements: Parameters<typeof catalog.transact>[0]) => {
        const result = await catalog.transact(statements)
        if (statements[0]?.sql.startsWith('SELECT body FROM works') && arrivals < 2) {
          arrivals++
          if (arrivals === 2) release()
          await bothRead
        }
        return result
      },
    }
    await Promise.all([
      registerWork(coordinated, { ...base, aliases: [{ kind: 'doi', value: '10.1234/a' }], metadataSources: ['b'.repeat(64)] }),
      registerWork(coordinated, { ...base, aliases: [{ kind: 'arxiv', value: '2401.01234' }], metadataSources: ['c'.repeat(64)] }),
    ])
    const row = (await listPapers(catalog, { limit: 20 })).rows[0]!
    assert.equal(row.work.aliases.length, 2)
    assert.equal(row.work.metadataSources.length, 3)
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('paper-record handoff preserves original IDs and records canonical mappings', async () => {
  const { importPaperRecords } = await import('../../dist/literature/import.js')
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-records-'))
  try {
    const original = [{ id: 's1', title: 'Paper A', abstract: 'Generated summary' }]
    const first = await importPaperRecords(root, 'r1', original)
    const second = await importPaperRecords(root, 'r1', original)
    assert.equal(first.records[0]?.id, 's1')
    assert.equal(first.records[0]?.workId, second.records[0]?.workId)
    assert.equal(first.records[0]?.sourceStatus, 'legacy_unverified')
    assert.equal(original[0]?.workId, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('source events are immutable and require an existing document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-event-'))
  const catalog = await openCatalog(root)
  try {
    const rawHash = await putObject(root, new TextEncoder().encode('source'))
    await catalog.transact([
      { sql: 'INSERT INTO works(id,body) VALUES(?,?)', params: ['w', '{}'] },
      { sql: 'INSERT INTO documents(id,work_id,raw_hash,body) VALUES(?,?,?,?)', params: ['d', 'w', rawHash, '{}'] },
    ])
    const event = { id: 'e', documentId: 'd', createdAt: '2026-09-16T00:00:00Z',
      kind: 'access_revoked' as const, sourceHash: rawHash, reason: 'owner revoked access' }
    await recordSourceEvent(catalog, event)
    await recordSourceEvent(catalog, event)
    await assert.rejects(recordSourceEvent(catalog, { ...event, reason: 'changed' }), /SOURCE_EVENT_CONFLICT/)
    await assert.rejects(recordSourceEvent(catalog, { ...event, id: 'missing', documentId: 'absent' }), /FOREIGN KEY/)
    const [rows] = await catalog.transact([{ sql: 'SELECT COUNT(*) AS n FROM source_events', params: [] }])
    assert.equal(rows?.[0]?.n, 1)
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})
