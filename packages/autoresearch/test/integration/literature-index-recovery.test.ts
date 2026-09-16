import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { openCatalog } from '../../dist/literature/catalog.js'
import {
  buildGeneration,
  getActiveGeneration,
  getGeneration,
  pinGeneration,
  publishGeneration,
} from '../../dist/literature/index-generation.js'
import { searchLexical } from '../../dist/literature/lexical.js'
import type { SourceSpan } from '../../dist/literature/contracts.js'
import { persistIndexedDocument } from '../fixtures/literature-index.ts'
import { withLibrary } from '../fixtures/literature.ts'

test('published directories survive restart before CAS and retired generations remain readable', async () => {
  await withLibrary(async (root) => {
    let catalog = await openCatalog(root)
    try {
      const firstFixture = await persistIndexedDocument(catalog, root, {
        id: 'first', partitionId: 'public', title: 'First', texts: ['first evidence'],
      })
      const first = await buildGeneration(catalog, root, firstFixture.spans, { expectedActiveId: null, maxSpans: 10 })
      await publishGeneration(catalog, root, first.id, null)

      const secondFixture = await persistIndexedDocument(catalog, root, {
        id: 'second', partitionId: 'public', title: 'Second', texts: ['second evidence'],
      })
      const second = await buildGeneration(
        catalog,
        root,
        [...firstFixture.spans, ...secondFixture.spans],
        { expectedActiveId: first.id, maxSpans: 10 },
      )
      await stat(join(root, 'indexes', 'generations', second.id, 'manifest.json'))
      assert.equal((await getActiveGeneration(catalog))?.id, first.id)

      await catalog.close()
      catalog = await openCatalog(root)
      assert.equal((await getActiveGeneration(catalog))?.id, first.id)
      await publishGeneration(catalog, root, second.id, first.id)
      assert.equal((await getActiveGeneration(catalog))?.id, second.id)
      assert.equal((await getGeneration(catalog, first.id))?.status, 'retired')

      await assert.rejects(
        searchLexical(catalog, root, {
          generationId: first.id,
          query: 'first',
          authorizedPartitionIds: ['public'],
          maxResults: 5,
        }),
        (error: unknown) => (error as { code?: string }).code === 'INDEX_GENERATION_NOT_PINNED',
      )
      await pinGeneration(catalog, 'run-pinned', first.id)
      await pinGeneration(catalog, 'run-pinned', first.id)
      const oldHits = await searchLexical(catalog, root, {
        generationId: first.id,
        runId: 'run-pinned',
        query: 'first',
        authorizedPartitionIds: ['public'],
        maxResults: 5,
      })
      assert.deepEqual(oldHits.map((hit) => hit.spanId), [firstFixture.spans[0]!.id])
      const [pins] = await catalog.transact([{
        sql: 'SELECT run_id,generation_id FROM generation_pins WHERE run_id=?',
        params: ['run-pinned'],
      }])
      assert.deepEqual(pins, [{ run_id: 'run-pinned', generation_id: first.id }])
    } finally {
      await catalog.close()
    }
  })
})

test('two publishers with the same expected active generation have exactly one CAS winner', async () => {
  await withLibrary(async (root) => {
    const setup = await openCatalog(root)
    let firstPublisher: Awaited<ReturnType<typeof openCatalog>> | undefined
    let secondPublisher: Awaited<ReturnType<typeof openCatalog>> | undefined
    try {
      const baseFixture = await persistIndexedDocument(setup, root, {
        id: 'base', partitionId: 'public', title: 'Base', texts: ['base evidence'],
      })
      const base = await buildGeneration(setup, root, baseFixture.spans, { expectedActiveId: null, maxSpans: 10 })
      await publishGeneration(setup, root, base.id, null)

      const leftFixture = await persistIndexedDocument(setup, root, {
        id: 'left', partitionId: 'public', title: 'Left', texts: ['left evidence'],
      })
      const rightFixture = await persistIndexedDocument(setup, root, {
        id: 'right', partitionId: 'public', title: 'Right', texts: ['right evidence'],
      })
      const left = await buildGeneration(setup, root, [...baseFixture.spans, ...leftFixture.spans], {
        expectedActiveId: base.id, maxSpans: 10,
      })
      const right = await buildGeneration(setup, root, [...baseFixture.spans, ...rightFixture.spans], {
        expectedActiveId: base.id, maxSpans: 10,
      })

      firstPublisher = await openCatalog(root)
      secondPublisher = await openCatalog(root)
      const outcomes = await Promise.allSettled([
        publishGeneration(firstPublisher, root, left.id, base.id),
        publishGeneration(secondPublisher, root, right.id, base.id),
      ])
      assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
      assert.equal(outcomes.filter((result) => result.status === 'rejected' &&
        (result.reason as { code?: string }).code === 'INDEX_CAS_FAILED').length, 1)
      const activeId = (await getActiveGeneration(setup))?.id
      assert.ok(activeId === left.id || activeId === right.id)
      const loserId = activeId === left.id ? right.id : left.id
      assert.equal((await getGeneration(setup, loserId))?.status, 'validated')
    } finally {
      await Promise.allSettled([setup.close(), firstPublisher?.close(), secondPublisher?.close()])
    }
  })
})

