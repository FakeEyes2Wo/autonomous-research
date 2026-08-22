import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sessionPromptPath = join(pkgRoot, 'prompts', 'session', 'autoresearch.md')

function parseArgs(argv) {
  const args = { profile: 'autoresearch', prompt: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--profile': args.profile = argv[++i]; break
      case '--prompt': args.prompt = argv[++i]; break
      default:
        console.error(`Unknown argument: ${arg}`)
        process.exit(2)
    }
  }
  return args
}

async function ensureProfile(profileName) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileDir = join(dshHome, 'profiles', profileName)
  const packageJsonPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  mkdirSync(profileDir, { recursive: true })

  if (!existsSync(packageJsonPath)) {
    await writeFile(packageJsonPath, `${JSON.stringify({
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2)}\n`, 'utf8')
  }
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  pkg.dependencies ??= {}
  if (!pkg.dependencies['@athena/autoresearch']) {
    pkg.dependencies['@athena/autoresearch'] = `link:${pkgRoot.replaceAll('\\', '/')}`
    await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  }
  if (!existsSync(patchPath)) await writeFile(patchPath, '# User patch layer\n[]\n', 'utf8')
  if (!existsSync(workspacePath)) await writeFile(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')

  const comSpec = process.env.ComSpec || 'cmd.exe'
  const install = spawnSync(comSpec, ['/d', '/s', '/c', 'pnpm install'], { cwd: profileDir, stdio: 'inherit' })
  if (install.status !== 0) {
    console.error(`pnpm install failed in ${profileDir}`)
    process.exit(install.status ?? 1)
  }
  return profileDir
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const profileDir = await ensureProfile(args.profile)
  const prompt = args.prompt ?? await readFile(sessionPromptPath, 'utf8')
  const nodeDir = dirname(process.execPath)
  const dshBin = join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  console.log(`[autoresearch] starting DSH session profile=${args.profile} dir=${profileDir}`)
  const result = existsSync(dshBin)
    ? spawnSync(process.execPath, [dshBin, '--profile', args.profile, prompt], { stdio: 'inherit' })
    : spawnSync('dsh', ['--profile', args.profile, prompt], { stdio: 'inherit', shell: true })
  process.exit(result.status ?? 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
