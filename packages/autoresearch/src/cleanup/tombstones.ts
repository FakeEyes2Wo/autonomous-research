import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { atomicWriteJson, readOptionalText, safeResolve } from '../core/utils.js'
import { hashContent } from '../research/records.js'
import { cleanupAuthorizationHash, directionId, validateManagedArtifact, validateManagedRelativePath, type CleanupTask, type DirectionManifest, type ManagedArtifact, type TombstoneRecord } from './direction-id.js'
import { assertCleanupPathContained } from './runtime.js'

const directory = (runDir: string) => safeResolve(runDir, '.autoresearch', 'cleanup', 'tombstones')
const fileFor = (runDir: string, artifact: Pick<ManagedArtifact, 'hash' | 'sourceId' | 'relativePath'>) => safeResolve(runDir, '.autoresearch', 'cleanup', 'tombstones', `${artifact.hash}-${hashContent({ sourceId: artifact.sourceId, relativePath: artifact.relativePath }).slice(0, 32)}.json`)
const legacyFileFor = (runDir: string, hash: string) => safeResolve(runDir, '.autoresearch', 'cleanup', 'tombstones', `${hash}.json`)

function seal(body: Omit<TombstoneRecord, 'contentHash'>): TombstoneRecord { return { ...body, contentHash: hashContent(body) } }

function validate(record: TombstoneRecord): void {
  if (record.schema !== 'autoresearch/source-tombstone/v1' || !record.taskId || !record.directionId || !record.manifestId || !record.manifestHash || !record.memoryId || !record.memoryContentHash || !record.taskContentHash || !record.sourceId || !/^[a-f0-9]{64}$/u.test(record.hash)) throw new Error('invalid source tombstone')
  validateManagedRelativePath(record.relativePath)
  const body = { ...record } as Partial<TombstoneRecord>
  delete body.contentHash
  if (record.contentHash !== hashContent(body)) throw new Error(`source tombstone hash mismatch: ${record.sourceId}`)
}

export async function writeSourceTombstone(input: { runDir: string; task: CleanupTask; manifest: DirectionManifest; memory: { id: string; contentHash: string }; artifact: ManagedArtifact }): Promise<TombstoneRecord> {
  const { task, manifest, artifact } = input
  validateManagedArtifact(artifact)
  if (task.state === 'pending' || !task.memory || task.directionId !== directionId(manifest.direction) || task.manifestId !== manifest.id || task.manifestHash !== manifest.contentHash || task.memory.id !== input.memory.id || task.memory.contentHash !== input.memory.contentHash || artifact.ownership !== 'direction' || !artifact.sourceId || !task.authorizationHash || cleanupAuthorizationHash(task) !== task.authorizationHash) throw new Error('source tombstone provenance mismatch')
  const record = seal({ schema: 'autoresearch/source-tombstone/v1', taskId: task.id, directionId: task.directionId, manifestId: manifest.id, manifestHash: manifest.contentHash, memoryId: input.memory.id, memoryContentHash: input.memory.contentHash, taskContentHash: task.authorizationHash, sourceId: artifact.sourceId, relativePath: artifact.relativePath, hash: artifact.hash, deletedAt: new Date().toISOString() })
  await assertCleanupPathContained(input.runDir, '.autoresearch', 'cleanup', 'tombstones')
  const target = safeResolve(input.runDir, ...artifact.relativePath.split('/'))
  await assertCleanupPathContained(input.runDir, ...artifact.relativePath.split('/'))
  try { await lstat(target); throw new Error(`source tombstone target still exists: ${artifact.relativePath}`) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const file = fileFor(input.runDir, artifact)
  const candidates = [file, legacyFileFor(input.runDir, artifact.hash)]
  for (const candidate of candidates) {
    await assertCleanupPathContained(input.runDir, '.autoresearch', 'cleanup', 'tombstones', basename(candidate))
    const saved = await readOptionalText(candidate)
    if (saved === undefined) continue
    const existing = JSON.parse(saved) as TombstoneRecord
    validate(existing)
    const sameIdentity = existing.taskId === record.taskId && existing.directionId === record.directionId && existing.manifestId === record.manifestId && existing.manifestHash === record.manifestHash && existing.memoryId === record.memoryId && existing.memoryContentHash === record.memoryContentHash && existing.taskContentHash === record.taskContentHash && existing.sourceId === record.sourceId && existing.relativePath === record.relativePath && existing.hash === record.hash
    if (!sameIdentity) {
      // Legacy hash-only files cannot represent aliases. Keep them for old
      // readers, while the composite key below records this exact source ref.
      if (candidate === legacyFileFor(input.runDir, artifact.hash)) continue
      throw new Error(`source tombstone conflict: ${artifact.sourceId}`)
    }
    return existing
  }
  await atomicWriteJson(file, record)
  return record
}

export async function loadSourceTombstones(runDir: string): Promise<TombstoneRecord[]> {
  await assertCleanupPathContained(runDir, '.autoresearch', 'cleanup', 'tombstones')
  let names: string[]
  const root = await directory(runDir)
  try { names = await readdir(root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const records: TombstoneRecord[] = []
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    await assertCleanupPathContained(runDir, '.autoresearch', 'cleanup', 'tombstones', name)
    const record = JSON.parse(await readFile(join(root, name), 'utf8')) as TombstoneRecord
    validate(record)
    records.push(record)
  }
  return records
}

export async function findSourceTombstone(runDir: string, source: { id: string; path: string; hash: string }): Promise<TombstoneRecord | undefined> {
  const records = await loadSourceTombstones(runDir)
  // SourceRef.id is a label supplied by the producer.  A single immutable
  // source blob may legitimately have several such labels in one snapshot.
  // The tombstone's task/manifest authorization and exact path+hash are the
  // durable identity; requiring the label here would make those aliases
  // unrecoverable after cleanup.
  const record = records.find(item => item.relativePath === source.path && item.hash === source.hash)
  if (!record) return undefined
  // A tombstone is admissible only when its durable task, exact direction
  // manifest, and compact project memory still exist. This prevents a hand
  // written marker from making deleted evidence authoritative again.
  const { loadCleanupTask } = await import('./queue.js')
  const { loadDirectionManifest } = await import('./manifest.js')
  const { ProjectDirectionMemoryStore } = await import('../memory/direction-memory.js')
  const task = await loadCleanupTask(record.directionId.startsWith('direction-') ? (await loadDirectionManifest(runDir, record.manifestId)).direction.projectId : runDir, record.taskId)
  if (!task || task.authorizationHash !== record.taskContentHash || !task.memory || task.memory.id !== record.memoryId || task.memory.contentHash !== record.memoryContentHash || task.state === 'pending' || cleanupAuthorizationHash(task) !== record.taskContentHash) throw new Error(`untrusted source tombstone: ${record.sourceId}`)
  const manifest = await loadDirectionManifest(runDir, record.manifestId)
  if (manifest.contentHash !== record.manifestHash || manifest.directionId !== record.directionId) throw new Error(`source tombstone manifest mismatch: ${record.sourceId}`)
  if (!manifest.artifacts.some(artifact => artifact.relativePath === source.path && artifact.hash === source.hash && artifact.ownership === 'direction')) throw new Error(`source tombstone artifact mismatch: ${source.id}`)
  const memory = await new ProjectDirectionMemoryStore(manifest.direction.projectId).read()
  const memoryRecord = memory.find(item => item.id === record.memoryId && item.version === task.memory!.version && hashContent(item) === record.memoryContentHash)
  if (!memoryRecord) throw new Error(`source tombstone memory missing: ${record.sourceId}`)
  return record
}
