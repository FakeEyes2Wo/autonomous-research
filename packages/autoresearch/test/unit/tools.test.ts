import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { researchHypothesisAdd, researchActionStart, researchActionFinish, researchEvidenceAdd, researchTreeQuery } from '../../dist/tools/index.js'

const exec = { signal: new AbortController().signal }

test('research tools maintain parent/artifact rules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-tools-'))
  try {
    const hyp = await researchHypothesisAdd.execute({ runDir: dir, content: 'hyp' }, exec) as { id: string }
    const action = await researchActionStart.execute({ runDir: dir, hypothesisId: hyp.id, content: 'act' }, exec) as { id: string }
    await researchActionFinish.execute({ runDir: dir, actionId: action.id, status: 'completed', summary: 'done', artifacts: ['out.txt'] }, exec)
    await researchEvidenceAdd.execute({ runDir: dir, actionId: action.id, content: 'evidence', verdict: 'supports' }, exec)

    const nodes = await researchTreeQuery.execute({ runDir: dir }, exec) as Array<{ kind: string; status: string }>
    assert.equal(nodes.filter((n) => n.kind === 'hypothesis').length, 1)
    assert.equal(nodes.filter((n) => n.kind === 'action').length, 1)
    assert.equal(nodes.filter((n) => n.kind === 'evidence').length, 1)
    const actionNode = nodes.find((n) => n.kind === 'action')
    assert.equal(actionNode?.status, 'completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
