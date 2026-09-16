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

test('legacy imports deduplicate canonical records across run IDs and retain each run association', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-import-'))
  const catalog = await openCatalog(root)
  try {
    const bytes = new TextEncoder().encode(JSON.stringify([
      { id: 'a', title: 'Same title', abstract: 'Unverified model summary', methods: ['method A'] },
      { id: 'b', title: 'Same title', abstract: 'Different work' },
    ]))
    const first = await importLegacy(catalog, root, { bytes, runId: 'r1' })
    assert.equal(first.imported, 2)
    const second = await importLegacy(catalog, root, { bytes, runId: 'r2' })
    assert.equal(second.skipped, 2)
    assert.deepEqual(second.mappings, first.mappings)
    const { rows } = await listPapers(catalog, { limit: 20 })
    assert.equal(rows.length, 2)
    assert.notEqual(rows[0]!.work.id, rows[1]!.work.id)
    assert.ok(rows.every(r => r.work.authors === null && r.versions.length === 0))
    assert.ok(rows.every(r => r.cards.every(c => c.verification === 'legacy_unverified' && c.spanIds.length === 0)))
    const spans = await catalog.transact([{ sql: 'SELECT COUNT(*) AS n FROM spans', params: [] }])
    assert.equal(spans[0]![0]!.n, 0)
    const [imports] = await catalog.transact([{ sql: 'SELECT body FROM imports', params: [] }])
    assert.equal(imports.length, 1)
    assert.deepEqual(JSON.parse(String(imports[0]!.body)).runIds, ['r1', 'r2'])
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

test('contradictory verified authors make the work unresolved while preserving both sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-authors-'))
  const catalog = await openCatalog(root)
  try {
    const base = { id: 'w-a', title: 'A', aliases: [{ kind: 'doi' as const, value: '10.1234/a' }],
      metadataSources: ['a'.repeat(64)], status: 'verified_metadata' as const }
    await registerWork(catalog, { ...base, authors: ['Ada Lovelace'] })
    await registerWork(catalog, { ...base, id: 'w-equivalent', authors: ['  ada   lovelace  '], metadataSources: ['b'.repeat(64)] })
    await assert.rejects(registerWork(catalog, { ...base, id: 'w-conflict', authors: ['Grace Hopper'],
      metadataSources: ['c'.repeat(64)] }), /METADATA_CONFLICT: authors/)
    const row = (await listPapers(catalog, { limit: 20 })).rows[0]!
    assert.equal(row.work.status, 'candidate')
    assert.deepEqual(row.work.authors, ['Ada Lovelace'])
    assert.deepEqual(row.work.metadataSources, ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)])
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('promoting a candidate does not certify aliases absent from verified metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-candidate-alias-'))
  const catalog = await openCatalog(root)
  try {
    const source = 'a'.repeat(64)
    await registerWork(catalog, { id: 'w', title: 'A', authors: ['Unverified Author'],
      aliases: [{ kind: 'url', value: 'https://example.test/unverified' }], metadataSources: [source], status: 'candidate' })
    const verified = await registerWork(catalog, { id: 'w', title: 'A', authors: ['Author'],
      aliases: [{ kind: 'doi', value: '10.1234/a' }], metadataSources: ['b'.repeat(64)], status: 'verified_metadata' })
    assert.deepEqual(verified.aliases, [{ kind: 'doi', value: '10.1234/a' }])
    const [aliases] = await catalog.transact([{ sql: 'SELECT kind,value FROM aliases ORDER BY kind,value', params: [] }])
    assert.deepEqual(aliases, [{ kind: 'doi', value: '10.1234/a' }])
  } finally { await catalog.close(); await rm(root, { recursive: true, force: true }) }
})

test('paper rows expose the 15 display columns with provenance and explicit gaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-header-'))
  const catalog = await openCatalog(root)
  try {
    const bytes = new TextEncoder().encode(JSON.stringify([{ id: 'a', title: 'Paper A', year: '2024', venue: 'Venue',
      methods: ['Method A'], experiments: ['Dataset A'], keyFinding: 'Result A', limitations: ['Limit A'], relevance: 'Related' }]))
    await importLegacy(catalog, root, { bytes, runId: 'r1' })
    const row = (await listPapers(catalog, { limit: 1 })).rows[0]!
    assert.deepEqual(Object.keys(row.header), [
      'paperId', 'title', 'authors', 'yearVersion', 'publicationStatus', 'researchQuestion', 'methods',
      'experimentTaskData', 'coreResults', 'limitationsCounterevidence', 'currentResearchRelationship',
      'baselineFit', 'readingCoverage', 'sourceLocation', 'ingestionStatus',
    ])
    assert.equal(row.header.title.status, 'unverified')
    assert.equal(row.header.title.origin, 'source_metadata')
    assert.equal(row.header.authors.display, 'unverified')
    assert.equal(row.header.publicationStatus.origin, 'source_metadata')
    assert.deepEqual(row.header.methods.values, ['Method A'])
    assert.equal(row.header.methods.origin, 'agent_analysis')
    assert.equal(row.header.methods.status, 'unverified')
    assert.equal(row.header.baselineFit.display, 'unknown')
    assert.equal(row.header.readingCoverage.display, 'unread')
    assert.deepEqual(row.header.ingestionStatus.values, ['acquisition:metadata_only', 'parse:pending', 'index:not_indexed'])
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
