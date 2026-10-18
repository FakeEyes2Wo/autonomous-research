import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

const yamlJsTag = { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }

async function createHost(profile: string, modern: boolean) {
  const host = join(profile, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(host, { recursive: true })
  await writeFile(join(host, 'package.json'), '{"name":"@deepseek-ai/dsh"}')
  if (modern) {
    for (const name of ['dsh-agent-preset', 'dsh-agent-preset-registry']) {
      const directory = join(host, 'node_modules', '@deepseek-ai', name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), '{}')
    }
  }
}

test('installer adds the core plugin beside autoresearch-web and stays idempotent', async (t) => {
  const dshTestHome = await mkdtemp(join(tmpdir(), 'ar-install-'))
  t.after(() => rm(dshTestHome, { recursive: true, force: true }))
  const profile = join(dshTestHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await createHost(profile, true)
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {} }))
  const patchPath = join(profile, 'cordis.patch.yml')
  await writeFile(patchPath, "- insert:\n    - id: autoresearch-web\n      name: '@athena/autoresearch-web'\n")
  const install = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/install-dsh-plugin.mjs', import.meta.url)), 'web'], {
      env: { ...process.env, DSH_HOME: dshTestHome }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  }
  install()
  const first = await readFile(patchPath, 'utf8')
  const rows = parse(first, { customTags: [yamlJsTag] }).flatMap((patch: { insert?: Array<{ name: string }> }) => patch.insert ?? [])
  assert.equal(rows.filter((row: { name: string }) => row.name === '@athena/autoresearch').length, 1)
  assert.equal(rows.filter((row: { name: string }) => row.name === '@athena/autoresearch-web').length, 1)
  const declaration = rows.find((row: { name: string }) => row.name === '@deepseek-ai/dsh-agent-preset')
  assert.equal(declaration.config.id, 'auto-research')
  const installedPreset = declaration.config.plugins as Array<{ id: string; config?: Record<string, unknown> }>
  assert.match(first, /!!js process.platform/)
  const persona = installedPreset.find((row) => row.id === 'persona')
  assert.equal(typeof persona?.config?.prefix, 'string')
  assert.match(persona?.config?.prefix as string, /research_run.*experiment_run.*paper_pipeline_/s)
  const delegation = installedPreset.find((row) => row.id === 'delegation')
  const subagents = (delegation?.config ?? []) as Array<{ id: string; config?: Record<string, unknown> }>
  const spawn = subagents.find((row) => row.id === 'tool-subagent')
  assert.deepEqual(spawn?.config, { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true, backgroundMode: 'continuable' })
  const fork = subagents.find((row) => row.id === 'tool-subagent-fork')
  assert.deepEqual(fork?.config, { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' })
  assert.equal(subagents.find((row) => row.id === 'workflow-ptc')?.config?.provider, 'spawn')
  assert.equal(subagents.some((row) => row.id === 'workflow-worker-thread'), false)
  await assert.rejects(stat(join(dshTestHome, '.agent-presets', 'auto_research')))
  await assert.rejects(stat(join(dshTestHome, '.agent-presets', 'auto-research')))
  const backup = await readFile(`${patchPath}.before-autoresearch-preset`, 'utf8')
  assert.equal(backup, "- insert:\n    - id: autoresearch-web\n      name: '@athena/autoresearch-web'\n")
  install()
  assert.equal(await readFile(patchPath, 'utf8'), first)
  assert.equal(await readFile(`${patchPath}.before-autoresearch-preset`, 'utf8'), backup)
})

