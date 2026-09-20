import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { safeResolve } from '../core/utils.js'

const DEFAULT_THRESHOLD = 10 * 1024
const DEFAULT_EXCERPT = 2048
const OBSERVATION_DIR = join('.autoresearch', 'observation-packs')
const HANDLE_PATTERN = /^\.autoresearch\/observation-packs\/[a-f0-9]{64}\.txt$/
const archiveLocks = new Map<string, Promise<void>>()

export interface ObservationPackOptions {
  runDir: string
  enabled?: boolean
  thresholdBytes?: number
  excerptBytes?: number
  archiveDirectory?: string
  taskId?: string
  direction?: string
}

export type PackedObservation =
  | { kind: 'inline'; text: string; byteLength: number }
  | { kind: 'handle'; handle: string; excerpt: string; byteLength: number; contentHash: string; owner: { taskId?: string; direction?: string } }

export interface ObservationPage { offset?: number; limitBytes?: number }
export interface ObservationPageResult { handle: string; text: string; offset: number; nextOffset: number; bytes: number; totalBytes: number; contentHash: string }
export interface ObservationMetadata { contentHash: string; byteLength: number; owners: Array<{ taskId?: string; direction?: string }>; exitStatus?: number | string | null }

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function utf8End(bytes: Buffer, offset: number, requested: number): number {
  let end = Math.min(bytes.length, offset + requested)
  while (end > offset && !isBoundary(bytes, end)) end -= 1
  if (end === offset && offset < bytes.length) {
    const first = bytes[offset] ?? 0
    const width = first < 0x80 ? 1 : first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : 2
    end = Math.min(bytes.length, offset + width)
  }
  return end
}
function isBoundary(bytes: Buffer, offset: number): boolean { return offset === 0 || offset === bytes.length || (((bytes[offset] ?? 0) & 0xc0) !== 0x80) }
function archiveRoot(runDir: string, archiveDirectory?: string): string { return safeResolve(runDir, archiveDirectory ?? OBSERVATION_DIR) }
function handleTarget(runDir: string, handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) throw new TypeError('invalid observation handle')
  return safeResolve(runDir, ...handle.split('/'))
}
async function ensureInside(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root)
  const realTarget = await realpath(target)
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) throw new TypeError('observation path escapes run dir')
}
async function ensureExistingAncestorInside(root: string, target: string): Promise<void> {
  let current = target
  while (true) {
    try { await ensureInside(root, current); return } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}
function validNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
  return value as number
}
function validPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RangeError(`${name} must be a positive safe integer`)
  return value as number
}
function validateOwner(owner: { taskId?: string; direction?: string }): void {
  for (const name of Object.keys(owner)) if (name !== 'taskId' && name !== 'direction') throw new TypeError(`observation owner field ${name} is invalid`)
  for (const [name, value] of Object.entries(owner)) if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`observation owner ${name} is invalid`)
}
function validateMetadata(value: unknown): ObservationMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('observation metadata is malformed')
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!['schema', 'contentHash', 'byteLength', 'owners', 'exitStatus'].includes(key)) throw new Error(`unknown observation metadata field: ${key}`)
  if (raw.schema !== 'autoresearch/observation-pack/v1' || typeof raw.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.contentHash) || !Number.isSafeInteger(raw.byteLength) || (raw.byteLength as number) < 0 || !Array.isArray(raw.owners)) throw new Error('observation metadata is malformed')
  const owners = raw.owners.map((owner) => {
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) throw new Error('observation metadata owner is malformed')
    const normalized = owner as { taskId?: string; direction?: string }
    validateOwner(normalized)
    return normalized
  })
  const exitStatus = raw.exitStatus
  if (exitStatus !== null && exitStatus !== undefined && (typeof exitStatus === 'string' ? !exitStatus || /[\u0000-\u001f\u007f]/u.test(exitStatus) : (!Number.isSafeInteger(exitStatus) || (exitStatus as number) < 0))) throw new Error('observation metadata exitStatus is malformed')
  return { contentHash: raw.contentHash, byteLength: raw.byteLength as number, owners, ...(exitStatus !== undefined ? { exitStatus: exitStatus as number | string | null } : {}) }
}
async function acquireArchiveFileLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + 15_000
  while (true) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(`${process.pid}\n`)
      await handle.close()
      return async () => { await unlink(lockPath).catch(() => undefined) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 60_000) await unlink(lockPath)
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ENOENT') throw probeError
      }
      if (Date.now() >= deadline) throw new Error('observation archive lock timeout')
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15 + Math.floor(Math.random() * 20)))
    }
  }
}
async function atomicWriteMetadata(path: string, metadata: ObservationMetadata): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ schema: 'autoresearch/observation-pack/v1', ...metadata }) + '\n', { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function packObservation(text: string, options: ObservationPackOptions): Promise<PackedObservation> {
  // SoL-Pi §2.5 describes stable handles for large observations; this adapter
  // archives locally and retains an exact UTF-8 source for deterministic reads.
  const bytes = Buffer.from(text, 'utf8')
  const threshold = options.thresholdBytes === undefined ? DEFAULT_THRESHOLD : validNonNegativeInteger(options.thresholdBytes, 'thresholdBytes')
  const excerptBytes = options.excerptBytes === undefined ? DEFAULT_EXCERPT : validPositiveInteger(options.excerptBytes, 'excerptBytes')
  const owner = { ...(options.taskId !== undefined ? { taskId: options.taskId } : {}), ...(options.direction !== undefined ? { direction: options.direction } : {}) }
  validateOwner(owner)
  if (!options.enabled || bytes.byteLength <= threshold) return { kind: 'inline', text, byteLength: bytes.byteLength }
  const archiveDirectory = archiveRoot(options.runDir, options.archiveDirectory)
  if (archiveDirectory !== safeResolve(options.runDir, OBSERVATION_DIR)) return { kind: 'inline', text, byteLength: bytes.byteLength }
  const contentHash = hash(bytes)
  const filename = `${contentHash}.txt`
  const target = safeResolve(archiveDirectory, filename)
  const previous = archiveLocks.get(target) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolveLock) => { release = resolveLock })
  const queued = previous.then(() => current)
  archiveLocks.set(target, queued)
  await previous
  let releaseFile: (() => Promise<void>) | undefined
  try {
    await ensureExistingAncestorInside(resolve(options.runDir), dirname(target))
    await mkdir(dirname(target), { recursive: true })
    releaseFile = await acquireArchiveFileLock(target)
    const metadata = `${target}.json`
    let targetExists = false
    try {
      const existingTarget = await lstat(target)
      if (!existingTarget.isFile() || existingTarget.isSymbolicLink()) throw new Error('observation archive target is not a regular file')
      await ensureInside(resolve(options.runDir), target)
      const existingBytes = await readFile(target)
      if (hash(existingBytes) !== contentHash || existingBytes.byteLength !== bytes.byteLength) throw new Error('observation archive target integrity mismatch')
      targetExists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let existingMetadata: ObservationMetadata | undefined
    try {
      const existingMetadataFile = await lstat(metadata)
      if (!existingMetadataFile.isFile() || existingMetadataFile.isSymbolicLink()) throw new Error('observation metadata is not a regular file')
      await ensureInside(resolve(options.runDir), metadata)
      existingMetadata = validateMetadata(JSON.parse(await readFile(metadata, 'utf8')))
      if (existingMetadata.contentHash !== contentHash || existingMetadata.byteLength !== bytes.byteLength) throw new Error('observation metadata integrity mismatch')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existingMetadata && !targetExists) throw new Error('observation metadata has no archive target')
    if (!targetExists) {
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, bytes, { flag: 'wx' })
        await rename(temporary, target)
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
      await ensureInside(resolve(options.runDir), target)
    }
    const owners = existingMetadata ? [...existingMetadata.owners, owner] : [owner]
    const uniqueOwners = owners.filter((entry, index, all) => all.findIndex((candidate) => candidate.taskId === entry.taskId && candidate.direction === entry.direction) === index)
    await atomicWriteMetadata(metadata, { contentHash, byteLength: bytes.byteLength, owners: uniqueOwners, exitStatus: null })
    const handle = relative(options.runDir, target).replaceAll('\\', '/')
    return { kind: 'handle', handle, excerpt: bytes.subarray(0, utf8End(bytes, 0, excerptBytes)).toString('utf8'), byteLength: bytes.byteLength, contentHash, owner }
  } catch {
    return { kind: 'inline', text, byteLength: bytes.byteLength }
  } finally {
    await releaseFile?.()
    release()
    if (archiveLocks.get(target) === queued) archiveLocks.delete(target)
  }
}

