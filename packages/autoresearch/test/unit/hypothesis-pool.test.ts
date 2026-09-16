import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test('malformed hypothesis pool is reported instead of silently discarding history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-pool-corrupt-'))
  try {
    await writeFile(join(dir, 'hypothesis_pool.json'), '{')
    await assert.rejects(() => HypothesisPool.load(dir), /JSON|parse|read/i)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('legacy contradictory evidence is aggregated and marked unknown provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-pool-conflict-'))
  try {
    const tree = await ResearchTree.load(dir)
    const hyp = tree.add('hypothesis', 'A helps')
    const action = tree.add('action', 'Compare A/B', { parent: hyp.id })
    tree.add('evidence', 'positive', { parent: action.id, status: 'supports' })
    tree.add('evidence', 'negative', { parent: action.id, status: 'refutes' })
    const pool = await HypothesisPool.load(dir)
    pool.syncFromTree(tree)
    assert.equal(pool.get(hyp.id)?.status, 'INCONCLUSIVE')
    assert.equal(pool.get(hyp.id)?.provenance, 'unknown')
    assert.equal(pool.get(hyp.id)?.evidence_ids.length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('canonical snapshot lineage and mixed assessment survive legacy tree refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-pool-canonical-'))
  try {
    const tree = await ResearchTree.load(dir)
    const hyp = tree.add('hypothesis', 'stale statement')
    const action = tree.add('action', 'old action', { parent: hyp.id })
    tree.add('evidence', 'old positive', { parent: action.id, status: 'supports' })
    const pool = await HypothesisPool.load(dir)
    assert.equal(typeof pool.syncFromSnapshot, 'function', 'canonical snapshot projection must exist')
    pool.syncFromSnapshot({ id: 'snapshot-3', content_hash: 'snapshot-hash', active_hypothesis: { id: hyp.id, version: 2 }, active_claim: { id: 'claim', version: 2 }, protocol: { hypothesis: { id: hyp.id, version: 2 } }, hypotheses: [{ id: hyp.id, version: 2, statement: 'current statement', status: 'proposed', parents: [{ id: hyp.id, version: 1 }], source_refs: [], content_hash: 'hyp-hash', mode: 'formal' }], evidence: [{ id: 'new-positive' }, { id: 'new-negative' }], assessment: { claim_status: 'inconclusive', category: 'mixed_evidence', supporting_evidence_ids: ['new-positive'], opposing_evidence_ids: ['new-negative'] } })
    pool.syncFromTree(tree)
    await pool.save()
    const reloaded = await HypothesisPool.load(dir)
    assert.equal(reloaded.get(hyp.id)?.statement, 'current statement')
    assert.equal(reloaded.get(hyp.id)?.status, 'INCONCLUSIVE')
    assert.equal(reloaded.get(hyp.id)?.version, 2)
    assert.equal(reloaded.get(hyp.id)?.snapshot_id, 'snapshot-3')
    assert.deepEqual(reloaded.get(hyp.id)?.evidence_ids, ['new-positive', 'new-negative'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