test('a process crash after a document checkpoint resumes the exact staging generation', { timeout: 30_000 }, async () => {
  await withLibrary(async (root) => {
    let catalog = await openCatalog(root)
    const spans: SourceSpan[] = []
    try {
      for (let index = 0; index < 120; index += 1) {
        const fixture = await persistIndexedDocument(catalog, root, {
          id: `crash-${String(index).padStart(3, '0')}`,
          partitionId: 'public',
          title: `Crash ${index}`,
          texts: [`checkpoint evidence ${index} ${'x'.repeat(256)}`],
        })
        spans.push(...fixture.spans)
      }
    } finally {
      await catalog.close()
    }

    const inputPath = join(root, 'crash-spans.json')
    await writeFile(inputPath, JSON.stringify(spans))
    const catalogUrl = pathToFileURL(resolve('dist/literature/catalog.js')).href
    const generationUrl = pathToFileURL(resolve('dist/literature/index-generation.js')).href
    const script = [
      `(async () => {`,
      `const { readFile } = require('node:fs/promises')`,
      `const { openCatalog } = await import(${JSON.stringify(catalogUrl)})`,
      `const { buildGeneration } = await import(${JSON.stringify(generationUrl)})`,
      `const catalog = await openCatalog(process.argv[1])`,
      `const spans = JSON.parse(await readFile(process.argv[2], 'utf8'))`,
      `await buildGeneration(catalog, process.argv[1], spans, { expectedActiveId: null, maxSpans: 200 })`,
      `await catalog.close()`,
      `})().catch(error => { console.error(error); process.exitCode = 1 })`,
    ].join(';')
    const child = spawn(process.execPath, ['-e', script, root, inputPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let childError = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { childError += chunk })

    const checkpoint = await waitForPartialCheckpoint(root, spans.length, () => ({
      exitCode: child.exitCode,
      stderr: childError,
    }))
    assert.ok(checkpoint.completedDocumentIds.length > 0)
    assert.ok(checkpoint.completedDocumentIds.length < spans.length)
    child.kill()
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once('exit', () => resolveExit())
      child.once('error', rejectExit)
    })
    assert.doesNotMatch(childError, /\bError\b|ERR_/u)

    catalog = await openCatalog(root)
    try {
      const [building] = await catalog.transact([{
        sql: "SELECT id,status FROM index_generations WHERE status='building'",
        params: [],
      }])
      assert.equal(building.length, 1)
      const resumed = await buildGeneration(catalog, root, spans, { expectedActiveId: null, maxSpans: 200 })
      assert.equal(resumed.id, building[0]?.id)
      assert.equal(resumed.status, 'validated')
      await stat(join(root, 'indexes', 'generations', resumed.id, 'manifest.json'))
    } finally {
      await catalog.close()
    }
  })
})

async function waitForPartialCheckpoint(
  root: string,
  totalDocuments: number,
  childState: () => { exitCode: number | null; stderr: string },
): Promise<{ completedDocumentIds: string[] }> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const stagingRoot = join(root, 'indexes', 'staging')
      const entries = await readdir(stagingRoot)
      for (const entry of entries) {
        const checkpoint = JSON.parse(await readFile(join(stagingRoot, entry, 'checkpoint.json'), 'utf8')) as {
          completedDocumentIds?: unknown
        }
        if (Array.isArray(checkpoint.completedDocumentIds) && checkpoint.completedDocumentIds.length < totalDocuments) {
          return { completedDocumentIds: checkpoint.completedDocumentIds as string[] }
        }
      }
    } catch {
      // The checkpoint is atomically replaced while the child is building.
    }
    const state = childState()
    if (state.exitCode !== null) {
      throw new Error(`index builder exited before a partial checkpoint (code ${state.exitCode}): ${state.stderr}`)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2))
  }
  throw new Error('timed out waiting for a partial index checkpoint')
}