export async function readObservationMetadata(handle: string, options: { runDir: string }): Promise<ObservationMetadata> {
  const target = handleTarget(options.runDir, handle)
  await ensureInside(resolve(options.runDir), target)
  await ensureInside(resolve(options.runDir), `${target}.json`).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  return validateMetadata(JSON.parse(await readFile(`${target}.json`, 'utf8')))
}

export async function readObservation(handle: string, options: { runDir: string } & ObservationPage): Promise<ObservationPageResult> {
  const target = handleTarget(options.runDir, handle)
  await ensureInside(resolve(options.runDir), target)
  const bytes = await readFile(target)
  const contentHash = hash(bytes)
  const expectedHash = handle.slice(handle.lastIndexOf('/') + 1, -4)
  if (contentHash !== expectedHash) throw new Error('observation handle hash mismatch')
  const metadata = await readObservationMetadata(handle, options)
  if (metadata.contentHash !== contentHash || metadata.byteLength !== bytes.byteLength) throw new Error('observation archive integrity mismatch')
  const offset = options.offset ?? 0
  const limit = options.limitBytes === undefined ? DEFAULT_EXCERPT : validPositiveInteger(options.limitBytes, 'limitBytes')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || !isBoundary(bytes, offset)) throw new RangeError('observation offset must be a UTF-8 boundary')
  const end = utf8End(bytes, offset, limit)
  return { handle, text: bytes.subarray(offset, end).toString('utf8'), offset, nextOffset: end, bytes: end - offset, totalBytes: bytes.length, contentHash }
}
