import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PROJECT_SETTINGS,
  loadProjectSecrets,
  loadProjectSettings,
  maskProjectSettings,
  saveProjectSecrets,
  saveProjectSettings,
} from '../../dist/settings/project-settings.js'

test('project settings default and round-trip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-settings-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  assert.deepEqual(await loadProjectSettings(dir), DEFAULT_PROJECT_SETTINGS)

  const saved = await saveProjectSettings(dir, {
    ...DEFAULT_PROJECT_SETTINGS,
    paperExploration: {
      ...DEFAULT_PROJECT_SETTINGS.paperExploration,
      maxPapers: 99,
      minSurveys: 4,
    },
    figureApi: {
      ...DEFAULT_PROJECT_SETTINGS.figureApi,
      enabled: true,
      apiUrl: 'https://example.com/api',
      model: 'image-model',
    },
  })
  const loaded = await loadProjectSettings(dir)
  assert.equal(saved.paperExploration.maxPapers, 99)
  assert.equal(loaded.paperExploration.maxPapers, 99)
  assert.equal(loaded.figureApi.enabled, true)
  assert.equal(loaded.figureApi.apiUrl, 'https://example.com/api')
  const text = await readFile(join(dir, '.autoresearch', 'project-settings.yaml'), 'utf8')
  assert.match(text, /maxPapers: 99/)
})

test('project secrets and masking', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-secrets-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  await saveProjectSecrets(dir, { figureApiKey: 'sk-abcdef123456' })
  const secrets = await loadProjectSecrets(dir)
  assert.equal(secrets.figureApiKey, 'sk-abcdef123456')

  const settings = await loadProjectSettings(dir)
  const masked = maskProjectSettings(settings, secrets)
  assert.equal(masked.figureApiKeyMasked, 'sk-a****')
  assert.equal('figureApiKey' in masked.figureApi, false)
})
