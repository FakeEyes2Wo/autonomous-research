import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { AutoResearchError } from '../../dist/core/utils.js'

test('ResearchTree add/query/update and persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-tree-'))
  try {
    const tree = await ResearchTree.load(dir)
    const hyp = tree.add('hypothesis', 'test hypothesis', { status: 'proposed' })
    const action = tree.add('action', 'run experiment', { parent: hyp.id, status: 'running' })
    const evidence = tree.add('evidence', 'observed result', { parent: action.id, status: 'supports', artifacts: ['a.txt'] })
    await tree.save()

    const loaded = await ResearchTree.load(dir)
    assert.equal(loaded.query({ kind: 'hypothesis' }).length, 1)
    assert.equal(loaded.query({ kind: 'action' }).length, 1)
    assert.equal(loaded.query({ kind: 'evidence' }).length, 1)
    assert.equal(loaded.get(evidence.id).status, 'supports')

    loaded.update(action.id, { status: 'completed' })
    assert.equal(loaded.get(action.id).status, 'completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ResearchTree rejects invalid parent and duplicate id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-tree-err-'))
  try {
    const tree = await ResearchTree.load(dir)
    assert.throws(() => tree.add('action', 'no parent'), AutoResearchError)
    const hyp = tree.add('hypothesis', 'h')
    assert.throws(() => tree.add('hypothesis', 'dup', { id: hyp.id }), AutoResearchError)
    assert.throws(() => tree.add('action', 'bad parent', { parent: 'missing' }), AutoResearchError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
