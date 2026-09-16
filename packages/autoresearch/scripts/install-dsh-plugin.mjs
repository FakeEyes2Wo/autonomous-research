import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDshRuntime } from './check-dsh-runtime.mjs'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

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

// dsh-agent-presets uses the directory name as the id and accepts only
// lowercase letters, digits, and hyphens. Keep the source directory name for
// the package layout, but install it under the id the host can discover.
const presetSrc = join(pkgRoot, 'presets', 'auto_research')
const presetId = 'auto-research'
const presetDest = join(dshHome, '.agent-presets', presetId)
await mkdir(presetDest, { recursive: true })
for (const name of ['preset.yml', 'agent.cordis.yml']) {
  await copyFile(join(presetSrc, name), join(presetDest, name))
}
console.log(`Installed AutoResearch agent preset in ${presetDest}`)
if (!dshPackagePath) {
  console.log('\nOffline configuration copying does not validate runtime readiness.')
  console.log('Validate the selected host before starting DSH:')
  console.log('  npm run check:dsh -- --dsh-package <absolute path to host dsh/package.json>')
}
console.log(`\nNext step (optional): run in ${profileDir}:\n  pnpm install\n  dsh --profile ${profileName}`)
