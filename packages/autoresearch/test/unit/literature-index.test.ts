import assert from 'node:assert/strict'
import { stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { openCatalog } from '../../dist/literature/catalog.js'
import {
  buildGeneration,
  generationDirectory,
  getActiveGeneration,
  getGeneration,
  loadGenerationManifest,
  publishGeneration,
} from '../../dist/literature/index-generation.js'
import { readGenerationSpans, searchLexical } from '../../dist/literature/lexical.js'
import { tokenize } from '../../dist/literature/tokenize.js'
import { persistIndexedDocument } from '../fixtures/literature-index.ts'
import { withCatalog, withLibrary } from '../fixtures/literature.ts'

test('tokenizer emits normalized English segments plus Han unigrams and bigrams', () => {
  const tokens = tokenize('反证 ＲＡＧ-2')
  assert.ok(tokens.includes('反证'))
  assert.ok(tokens.includes('反'))
  assert.ok(tokens.includes('证'))
  assert.ok(tokens.includes('rag'))
  assert.ok(tokens.includes('2'))
  assert.ok(!tokenize('反 证').includes('反证'))
  assert.deepEqual(tokenize('rag rag'), ['rag', 'rag'])
  assert.deepEqual(tokenize('   '), [])
})

test('generation identity is reproducible and each exposure partition has a separate index', async () => {
  await withCatalog(async (root, catalog) => {
    const publicDocument = await persistIndexedDocument(catalog, root, {
      id: 'public', partitionId: 'public', title: 'Visible title', texts: ['反证 evidence'],
    })
    const privateDocument = await persistIndexedDocument(catalog, root, {
      id: 'private', partitionId: 'private', title: 'Hidden title', texts: ['反证 hidden'],
    })
    const spans = [...publicDocument.spans, ...privateDocument.spans]

    const first = await buildGeneration(catalog, root, spans, { expectedActiveId: null, maxSpans: 10 })
    const repeated = await buildGeneration(catalog, root, [...spans].reverse(), { expectedActiveId: null, maxSpans: 10 })

    assert.equal(repeated.id, first.id)
    assert.equal(repeated.manifestHash, first.manifestHash)
    assert.deepEqual(first.partitionIds, ['private', 'public'])
    const stored = await getGeneration(catalog, first.id)
    assert.equal(stored?.status, 'validated')

    const [files] = await catalog.transact([{
      sql: 'SELECT id,manifest_hash,corpus_hash,config_hash,status FROM index_generations WHERE id=?',
      params: [first.id],
    }])
    assert.deepEqual(files, [{
      id: first.id,
      manifest_hash: first.manifestHash,
      corpus_hash: first.corpusHash,
      config_hash: first.configHash,
      status: 'validated',
    }])
  })
})

test('generation identity is stable across host locale ordering', async () => {
  await withCatalog(async (root, catalog) => {
    const zDocument = await persistIndexedDocument(catalog, root, {
      id: 'z', partitionId: 'z', title: 'Zulu', texts: ['stable corpus'],
    })
    const umlautDocument = await persistIndexedDocument(catalog, root, {
      id: 'ä', partitionId: 'ä', title: 'Umlaut', texts: ['stable corpus'],
    })
    const spans = [...zDocument.spans, ...umlautDocument.spans]
    const baseline = await buildGeneration(catalog, root, spans, { expectedActiveId: null, maxSpans: 4 })

    const localeCompare = String.prototype.localeCompare
    try {
      String.prototype.localeCompare = function (other: string): number {
        const left = String(this)
        return left < other ? 1 : left > other ? -1 : 0
      }
      const underDifferentCollation = await buildGeneration(
        catalog,
        root,
        [...spans].reverse(),
        { expectedActiveId: null, maxSpans: 4 },
      )
      assert.equal(underDifferentCollation.id, baseline.id)
      assert.equal(underDifferentCollation.manifestHash, baseline.manifestHash)
    } finally {
      String.prototype.localeCompare = localeCompare
    }
  })
})

test('lexical search accepts only authorized partitions and has stable score/span ordering', async () => {
  await withCatalog(async (root, catalog) => {
    const titleMatch = await persistIndexedDocument(catalog, root, {
      id: 'title-match', partitionId: 'public', title: 'Counterfactual benchmark', texts: ['ordinary result'],
    })
    const bodyMatch = await persistIndexedDocument(catalog, root, {
      id: 'body-match', partitionId: 'public', title: 'Ordinary paper', texts: ['counterfactual benchmark'],
    })
    const hidden = await persistIndexedDocument(catalog, root, {
      id: 'hidden', partitionId: 'private', title: 'Counterfactual benchmark', texts: ['secret result'],
    })
    const generation = await buildGeneration(
      catalog,
      root,
      [...titleMatch.spans, ...bodyMatch.spans, ...hidden.spans],
      { expectedActiveId: null, maxSpans: 10 },
    )
    await publishGeneration(catalog, root, generation.id, null)

    const hits = await searchLexical(catalog, root, {
      generationId: generation.id,
      query: 'counterfactual',
      authorizedPartitionIds: ['public'],
      maxResults: 10,
    })

    assert.deepEqual(new Set(hits.map((hit) => hit.partitionId)), new Set(['public']))
    assert.equal(hits[0]?.spanId, titleMatch.spans[0]?.id)
    assert.ok(hits.every((hit, index) => index === 0 ||
      hits[index - 1]!.score < hit.score ||
      (hits[index - 1]!.score === hit.score && hits[index - 1]!.spanId <= hit.spanId)))
    assert.deepEqual(await searchLexical(catalog, root, {
      generationId: generation.id,
      query: '"* OR *"',
      authorizedPartitionIds: ['public'],
      maxResults: 10,
    }), [])
  })
})

test('lexical search rejects an empty token stream without passing raw MATCH syntax', async () => {
  await withCatalog(async (root, catalog) => {
    const fixture = await persistIndexedDocument(catalog, root, {
      id: 'query', partitionId: 'public', title: 'Query', texts: ['searchable'],
    })
    const generation = await buildGeneration(catalog, root, fixture.spans, { expectedActiveId: null, maxSpans: 2 })
    await publishGeneration(catalog, root, generation.id, null)
    await assert.rejects(
      searchLexical(catalog, root, {
        generationId: generation.id,
        query: ' --- ',
        authorizedPartitionIds: ['public'],
        maxResults: 5,
      }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_query',
    )
  })
})

test('empty lexical input is invalid before generation lookup', async () => {
  await withCatalog(async (root, catalog) => {
    await assert.rejects(
      searchLexical(catalog, root, {
        generationId: 'missing-generation',
        query: ' --- ',
        authorizedPartitionIds: ['public'],
        maxResults: 5,
      }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_query',
    )
  })
})

test('publication rejects an FTS file changed after build validation', async () => {
  await withCatalog(async (root, catalog) => {
    const fixture = await persistIndexedDocument(catalog, root, {
      id: 'tampered-index', partitionId: 'public', title: 'Tamper', texts: ['original searchable body'],
    })
    const generation = await buildGeneration(catalog, root, fixture.spans, { expectedActiveId: null, maxSpans: 2 })
    const manifest = await loadGenerationManifest(root, generation.id)
    const database = new DatabaseSync(join(
      generationDirectory(root, generation.id),
      manifest.partitionFiles[0]!.file,
    ))
    try {
      database.prepare('UPDATE spans_fts SET body=?').run('different searchable body')
    } finally {
      database.close()
    }

    await assert.rejects(
      publishGeneration(catalog, root, generation.id, null),
      (error: unknown) => (error as { code?: string }).code === 'INDEX_INTEGRITY_FAILED',
    )
    assert.equal(await getGeneration(catalog, generation.id).then(value => value?.status), 'validated')
  })
})

test('a failed rebuild cannot demote the active generation', async () => {
  await withCatalog(async (root, catalog) => {
    const fixture = await persistIndexedDocument(catalog, root, {
      id: 'active-rebuild', partitionId: 'public', title: 'Active', texts: ['active evidence'],
    })
    const generation = await buildGeneration(catalog, root, fixture.spans, { expectedActiveId: null, maxSpans: 2 })
    await publishGeneration(catalog, root, generation.id, null)
    await writeFile(join(generationDirectory(root, generation.id), 'manifest.json'), '{}\n')

    await assert.rejects(
      buildGeneration(catalog, root, fixture.spans, { expectedActiveId: generation.id, maxSpans: 2 }),
      (error: unknown) => (error as { code?: string }).code === 'INDEX_MANIFEST_INVALID',
    )
    assert.equal((await getActiveGeneration(catalog))?.id, generation.id)
    assert.equal((await getGeneration(catalog, generation.id))?.status, 'active')
  })
})

test('generation build stops when a registered raw object is missing', async () => {
  await withCatalog(async (root, catalog) => {
    const fixture = await persistIndexedDocument(catalog, root, {
      id: 'missing', partitionId: 'public', title: 'Missing', texts: ['must not be skipped'],
    })
    const hash = fixture.document.rawHash
    await unlink(join(root, 'objects', hash.slice(0, 2), hash.slice(2)))

    await assert.rejects(
      buildGeneration(catalog, root, fixture.spans, { expectedActiveId: null, maxSpans: 2 }),
      /object|source|missing|not found/i,
    )
    const [rows] = await catalog.transact([{ sql: 'SELECT status FROM index_generations', params: [] }])
    assert.deepEqual(rows, [{ status: 'failed' }])
  })
})

test('one partition cannot mix distinct project or policy visibility scopes', async () => {
  await withCatalog(async (root, catalog) => {
    const first = await persistIndexedDocument(catalog, root, {
      id: 'scope-a', partitionId: 'shared-name', projectId: 'project-a', title: 'A', texts: ['same token'],
    })
    const second = await persistIndexedDocument(catalog, root, {
      id: 'scope-b', partitionId: 'shared-name', projectId: 'project-b', title: 'B', texts: ['same token'],
    })
    await assert.rejects(
      buildGeneration(catalog, root, [...first.spans, ...second.spans], { expectedActiveId: null, maxSpans: 10 }),
      (error: unknown) => (error as { code?: string }).code === 'INDEX_PARTITION_SCOPE_CONFLICT',
    )
  })
})

test('generation build validates span hashes and document source provenance', async () => {
  await withCatalog(async (root, catalog) => {
    const fixture = await persistIndexedDocument(catalog, root, {
      id: 'bad-source-binding', partitionId: 'public', title: 'Binding', texts: ['bound evidence'],
    })
    const mismatched = {
      ...fixture.spans[0]!,
      locator: { ...fixture.spans[0]!.locator, sourceHash: '0'.repeat(64) },
    }
    await catalog.transact([{
      sql: 'UPDATE spans SET body=? WHERE id=?',
      params: [JSON.stringify(mismatched), mismatched.id],
    }])
    await assert.rejects(
      buildGeneration(catalog, root, [mismatched], { expectedActiveId: null, maxSpans: 2 }),
      (error: unknown) => (error as { code?: string }).code === 'INDEX_SPAN_SOURCE_MISMATCH',
    )

    const badContent = {
      ...mismatched,
      locator: fixture.spans[0]!.locator,
      contentHash: '0'.repeat(64),
    }
    await catalog.transact([{
      sql: 'UPDATE spans SET body=? WHERE id=?',
      params: [JSON.stringify(badContent), badContent.id],
    }])
    await assert.rejects(
      buildGeneration(catalog, root, [badContent], { expectedActiveId: null, maxSpans: 2 }),
      (error: unknown) => (error as { code?: string }).code === 'INDEX_SPAN_CONTENT_MISMATCH',
    )
  })
})

test('pinned span reads use immutable generation records instead of mutable catalog bodies', async () => {
  await withCatalog(async (root, catalog) => {
    const fixture = await persistIndexedDocument(catalog, root, {
      id: 'immutable', partitionId: 'public', title: 'Immutable', texts: ['original evidence'],
    })
    const generation = await buildGeneration(catalog, root, fixture.spans, { expectedActiveId: null, maxSpans: 2 })
    await publishGeneration(catalog, root, generation.id, null)
    const changed = { ...fixture.spans[0]!, evidenceText: 'mutated catalog text' }
    await catalog.transact([{ sql: 'UPDATE spans SET body=? WHERE id=?', params: [JSON.stringify(changed), changed.id] }])

    const [stored] = await readGenerationSpans(catalog, root, generation.id, [changed.id], ['public'])
    assert.equal(stored?.evidenceText, 'original evidence')
  })
})

test('v1 catalog migration creates a consistent backup before adding generation tables', async () => {
  await withLibrary(async (root) => {
    let catalog = await openCatalog(root)
    await catalog.transact([{
      sql: 'INSERT INTO works(id,body) VALUES(?,?)',
      params: ['legacy-work', '{"id":"legacy-work"}'],
    }])
    await catalog.close()

    const databasePath = join(root, 'catalog.sqlite')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE generation_pins;
      DROP TABLE index_state;
      DROP TABLE index_generations;
      PRAGMA user_version=1;
    `)
    legacy.close()
    await writeFile(`${databasePath}.v1.backup`, 'interrupted backup')

    catalog = await openCatalog(root)
    try {
      const [works, tables, version] = await catalog.transact([
        { sql: 'SELECT id FROM works', params: [] },
        { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('index_generations','index_state','generation_pins') ORDER BY name", params: [] },
        { sql: 'PRAGMA user_version', params: [] },
      ])
      assert.deepEqual(works, [{ id: 'legacy-work' }])
      assert.deepEqual(tables.map(row => row.name), ['generation_pins', 'index_generations', 'index_state'])
      assert.equal(version[0]?.user_version, 2)
      await stat(`${databasePath}.v1.backup`)

      const backup = new DatabaseSync(`${databasePath}.v1.backup`, { readOnly: true })
      try {
        assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1)
        assert.deepEqual(backup.prepare('SELECT id FROM works').all().map(row => row.id), ['legacy-work'])
      } finally {
        backup.close()
      }
    } finally {
      await catalog.close()
    }
  })
})
