import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { patchProjectSettingsDocument, readProjectSettingsDocument } from '../../dist/settings/service.js'

const emptyRevision = createHash('sha256').update('', 'utf8').digest('hex')

test('missing settings can be created by revision-checked patch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-settings-v2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const before = await readProjectSettingsDocument(dir)
  assert.equal(before.source, 'missing')
  const after = await patchProjectSettingsDocument(dir, { expectedRevision: emptyRevision, ops: [{ op: 'replace', path: '/budget/maxRunTokens', value: 999 }] })
  assert.equal(after.source, 'v2')
  assert.equal(after.settings.budget.maxRunTokens, 999)
})

test('two first writers cannot both commit against the missing revision', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-settings-race-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const results = await Promise.allSettled([
    patchProjectSettingsDocument(dir, { expectedRevision: emptyRevision, ops: [{ op: 'replace', path: '/budget/maxRunTokens', value: 101 }] }),
    patchProjectSettingsDocument(dir, { expectedRevision: emptyRevision, ops: [{ op: 'replace', path: '/budget/maxRunTokens', value: 202 }] }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected' && (result.reason as { code?: string }).code === 'REVISION_CONFLICT').length, 1)
})

test('revision conflict, malformed YAML, and prototype paths are visible errors', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-settings-errors-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(() => patchProjectSettingsDocument(dir, { expectedRevision: 'wrong', ops: [] }), (error: { code?: string }) => error.code === 'REVISION_CONFLICT')
  const path = join(dir, '.autoresearch', 'project-settings.yaml')
  await (await import('node:fs/promises')).mkdir(join(dir, '.autoresearch'), { recursive: true })
  await writeFile(path, 'version: [', 'utf8')
  await assert.rejects(() => readProjectSettingsDocument(dir), (error: { code?: string }) => error.code === 'SETTINGS_CORRUPT')
  await writeFile(path, 'version: 2\n', 'utf8')
  const valid = await readProjectSettingsDocument(dir)
  await unlink(path)
  await assert.rejects(() => patchProjectSettingsDocument(dir, { expectedRevision: valid.revision, ops: [{ op: 'replace', path: '/budget/maxRunTokens', value: 10 }] }), (error: { code?: string }) => error.code === 'REVISION_CONFLICT')
  await writeFile(path, 'version: 2\n', 'utf8')
  const restored = await readProjectSettingsDocument(dir)
  await assert.rejects(() => patchProjectSettingsDocument(dir, { expectedRevision: restored.revision, ops: [{ op: 'replace', path: '/__proto__/polluted', value: true }] }), (error: { code?: string }) => error.code === 'SETTINGS_CORRUPT')
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.ok((await readFile(path, 'utf8')).includes('version'))
})
