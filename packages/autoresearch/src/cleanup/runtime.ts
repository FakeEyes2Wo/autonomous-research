import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { loadState } from '../core/state.js'
import { flushLoggers } from '../core/utils.js'
import { listFrozenTaskGraphs } from '../experiment/runtime-adapter.js'
import { hashBytes } from '../research/records.js'
import { openJobStore } from '../runtime/job-store.js'
import { terminal, type JobRecord } from '../runtime/contracts.js'
import { loadDirectionManifest } from './manifest.js'
import { validateManagedRelativePath, type CleanupTask } from './direction-id.js'

export interface ProtectionResult { safe: boolean; reasons: string[] }
const contained = (root: string, target: string) => target === root || target.startsWith(root + sep)

/** Verify every existing metadata component before cleanup reads or writes it. */
export async function assertCleanupPathContained(runDir: string, ...parts: string[]): Promise<string> {
  const lexicalRoot = resolve(runDir)
  const root = await realpath(lexicalRoot)
  let current = lexicalRoot
  for (const part of parts) {
    current = resolve(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`cleanup metadata contains symlink: ${current}`)
      const actual = await realpath(current)
      if (!contained(root, actual)) throw new Error(`cleanup metadata escapes run root: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return current
      throw error
    }
  }
  return current
}

async function verifyProjectIdentity(projectDir: string, task: CleanupTask): Promise<{ projectRoot: string; runRoot: string }> {
  const projectRoot = await realpath(resolve(projectDir))
  const runRoot = await realpath(resolve(task.runDir))
  if (task.direction.projectId !== projectRoot) throw new Error('cleanup direction project identity mismatch')
  const identityPath = await assertCleanupPathContained(runRoot, '.autoresearch', 'project-identity.json')
  let identity: unknown
  try { identity = JSON.parse(await readFile(identityPath, 'utf8')) } catch (error) { throw new Error(`cleanup run project identity unavailable: ${String(error)}`) }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new Error('cleanup run project identity is malformed')
  const value = identity as Record<string, unknown>
  const expectedProjectId = hashBytes(JSON.stringify({ projectDir: projectRoot }))
  if (value.projectDir !== projectRoot || value.projectId !== expectedProjectId) throw new Error('cleanup run project identity mismatch')
  return { projectRoot, runRoot }
}

export async function assertCleanupScope(projectDir: string, task: CleanupTask): Promise<{ projectRoot: string; runRoot: string }> {
  return verifyProjectIdentity(projectDir, task)
}

async function currentDirectionIsSupported(task: CleanupTask): Promise<boolean> {
  const pointerPath = await assertCleanupPathContained(task.runDir, 'CURRENT.json')
  let pointer: unknown
  try { pointer = JSON.parse(await readFile(pointerPath, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  if (!pointer || typeof pointer !== 'object' || typeof (pointer as Record<string, unknown>).snapshot_id !== 'string') throw new Error('current research pointer is malformed')
  const id = (pointer as { snapshot_id: string }).snapshot_id
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/u.test(id)) throw new Error('current research pointer id is invalid')
  const snapshotPath = await assertCleanupPathContained(task.runDir, 'research', 'snapshots', id, 'manifest.json')
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Record<string, any>
  const activeClaim = snapshot.active_claim, activeHypothesis = snapshot.active_hypothesis
  const sameDirection = activeClaim?.id === task.direction.claim.id && activeClaim?.version >= task.direction.claim.version && activeHypothesis?.id === task.direction.hypothesis.id && activeHypothesis?.version === task.direction.hypothesis.version && (task.direction.protocolHash === undefined || snapshot.protocol?.content_hash === task.direction.protocolHash)
  return sameDirection && snapshot.assessment?.claim_status === 'supported'
}

async function safeManagedPath(root: string, relativePath: string): Promise<string> {
  validateManagedRelativePath(relativePath)
  let current = root
  for (const part of relativePath.split('/')) {
    current = resolve(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error(`managed path contains symlink: ${relativePath}`)
    const actual = await realpath(current)
    if (!contained(root, actual)) throw new Error(`managed path escapes run root: ${relativePath}`)
  }
  return current
}

export async function inspectCleanupProtection(task: CleanupTask): Promise<ProtectionResult> {
  const reasons: string[] = []
  let root: string
  try {
    const scope = await verifyProjectIdentity(task.direction.projectId, task)
    root = scope.runRoot
  } catch (error) { return { safe: false, reasons: [`cleanup_scope_invalid:${String(error)}`] } }
  const state = await loadState(task.runDir)
  if (!state) reasons.push('run_state_missing')
  else if (state.status === 'RUNNING' || state.status === 'WAITING') reasons.push(`run_${state.status.toLowerCase()}`)
  try {
    if (await currentDirectionIsSupported(task)) reasons.push('retired_direction_is_supported')
  } catch (error) { reasons.push(`research_state_unreadable:${String(error)}`) }
  try {
    const manifest = task.manifestId ? await loadDirectionManifest(task.runDir, task.manifestId) : undefined
    if (!manifest) reasons.push('direction_manifest_missing')
    else if (task.manifestHash && manifest.contentHash !== task.manifestHash) reasons.push('direction_manifest_changed')
    for (const target of task.targets) {
      if (target.ownership !== 'direction') reasons.push(`target_not_exclusive:${target.relativePath}`)
      if (manifest && !manifest.artifacts.some(artifact => artifact.relativePath === target.relativePath && artifact.hash === target.hash && artifact.ownership === 'direction')) reasons.push(`target_not_in_manifest:${target.relativePath}`)
      validateManagedRelativePath(target.relativePath)
      let file: string
      try {
        file = await safeManagedPath(root, target.relativePath)
        const stat = await lstat(file)
        if (stat.isSymbolicLink() || !stat.isFile()) reasons.push(`target_not_regular:${target.relativePath}`)
        else if (hashBytes(await readFile(file)) !== target.hash) reasons.push(`target_changed:${target.relativePath}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reasons.push(`target_unreadable:${target.relativePath}`)
      }
    }
    const graphs = await listFrozenTaskGraphs(task.runDir)
    const jobsRoot = resolve(task.runDir, 'runtime', 'jobs')
    const jobsFile = join(jobsRoot, 'jobs.sqlite')
    let jobs: JobRecord[] = []
    try { await access(jobsFile) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (graphs.some(graph => graph.tasks.length > 0)) reasons.push('jobs_database_missing')
    }
    if (jobs.length === 0) {
      try {
        await assertCleanupPathContained(task.runDir, 'runtime', 'jobs', 'jobs.sqlite')
        await access(jobsFile)
        const store = await openJobStore(jobsRoot)
        try { jobs = await store.list() } finally { await store.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reasons.push(`jobs_unreadable:${String(error)}`)
      }
    }
    const graphJobs = new Set(graphs.flatMap(graph => graph.tasks.flatMap(item => [item.job.id, item.job.attemptId])))
    for (const graph of graphs) for (const item of graph.tasks) {
      if (!jobs.some(job => job.spec.id === item.job.id || job.spec.attemptId === item.job.attemptId)) reasons.push(`job_missing:${graph.id}:${item.job.id}`)
    }
    for (const job of jobs) {
      if (!terminal(job.receipt.status)) reasons.push(`live_job:${job.spec.id}:${job.receipt.status}`)
      if (!graphJobs.has(job.spec.id)) reasons.push(`orphan_job:${job.spec.id}`)
    }
  } catch (error) { reasons.push(`runtime_inspection_failed:${String(error)}`) }
  return { safe: reasons.length === 0, reasons }
}

export async function flushCleanupRuntime(): Promise<void> { await flushLoggers() }
