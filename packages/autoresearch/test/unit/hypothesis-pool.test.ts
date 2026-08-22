import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { HypothesisPool } from '../../dist/core/hypothesis-pool.js'

test('HypothesisPool syncs statuses from evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-pool-'))
  try {
    const tree = await ResearchTree.load(dir)
    const hyp = tree.add('hypothesis', 'H1')
    const action = tree.add('action', 'A1', { parent: hyp.id })
    const ev = tree.add('evidence', 'E1', { parent: action.id, status: 'supports' })
    await tree.save()

    const pool = await HypothesisPool.load(dir)
    pool.syncFromTree(tree, 'cand-1')
    await pool.save()

    assert.equal(pool.get(hyp.id)?.status, 'SUPPORTED')
    assert.deepEqual(pool.get(hyp.id)?.evidence_ids, [ev.id])
    assert.equal(pool.query('SUPPORTED').length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
