import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG,
  compileSettings,
  validateConfig,
  networkDoctor,
  planInstall,
  applyPlan,
  planUninstall,
  runDoctor
} from '../src/index.mjs'

test('compiles both explicit CPA protocols without secrets', () => {
  const response = compileSettings(DEFAULT_CONFIG)
  assert.equal(response['llm-pi-ai'].providers['cpa-gpt'].api, 'openai-responses')
  const completion = compileSettings({ routes: [{ ...DEFAULT_CONFIG.routes[0], id: 'cpa-chat', api: 'openai-completions' }] })
  assert.equal(completion['llm-pi-ai'].providers['cpa-chat'].api, 'openai-completions')
  assert.equal(JSON.stringify(response).includes('sk-'), false)
})

test('maps a native DSH provider document into CPA routes', () => {
  const response = compileSettings({
    'llm-pi-ai': {
      providers: {
        'native-route': {
          displayName: 'Native Route',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:8317/v1',
          apiKeyEnv: 'CPA_API_KEY',
          models: [{ id: 'native-model', input: ['text'] }]
        }
      }
    }
  })
  const route = response['llm-pi-ai'].providers['native-route']
  assert.equal(route.api, 'openai-completions')
  assert.equal(route.apiKeyEnv, 'CPA_API_KEY')
  assert.equal(route.models[0].id, 'native-model')
})

test('reports malformed native provider entries as config errors', () => {
  assert.throws(
    () => compileSettings({ 'llm-pi-ai': { providers: { broken: null } } }),
    (error) => error.code === 'CPA_CONFIG_INVALID' && error.issues.some((issue) => issue.path === 'routes[0].api')
  )
})

test('rejects secret fields, unknown fields, unsafe URLs, and invalid retry values', () => {
  const result = validateConfig({ routes: [{ ...DEFAULT_CONFIG.routes[0], apiKey: 'secret', baseURL: 'https://x.test/v1?key=secret', retryPolicy: { mode: 'normal', maxRetries: 11 } }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === 'secret_field'))
  assert.ok(result.errors.some((error) => error.code === 'base_url'))
  assert.ok(result.errors.some((error) => error.code === 'retry_count'))
})

test('network doctor uses only /models and cancels body', async () => {
  let seen
  let cancelled = false
  const response = await networkDoctor(DEFAULT_CONFIG, {
    timeoutMs: 100,
    credentials: { CPA_API_KEY: 'test-only-secret' },
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, body: { cancel: async () => { cancelled = true } } }
    }
  })
  assert.equal(response.ok, true)
  assert.match(seen.url, /127\.0\.0\.1:8317\/v1\/models$/)
  assert.equal(seen.init.redirect, 'manual')
  assert.equal(cancelled, true)
})

test('doctor does not perform network checks unless explicitly enabled', async () => {
  let calls = 0
  const report = await runDoctor(DEFAULT_CONFIG, { fetchImpl: async () => { calls += 1; throw new Error('unexpected network') } })
  assert.equal(report.ok, true)
  assert.equal(report.network, false)
  assert.equal(calls, 0)
})

test('dry-run and apply are idempotent and uninstall preserves modified routes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cpa-'))
  const settingsPath = join(home, 'settings.yaml')
  const first = await planInstall({ config: DEFAULT_CONFIG, settingsPath, dshHome: home })
  assert.equal(first.ok, true)
  assert.equal(first.changes.length, 2)
  await applyPlan(first)
  const second = await planInstall({ config: DEFAULT_CONFIG, settingsPath, dshHome: home })
  assert.equal(second.ok, true)
  assert.equal(second.changes.length, 0)
  const text = await readFile(settingsPath, 'utf8')
  assert.match(text, /cpa-gpt-deep/)
  await writeFile(settingsPath, text.replace('displayName: CPA GPT', 'displayName: User Owned GPT'), 'utf8')
  const uninstall = await planUninstall({ settingsPath, statePath: join(home, '.athena-dsh-cpa.json') })
  assert.equal(uninstall.ok, false)
  assert.ok(uninstall.errors.some((error) => error.code === 'user_modified'))
})

