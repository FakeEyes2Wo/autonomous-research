import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readAutoMode, writeAutoMode } from '../../dist/session/auto-mode.js'

test('auto mode file round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-auto-mode-'))
  assert.equal(await readAutoMode(dir), false)
  await writeAutoMode(true, dir)
  assert.equal(await readAutoMode(dir), true)
  await writeAutoMode(false, dir)
  assert.equal(await readAutoMode(dir), false)
})
