import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson, readOptionalText } from '../core/utils.js'
import { artifactHash } from '../project/inventory.js'
import type { ResearchRunOptions } from './autoresearch-service.js'

export interface RunProjectIdentity {
  version: 1
  projectDir: string
  projectId: string
  workflow: 'research' | 'project-paper'
  validation: 'bounded-supplementary'
  options: Pick<ResearchRunOptions, 'maxCycles' | 'paper'>
}

/** Old runs acquire a scope on their next explicit run/resume; new runs never lose it. */
export async function bindRunProject(options: ResearchRunOptions, requestedWorkflow?: 'project-paper', existingState = false): Promise<RunProjectIdentity> {
  const path = join(options.runDir, '.autoresearch', 'project-identity.json')
  const saved = await readOptionalText(path)
  if (saved) {
    const identity = JSON.parse(saved) as RunProjectIdentity
    if (identity.version !== 1 || !['research', 'project-paper'].includes(identity.workflow) || typeof identity.projectDir !== 'string' || identity.projectId !== artifactHash({ projectDir: identity.projectDir })) throw new Error('invalid run project identity')
    const root = await realpath(options.projectDir ?? identity.projectDir)
    if (root !== identity.projectDir) throw new Error('run project identity mismatch')
    if (requestedWorkflow && requestedWorkflow !== identity.workflow) throw new Error('run workflow identity mismatch; choose a fresh run directory')
    return identity
  }
  if (requestedWorkflow && existingState) throw new Error('existing run has no project discovery identity; choose a fresh run directory')
  const projectDir = await realpath(options.projectDir ?? options.runDir)
  const paper = options.paper ? Object.fromEntries(Object.entries(options.paper).filter(([key]) => ['venue', 'assurance', 'effort', 'styleRef', 'maxImprovementRounds'].includes(key))) : undefined
  const identity: RunProjectIdentity = { version: 1, projectDir, projectId: artifactHash({ projectDir }), workflow: requestedWorkflow ?? 'research', validation: 'bounded-supplementary', options: { ...(options.maxCycles !== undefined ? { maxCycles: options.maxCycles } : {}), ...(paper ? { paper } : {}) } }
  await atomicWriteJson(path, identity)
  return identity
}
