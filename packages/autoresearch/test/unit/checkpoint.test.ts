import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCheckpoint, saveCheckpoint } from '../../dist/paper/checkpoint.js'

test('checkpoint saves and loads pipeline state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-cp-'))
  try {
    await saveCheckpoint(dir, {
      schema: 'autoresearch/paper-pipeline-checkpoint/v1',
      updated_at: new Date().toISOString(),
      assurance: 'draft',
      phases: { plan: 'done', writing: 'done' },
      data: { planFile: 'PAPER_PLAN.md', compileOk: true },
    })
    const cp = await loadCheckpoint(dir)
    assert.ok(cp)
    assert.equal(cp?.phases.plan, 'done')
    assert.equal(cp?.data.compileOk, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadCheckpoint returns undefined when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-cp-missing-'))
  try {
    assert.equal(await loadCheckpoint(dir), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
