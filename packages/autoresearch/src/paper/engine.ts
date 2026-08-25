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
    candidates: ['tectonic', 'D:\\Tectonic\\bin\\tectonic.exe', 'C:\\Tectonic\\bin\\tectonic.exe'],
    versionArgs: [['--version']],
    args: () => ['main.tex'],
    env: () => ({
      HTTP_PROXY: process.env.HTTP_PROXY ?? 'http://127.0.0.1:7890',
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? 'http://127.0.0.1:7890',
      ALL_PROXY: process.env.ALL_PROXY ?? 'http://127.0.0.1:7890',
    }),
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

export function findLatexEngine(): ResolvedLatexEngine | undefined {
  // Preserve the original priority: probe every normal executable first, then
  // fall back to known absolute-package paths in the same registry order.
  for (const spec of latexEngines) {
    for (const candidate of spec.candidates) {
      if (looksLikeFileCandidate(candidate)) continue
      for (const versionArgs of spec.versionArgs) {
        const probe = spawnSync(candidate, [...versionArgs], { stdio: 'ignore' })
        if (!probe.error && probe.status === 0) {
          return { name: spec.name, command: candidate, spec }
        }
      }
    }
  }
  for (const spec of latexEngines) {
    for (const candidate of spec.candidates) {
      if (!looksLikeFileCandidate(candidate)) continue
      if (existsSync(candidate)) {
        return { name: spec.name, command: candidate, spec }
      }
    }
  }
  return undefined
}
