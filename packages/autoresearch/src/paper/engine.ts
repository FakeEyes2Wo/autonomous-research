import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * A registered LaTeX engine. New engines are added by appending one entry to
 * `latexEngines`; `compilePaper` only needs to look up the resolved command and
 * run its configured args.
 */
export interface LatexEngine {
  name: string
  candidates: readonly string[]
  versionArgs: readonly (readonly string[])[]
  args(paperDir: string): readonly string[]
  env?(): Record<string, string>
}

export interface ResolvedLatexEngine {
  name: string
  command: string
  spec: LatexEngine
}

export interface LatexEngineLookupOptions {
  /** Environment used for explicit compiler configuration and tests. */
  env?: NodeJS.ProcessEnv
  /** Injectable version probe keeps discovery testable without invoking a compiler. */
  probe?: (command: string, args: readonly string[]) => boolean
  /** Injectable path check keeps explicit path behavior testable. */
  exists?: (command: string) => boolean
}

/**
 * Single source of truth for the engines the paper pipeline can use.
 * The array also acts as the lookup order: the first resolvable engine wins.
 */
export const latexEngines = [
  {
    name: 'xelatex',
    candidates: ['xelatex'],
    versionArgs: [['--version']],
    args: () => ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
  },
  {
    name: 'tectonic',
    candidates: ['tectonic'],
    versionArgs: [['--version']],
    args: () => ['main.tex'],
    env: () => proxyEnvironment(process.env),
  },
  {
    name: 'latexmk',
    candidates: ['latexmk'],
    versionArgs: [['--version'], ['-version']],
    args: () => ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
  },
  {
    name: 'pdflatex',
    candidates: ['pdflatex'],
    versionArgs: [['--version']],
    args: () => ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
  },
] as const satisfies readonly LatexEngine[]

function looksLikeFileCandidate(command: string): boolean {
  return /[\\/]/.test(command)
}

export function proxyEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    const value = env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

export function findLatexEngine(options: LatexEngineLookupOptions = {}): ResolvedLatexEngine | undefined {
  const env = options.env ?? process.env
  const probe = options.probe ?? ((command: string, args: readonly string[]) => {
    const result = spawnSync(command, [...args], { stdio: 'ignore' })
    return !result.error && result.status === 0
  })
  const exists = options.exists ?? existsSync
  const tectonic = latexEngines.find((spec) => spec.name === 'tectonic')
  const explicit = typeof env.TECTONIC_PATH === 'string' ? env.TECTONIC_PATH.trim() : ''
  if (explicit && tectonic) {
    // An explicit setting is authoritative. A stale setting must report that
    // no engine is available rather than silently selecting another compiler.
    if (looksLikeFileCandidate(explicit) && !exists(explicit)) return undefined
    if (tectonic.versionArgs.some((args) => probe(explicit, args))) return { name: tectonic.name, command: explicit, spec: tectonic }
    return undefined
  }

  for (const spec of latexEngines) {
    for (const candidate of spec.candidates) {
      if (looksLikeFileCandidate(candidate)) continue
      for (const versionArgs of spec.versionArgs) {
        if (probe(candidate, versionArgs)) {
          return { name: spec.name, command: candidate, spec }
        }
      }
    }
  }
  return undefined
}
