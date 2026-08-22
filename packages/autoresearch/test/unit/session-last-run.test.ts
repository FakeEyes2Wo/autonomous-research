import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLastRun, writeLastRun } from '../../dist/session/last-run.js'

test('writeLastRun and readLastRun round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-last-run-'))
  try {
    await writeLastRun('C:/runs/run-1', dir)
    const info = await readLastRun(dir)
    assert.equal(info?.lastRunDir, 'C:/runs/run-1')
    assert.ok(info?.updatedAt)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readLastRun returns undefined when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-last-run-missing-'))
  try {
    assert.equal(await readLastRun(dir), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
