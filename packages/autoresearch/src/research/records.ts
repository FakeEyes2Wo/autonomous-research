import { createHash } from 'node:crypto'
import type { VersionedRecord } from './contracts.js'

export function hashBytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite research value')
  return value
}

export function hashContent(value: unknown): string {
  return hashBytes(JSON.stringify(canonical(value)))
}

export function freezeRecord<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRecord(child)
    Object.freeze(value)
  }
  return value
}

export function sealRecord<T extends Omit<VersionedRecord, 'content_hash'>>(value: T): T & { content_hash: string } {
  const copy = JSON.parse(JSON.stringify(value)) as T & { content_hash?: string }
  delete copy.content_hash
  return freezeRecord({ ...copy, content_hash: hashContent(copy) })
}

export function verifyRecord(value: VersionedRecord): void {
  if (!value || typeof value.id !== 'string' || !value.id || !Number.isInteger(value.version) || value.version < 1 || !Array.isArray(value.source_refs) || typeof value.created_at !== 'string') throw new Error('malformed research record')
  const { content_hash, ...body } = value
  if (!content_hash || hashContent(body) !== content_hash) throw new Error(`research content hash mismatch: ${value.id}`)
}
