import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { contextHash } from '../research-context/seal.js'
import type { CapabilityRecord, CapabilityRecordInput, CapabilityStatus } from './types.js'

interface CapabilityRegistryFile {
  readonly schema: 'autoresearch/capability-registry/v1'
  readonly records: readonly CapabilityRecord[]
}

const capabilityLocks = new Map<string, Promise<void>>()

async function withCapabilityLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = capabilityLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  capabilityLocks.set(path, queued)
  await previous
  try { return await fn() } finally { release(); if (capabilityLocks.get(path) === queued) capabilityLocks.delete(path) }
}

export interface CapabilityRegistryOptions {
  readonly maxRecords?: number
  readonly now?: () => Date
}

function deriveStatus(input: CapabilityRecordInput, now: Date): CapabilityStatus {
  if (!input.configFingerprint) return 'discovered'
  if (!input.probe) return 'configured'
  const checkedAt = Date.parse(input.probe.checkedAt)
  const expiresAt = Date.parse(input.probe.expiresAt)
  if (!Number.isFinite(checkedAt) || !Number.isFinite(expiresAt) || expiresAt <= checkedAt) throw new Error(`invalid probe timestamps for ${input.capabilityId}`)
  if (input.probe.outcome === 'failed') return input.probe.failureStatus ?? 'degraded'
  if (input.probe.outcome === 'unknown' || now.getTime() >= expiresAt) return 'probed'
  return 'available'
}

function seal(input: CapabilityRecordInput, now: Date): CapabilityRecord {
  if (!input.capabilityId || input.capabilityId.includes('\u0000')) throw new Error('capability id is required')
  if (!input.purpose || !input.version || !input.discoveredAt) throw new Error(`capability identity is incomplete for ${input.capabilityId}`)
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) throw new Error(`invalid capability concurrency for ${input.capabilityId}`)
  if (input.quota.limit !== 'unknown' && (!Number.isFinite(input.quota.limit) || input.quota.limit < 0)) throw new Error(`invalid capability quota for ${input.capabilityId}`)
  const status = deriveStatus(input, now)
  return { ...input, status, contentHash: contextHash({ ...input, status }) }
}

export class FileCapabilityRegistry {
  readonly path: string
  private readonly maxRecords: number
  private readonly now: () => Date

  constructor(runDir: string, options: CapabilityRegistryOptions = {}) {
    this.path = join(runDir, '.autoresearch', 'capabilities.json')
    this.maxRecords = Math.max(1, Math.min(1_024, Math.floor(options.maxRecords ?? 128)))
    this.now = options.now ?? (() => new Date())
  }

  async readAll(): Promise<CapabilityRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as CapabilityRegistryFile
      if (parsed.schema !== 'autoresearch/capability-registry/v1' || !Array.isArray(parsed.records)) throw new Error('invalid capability registry')
      return parsed.records.map((record) => {
        const { status, contentHash, ...input } = record
        if (contentHash !== contextHash({ ...input, status })) throw new Error(`capability registry hash mismatch for ${record.capabilityId}`)
        return seal(input, this.now())
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      if (error instanceof SyntaxError) throw new Error('invalid capability registry')
      throw error
    }
  }

  async put(input: CapabilityRecordInput): Promise<CapabilityRecord> {
    return withCapabilityLock(this.path, async () => {
      const next = seal(input, this.now())
      const records = await this.readAll()
      const index = records.findIndex((record) => record.capabilityId === next.capabilityId)
      if (index >= 0) records[index] = next
      else records.push(next)
      records.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))
      if (records.length > this.maxRecords) throw new Error(`capability registry limit ${this.maxRecords} exceeded`)
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ schema: 'autoresearch/capability-registry/v1', records }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
        await rename(temporary, this.path)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      return next
    })
  }
}
