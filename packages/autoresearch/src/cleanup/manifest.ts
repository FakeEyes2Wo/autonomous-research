import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { atomicWriteJson, readJson, readOptionalText, safeResolve } from '../core/utils.js'
import { hashBytes, hashContent } from '../research/records.js'
import { directionId, validateDirectionRef, validateManagedArtifact, validateManagedRelativePath, type DirectionManifest, type DirectionRef, type ManagedArtifact } from './direction-id.js'

const locks = new Map<string, Promise<void>>()
const manifestPath = (runDir: string, id: string) => safeResolve(runDir, '.autoresearch', 'directions', `${id}.json`)
const contained = (root: string, target: string) => target === root || target.startsWith(root + sep)

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolvePromise => { release = resolvePromise })
  const queued = previous.then(() => current)
  locks.set(key, queued)
  await previous
  try { return await fn() } finally { release(); if (locks.get(key) === queued) locks.delete(key) }
}

function sealManifest(body: Omit<DirectionManifest, 'contentHash'>): DirectionManifest {
  return { ...body, contentHash: hashContent(body) }
}

function validateManifest(manifest: DirectionManifest): void {
  validateDirectionRef(manifest.direction)
  if (manifest.directionId !== directionId(manifest.direction) || manifest.id !== manifest.directionId || resolve(manifest.runDir) !== manifest.runDir || !Array.isArray(manifest.artifacts)) throw new Error('invalid direction manifest')
  for (const artifact of manifest.artifacts) validateManagedArtifact(artifact)
  const body = { ...manifest } as Partial<DirectionManifest>
  delete body.contentHash
  if (manifest.contentHash !== hashContent(body)) throw new Error('direction manifest hash mismatch')
}

export function directionManifestPath(runDir: string, id: string): string { return manifestPath(runDir, id) }

export async function openDirectionManifest(runDir: string, direction: DirectionRef, createdAt = new Date().toISOString()): Promise<DirectionManifest> {
  validateDirectionRef(direction)
  const id = directionId(direction), file = manifestPath(runDir, id)
  return withLock(file, async () => {
    const saved = await readOptionalText(file)
    if (saved !== undefined) {
      const existing = JSON.parse(saved) as DirectionManifest
      validateManifest(existing)
      if (existing.directionId !== id || existing.runDir !== resolve(runDir)) throw new Error('direction manifest identity conflict')
      return existing
    }
    const body: Omit<DirectionManifest, 'contentHash'> = { schema: 'autoresearch/direction-manifest/v1', id, directionId: id, direction, runDir: resolve(runDir), artifacts: [], createdAt, updatedAt: createdAt, boundaryCaptured: false }
    const manifest = sealManifest(body)
    await atomicWriteJson(file, manifest)
    return manifest
  })
}

export async function loadDirectionManifest(runDir: string, id: string): Promise<DirectionManifest> {
  const manifest = await readJson<DirectionManifest>(manifestPath(runDir, id))
  validateManifest(manifest)
  return manifest
}

export async function registerManagedArtifact(runDir: string, manifestId: string, input: { relativePath: string; sourceId?: string; kind: string; producer: string; ownership?: ManagedArtifact['ownership'] }): Promise<ManagedArtifact> {
  validateManagedRelativePath(input.relativePath)
  const file = safeResolve(runDir, input.relativePath)
  const root = await realpath(runDir), stat = await lstat(file), actual = await realpath(file)
  if (!stat.isFile() || stat.isSymbolicLink() || !contained(root, actual)) throw new Error(`managed artifact escapes run root: ${input.relativePath}`)
  const bytes = await readFile(file), artifact: ManagedArtifact = { relativePath: input.relativePath, ...(input.sourceId ? { sourceId: input.sourceId } : {}), hash: hashBytes(bytes), bytes: bytes.length, kind: input.kind, producer: input.producer, ownership: input.ownership ?? 'direction' }
  validateManagedArtifact(artifact)
  const target = manifestPath(runDir, manifestId)
  return withLock(target, async () => {
    const manifest = await loadDirectionManifest(runDir, manifestId)
    const { listCleanupTasks, isCleanupTaskRetired } = await import('./queue.js')
    let retired: Awaited<ReturnType<typeof listCleanupTasks>>[number] | undefined
    for (const task of await listCleanupTasks(manifest.direction.projectId)) {
      if (task.runDir === manifest.runDir && task.directionId === manifest.directionId && await isCleanupTaskRetired(manifest.direction.projectId, task)) {
        retired = task
        break
      }
    }
    if (retired) throw new Error(`direction manifest is retired: ${manifest.directionId}`)
    const existing = manifest.artifacts.find(item => item.relativePath === artifact.relativePath)
    if (existing && hashContent(existing) !== hashContent(artifact)) throw new Error(`direction artifact ownership conflict: ${artifact.relativePath}`)
    if (existing) return existing
    const artifacts = existing ? manifest.artifacts : [...manifest.artifacts, artifact]
    const next = sealManifest({ schema: manifest.schema, id: manifest.id, directionId: manifest.directionId, direction: manifest.direction, runDir: manifest.runDir, artifacts, createdAt: manifest.createdAt, updatedAt: new Date().toISOString(), boundaryCaptured: manifest.boundaryCaptured })
    await atomicWriteJson(target, next)
    return artifact
  })
}

export async function markDirectionBoundaryCaptured(runDir: string, manifestId: string): Promise<DirectionManifest> {
  const target = manifestPath(runDir, manifestId)
  return withLock(target, async () => {
    const manifest = await loadDirectionManifest(runDir, manifestId)
    if (manifest.boundaryCaptured) return manifest
    const next = sealManifest({ schema: manifest.schema, id: manifest.id, directionId: manifest.directionId, direction: manifest.direction, runDir: manifest.runDir, artifacts: manifest.artifacts, createdAt: manifest.createdAt, updatedAt: new Date().toISOString(), boundaryCaptured: true })
    await atomicWriteJson(target, next)
    return next
  })
}
