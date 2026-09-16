import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { checkDshRuntime } from '../../scripts/check-dsh-runtime.mjs'

const checker = fileURLToPath(new URL('../../scripts/check-dsh-runtime.mjs', import.meta.url))
const preset = fileURLToPath(new URL('../../presets/auto_research/agent.cordis.yml', import.meta.url))

type PresetRow = { name?: string; config?: unknown; disabled?: unknown }
const yamlJsTag = { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }

function packageName(specifier: string) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
}

function collectPluginSpecifiers(value: unknown, result = new Set<string>()) {
  if (Array.isArray(value)) for (const item of value) collectPluginSpecifiers(item, result)
  else if (value && typeof value === 'object') {
    const row = value as PresetRow
    if (typeof row.name === 'string' && !row.name.startsWith('cordis:') && row.disabled !== true) result.add(row.name)
    if (Array.isArray(row.config)) collectPluginSpecifiers(row.config, result)
  }
  return result
}

async function writePackage(nodeModules: string, name: string, source = 'export default {}\n', subpaths: string[] = []) {
  const dir = join(nodeModules, ...name.split('/'))
  await mkdir(dir, { recursive: true })
  const exports: Record<string, { import: string }> = { '.': { import: './index.js' } }
  await writeFile(join(dir, 'index.js'), source)
  for (const subpath of subpaths) {
    const filename = `${subpath.replaceAll('/', '-')}.js`
    exports[`./${subpath}`] = { import: `./${filename}` }
    await writeFile(join(dir, filename), 'export default {}\n')
  }
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name, version: '9.8.7', type: 'module', exports }, null, 2)}\n`)
}

async function makeRuntime(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ar-dsh-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const nodeModules = join(root, 'node_modules')
  const dshPackage = join(nodeModules, '@deepseek-ai', 'dsh', 'package.json')
  await mkdir(dirname(dshPackage), { recursive: true })
  await writeFile(dshPackage, `${JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.1.5-fixture',
    dependencies: { '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/dsh-agent': '0.1.5-fixture' },
  }, null, 2)}\n`)

  const rows = parse(await readFile(preset, 'utf8'), { customTags: [yamlJsTag] })
  const specifiers = collectPluginSpecifiers(rows)
  const subpathsByPackage = new Map<string, string[]>()
  for (const specifier of specifiers) {
    const name = packageName(specifier)
    const subpath = specifier.slice(name.length + 1)
    if (subpath) subpathsByPackage.set(name, [...(subpathsByPackage.get(name) ?? []), subpath])
    else subpathsByPackage.set(name, subpathsByPackage.get(name) ?? [])
  }
  for (const [name, subpaths] of subpathsByPackage) await writePackage(nodeModules, name, undefined, subpaths)
  await writePackage(nodeModules, '@deepseek-ai/cordis')
  await writePackage(nodeModules, '@deepseek-ai/dsh-agent')
  return { root, dshPackage, nodeModules }
}

function runChecker(dshPackage: string) {
  return spawnSync(process.execPath, [checker, '--dsh-package', dshPackage], { encoding: 'utf8' })
}

test('reports the consuming plugin and its missing transitive ESM dependency', async (t) => {
  const runtime = await makeRuntime(t)
  await writePackage(runtime.nodeModules, '@deepseek-ai/dsh-tool-workflow', "import 'missing-workflow-peer'\nexport default {}\n")
  await writePackage(runtime.nodeModules, '@deepseek-ai/dsh-tool-ralph', "import 'missing-ralph-peer'\nexport default {}\n")

  const result = runChecker(runtime.dshPackage)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /@deepseek-ai\/dsh-tool-workflow/)
  assert.match(result.stderr, /missing-workflow-peer/)
  assert.match(result.stderr, /@deepseek-ai\/dsh-tool-ralph/)
  assert.match(result.stderr, /missing-ralph-peer/)
})

test('uses import conditions for package subpaths and reports selected runtime versions', async (t) => {
  const runtime = await makeRuntime(t)
  await writePackage(runtime.nodeModules, '@deepseek-ai/dsh-tool-workflow', "import 'missing-workflow-peer'\nexport default {}\n")
  await writePackage(runtime.nodeModules, 'missing-workflow-peer')

  const result = runChecker(runtime.dshPackage)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /@deepseek-ai\/dsh 0\.1\.5-fixture/)
  assert.match(result.stdout, /@deepseek-ai\/cordis 9\.8\.7/)
  assert.match(result.stdout, /@deepseek-ai\/dsh-agent 9\.8\.7/)
  assert.match(result.stdout, /@deepseek-ai\/dsh-tool-subagent-control\/list-agents/)
  assert.match(result.stdout, /runtime imports passed/i)
})

test('rejects an unavailable selected DSH runtime', () => {
  const missing = join(tmpdir(), `missing-dsh-${process.pid}`, 'package.json')

  const result = runChecker(missing)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /selected DSH package is unavailable/i)
  assert.match(result.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('does not evaluate tagged disabled expressions and skips statically disabled rows', async (t) => {
  const runtime = await makeRuntime(t)
  const marker = join(runtime.root, 'expression-ran')
  const customPreset = join(runtime.root, 'preset.yml')
  await writePackage(runtime.nodeModules, '@fixture/conditional-tool')
  await writeFile(customPreset, [
    '- id: disabled',
    "  name: '@fixture/not-installed'",
    '  disabled: true',
    '- id: disabled-group',
    '  name: cordis:group',
    '  group: true',
    '  disabled: true',
    '  config:',
    '    - id: nested-disabled',
    "      name: '@fixture/nested-not-installed'",
    '- id: expression',
    "  name: '@fixture/conditional-tool'",
    `  disabled: !!js (() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'))()`,
    '',
  ].join('\n'))
  let stdout = ''
  let stderr = ''

  const ok = await checkDshRuntime({
    dshPackagePath: runtime.dshPackage,
    presetPath: customPreset,
    stdout: { write: (value: string) => { stdout += value } },
    stderr: { write: (value: string) => { stderr += value } },
  })

  assert.equal(ok, true, stderr)
  assert.match(stdout, /CHECK @fixture\/conditional-tool/)
  assert.doesNotMatch(stdout, /@fixture\/not-installed/)
  assert.doesNotMatch(stdout, /@fixture\/nested-not-installed/)
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' })
})
