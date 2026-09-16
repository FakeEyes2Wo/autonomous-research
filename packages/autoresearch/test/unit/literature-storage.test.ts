import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { Worker } from 'node:worker_threads'

import {
  assertDocumentVersion,
  assertHash,
  assertSourceSpan,
  assertWork,
} from '../../dist/literature/contracts.js'
import { openCatalog } from '../../dist/literature/catalog.js'
import { putObject, readObject } from '../../dist/literature/objects.js'
import { withCatalog, withLibrary } from '../fixtures/literature.ts'

const hash = 'a'.repeat(64)

test('contract validators accept complete records and reject malformed hashes', () => {
  assert.equal(assertHash(hash), hash)
  assert.throws(() => assertHash('A'.repeat(64)), /hash/i)

  const work = {
    id: 'work-1',
    title: 'Measured result',
    authors: ['Ada Example'],
    aliases: [{ kind: 'doi', value: '10.1/example' }],
    metadataSources: [hash],
    status: 'verified_metadata',
  }
  assert.deepEqual(assertWork(work), work)

  const document = {
    id: 'doc-1',
    workId: work.id,
    versionLabel: null,
    sourceUrl: 'https://example.test/paper',
    rawHash: hash,
    mediaType: 'text/plain',
    fetchedAt: '2026-09-16T00:00:00.000Z',
    visibility: {
      projectId: 'project-1',
      partitionId: 'public',
      roles: ['researcher'],
      policyHash: hash,
    },
    publicationDate: '2026-09-01',
    updatedAt: null,
    sourceKind: 'full_text',
    license: 'CC-BY-4.0',
  }
  assert.deepEqual(assertDocumentVersion(document), document)

  const span = {
    id: 'span-1',
    workId: work.id,
    documentId: document.id,
    parserFingerprint: hash,
    kind: 'paragraph',
    sectionPath: ['Results'],
    evidenceText: 'Accuracy was 0.42.',
    retrievalText: 'Accuracy was 0.42.',
    locator: { kind: 'text', start: 0, end: 18, unit: 'utf16', sourceHash: hash },
    contentHash: hash,
    visibility: document.visibility,
    quality: 'accepted',
    sourceKind: 'full_text',
  }
  assert.deepEqual(assertSourceSpan(span), span)
  assert.throws(
    () => assertSourceSpan({ ...span, locator: { ...span.locator, end: -1 } }),
    /locator/i,
  )
})

test('repeated source bytes produce one immutable object and read back byte-for-byte', async () => {
  await withLibrary(async root => {
    const bytes = new TextEncoder().encode('Table 1: 0.42 ± 0.03')
    const first = await putObject(root, bytes)
    assert.equal(await putObject(root, bytes), first)
    assert.deepEqual(await readObject(root, first), bytes)
  })
})

test('object reads reject tampering instead of returning bytes under a false hash', async () => {
  await withLibrary(async temporaryRoot => {
    const root = join(temporaryRoot, '中文文献库')
    const hash = await putObject(root, new TextEncoder().encode('original evidence'))
    await writeFile(join(root, 'objects', hash.slice(0, 2), hash.slice(2)), 'tampered evidence')
    await assert.rejects(readObject(root, hash), /integrity|hash/i)
  })
})

test('object reads reject malformed and missing hashes', async () => {
  await withLibrary(async root => {
    await assert.rejects(readObject(root, '../not-a-hash'), /hash/i)
    await assert.rejects(readObject(root, 'f'.repeat(64)), /not found/i)
  })
})

test('catalog probes FTS5, enables foreign keys, creates the registry, and reopens', async () => {
  await withLibrary(async root => {
    let catalog = await openCatalog(root)
    try {
      const [foreignKeys] = await catalog.transact([{ sql: 'PRAGMA foreign_keys', params: [] }])
      assert.equal(foreignKeys[0]?.foreign_keys, 1)
      await catalog.transact([
        { sql: 'CREATE VIRTUAL TABLE fts_probe USING fts5(body)', params: [] },
        { sql: 'INSERT INTO fts_probe(body) VALUES (?)', params: ['searchable phrase'] },
      ])
      const [tables, matches] = await catalog.transact([
        {
          sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('works','aliases','documents','spans','cards','imports','parse_reports','source_events') ORDER BY name",
          params: [],
        },
        { sql: "SELECT body FROM fts_probe WHERE fts_probe MATCH 'searchable'", params: [] },
      ])
      assert.deepEqual(tables.map(row => row.name), ['aliases', 'cards', 'documents', 'imports', 'parse_reports', 'source_events', 'spans', 'works'])
      assert.deepEqual(matches, [{ body: 'searchable phrase' }])
      await catalog.close()

      catalog = await openCatalog(root)
      const [persisted] = await catalog.transact([{ sql: 'SELECT body FROM fts_probe', params: [] }])
      assert.deepEqual(persisted, [{ body: 'searchable phrase' }])
    } finally {
      await catalog.close()
    }
  })
})

