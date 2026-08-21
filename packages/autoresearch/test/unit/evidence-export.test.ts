import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { exportEvidenceChain } from '../../dist/export/evidence-chain.js'

test('exportEvidenceChain writes all node kinds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-export-'))
  try {
    const tree = await ResearchTree.load(dir)
    const hyp = tree.add('hypothesis', 'h1')
    const action = tree.add('action', 'a1', { parent: hyp.id })
    tree.add('evidence', 'e1', { parent: action.id, status: 'supports' })
    await tree.save()

    const file = await exportEvidenceChain(dir, 'ar_run', tree)
    const chain = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(chain.schema, 'autoresearch/evidence-chain/v1')
    assert.equal(chain.run_id, 'ar_run')
    assert.equal(chain.hypotheses.length, 1)
    assert.equal(chain.actions.length, 1)
    assert.equal(chain.evidence.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
