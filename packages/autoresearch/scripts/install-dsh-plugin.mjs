import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDshRuntime } from './check-dsh-runtime.mjs'
import { parseDocument, isSeq, isMap } from 'yaml'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] }

async function installPresetDeclaration(patch) {
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
      if (isMap(row) && row.get('id') === 'autoresearch-preset') declarations.push(row)
    }
  }
  if (declarations.length > 1) throw new Error('Duplicate autoresearch-preset declarations')
  const declaration = declarations[0]
  if (declaration && declaration.get('name') !== '@deepseek-ai/dsh-agent-preset') {
    throw new Error('autoresearch-preset id is already owned by another plugin')
  }
  if (!declaration) {
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
      && /- id:\s*autoresearch-preset\s*\n\s+name:\s*['"]?@deepseek-ai\/dsh-agent-preset['"]?/m.test(patch)) {
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
  let profileSeen = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dsh-package') {
      dshPackagePath = argv[index + 1]
      if (!dshPackagePath) throw new Error('--dsh-package requires an absolute path to dsh/package.json')
      index += 1
    } else if (!argument.startsWith('-') && !profileSeen) {
      profileName = argument
      profileSeen = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return { profileName, dshPackagePath }
}

const { profileName, dshPackagePath } = parseArgs(process.argv.slice(2))
const profileDir = join(dshHome, 'profiles', profileName)
const packageJsonPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')

if (!existsSync(packageJsonPath) || !existsSync(patchPath)) {
  console.error(`DSH profile not found: ${profileDir}`)
  process.exit(1)
}

if (dshPackagePath && !await checkDshRuntime({ dshPackagePath })) process.exit(1)

// Parse all source documents before making any profile changes.
const patch = await readFile(patchPath, 'utf8')
const normalized = await installPresetDeclaration(normalizePatch(patch))

const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'))
pkg.dependencies ??= {}
if (!pkg.dependencies['@athena/autoresearch']) {
  pkg.dependencies['@athena/autoresearch'] = `link:${pkgRoot.replaceAll('\\', '/')}`
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`Added @athena/autoresearch to ${packageJsonPath}`)
}

if (normalized !== patch) {
  await writeFile(patchPath, normalized, 'utf8')
  console.log(`Added/normalized autoresearch plugin row in ${patchPath}`)
}

console.log(`Registered AutoResearch agent preset in ${patchPath}`)
if (!dshPackagePath) {
  console.log('\nOffline configuration copying does not validate runtime readiness.')
  console.log('Validate the selected host before starting DSH:')
  console.log('  npm run check:dsh -- --dsh-package <absolute path to host dsh/package.json>')
}
console.log(`\nNext step (optional): run in ${profileDir}:\n  pnpm install\n  dsh --profile ${profileName}`)
