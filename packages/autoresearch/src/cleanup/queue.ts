import { mkdir, readFile, open, unlink, lstat, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteJson, readOptionalText, safeResolve } from '../core/utils.js'
import { ProjectDirectionMemoryStore } from '../memory/direction-memory.js'
import { hashContent } from '../research/records.js'
import { cleanupAuthorizationHash, directionId, validateCleanupTask, validateDirectionRef, type CleanupTask, type DirectionRef, type ManagedArtifact, type RetirementDisposition } from './direction-id.js'

const queueDir = (projectDir: string) => safeResolve(projectDir, '.autoresearch', 'cleanup', 'tasks')
const queueFile = (projectDir: string, id: string) => safeResolve(projectDir, '.autoresearch', 'cleanup', 'tasks', `${id}.json`)
const locks = new Map<string, Promise<void>>()
const contained = (root: string, target: string) => target === root || target.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)

async function assertQueuePath(projectDir: string, file: string): Promise<void> {
  const root = await realpath(projectDir)
  let current = root
  for (const part of file.slice(root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = safeResolve(current, part)
    const info = await lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (!info) continue
    if (info.isSymbolicLink() || !contained(root, await realpath(current))) throw new Error('cleanup queue metadata escapes project root')
  }
}

async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lockFile = `${file}.lock`
  await mkdir(await queueDir(file.slice(0, file.lastIndexOf('.autoresearch'))), { recursive: true }).catch(() => undefined)
  const deadline = Date.now() + 15_000
  while (true) {
    try {
      const handle = await open(lockFile, 'wx')
      await handle.writeFile(`${process.pid} ${randomUUID()}\n`)
      await handle.close()
      try { return await fn() } finally { await unlink(lockFile).catch(() => undefined) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const owner = (await readFile(lockFile, 'utf8')).trim().split(/\s+/u)
        const pid = Number(owner[0])
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) }
          catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(lockFile); continue }
          }
        }
      } catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ENOENT') { /* malformed/live lock: wait for owner or timeout */ } }
      if (Date.now() >= deadline) throw new Error(`cleanup queue lock timeout: ${file}`)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 15))
    }
  }
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = previous.then(() => current)
  locks.set(key, queued)
  await previous
  try { return await fn() } finally { release(); if (locks.get(key) === queued) locks.delete(key) }
}

function sealTask(task: Omit<CleanupTask, 'contentHash'>): CleanupTask { return { ...task, contentHash: hashContent(task) } }
function verifyTask(task: CleanupTask): CleanupTask {
  validateCleanupTask(task)
  const body = { ...task } as Partial<CleanupTask>
  delete body.contentHash
  if (task.contentHash !== hashContent(body)) throw new Error(`cleanup task hash mismatch: ${task.id}`)
  return task
}

export async function enqueueRetirement(input: {
  projectDir: string
  runDir: string
  direction: DirectionRef
  disposition: RetirementDisposition
  idea: string
  reason: string
  avoidRepeat: string
  targets?: ManagedArtifact[]
  manifestId?: string
  manifestHash?: string
  mechanismKey?: string
  changedAssumption?: string
}): Promise<CleanupTask> {
  validateDirectionRef(input.direction)
  const id = `cleanup-${directionId(input.direction)}`
  const file = queueFile(input.projectDir, id)
  await assertQueuePath(input.projectDir, file)
  return withLock(file, async () => {
    return withFileLock(file, async () => {
    const saved = await readOptionalText(file)
    if (saved !== undefined) {
      const existing = verifyTask(JSON.parse(saved) as CleanupTask)
      if (existing.directionId !== directionId(input.direction) || existing.runDir !== input.runDir || existing.disposition !== input.disposition) throw new Error(`cleanup task identity conflict: ${id}`)
      return existing
    }
    const now = new Date().toISOString()
    const task = sealTask({ schema: 'autoresearch/cleanup-task/v1', id, direction: input.direction, directionId: directionId(input.direction), disposition: input.disposition, state: 'pending', idea: input.idea, reason: input.reason, avoidRepeat: input.avoidRepeat, ...(input.mechanismKey ? { mechanismKey: input.mechanismKey } : {}), ...(input.changedAssumption ? { changedAssumption: input.changedAssumption } : {}), runDir: input.runDir, targets: input.targets ?? [], ...(input.manifestId ? { manifestId: input.manifestId } : {}), ...(input.manifestHash ? { manifestHash: input.manifestHash } : {}), createdAt: now, updatedAt: now })
    await mkdir(await queueDir(input.projectDir), { recursive: true })
    await atomicWriteJson(file, task)
    return task
    })
  })
}

export async function loadCleanupTask(projectDir: string, id: string): Promise<CleanupTask | undefined> {
  const file = queueFile(projectDir, id)
  await assertQueuePath(projectDir, file)
  const text = await readOptionalText(file)
  return text === undefined ? undefined : verifyTask(JSON.parse(text) as CleanupTask)
}

