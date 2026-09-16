import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'

export function parseArgs(argv) {
  const args = { profile: 'autoresearch', prompt: undefined, resume: false, projectDir: undefined, runDir: undefined }
  const valueFor = (argument, index) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--profile') args.profile = valueFor(argument, index++)
    else if (argument === '--prompt') args.prompt = valueFor(argument, index++)
    else if (argument === '--project-dir') args.projectDir = valueFor(argument, index++)
    else if (argument === '--run-dir') args.runDir = valueFor(argument, index++)
    else if (argument === '--resume') args.resume = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return args
}

export function resolveSessionPaths(args, cwd = process.cwd()) {
  const projectDir = resolve(cwd, args.projectDir || '.')
  return {
    projectDir,
    ...(args.runDir ? { runDir: resolve(projectDir, args.runDir) } : {}),
  }
}

export async function prepareSessionResume({ projectDir, runDir }, preparer) {
  const prepare = preparer || (await import('../dist/startup/prepare.js')).prepareStartup
  return prepare({ intent: 'resume', projectDir, ...(runDir ? { runDir } : {}) })
}

function actionText(action) {
  if (!action || typeof action.tool !== 'string') return ''
  return `Call \`${action.tool}\` with arguments ${JSON.stringify(action.args || {})}.`
}

export function buildSessionPrompt({ projectDir, runDir, intent = 'ambiguous', preparation }) {
  const lines = [
    'You are in an AutoResearch session.',
    `The selected project workspace is: ${projectDir}`,
    '',
  ]
  if (preparation) {
    lines.push(`Resume preparation status: ${preparation.status}.`, `Reason: ${preparation.reason}.`)
    if (preparation.runStatus) lines.push(`Run status: ${preparation.runStatus}.`)
    if (preparation.phase) lines.push(`Run phase: ${preparation.phase}.`)
    if (preparation.status === 'resumable') {
      lines.push('', 'Continue the same run. Do not create a new run or use the global last-run pointer.', actionText(preparation.nextAction))
      if (preparation.runStatus === 'WAITING') lines.push('The run is WAITING; monitor and resume this same run with bounded delays.')
    } else if (preparation.runStatus === 'PAUSED' || preparation.status === 'blocked') {
      lines.push('', 'Do not retry automatically. Explain the reported constraint and wait for it to be resolved.')
    } else if (preparation.status === 'terminal') {
      lines.push('', 'This run is terminal. Report its persisted result; do not launch another pipeline automatically.')
    } else {
      lines.push('', 'Ask the user for the missing recovery choice before launching any pipeline.')
    }
    return lines.join('\n')
  }

  lines.push(
    'On the first task turn, identify exactly one intent: `project-paper`, `research`, `experiment`, or `resume`; use `ambiguous` when the request is unclear.',
    'Call `research_prepare` first with only its supported routing fields: intent, selected project workspace, a distinct run directory for a new task, and task when required.',
    'Execute only the returned nextAction. Preserve the user brief and runner options such as candidatePath, profilePath, maxCycles, and paper when invoking a new-run action.',
    'For WAITING, continue the same run. For PAUSED, explain the constraint and do not retry. A terminal run is reported with its persisted terminal status and is not relaunched.',
    '',
    `Initial intent hint: ${intent}.`,
  )
  if (runDir) lines.push(`Selected run directory: ${runDir}`)
  lines.push('', 'Plugin registration and session startup do not themselves start research work. `research_prepare` does not accept paper or runner options; pass those to the returned execution tool.')
  return lines.join('\n')
}

export function shouldLaunchSession(preparation) {
  return preparation?.status === 'resumable'
}

export async function ensureProfile(profileName) {
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
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  if (!pkg.dependencies['@athena/autoresearch']) {
    pkg.dependencies['@athena/autoresearch'] = `link:${pkgRoot.replaceAll('\\', '/')}`
    await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  }
  if (!existsSync(patchPath)) await writeFile(patchPath, '# User patch layer\n[]\n', 'utf8')
  if (!existsSync(workspacePath)) await writeFile(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')

  const install = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm install'], { cwd: profileDir, stdio: 'inherit' })
  if (install.status !== 0) throw new Error(`pnpm install failed in ${profileDir}`)
  return profileDir
}