test('catalog rolls back every statement when one statement fails', async () => {
  await withCatalog(async (_root, catalog) => {
    await assert.rejects(
      catalog.transact([
        { sql: 'INSERT INTO works(id, body) VALUES (?, ?)', params: ['work-1', '{"id":"work-1"}'] },
        { sql: 'INSERT INTO works(id, body) VALUES (?, ?)', params: ['work-1', '{"id":"duplicate"}'] },
      ]),
      /unique|constraint/i,
    )
    const [rows] = await catalog.transact([{ sql: 'SELECT id FROM works', params: [] }])
    assert.deepEqual(rows, [])
  })
})

test('catalog enforces relations, JSON bodies, and immutable source existence', async () => {
  await withCatalog(async (root, catalog) => {
    await assert.rejects(
      catalog.transact([{ sql: 'INSERT INTO aliases(kind,value,work_id) VALUES (?,?,?)', params: ['doi', '10.1/missing', 'missing'] }]),
      /foreign key/i,
    )
    await assert.rejects(
      catalog.transact([{ sql: 'INSERT INTO works(id,body) VALUES (?,?)', params: ['invalid-json', 'not json'] }]),
      /check constraint/i,
    )
    await catalog.transact([{ sql: 'INSERT INTO works(id,body) VALUES (?,?)', params: ['work-1', '{"id":"work-1"}'] }])
    await assert.rejects(
      catalog.transact([{ sql: 'INSERT INTO documents(id,work_id,raw_hash,body) VALUES (?,?,?,?)', params: ['doc-1', 'work-1', 'f'.repeat(64), '{"id":"doc-1"}'] }]),
      /object|source|hash/i,
    )
    const rawHash = await putObject(root, new TextEncoder().encode('verifiable source'))
    await catalog.transact([{ sql: 'INSERT INTO documents(id,work_id,raw_hash,body) VALUES (?,?,?,?)', params: ['doc-1', 'work-1', rawHash, '{"id":"doc-1"}'] }])
    const [documents] = await catalog.transact([{ sql: 'SELECT id,raw_hash FROM documents', params: [] }])
    assert.deepEqual(documents, [{ id: 'doc-1', raw_hash: rawHash }])
  })
})

test('two catalog connections serialize competing writers without losing either transaction', async () => {
  await withLibrary(async root => {
    const first = await openCatalog(root)
    const second = await openCatalog(root)
    try {
      await Promise.all([
        first.transact([{ sql: 'INSERT INTO works(id,body) VALUES (?,?)', params: ['first', '{"id":"first"}'] }]),
        second.transact([{ sql: 'INSERT INTO works(id,body) VALUES (?,?)', params: ['second', '{"id":"second"}'] }]),
      ])
      const [rows] = await first.transact([{ sql: 'SELECT id FROM works ORDER BY id', params: [] }])
      assert.deepEqual(rows, [{ id: 'first' }, { id: 'second' }])
    } finally {
      await Promise.allSettled([first.close(), second.close()])
    }
  })
})

test('future schemas and corrupt database bytes are rejected with stable error codes', async () => {
  await withLibrary(async root => {
    const database = new DatabaseSync(join(root, 'catalog.sqlite'))
    database.exec('PRAGMA user_version=99')
    database.close()
    await assert.rejects(openCatalog(root), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SCHEMA_TOO_NEW')
      return true
    })
  })
  await withLibrary(async root => {
    await writeFile(join(root, 'catalog.sqlite'), 'definitely not sqlite')
    await assert.rejects(openCatalog(root), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CATALOG_CORRUPT')
      return true
    })
  })
})

test('worker termination rejects pending transactions and future calls instead of hanging', async () => {
  await withLibrary(async root => {
    const catalog = await openCatalog(root)
    const pending = catalog.transact([{
      sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 100000000) SELECT sum(x) FROM n',
      params: [],
    }])
    const worker = (catalog as unknown as { worker: Worker }).worker
    await worker.terminate()
    await assert.rejects(pending, /worker|terminated|exit/i)
    await assert.rejects(catalog.transact([{ sql: 'SELECT 1', params: [] }]), /worker|closed|terminated|exit/i)
    await catalog.close()
  })
})
