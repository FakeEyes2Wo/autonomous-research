import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastRunPath, readLastRun, writeLastRun } from '../../dist/session/last-run.js'

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

test('last run uses DSH_HOME when no profile directory is supplied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-last-run-env-'))
  const previousDshHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = dir
    await writeLastRun('C:/runs/from-env')
    assert.equal(lastRunPath(), join(dir, 'autoresearch-last-run.json'))
    assert.equal((await readLastRun())?.lastRunDir, 'C:/runs/from-env')

    const explicitDir = join(dir, 'explicit')
    await writeLastRun('C:/runs/explicit', explicitDir)
    assert.equal(lastRunPath(explicitDir), join(explicitDir, 'autoresearch-last-run.json'))
    assert.equal((await readLastRun(explicitDir))?.lastRunDir, 'C:/runs/explicit')
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    await rm(dir, { recursive: true, force: true })
  }
})

test('last run defaults to ~/.dsh when DSH_HOME is blank or unset', () => {
  const previousDshHome = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.equal(lastRunPath(), join(homedir(), '.dsh', 'autoresearch-last-run.json'))
    process.env.DSH_HOME = '  '
    assert.equal(lastRunPath(), join(homedir(), '.dsh', 'autoresearch-last-run.json'))
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
})