test('stale plans are refused and unrelated YAML comments survive', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cpa-stale-'))
  const settingsPath = join(home, 'settings.yaml')
  await writeFile(settingsPath, '# keep this comment\nother: &anchor { value: 1 }\n', 'utf8')
  const plan = await planInstall({ config: DEFAULT_CONFIG, settingsPath, dshHome: home })
  await writeFile(settingsPath, '# changed outside the installer\nother: &anchor { value: 2 }\n', 'utf8')
  await assert.rejects(() => applyPlan(plan), (error) => error.code === 'CPA_INSTALL_STALE_PLAN')
  const fresh = await planInstall({ config: DEFAULT_CONFIG, settingsPath, dshHome: home })
  await applyPlan(fresh)
  const written = await readFile(settingsPath, 'utf8')
  assert.match(written, /changed outside the installer/)
  assert.match(written, /value: 2/)
})

test('corrupt YAML is rejected before a write and the settings lock is honored', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cpa-yaml-'))
  const settingsPath = join(home, 'settings.yaml')
  await writeFile(settingsPath, 'llm-pi-ai: [broken\n', 'utf8')
  await assert.rejects(() => planInstall({ config: DEFAULT_CONFIG, settingsPath, dshHome: home }), (error) => error.code === 'CPA_SETTINGS_YAML_INVALID')
  await writeFile(settingsPath, '{}\n', 'utf8')
  const plan = await planInstall({ config: DEFAULT_CONFIG, settingsPath, dshHome: home })
  await writeFile(settingsPath + '.lock', 'held', 'utf8')
  await assert.rejects(() => applyPlan(plan), (error) => error.code === 'CPA_INSTALL_LOCKED')
})

test('state write failure rolls back a newly created settings file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cpa-rollback-'))
  const settingsPath = join(home, 'settings.yaml')
  const plan = await planInstall({ config: DEFAULT_CONFIG, settingsPath, dshHome: home })
  await mkdir(plan.statePath)
  await assert.rejects(() => applyPlan(plan), /EISDIR|directory/i)
  await assert.rejects(() => access(settingsPath))
})

test('rejects install state bound to a different settings path', async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), 'dsh-cpa-state-source-'))
  const sourceSettings = join(sourceHome, 'settings.yaml')
  const sourcePlan = await planInstall({ config: DEFAULT_CONFIG, settingsPath: sourceSettings, dshHome: sourceHome })
  await applyPlan(sourcePlan)

  const targetHome = await mkdtemp(join(tmpdir(), 'dsh-cpa-state-target-'))
  const targetSettings = join(targetHome, 'settings.yaml')
  await writeFile(targetSettings, await readFile(sourceSettings, 'utf8'), 'utf8')
  await writeFile(join(targetHome, '.athena-dsh-cpa.json'), await readFile(join(sourceHome, '.athena-dsh-cpa.json'), 'utf8'), 'utf8')

  await assert.rejects(
    () => planUninstall({ settingsPath: targetSettings, dshHome: targetHome }),
    (error) => error.code === 'CPA_INSTALL_STATE_INVALID'
  )
})

test('rejects install state with a different owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cpa-state-owner-'))
  const settingsPath = join(home, 'settings.yaml')
  const plan = await planInstall({ config: DEFAULT_CONFIG, settingsPath, dshHome: home })
  await applyPlan(plan)
  const statePath = join(home, '.athena-dsh-cpa.json')
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  state.managedBy = '@other/installer'
  await writeFile(statePath, JSON.stringify(state), 'utf8')

  await assert.rejects(
    () => planUninstall({ settingsPath, dshHome: home }),
    (error) => error.code === 'CPA_INSTALL_STATE_INVALID'
  )
})

test('accepts equivalent Windows settings path casing in install state', async () => {
  if (process.platform !== 'win32') return
  const home = await mkdtemp(join(tmpdir(), 'dsh-cpa-state-case-'))
  const settingsPath = join(home, 'settings.yaml')
  const plan = await planInstall({ config: DEFAULT_CONFIG, settingsPath, dshHome: home })
  await applyPlan(plan)

  const equivalentPath = settingsPath.toUpperCase()
  const uninstall = await planUninstall({ settingsPath: equivalentPath, dshHome: home })
  assert.equal(uninstall.ok, true)
  assert.equal(uninstall.changes.length, 2)
})
