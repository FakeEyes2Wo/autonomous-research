import { lstat, open, readFile, readdir, realpath, stat, unlink, utimes } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { ProjectDirectionMemoryStore } from '../memory/direction-memory.js'
import { hashBytes, hashContent } from '../research/records.js'
import { atomicWriteJson, flushLoggers, readOptionalText } from '../core/utils.js'
import { loadDirectionManifest } from './manifest.js'
import { assertCleanupPathContained, assertCleanupScope, inspectCleanupProtection } from './runtime.js'
import { loadCleanupTask, saveCleanupTask } from './queue.js'
import { writeSourceTombstone } from './tombstones.js'
import { cleanupAuthorizationHash, validateManagedRelativePath, type CleanupTask, type DirectionManifest, type ManagedArtifact } from './direction-id.js'

export interface RetirementResult {
  task: CleanupTask
  deleted: string[]
  blocked: string[]
}

const contained = (root: string, target: string) => target === root || target.startsWith(root + sep)

async function acquireExecutionLock(projectDir: string, taskId: string): Promise<() => Promise<void>> {
  const file = resolve(projectDir, '.autoresearch', 'cleanup', 'tasks', `${taskId}.execute.lock`)
  await assertCleanupPathContained(projectDir, '.autoresearch', 'cleanup', 'tasks')
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(`${process.pid}\n`)
      await handle.close()
      const heartbeat = setInterval(() => { void utimes(file, new Date(), new Date()).catch(() => undefined) }, 30_000)
      heartbeat.unref?.()
      return async () => { clearInterval(heartbeat); await unlink(file).catch(() => undefined) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const lockStat = await stat(file)
        let ownerAlive = false
        try {
          const owner = Number.parseInt((await readFile(file, 'utf8')).trim(), 10)
          if (Number.isSafeInteger(owner) && owner > 0) { process.kill(owner, 0); ownerAlive = true }
        } catch { ownerAlive = false }
        if (!ownerAlive && Date.now() - lockStat.mtimeMs > 120_000) await unlink(file)
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe
      }
      if (Date.now() >= deadline) throw new Error(`cleanup execution lock timeout: ${taskId}`)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20 + Math.floor(Math.random() * 30)))
    }
  }
}

interface CleanupProgress {
  schema: 'autoresearch/cleanup-progress/v1'
  taskId: string
  authorizationHash: string
  states: Record<string, 'started' | 'completed'>
}

function progressFile(projectDir: string, taskId: string): string {
  return resolve(projectDir, '.autoresearch', 'cleanup', 'tasks', `${taskId}.progress.json`)
}

async function loadProgress(projectDir: string, task: CleanupTask): Promise<CleanupProgress> {
  const saved = await readOptionalText(progressFile(projectDir, task.id))
  if (saved === undefined) return { schema: 'autoresearch/cleanup-progress/v1', taskId: task.id, authorizationHash: cleanupAuthorizationHash(task), states: {} }
  const parsed = JSON.parse(saved) as CleanupProgress
  const expected = new Set(task.targets.map(target => target.relativePath))
  if (parsed.schema !== 'autoresearch/cleanup-progress/v1' || parsed.taskId !== task.id || parsed.authorizationHash !== cleanupAuthorizationHash(task) || !parsed.states || Object.keys(parsed.states).some(path => !expected.has(path) || !['started', 'completed'].includes(parsed.states[path]!))) {
    throw new Error('cleanup progress receipt is stale or malformed')
  }
  return parsed
}

async function saveProgress(projectDir: string, progress: CleanupProgress): Promise<void> {
  await atomicWriteJson(progressFile(projectDir, progress.taskId), progress)
}

async function verifyMemory(projectDir: string, task: CleanupTask): Promise<void> {
  if (!task.memory || task.state === 'pending') throw new Error('cleanup memory receipt is missing')
  const records = await new ProjectDirectionMemoryStore(projectDir).read()
  const record = records.find(item => item.id === task.memory!.id && item.version === task.memory!.version)
  if (!record || hashContent(record) !== task.memory.contentHash) throw new Error('cleanup memory receipt is stale or missing')
}

