import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { autoModeFile, readAutoMode, writeAutoMode } from '../../dist/session/auto-mode.js'

test('auto mode file round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-auto-mode-'))
  const previousAuto = process.env.DSH_AUTORESEARCH_AUTO
  try {
    delete process.env.DSH_AUTORESEARCH_AUTO
    assert.equal(await readAutoMode(dir), false)
    await writeAutoMode(true, dir)
    assert.equal(await readAutoMode(dir), true)
    await writeAutoMode(false, dir)
    assert.equal(await readAutoMode(dir), false)
  } finally {
    if (previousAuto === undefined) delete process.env.DSH_AUTORESEARCH_AUTO
    else process.env.DSH_AUTORESEARCH_AUTO = previousAuto
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto mode uses DSH_HOME, with explicit profile directory taking priority', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-auto-mode-env-'))
  const previousDshHome = process.env.DSH_HOME
  const previousAuto = process.env.DSH_AUTORESEARCH_AUTO
  try {
    delete process.env.DSH_AUTORESEARCH_AUTO
    process.env.DSH_HOME = dir
    await writeAutoMode(true)
    assert.equal(autoModeFile(), join(dir, 'autoresearch-auto-mode.json'))
    assert.equal(await readAutoMode(), true)

    const explicitDir = join(dir, 'explicit')
    await writeAutoMode(false, explicitDir)
    assert.equal(autoModeFile(explicitDir), join(explicitDir, 'autoresearch-auto-mode.json'))
    assert.equal(await readAutoMode(explicitDir), false)
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    if (previousAuto === undefined) delete process.env.DSH_AUTORESEARCH_AUTO
    else process.env.DSH_AUTORESEARCH_AUTO = previousAuto
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto mode defaults to ~/.dsh when DSH_HOME is blank or unset', () => {
  const previousDshHome = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.equal(autoModeFile(), join(homedir(), '.dsh', 'autoresearch-auto-mode.json'))
    process.env.DSH_HOME = '  '
    assert.equal(autoModeFile(), join(homedir(), '.dsh', 'autoresearch-auto-mode.json'))
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
})
