import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDshRuntime } from './check-dsh-runtime.mjs'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// Agent preset identity. The source directory keeps its underscore name for the
// package layout; the host ids accept only lowercase letters, digits and hyphens.
const PRESET_SOURCE_DIR = 'auto_research'
const PRESET_ID = 'auto-research'
const PRESET_ENTRY_ID = 'preset-autoresearch'

function normalizePatch(patch) {
  const lines = patch.split(/\r?\n/)
  const withoutEmptyFlow = lines.filter((line) => line.trim() !== '[]')
  let normalized = withoutEmptyFlow.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!/^\s*name:\s*(['"]?)@athena\/autoresearch\1\s*(?:#.*)?$/m.test(normalized)) {
    const insert = `- insert:\n    - id: autoresearch\n      name: '@athena/autoresearch'`
    normalized = normalized.length === 0 ? insert : `${normalized}\n${insert}`
  }
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`
}

/**
 * Read the preset's published metadata (`name`, `description`, `order`) from the
 * directory-form `preset.yml`. Only these three plain keys are recognised; the
 * file is never rewritten.
 */
function readPresetMeta(text) {
  const meta = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^(name|description|order):\s*(.+?)\s*$/.exec(line)
    if (match) meta[match[1]] = match[2]
  }
  return meta
}

/**
 * Take the top-level entry list out of the agent-plane composition, dropping the
 * file's leading documentation comment. Lines are copied verbatim so `!!js`
 * expressions and block scalars survive the move.
 */
function presetEntryLines(text) {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex((line) => line.startsWith('- '))
  if (first < 0) throw new Error(`${PRESET_SOURCE_DIR}/agent.cordis.yml has no top-level entry list`)
  return lines.slice(first)
}

/**
 * Build the profile patch entry for hosts that take agent presets as plugins
 * (`@deepseek-ai/dsh-agent-preset`, 0.2.x). The body is re-indented by a constant
 * amount, which preserves every relative indentation inside it.
 */
function buildPluginPresetPatch({ meta, entryLines, indent = ' '.repeat(10) }) {
  if (!meta.name || meta.order === undefined) {
    throw new Error('preset.yml is missing `name` or `order`')
  }
  const body = entryLines
    .map((line) => (line.trim() === '' ? '' : indent + line))
    .join('\n')
    .replace(/\n+$/, '')
  return [
    '- insert:',
    `    - id: ${PRESET_ENTRY_ID}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${PRESET_ID}`,
    `        name: ${meta.name}`,
    `        description: "${meta.description ?? ''}"`,
    `        order: ${meta.order}`,
    '        plugins:',
    body,
    '',
  ].join('\n')
}

/**
 * Locate the DSH installation that owns this profile, so preset support can be
 * detected from what the host actually ships. Returns undefined when nothing
 * conclusive is found; callers then fall back to the directory-form preset only.
 */
function findDshDir({ dshPackagePath, profileDir }) {
  const candidates = []
  if (dshPackagePath) candidates.push(dirname(resolve(dshPackagePath)))
  candidates.push(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh'))
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  candidates.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** True when the host registers agent presets as plugins instead of reading `~/.dsh/.agent-presets`. */
function supportsPluginPresets(dshDir) {
  return (
    existsSync(join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-agent-preset', 'package.json')) &&
    existsSync(join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry', 'package.json'))
  )
}

/**
 * Append the plugin-form preset to the profile patch layer. Idempotent: a second
 * run reports `already` and writes nothing. The original file is backed up first.
 */
async function injectPluginPreset(patchPath, block) {
  const current = await readFile(patchPath, 'utf8')
  if (current.includes(PRESET_ENTRY_ID)) return 'already'
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
  await copyFile(patchPath, `${patchPath}.before-autoresearch-preset`)
  await copyFile(patchPath, `${patchPath}.bak-${stamp}`)
  await writeFile(patchPath, `${current.replace(/\s*$/, '')}\n\n${block}`, 'utf8')
  return 'injected'
}

const configuredDshHome = process.env.DSH_HOME?.trim()
const dshHomeValue = configuredDshHome || join(homedir(), '.dsh')
const dshHome = resolve(
  dshHomeValue === '~'
    ? homedir()
    : dshHomeValue.startsWith('~/') || dshHomeValue.startsWith('~\\')
      ? join(homedir(), dshHomeValue.slice(2))
      : dshHomeValue,
)
function parseArgs(argv) {
  let profileName = 'web'
  let dshPackagePath
  let printPreset = false
  let profileSeen = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dsh-package') {
      dshPackagePath = argv[index + 1]
      if (!dshPackagePath) throw new Error('--dsh-package requires an absolute path to dsh/package.json')
      index += 1
    } else if (argument === '--print-preset') {
      printPreset = true
    } else if (!argument.startsWith('-') && !profileSeen) {
      profileName = argument
      profileSeen = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return { profileName, dshPackagePath, printPreset }
}

const { profileName, dshPackagePath, printPreset } = parseArgs(process.argv.slice(2))
const profileDir = join(dshHome, 'profiles', profileName)
const packageJsonPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const presetSrc = join(pkgRoot, 'presets', PRESET_SOURCE_DIR)

const presetMeta = readPresetMeta(await readFile(join(presetSrc, 'preset.yml'), 'utf8'))
const pluginPresetBlock = buildPluginPresetPatch({
  meta: presetMeta,
  entryLines: presetEntryLines(await readFile(join(presetSrc, 'agent.cordis.yml'), 'utf8')),
})

if (printPreset) {
  process.stdout.write(`${pluginPresetBlock}\n`)
  process.exit(0)
}

if (!existsSync(packageJsonPath) || !existsSync(patchPath)) {
  console.error(`DSH profile not found: ${profileDir}`)
  process.exit(1)
}

if (dshPackagePath && !await checkDshRuntime({ dshPackagePath })) process.exit(1)

const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'))
pkg.dependencies ??= {}
if (!pkg.dependencies['@athena/autoresearch']) {
  pkg.dependencies['@athena/autoresearch'] = `link:${pkgRoot.replaceAll('\\', '/')}`
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`Added @athena/autoresearch to ${packageJsonPath}`)
}

let patch = await readFile(patchPath, 'utf8')
const normalized = normalizePatch(patch)
if (normalized !== patch) {
  await writeFile(patchPath, normalized, 'utf8')
  console.log(`Added/normalized autoresearch plugin row in ${patchPath}`)
}

// Directory-form preset: hosts up to 0.1.x discover `$DSH_HOME/.agent-presets/<id>`
// by scanning that directory. Kept for backwards compatibility.
const presetDest = join(dshHome, '.agent-presets', PRESET_ID)
await mkdir(presetDest, { recursive: true })
for (const name of ['preset.yml', 'agent.cordis.yml']) {
  await copyFile(join(presetSrc, name), join(presetDest, name))
}
console.log(`Installed directory-form agent preset in ${presetDest}`)

// Plugin-form preset: DSH 0.2.x registers presets through `@deepseek-ai/dsh-agent-preset`
// rows and no longer reads the directory above. Detect what the host ships and inject
// the same composition into the profile's patch layer.
const dshDir = findDshDir({ dshPackagePath, profileDir })
if (dshDir === undefined) {
  console.log('Could not locate the DSH installation, so the plugin-form preset was not injected.')
  console.log('Re-run with --dsh-package <absolute path to host dsh/package.json> on DSH 0.2.x.')
} else if (!supportsPluginPresets(dshDir)) {
  console.log(`Host at ${dshDir} uses the directory-form preset only; no plugin-form row was added.`)
} else {
  const outcome = await injectPluginPreset(patchPath, pluginPresetBlock)
  console.log(
    outcome === 'already'
      ? `Plugin-form agent preset already present in ${patchPath}`
      : `Injected plugin-form agent preset into ${patchPath} (backup: cordis.patch.yml.before-autoresearch-preset)`,
  )
}

if (!dshPackagePath) {
  console.log('\nOffline configuration copying does not validate runtime readiness.')
  console.log('Validate the selected host before starting DSH:')
  console.log('  npm run check:dsh -- --dsh-package <absolute path to host dsh/package.json>')
}
console.log(`\nNext step: restart DSH completely, then start a NEW session.`)
console.log(`Run in ${profileDir}:\n  pnpm install\n  dsh --profile ${profileName}`)