async function manifestsForRun(runDir: string): Promise<DirectionManifest[]> {
  const directory = resolve(runDir, '.autoresearch', 'directions')
  let names: string[]
  try { names = await readdir(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const manifests: DirectionManifest[] = []
  for (const name of names.filter(name => name.endsWith('.json'))) manifests.push(await loadDirectionManifest(runDir, name.slice(0, -5)))
  return manifests
}

async function safeManagedFile(root: string, relativePath: string): Promise<string> {
  let current = root
  for (const part of relativePath.split('/')) {
    current = resolve(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error(`target contains symlink: ${relativePath}`)
    const actual = await realpath(current)
    if (!contained(root, actual)) throw new Error(`target escapes run root: ${relativePath}`)
  }
  return current
}

function sharedByAnotherDirection(manifest: DirectionManifest, all: DirectionManifest[], artifact: ManagedArtifact): boolean {
  return all.some(other => other.id !== manifest.id && other.artifacts.some(candidate =>
    (candidate.relativePath === artifact.relativePath || candidate.hash === artifact.hash || (candidate.sourceId && candidate.sourceId === artifact.sourceId))))
}

/** Advance one durable cleanup task. Every deletion target is exact and hash checked. */
export async function executeCleanupTask(projectDir: string, task: CleanupTask): Promise<RetirementResult> {
  const release = await acquireExecutionLock(projectDir, task.id)
  try {
    // A second process may have loaded the task before waiting on the file lock.
    // Re-read the durable state so it observes completed/deleting progress.
    const fresh = await loadCleanupTask(projectDir, task.id)
    return await executeCleanupTaskLocked(projectDir, fresh ?? task)
  } finally { await release() }
}

async function executeCleanupTaskLocked(projectDir: string, task: CleanupTask): Promise<RetirementResult> {
  if (task.state === 'completed') return { task, deleted: [], blocked: [] }
  await flushLoggers()
  let current = task
  try { await assertCleanupScope(projectDir, current) }
  catch (error) {
    current = await saveCleanupTask(projectDir, { ...current, state: 'blocked', lastError: String(error) })
    return { task: current, deleted: [], blocked: [String(error)] }
  }
  try { await verifyMemory(projectDir, current) }
  catch (error) {
    current = await saveCleanupTask(projectDir, { ...current, state: 'blocked', lastError: String(error) })
    return { task: current, deleted: [], blocked: [String(error)] }
  }
  let manifest: DirectionManifest
  try {
    if (!current.manifestId || !current.manifestHash) throw new Error('direction manifest receipt is missing')
    manifest = await loadDirectionManifest(current.runDir, current.manifestId)
    if (manifest.contentHash !== current.manifestHash || manifest.directionId !== current.directionId) throw new Error('direction manifest receipt is stale')
  } catch (error) {
    current = await saveCleanupTask(projectDir, { ...current, state: 'blocked', lastError: String(error) })
    return { task: current, deleted: [], blocked: [String(error)] }
  }
  const protection = await inspectCleanupProtection(current)
  if (!protection.safe) {
    current = await saveCleanupTask(projectDir, { ...current, state: protection.reasons.some(reason => reason.startsWith('run_')) ? 'waiting_live' : 'blocked', lastError: protection.reasons.join('; ') })
    return { task: current, deleted: [], blocked: protection.reasons }
  }
  let all: DirectionManifest[]
  let root: string
  try {
    await assertCleanupPathContained(current.runDir, '.autoresearch', 'directions')
    all = await manifestsForRun(current.runDir)
    root = await realpath(current.runDir)
  } catch (error) {
    current = await saveCleanupTask(projectDir, { ...current, state: 'blocked', lastError: String(error) })
    return { task: current, deleted: [], blocked: [String(error)] }
  }
  if (current.targets.length === 0 &&
    (!manifest.boundaryCaptured || manifest.artifacts.some(artifact => artifact.ownership === 'direction' || artifact.ownership === 'unknown'))) {
    const error = 'empty cleanup target receipt is not proven complete'
    current = await saveCleanupTask(projectDir, { ...current, state: 'blocked', lastError: error })
    return { task: current, deleted: [], blocked: [error] }
  }
  const deleted: string[] = []
  try {
    current = await saveCleanupTask(projectDir, { ...current, state: 'deleting', lastError: undefined })
    const progress = await loadProgress(projectDir, current)
    await saveProgress(projectDir, progress)
    for (const artifact of current.targets) {
      if (progress.states[artifact.relativePath] === 'completed') continue
      const wasStarted = progress.states[artifact.relativePath] === 'started'
      progress.states[artifact.relativePath] = 'started'
      await saveProgress(projectDir, progress)
      validateManagedRelativePath(artifact.relativePath)
      const registered = manifest.artifacts.find(candidate => candidate.relativePath === artifact.relativePath && candidate.hash === artifact.hash && candidate.ownership === 'direction')
      if (!registered) throw new Error(`target is not the exact exclusive manifest entry: ${artifact.relativePath}`)
      if (sharedByAnotherDirection(manifest, all, artifact)) throw new Error(`target is shared by another direction: ${artifact.relativePath}`)
      try {
        const file = await safeManagedFile(root, artifact.relativePath)
        const stat = await lstat(file)
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`target is not a regular file: ${artifact.relativePath}`)
        const bytes = await readFile(file)
        if (hashBytes(bytes) !== artifact.hash) throw new Error(`target changed: ${artifact.relativePath}`)
        await unlink(file)
        if (artifact.sourceId) await writeSourceTombstone({ runDir: current.runDir, task: current, manifest, memory: { id: current.memory!.id, contentHash: current.memory!.contentHash }, artifact })
        progress.states[artifact.relativePath] = 'completed'
        await saveProgress(projectDir, progress)
        deleted.push(artifact.relativePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (wasStarted) {
            if (artifact.sourceId) await writeSourceTombstone({ runDir: current.runDir, task: current, manifest, memory: { id: current.memory!.id, contentHash: current.memory!.contentHash }, artifact })
            progress.states[artifact.relativePath] = 'completed'
            await saveProgress(projectDir, progress)
            deleted.push(artifact.relativePath)
            continue
          }
          throw error
        }
        throw error
      }
    }
    await flushLoggers()
    current = await saveCleanupTask(projectDir, { ...current, state: 'completed', lastError: undefined })
    return { task: current, deleted, blocked: [] }
  } catch (error) {
    current = await saveCleanupTask(projectDir, { ...current, state: 'blocked', lastError: String(error) })
    return { task: current, deleted, blocked: [String(error)] }
  }
}

export async function resumeCleanupTask(projectDir: string, taskId: string): Promise<RetirementResult | undefined> {
  const task = await loadCleanupTask(projectDir, taskId)
  return task ? executeCleanupTask(projectDir, task) : undefined
}