test('reinstall preserves an existing preset declaration and its user customizations', async (t) => {
  const dshTestHome = await mkdtemp(join(tmpdir(), 'ar-install-custom-preset-'))
  t.after(() => rm(dshTestHome, { recursive: true, force: true }))
  const profile = join(dshTestHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), '{"private":true,"dependencies":{}}\n')
  const patchPath = join(profile, 'cordis.patch.yml')
  const patchBefore = `- insert:
    - id: autoresearch-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: auto-research
        description: My locally tuned research preset
        plugins:
          - id: persona
            config:
              prefix: !!js "process.platform === 'win32' ? 'Windows persona' : 'Other persona'"
          - id: user-plugin
            config:
              enabled: true
    - id: autoresearch-web
      name: '@athena/autoresearch-web'
`
  await writeFile(patchPath, patchBefore)
  const legacyDir = join(dshTestHome, '.agent-presets', 'auto-research')
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, 'preset.yml'), 'name: User preset\n')
  await writeFile(join(legacyDir, 'agent.cordis.yml'), '# custom legacy plugins\n')
  const install = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/install-dsh-plugin.mjs', import.meta.url)), 'web'], {
      env: { ...process.env, DSH_HOME: dshTestHome }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  }

  install()
  const first = await readFile(patchPath, 'utf8')
  const declaration = parse(first, { customTags: [yamlJsTag] })
    .flatMap((patch: { insert?: Array<Record<string, unknown>> }) => patch.insert ?? [])
    .find((row: Record<string, unknown>) => row.id === 'autoresearch-preset')
  assert.equal(declaration.config.description, 'My locally tuned research preset')
  assert.match(first, /!!js "process\.platform/)
  assert.match(first, /- id: user-plugin\n\s+config:\n\s+enabled: true/)
  assert.ok(first.indexOf('id: autoresearch-preset') < first.indexOf('id: autoresearch-web'))
  install()
  assert.equal(await readFile(patchPath, 'utf8'), first)
  assert.equal(await readFile(join(legacyDir, 'preset.yml'), 'utf8'), 'name: User preset\n')
  assert.equal(await readFile(join(legacyDir, 'agent.cordis.yml'), 'utf8'), '# custom legacy plugins\n')
})

test('explicit runtime preflight failure leaves profile and preset files untouched', async (t) => {
  const dshTestHome = await mkdtemp(join(tmpdir(), 'ar-install-preflight-'))
  t.after(() => rm(dshTestHome, { recursive: true, force: true }))
  const profile = join(dshTestHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  const packagePath = join(profile, 'package.json')
  const patchPath = join(profile, 'cordis.patch.yml')
  const packageBefore = '{"private":true,"dependencies":{}}\n'
  const patchBefore = "- insert:\n    - id: existing\n      name: '@example/existing'\n"
  await writeFile(packagePath, packageBefore)
  await writeFile(patchPath, patchBefore)
  const presetDir = join(dshTestHome, '.agent-presets', 'auto-research')
  await mkdir(presetDir, { recursive: true })
  const presetPath = join(presetDir, 'preset.yml')
  const presetBefore = 'name: keep-me\n'
  await writeFile(presetPath, presetBefore)

  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/install-dsh-plugin.mjs', import.meta.url)),
    'web',
    '--dsh-package',
    join(dshTestHome, 'missing-runtime', 'package.json'),
  ], { env: { ...process.env, DSH_HOME: dshTestHome }, encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /selected DSH package is unavailable/i)
  assert.equal(await readFile(packagePath, 'utf8'), packageBefore)
  assert.equal(await readFile(patchPath, 'utf8'), patchBefore)
  assert.equal(await readFile(presetPath, 'utf8'), presetBefore)
})

test('malformed YAML and preset id collisions fail before profile writes', async (t) => {
  const cases = [
    ['malformed', '- insert: [\n'],
    ['collision', "- insert:\n    - id: autoresearch-preset\n      name: '@example/other-plugin'\n"],
  ] as const
  for (const [label, patchBefore] of cases) {
    const dshTestHome = await mkdtemp(join(tmpdir(), `ar-install-${label}-`))
    t.after(() => rm(dshTestHome, { recursive: true, force: true }))
    const profile = join(dshTestHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    const packagePath = join(profile, 'package.json')
    const patchPath = join(profile, 'cordis.patch.yml')
    const packageBefore = '{"private":true,"dependencies":{}}\n'
    await writeFile(packagePath, packageBefore)
    await writeFile(patchPath, patchBefore)

    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../../scripts/install-dsh-plugin.mjs', import.meta.url)),
      'web',
    ], { env: { ...process.env, DSH_HOME: dshTestHome }, encoding: 'utf8' })

    assert.notEqual(result.status, 0, label)
    if (label === 'collision') assert.match(result.stderr, /already owned by another plugin/i)
    assert.equal(await readFile(packagePath, 'utf8'), packageBefore)
    assert.equal(await readFile(patchPath, 'utf8'), patchBefore)
  }
})

