import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { ActionResult } from '../core/types.js'
import { safeResolve } from '../core/utils.js'
import { ExperimentPauseError } from './errors.js'

function pause(message: string): never {
  throw new ExperimentPauseError(`worker result rejected: ${message}`)
}

/**
 * Validate the local evidence envelope shared by every worker path.
 * This proves shape and containment only; it does not establish scientific truth.
 */
export async function validateWorkerResult(runDir: string, value: unknown): Promise<ActionResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) pause('expected a structured object')
  const record = value as Record<string, unknown>
  if (record.status !== 'completed' && record.status !== 'failed') pause('status must be completed or failed')
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) pause('summary must be a non-empty string')
  if (record.status === 'failed') pause(`worker reported failed: ${record.summary}`)
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) pause('artifacts must contain at least one file')
  if (!record.artifacts.every((artifact) => typeof artifact === 'string' && artifact.trim().length > 0)) {
    pause('every artifact must be a non-empty path string')
  }
  const root = await realpath(runDir)
  const artifacts = record.artifacts as string[]
  for (const artifact of artifacts) {
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
        pause(`artifact resolves outside the run directory: ${artifact}`)
      }
    } catch (error) {
      if (error instanceof ExperimentPauseError) throw error
      pause(`artifact does not exist or cannot be read: ${artifact}`)
    }
  }

  return { status: 'completed', summary: record.summary as string, artifacts }
}
