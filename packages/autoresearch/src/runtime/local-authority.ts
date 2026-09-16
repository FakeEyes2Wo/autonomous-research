import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { JobSpec, RuntimeLimits } from './contracts.js'
import { validateLocalBudget } from './budget.js'

/** Host-only grant for trusted local programs. This is not a hostile-code sandbox. */
export interface LocalExperimentConfig {
  projectRoots: string[]; executables: string[]; envNames?: string[]
  maxWallMs: number; maxRunWallMs: number; maxLogBytes: number; maxArtifactBytes: number
}
const within = (root: string, path: string) => { const child = relative(root, path); return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..\\') && !child.startsWith('../')) }
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }

export async function createLocalExperimentRuntime(config: LocalExperimentConfig, projectDir: string): Promise<{
  authorize(spec: JobSpec, task: unknown): Promise<void>; limits: RuntimeLimits
}> {
  config = structuredClone(config)
  if (!config || !Array.isArray(config.projectRoots) || !config.projectRoots.length || !Array.isArray(config.executables) || !config.executables.length ||
    [...config.projectRoots, ...config.executables].some(p => typeof p !== 'string' || !isAbsolute(p)) ||
    (config.envNames !== undefined && (!Array.isArray(config.envNames) || config.envNames.some(n => typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)))) ||
    [config.maxWallMs, config.maxRunWallMs, config.maxLogBytes, config.maxArtifactBytes].some(n => !Number.isSafeInteger(n) || n < 1) ||
    config.maxWallMs > config.maxRunWallMs) fail('INVALID_LOCAL_EXECUTION_CONFIG')
  const project = await realpath(resolve(projectDir))
  const roots = await Promise.all(config.projectRoots.map(p => realpath(p)))
  if (!roots.some(root => within(root, project))) fail('PROJECT_NOT_AUTHORIZED')
  const executables = await Promise.all(config.executables.map(p => realpath(p)))
  const names = new Set(config.envNames ?? [])
  return {
    limits: { maxConcurrentJobs: 1, maxReservedWallMs: config.maxRunWallMs },
    async authorize(spec) {
      if (!isAbsolute(spec.cwd)) fail('CWD_NOT_AUTHORIZED')
      const cwd = await realpath(spec.cwd)
      if (!within(project, cwd) || !(await stat(cwd)).isDirectory()) fail('CWD_NOT_AUTHORIZED')
      if (!isAbsolute(spec.executable)) fail('EXECUTABLE_NOT_AUTHORIZED')
      const executable = await realpath(spec.executable).catch(() => fail('EXECUTABLE_NOT_AUTHORIZED'))
      if (!executables.includes(executable)) fail('EXECUTABLE_NOT_AUTHORIZED')
      if (!Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) fail('INVALID_ARGUMENT_VECTOR')
      if (!spec.env || Object.keys(spec.env).some(name => !names.has(name))) fail('ENV_NOT_AUTHORIZED')
      validateLocalBudget(spec.budget)
      if (spec.budget.wallMs > config.maxWallMs || spec.budget.maxLogBytes > config.maxLogBytes || spec.budget.maxArtifactBytes > config.maxArtifactBytes) fail('BUDGET_NOT_AUTHORIZED')
    },
  }
}
