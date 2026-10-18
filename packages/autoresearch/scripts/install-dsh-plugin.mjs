import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDshRuntime } from './check-dsh-runtime.mjs'
import { parseDocument, isSeq, isMap } from 'yaml'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] }

async function installPresetDeclaration(patch, install = true) {
  const document = parseDocument(patch, yamlOptions)
  const metadata = parseDocument(await readFile(join(pkgRoot, 'presets/auto_research/preset.yml'), 'utf8'), yamlOptions)
  const plugins = parseDocument(await readFile(join(pkgRoot, 'presets/auto_research/agent.cordis.yml'), 'utf8'), yamlOptions)
  for (const source of [document, metadata, plugins]) {
    if (source.errors.length) throw new Error(source.errors[0].message)
  }
  if (!isSeq(document.contents) || !isSeq(plugins.contents) || !isMap(metadata.contents)) {
    throw new Error('Profile patch and preset plugins must be YAML lists; preset metadata must be a map')
  }
  const declarations = []
  for (const patchRow of document.contents.items) {
    const insert = isMap(patchRow) ? patchRow.get('insert') : undefined
    if (!isSeq(insert)) continue
    for (const row of insert.items) {
      if (!isMap(row)) continue
      const ownedId = ['autoresearch-preset', 'preset-autoresearch'].includes(row.get('id'))
      const config = row.get('config')
      const isPreset = row.get('name') === '@deepseek-ai/dsh-agent-preset'
      if (ownedId && (!isPreset || !isMap(config) || config.get('id') !== 'auto-research')) {
        throw new Error(`${row.get('id')} id is already owned by another plugin or preset`)
      }
      if (ownedId || (isPreset && isMap(config) && config.get('id') === 'auto-research')) declarations.push(row)
    }
  }
  if (declarations.length > 1) throw new Error('Duplicate autoresearch-preset declarations')
  const declaration = declarations[0]
  if (declaration && declaration.get('name') !== '@deepseek-ai/dsh-agent-preset') {
    throw new Error('autoresearch-preset id is already owned by another plugin')
  }
  if (!declaration && install) {
    const insertion = document.createNode({ insert: [{ id: 'autoresearch-preset', name: '@deepseek-ai/dsh-agent-preset' }] })
    const newDeclaration = insertion.get('insert').items[0]
    const config = metadata.contents.clone()
    config.set('id', 'auto-research')
    // Preserve !!js nodes without evaluating them or converting them to strings.
    config.set('plugins', plugins.contents)
    newDeclaration.set('config', config)
    document.contents.add(insertion)
  } else {
    // An existing owned declaration is user-managed. Return the source verbatim so
    // both its formatting and any tagged YAML values survive repeat installs.
    return patch
  }
  return document.toString({ lineWidth: 0 })
}

function normalizePatch(patch) {
  if (/^\s*name:\s*(['"]?)@athena\/autoresearch\1\s*(?:#.*)?$/m.test(patch)
      && /- id:\s*(?:autoresearch-preset|preset-autoresearch)\s*\n\s+name:\s*['"]?@deepseek-ai\/dsh-agent-preset['"]?/m.test(patch)) {
    return patch
  }
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
 * Locate the DSH installation that owns this profile, so preset support can be
 * detected from what the host actually ships. Returns undefined when nothing
 * conclusive is found; offline installs then require an explicit host check.
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

if (printPreset) {
  process.stdout.write(await installPresetDeclaration('[]\n'))
  process.exit(0)
}

if (!existsSync(packageJsonPath) || !existsSync(patchPath)) {
  console.error(`DSH profile not found: ${profileDir}`)
  process.exit(1)
}

if (dshPackagePath && !await checkDshRuntime({ dshPackagePath })) process.exit(1)

// Parse all source documents before making any profile changes.
const patch = await readFile(patchPath, 'utf8')
const dshDir = findDshDir({ dshPackagePath, profileDir })
const pluginPresets = Boolean(dshDir && supportsPluginPresets(dshDir))
if (dshDir && !pluginPresets) {
  throw new Error('This release requires a DSH 0.2 host with dsh-agent-preset and dsh-agent-preset-registry; upgrade the host before installing.')
}
const normalized = await installPresetDeclaration(normalizePatch(patch), pluginPresets)

const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'))
pkg.dependencies ??= {}
if (!pkg.dependencies['@athena/autoresearch']) {
  pkg.dependencies['@athena/autoresearch'] = `link:${pkgRoot.replaceAll('\\', '/')}`
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`Added @athena/autoresearch to ${packageJsonPath}`)
}

if (normalized !== patch) {
  const backup = `${patchPath}.before-autoresearch-preset`
  if (!existsSync(backup)) await copyFile(patchPath, backup)
  await writeFile(patchPath, normalized, 'utf8')
  console.log(`Added/normalized autoresearch plugin row in ${patchPath}`)
}

// DSH 0.2 registers presets through plugins. Leave legacy directory presets
// untouched: this release does not support the older directory-only host.
if (dshDir === undefined) {
  console.log('Could not locate the DSH installation, so the plugin-form preset was not injected.')
  console.log('Re-run with --dsh-package <absolute path to host dsh/package.json> on DSH 0.2.x.')
} else {
  console.log(`Registered AutoResearch agent preset in ${patchPath}; existing customizations are preserved.`)
}

if (!dshPackagePath) {
  console.log('\nOffline configuration copying does not validate runtime readiness.')
  console.log('Validate the selected host before starting DSH:')
  console.log('  npm run check:dsh -- --dsh-package <absolute path to host dsh/package.json>')
}
console.log(`\nNext step: restart DSH completely, then start a NEW session.`)
console.log(`Run in ${profileDir}:\n  pnpm install\n  dsh --profile ${profileName}`)
