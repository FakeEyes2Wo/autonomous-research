import { hashContent } from '../research/records.js'
import type { VersionRef } from '../research/contracts.js'

export interface DirectionRef {
  projectId: string
  branchId: string
  claim: VersionRef
  hypothesis: VersionRef
  protocolHash?: string
}

export type RetirementDisposition = 'refuted' | 'abandoned'
export type CleanupTaskState = 'pending' | 'memory_saved' | 'waiting_live' | 'deleting' | 'completed' | 'blocked'

export interface ManagedArtifact {
  relativePath: string
  sourceId?: string
  hash: string
  bytes: number
  kind: string
  producer: string
  ownership: 'direction' | 'shared' | 'user' | 'unknown'
}

export interface DirectionManifest {
  schema: 'autoresearch/direction-manifest/v1'
  id: string
  directionId: string
  direction: DirectionRef
  runDir: string
  artifacts: ManagedArtifact[]
  createdAt: string
  updatedAt: string
  boundaryCaptured?: boolean
  contentHash: string
}

export interface CleanupTask {
  schema: 'autoresearch/cleanup-task/v1'
  id: string
  direction: DirectionRef
  directionId: string
  disposition: RetirementDisposition
  state: CleanupTaskState
  idea: string
  reason: string
  avoidRepeat: string
  mechanismKey?: string
  changedAssumption?: string
  runDir: string
  targets: ManagedArtifact[]
  /** Absent while the durable task is pending its first memory write. */
  memory?: { id: string; version: number; contentHash: string }
  manifestId?: string
  manifestHash?: string
  authorizationHash?: string
  lastError?: string
  attempts?: number
  createdAt: string
  updatedAt: string
  contentHash?: string
}

export interface TombstoneRecord {
  schema: 'autoresearch/source-tombstone/v1'
  taskId: string
  directionId: string
  manifestId: string
  manifestHash: string
  memoryId: string
  memoryContentHash: string
  taskContentHash: string
  sourceId: string
  relativePath: string
  hash: string
  deletedAt: string
  contentHash: string
}

const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function validateManagedRelativePath(path: string): void {
  if (!identity(path) || path.includes('\\') || path.includes('\u0000') || path.includes(':') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`invalid managed relative path: ${path}`)
  }
}

export function validateDirectionRef(direction: DirectionRef): void {
  if (!identity(direction.projectId) || !identity(direction.branchId) || !identity(direction.claim?.id) || !identity(direction.hypothesis?.id) ||
    !Number.isSafeInteger(direction.claim?.version) || direction.claim.version < 1 || !Number.isSafeInteger(direction.hypothesis?.version) || direction.hypothesis.version < 1 ||
    (direction.protocolHash !== undefined && !identity(direction.protocolHash))) throw new Error('invalid direction reference')
}

/** Stable lineage identity. Every hypothesis version and protocol change is a distinct direction. */
export function directionId(direction: DirectionRef): string {
  validateDirectionRef(direction)
  // Claim versions advance when evidence is assessed. The hypothesis version
  // and frozen protocol identify the executable direction; claim id preserves
  // its lineage without making a post-assessment version a new direction.
  return `direction-${hashContent({ projectId: direction.projectId, branchId: direction.branchId, claimId: direction.claim.id, hypothesis: direction.hypothesis, protocolHash: direction.protocolHash ?? null }).slice(0, 32)}`
}

export function validateManagedArtifact(artifact: ManagedArtifact): void {
  validateManagedRelativePath(artifact.relativePath)
  if ((artifact.sourceId !== undefined && !identity(artifact.sourceId)) || !/^[a-f0-9]{64}$/u.test(artifact.hash) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || !identity(artifact.kind) || !identity(artifact.producer) ||
    !['direction', 'shared', 'user', 'unknown'].includes(artifact.ownership)) throw new Error(`invalid managed artifact: ${artifact.relativePath}`)
}

export function validateCleanupTask(task: CleanupTask): void {
  validateDirectionRef(task.direction)
  if (task.directionId !== directionId(task.direction) || !/^cleanup-[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/u.test(task.id) ||
    !['refuted', 'abandoned'].includes(task.disposition) || !['pending', 'memory_saved', 'waiting_live', 'deleting', 'completed', 'blocked'].includes(task.state) ||
    !identity(task.idea) || !identity(task.reason) || !identity(task.avoidRepeat) || !identity(task.runDir) ||
    (task.state !== 'pending' && (!task.memory?.id || !Number.isSafeInteger(task.memory.version) || task.memory.version < 1 || !identity(task.memory.contentHash)))) throw new Error('invalid cleanup task')
  const seen = new Set<string>()
  for (const artifact of task.targets) {
    validateManagedArtifact(artifact)
    if (seen.has(artifact.relativePath)) throw new Error(`duplicate cleanup target: ${artifact.relativePath}`)
    seen.add(artifact.relativePath)
  }
}

/** Stable authorization receipt; excludes mutable state, attempts, and timestamps. */
export function cleanupAuthorizationHash(task: CleanupTask): string {
  if (!task.memory) throw new Error('cleanup authorization requires memory')
  return hashContent({ id: task.id, directionId: task.directionId, disposition: task.disposition, runDir: task.runDir,
    manifestId: task.manifestId ?? null, manifestHash: task.manifestHash ?? null, memory: task.memory,
    targets: task.targets.map(target => ({ relativePath: target.relativePath, sourceId: target.sourceId ?? null, hash: target.hash, bytes: target.bytes, ownership: target.ownership })) })
}
