import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSessionPrompt,
  ensureProfile,
  parseArgs,
  prepareSessionResume,
  resolveSessionPaths,
  shouldLaunchSession,
} from './session-startup.mjs'

export async function startSession(argv = process.argv.slice(2), cwd = process.cwd(), deps = {}) {
  const args = parseArgs(argv)
  const paths = resolveSessionPaths(args, cwd)

  let preparation
  if (args.resume) {
    // Prepare before ensureProfile: a blocked or ambiguous resume must not alter
    // a DSH profile while deciding whether it is safe to launch.
    preparation = await prepareSessionResume(paths, deps.prepare)
    if (!shouldLaunchSession(preparation)) {
      const message = buildSessionPrompt({ ...paths, preparation })
      return { status: preparation.status === 'terminal' ? 'terminal' : 'blocked', message, exitCode: preparation.status === 'terminal' ? 0 : 2 }
    }
  }

  const profileDir = await (deps.ensureProfile ?? ensureProfile)(args.profile)
  const guidance = buildSessionPrompt({ ...paths, preparation })
  const prompt = args.prompt ? `${args.prompt}\n\n${guidance}` : guidance
  const nodeDir = dirname(process.execPath)
  const dshBin = join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const command = existsSync(dshBin) ? process.execPath : 'dsh'
  const commandArgs = existsSync(dshBin) ? [dshBin, '--profile', args.profile, prompt] : ['--profile', args.profile, prompt]
  const spawn = deps.spawn ?? spawnSync
  const result = spawn(command, commandArgs, { cwd: paths.projectDir, stdio: 'inherit', ...(command === 'dsh' ? { shell: true } : {}) })
  return { status: 'launched', profileDir, projectDir: paths.projectDir, runDir: paths.runDir, exitCode: result.status ?? 1 }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startSession().then((result) => {
    if (result.status !== 'launched') console.error(result.message)
    process.exitCode = result.exitCode
  }).catch((error) => { console.error(error); process.exitCode = 1 })
}
