import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, parse as parsePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const defaultPresetPath = join(packageRoot, 'presets', 'auto_research', 'agent.cordis.yml')
const coreRuntimePackages = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tools',
]
const taggedExpression = Symbol('taggedExpression')
const yamlJsTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve(value) {
    return { [taggedExpression]: String(value) }
  },
}

function collectPluginRows(value, rows = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectPluginRows(item, rows)
    return rows
  }
  if (!value || typeof value !== 'object') return rows
  if (value.disabled === true) return rows

  if (typeof value.name === 'string') {
    if (!value.name.startsWith('cordis:')) {
      rows.push({
        id: typeof value.id === 'string' ? value.id : value.name,
        name: value.name,
        uncertainDisabled: value.disabled != null && value.disabled !== false,
      })
    }
  }
  if (Array.isArray(value.config)) collectPluginRows(value.config, rows)
  return rows
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function findInstalledPackageJson(dshPackagePath, name) {
  let current = dirname(dshPackagePath)
  const root = parsePath(current).root
  while (true) {
    const candidate = join(current, 'node_modules', ...name.split('/'), 'package.json')
    try {
      await readFile(candidate, 'utf8')
      return candidate
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (current === root) return undefined
    current = dirname(current)
  }
}

async function runtimeVersions(dshPackagePath, dshPackage) {
  const versions = [{ name: dshPackage.name ?? '@deepseek-ai/dsh', version: dshPackage.version ?? 'unknown' }]
  for (const name of coreRuntimePackages) {
    const packagePath = await findInstalledPackageJson(dshPackagePath, name)
    if (!packagePath) continue
    const pkg = await readJson(packagePath)
    versions.push({ name, version: pkg.version ?? 'unknown' })
  }
  return versions
}

function probeImport(specifier, cwd) {
  const source = `
    const name = process.argv[1]
    try {
      await import(name)
    } catch (error) {
      const message = error && typeof error === 'object' && 'stack' in error ? error.stack : String(error)
      process.stderr.write(message + '\\n')
      process.exitCode = 1
    }
  `
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source, specifier], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
  })
}

export async function checkDshRuntime({ dshPackagePath, presetPath = defaultPresetPath, stdout = process.stdout, stderr = process.stderr }) {
  if (!dshPackagePath || !isAbsolute(dshPackagePath)) {
    stderr.write('A selected DSH runtime is required: --dsh-package must be an absolute path to dsh/package.json.\n')
    return false
  }

  let dshPackage
  try {
    dshPackage = await readJson(dshPackagePath)
  } catch (error) {
    stderr.write(`Selected DSH package is unavailable or unreadable: ${dshPackagePath}\n${error.message}\n`)
    return false
  }

  let preset
  try {
    preset = parse(await readFile(presetPath, 'utf8'), { customTags: [yamlJsTag] })
  } catch (error) {
    stderr.write(`Preset is unavailable or unreadable: ${presetPath}\n${error.message}\n`)
    return false
  }

  const rows = collectPluginRows(preset)
  const plugins = [...new Map(rows.map((row) => [row.name, row])).values()]
  const versions = await runtimeVersions(dshPackagePath, dshPackage)
  stdout.write('Selected runtime versions:\n')
  stdout.write(`  node ${process.version}\n`)
  for (const item of versions) stdout.write(`  ${item.name} ${item.version}\n`)
  stdout.write(`Checking ${plugins.length} preset plugin imports from ${dirname(dshPackagePath)}\n`)

  const failures = []
  for (const plugin of plugins) {
    if (plugin.uncertainDisabled) {
      stdout.write(`CHECK ${plugin.name} (disabled expression was not evaluated)\n`)
    }
    const result = probeImport(plugin.name, dirname(dshPackagePath))
    if (result.status === 0) {
      stdout.write(`PASS ${plugin.name}\n`)
    } else {
      const detail = (result.stderr || result.error?.message || `import process exited ${result.status}`).trim()
      failures.push({ plugin: plugin.name, detail })
    }
  }

  if (failures.length > 0) {
    stderr.write(`Runtime import check failed for ${failures.length} plugin(s):\n`)
    for (const failure of failures) stderr.write(`\nFAIL ${failure.plugin}\n${failure.detail}\n`)
    return false
  }

  stdout.write(`Runtime imports passed for ${plugins.length} preset plugin specifier(s).\n`)
  stdout.write('Importability does not prove the preset mounts or that session creation succeeds; complete those acceptance checks separately.\n')
  return true
}

function parseCliArgs(argv) {
  let dshPackagePath
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dsh-package') {
      dshPackagePath = argv[index + 1]
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`)
    }
  }
  return { dshPackagePath }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const ok = await checkDshRuntime(parseCliArgs(process.argv.slice(2)))
    if (!ok) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
