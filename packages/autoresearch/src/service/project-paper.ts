import { link, mkdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { readOptionalText } from '../core/utils.js'
import { artifactHash } from '../project/inventory.js'
import type { ResearchRunOptions } from './autoresearch-service.js'

export interface RunProjectIdentity {
  version: 1
  projectDir: string
  projectId: string
  workflow: 'research' | 'project-paper' | 'experiment'
  validation: 'bounded-supplementary'
  options: Pick<ResearchRunOptions, 'maxCycles' | 'paper'>
}

async function validateBinding(saved: string | undefined, options: ResearchRunOptions, requestedWorkflow?: RunProjectIdentity['workflow']): Promise<RunProjectIdentity> {
  if (!saved) throw new Error('invalid run project identity')
  const identity = JSON.parse(saved) as RunProjectIdentity
  if (identity.version !== 1 || !['research', 'project-paper', 'experiment'].includes(identity.workflow) || typeof identity.projectDir !== 'string' || identity.projectId !== artifactHash({ projectDir: identity.projectDir })) throw new Error('invalid run project identity')
  const root = await realpath(options.projectDir ?? identity.projectDir)
  if (root !== identity.projectDir) throw new Error('run project identity mismatch')
  // Generic research can resume a project-paper run, but an experiment is a
  // separate engine and must always be resumed explicitly by that engine.
  if (!requestedWorkflow && identity.workflow === 'experiment') throw new Error('run workflow identity mismatch; experiment run requires the experiment engine')
  if (requestedWorkflow && requestedWorkflow !== identity.workflow) throw new Error('run workflow identity mismatch; choose a fresh run directory')
  return identity
}

/** Old runs acquire a scope on their next explicit run/resume; new runs never lose it. */
export async function bindRunProject(options: ResearchRunOptions, requestedWorkflow?: RunProjectIdentity['workflow'], existingState = false): Promise<RunProjectIdentity> {
  const path = join(options.runDir, '.autoresearch', 'project-identity.json')
  const saved = await readOptionalText(path)
  if (saved) return validateBinding(saved, options, requestedWorkflow)
  // A legacy experiment has no project identity yet, but its manifest still
  // marks the directory as owned by the experiment engine. Do not let generic
  // research silently adopt it while it is between legacy and v1 metadata.
  const experimentManifest = await readOptionalText(join(options.runDir, '.autoresearch', 'experiment-manifest.json'))
  const experimentRequest = await readOptionalText(join(options.runDir, '.autoresearch', 'experiment-request.json'))
  if ((experimentManifest !== undefined || experimentRequest !== undefined) && requestedWorkflow !== 'experiment') throw new Error('run workflow identity mismatch; legacy experiment run requires the experiment engine')
  if (requestedWorkflow === 'project-paper' && existingState) throw new Error('existing run has no project discovery identity; choose a fresh run directory')
  // Direct callers historically used runDir as the project root and may pass
  // a path that has not been created yet. Materialize only that empty root so
  // realpath can establish the identity; state and input files remain behind
  // the binding boundary.
  if (!options.projectDir) {
    try { await realpath(options.runDir) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(options.runDir, { recursive: true })
    }
  }
  const projectDir = await realpath(options.projectDir ?? options.runDir)
  const paper = options.paper ? Object.fromEntries(Object.entries(options.paper).filter(([key]) => ['venue', 'assurance', 'effort', 'styleRef', 'maxImprovementRounds'].includes(key))) : undefined
  const identity: RunProjectIdentity = { version: 1, projectDir, projectId: artifactHash({ projectDir }), workflow: requestedWorkflow ?? 'research', validation: 'bounded-supplementary', options: { ...(options.maxCycles !== undefined ? { maxCycles: options.maxCycles } : {}), ...(paper ? { paper } : {}) } }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx' })
  try {
    // Publish complete bytes without replacement, including across processes.
    try { await link(temporary, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // This caller observed absence, so its new-run intent must match the winner.
      // Ordinary resume (the saved branch above) may inherit an existing project-paper workflow.
      return await validateBinding(await readOptionalText(path), { ...options, projectDir }, requestedWorkflow ?? 'research')
    }
    return identity
  } finally { await unlink(temporary) }
}
