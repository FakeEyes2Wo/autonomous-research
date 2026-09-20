import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { ActionResult } from '../core/types.js'
import { safeResolve } from '../core/utils.js'
import { ExperimentPauseError } from './errors.js'

function pause(message: string): never {
  throw new ExperimentPauseError(`worker result rejected: ${message}`)
}

/** Filesystem identity preserves distinct files on case-sensitive volumes. */
export async function canonicalRelativePath(rootDir: string, path: string): Promise<string> {
  const root = await realpath(rootDir), actual = await realpath(safeResolve(rootDir, path))
  const value = relative(root, actual)
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) pause(`path resolves outside its root: ${path}`)
  return value.replaceAll('\\', '/')
}

/**
 * Validate the local evidence envelope shared by every worker path.
 * This proves shape and containment only; it does not establish scientific truth.
 */
export async function validateWorkerResult(runDir: string, issuedWorkDir: string, value: unknown): Promise<ActionResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) pause('expected a structured object')
  const record = value as Record<string, unknown>
  if (record.status !== 'completed' && record.status !== 'failed') pause('status must be completed or failed')
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) pause('summary must be a non-empty string')
  if (record.status === 'failed') pause(`worker reported failed: ${record.summary}`)
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) pause('artifacts must contain at least one file')
  if (!record.artifacts.every((artifact) => typeof artifact === 'string' && artifact.trim().length > 0)) {
    pause('every artifact must be a non-empty path string')
  }
  const root = await realpath(issuedWorkDir)
  const runRoot = await realpath(runDir)
  const workRelative = relative(runRoot, root)
  if (!workRelative || workRelative === '..' || workRelative.startsWith(`..${sep}`) || isAbsolute(workRelative)) pause('issued workDir must be a child of the run directory')
  const artifacts: string[] = []
  for (const artifact of record.artifacts as string[]) {
    let candidate: string
    try {
      candidate = safeResolve(runDir, artifact)
    } catch {
      pause(`artifact path escapes the run directory: ${artifact}`)
    }
    try {
      const info = await stat(candidate)
      if (!info.isFile()) pause(`artifact is not a regular file: ${artifact}`)
      const resolved = await realpath(candidate)
      const fromRoot = relative(root, resolved)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        pause(`artifact resolves outside the issued workDir: ${artifact}`)
      }
      artifacts.push(relative(runRoot, resolved).replaceAll('\\', '/'))
    } catch (error) {
      if (error instanceof ExperimentPauseError) throw error
      pause(`artifact does not exist or cannot be read: ${artifact}`)
    }
  }

  return { status: 'completed', summary: record.summary as string, artifacts }
}