export async function listCleanupTasks(projectDir: string): Promise<CleanupTask[]> {
  await assertQueuePath(projectDir, queueDir(projectDir))
  let names: string[]
  try { names = await (await import('node:fs/promises')).readdir(await queueDir(projectDir)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const tasks: CleanupTask[] = []
  for (const name of names.filter(value => value.endsWith('.json') && !value.endsWith('.progress.json')).sort()) {
    const task = verifyTask(JSON.parse(await readFile(join(await queueDir(projectDir), name), 'utf8')) as CleanupTask)
    tasks.push(task)
  }
  return tasks
}

/** A blocked task with deletion progress must not resurrect its direction. */
export async function hasCleanupProgress(projectDir: string, task: CleanupTask): Promise<boolean> {
  const file = safeResolve(projectDir, '.autoresearch', 'cleanup', 'tasks', `${task.id}.progress.json`)
  await assertQueuePath(projectDir, file)
  const saved = await readOptionalText(file)
  if (saved === undefined) return false
  try {
    const progress = JSON.parse(saved) as { taskId?: unknown; authorizationHash?: unknown; states?: unknown }
    if (progress.taskId !== task.id || typeof progress.authorizationHash !== 'string' || !progress.states || typeof progress.states !== 'object' || Array.isArray(progress.states)) return true
    const authorization = task.authorizationHash ?? (task.memory ? cleanupAuthorizationHash(task) : undefined)
    if (!authorization || progress.authorizationHash !== authorization) return true
    return Object.values(progress.states as Record<string, unknown>).some(value => value === 'started' || value === 'completed')
  } catch { return true }
}

export async function isCleanupTaskRetired(projectDir: string, task: CleanupTask): Promise<boolean> {
  // Once deletion has started, the direction is retired even if a later
  // lifecycle pass moves the task to waiting_live/blocked.  Redispatching in
  // that window could recreate artifacts whose durable intent is already on
  // disk and make a partial cleanup impossible to resume safely.
  return task.state === 'deleting' || task.state === 'completed' || await hasCleanupProgress(projectDir, task)
}

export async function saveCleanupTask(projectDir: string, task: CleanupTask): Promise<CleanupTask> {
  const { contentHash: _ignored, ...body } = task
  const nextBody = { ...body, updatedAt: new Date().toISOString() } as CleanupTask
  if (nextBody.state !== 'pending' && nextBody.memory) nextBody.authorizationHash = cleanupAuthorizationHash(nextBody)
  const { contentHash: _contentHash, ...unsigned } = nextBody
  const next = sealTask(unsigned)
  verifyTask(next)
  const file = queueFile(projectDir, task.id)
  await assertQueuePath(projectDir, file)
  return withLock(file, async () => withFileLock(file, async () => {
    const saved = await readOptionalText(file)
    if (saved === undefined) { await atomicWriteJson(file, next); return next }
    const current = verifyTask(JSON.parse(saved) as CleanupTask)
    if (current.contentHash === task.contentHash) { await atomicWriteJson(file, next); return next }
    const priority: Record<CleanupTask['state'], number> = { pending: 0, memory_saved: 1, waiting_live: 2, deleting: 3, blocked: 2, completed: 4 }
    const mergedTargets = [...current.targets]
    for (const target of next.targets) if (!mergedTargets.some(item => item.relativePath === target.relativePath)) mergedTargets.push(target)
    const merged = { ...next, ...current, targets: mergedTargets, state: priority[current.state] >= priority[next.state] ? current.state : next.state,
      memory: current.memory ?? next.memory, manifestId: current.manifestId ?? next.manifestId, manifestHash: current.manifestHash ?? next.manifestHash,
      lastError: next.lastError, updatedAt: new Date().toISOString() }
    const { contentHash: _ignoredMerged, ...unsignedMerged } = merged
    const reconciledBody = { ...unsignedMerged } as CleanupTask
    if (reconciledBody.state !== 'pending' && reconciledBody.memory) reconciledBody.authorizationHash = (await import('./direction-id.js')).cleanupAuthorizationHash(reconciledBody)
    const { contentHash: _ignoredReconciled, ...reconciledUnsigned } = reconciledBody
    const reconciled = sealTask(reconciledUnsigned)
    await atomicWriteJson(file, reconciled)
    return reconciled
  }))
}

/** Extend a pending/live task with artifacts created after its early memory receipt. */
export async function refreshCleanupTargets(projectDir: string, taskId: string, targets: ManagedArtifact[], manifestId?: string, manifestHash?: string): Promise<CleanupTask | undefined> {
  const task = await loadCleanupTask(projectDir, taskId)
  if (!task || task.state === 'completed' || task.state === 'deleting') return task
  const merged = [...task.targets]
  for (const target of targets) {
    const prior = merged.find(item => item.relativePath === target.relativePath)
    if (prior && (prior.hash !== target.hash || prior.ownership !== target.ownership)) throw new Error(`cleanup target changed after registration: ${target.relativePath}`)
    if (!prior) merged.push(target)
  }
  return saveCleanupTask(projectDir, { ...task, targets: merged, ...(manifestId ? { manifestId } : {}), ...(manifestHash ? { manifestHash } : {}) })
}

/** Memory is written exactly once before the task becomes eligible for deletion. */
export async function persistRetirementMemory(projectDir: string, task: CleanupTask): Promise<CleanupTask> {
  const existing = task.memory
  if (existing && task.state !== 'pending') return task
  const record = await new ProjectDirectionMemoryStore(projectDir).upsert({ idea: task.idea, eliminationReason: task.reason, avoid: task.avoidRepeat, reasonCode: task.disposition === 'refuted' ? 'confirmed_error' : 'explicit_abandonment', ...(task.mechanismKey ? { mechanismKey: task.mechanismKey } : {}), ...(task.changedAssumption ? { changedAssumption: task.changedAssumption } : {}) })
  return saveCleanupTask(projectDir, { ...task, state: 'memory_saved', memory: { id: record.id, version: record.version, contentHash: hashContent(record) } })
}
