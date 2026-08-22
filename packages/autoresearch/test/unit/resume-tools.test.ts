import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveCheckpoint } from '../../dist/paper/checkpoint.js'
import { paperPipelineStatus } from '../../dist/tools/index.js'

test('paper_pipeline_status returns no_checkpoint when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-status-missing-'))
  try {
    const result = await paperPipelineStatus.execute({ runDir: dir }, { signal: new AbortController().signal })
    assert.deepEqual(result, { status: 'no_checkpoint' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('paper_pipeline_status returns checkpoint phases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-status-'))
  try {
    await saveCheckpoint(join(dir, 'paper'), {
      schema: 'autoresearch/paper-pipeline-checkpoint/v1',
      updated_at: new Date().toISOString(),
      assurance: 'draft',
      phases: { writing: 'done' },
      data: {},
    })
    const result = await paperPipelineStatus.execute({ runDir: dir }, { signal: new AbortController().signal }) as { phases?: Record<string, string> }
    assert.equal(result.phases?.writing, 'done')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