test('offline install says runtime validation is still required', async (t) => {
  const dshTestHome = await mkdtemp(join(tmpdir(), 'ar-install-offline-'))
  t.after(() => rm(dshTestHome, { recursive: true, force: true }))
  const profile = join(dshTestHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), '{"private":true,"dependencies":{}}\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')

  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/install-dsh-plugin.mjs', import.meta.url)),
    'web',
  ], { env: { ...process.env, DSH_HOME: dshTestHome }, encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /does not validate runtime readiness/i)
  assert.match(result.stdout, /npm run check:dsh -- --dsh-package <absolute path/i)
})

test('legacy preset entry ids and custom ids retain their declaration without duplicates', async (t) => {
  for (const id of ['preset-autoresearch', 'my-research-preset']) {
    const dshTestHome = await mkdtemp(join(tmpdir(), 'ar-install-alias-'))
    t.after(() => rm(dshTestHome, { recursive: true, force: true }))
    const profile = join(dshTestHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await createHost(profile, true)
    await writeFile(join(profile, 'package.json'), '{"private":true,"dependencies":{}}\n')
    const patchPath = join(profile, 'cordis.patch.yml')
    await writeFile(patchPath, `- insert:\n    - id: ${id}\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: auto-research\n        description: Custom research\n        plugins: []\n`)
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/install-dsh-plugin.mjs', import.meta.url)), 'web'], {
      env: { ...process.env, DSH_HOME: dshTestHome }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const rows = parse(await readFile(patchPath, 'utf8')).flatMap((row: { insert: Array<Record<string, any>> }) => row.insert)
    const presets = rows.filter((row: Record<string, any>) => row.name === '@deepseek-ai/dsh-agent-preset')
    assert.equal(presets.length, 1)
    assert.equal(presets[0].id, id)
    assert.equal(presets[0].config.description, 'Custom research')
  }
})

test('a directory-only host is rejected before any profile or preset writes', async (t) => {
  const dshTestHome = await mkdtemp(join(tmpdir(), 'ar-install-directory-'))
  t.after(() => rm(dshTestHome, { recursive: true, force: true }))
  const profile = join(dshTestHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await createHost(profile, false)
  await writeFile(join(profile, 'package.json'), '{"private":true,"dependencies":{}}\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/install-dsh-plugin.mjs', import.meta.url)), 'web'], {
    env: { ...process.env, DSH_HOME: dshTestHome }, encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /upgrade the host before installing/)
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), '{"private":true,"dependencies":{}}\n')
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n')
  await assert.rejects(stat(join(dshTestHome, '.agent-presets')))
})

test('print-preset emits tagged YAML without requiring or writing a profile', async (t) => {
  const dshTestHome = await mkdtemp(join(tmpdir(), 'ar-install-print-'))
  t.after(() => rm(dshTestHome, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/install-dsh-plugin.mjs', import.meta.url)), 'web', '--print-preset'], {
    env: { ...process.env, DSH_HOME: dshTestHome }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const rows = parse(result.stdout, { customTags: [yamlJsTag] })
  assert.equal(rows[0].insert[0].config.id, 'auto-research')
  assert.match(result.stdout, /!!js process.platform/)
  await assert.rejects(stat(join(dshTestHome, 'profiles')))
  await assert.rejects(stat(join(dshTestHome, '.agent-presets')))
})
