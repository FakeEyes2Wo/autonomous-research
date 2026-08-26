import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function normalizePatch(patch) {
  const lines = patch.split(/\r?\n/)
  const withoutEmptyFlow = lines.filter((line) => line.trim() !== '[]')
  let normalized = withoutEmptyFlow.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!normalized.includes('@athena/autoresearch')) {
    const insert = `- insert:\n    - id: autoresearch\n      name: '@athena/autoresearch'`
    normalized = normalized.length === 0 ? insert : `${normalized}\n${insert}`
  }
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`
}
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileName = process.argv[2] ?? 'web'
const profileDir = join(dshHome, 'profiles', profileName)
const packageJsonPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')

if (!existsSync(packageJsonPath) || !existsSync(patchPath)) {
  console.error(`DSH profile not found: ${profileDir}`)
  process.exit(1)
}

const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'))
pkg.dependencies ??= {}
if (!pkg.dependencies['@athena/autoresearch']) {
  pkg.dependencies['@athena/autoresearch'] = `link:${pkgRoot.replaceAll('\\', '/')}`
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`Added @athena/autoresearch to ${packageJsonPath}`)
}

let patch = await readFile(patchPath, 'utf8')
const normalized = normalizePatch(patch)
if (normalized !== patch || !normalized.includes('@athena/autoresearch')) {
  await writeFile(patchPath, normalized, 'utf8')
  console.log(`Added/normalized autoresearch plugin row in ${patchPath}`)
}

const presetSrc = join(pkgRoot, 'presets', 'auto_research')
const presetDest = join(dshHome, '.agent-presets', 'auto_research')
await mkdir(presetDest, { recursive: true })
for (const name of ['preset.yml', 'agent.cordis.yml']) {
  await copyFile(join(presetSrc, name), join(presetDest, name))
}
console.log(`Installed AutoResearch agent preset in ${presetDest}`)
console.log(`\nNext step (optional): run in ${profileDir}:\n  pnpm install\n  dsh --profile ${profileName}`)
