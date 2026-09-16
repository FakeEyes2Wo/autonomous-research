import { createHash } from 'node:crypto'
import type { ContextRecord, ContextRecordInput } from './types.js'

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) output[key] = normalized(child)
    }
    return output
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('context records require finite numbers')
  return value
}

export function canonicalContextJson(value: unknown): string {
  const json = JSON.stringify(normalized(value))
  if (json === undefined) throw new Error('context values must be JSON serializable')
  return json
}

export function contextHash(value: unknown): string {
  return createHash('sha256').update(canonicalContextJson(value), 'utf8').digest('hex')
}

function assertRecordInput(input: ContextRecordInput): void {
  if (!input.id || input.id.includes('\u0000')) throw new Error('context record id is required')
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error(`invalid context record version for ${input.id}`)
  if (!input.source.recordType) throw new Error(`context record source type is required for ${input.id}`)
  if (!input.scope.projectId) throw new Error(`context record project scope is required for ${input.id}`)
  if (input.scope.visibility !== 'project' && !input.scope.branchId) throw new Error(`context record branch scope is required for ${input.id}`)
  if (input.scope.visibility === 'run' && !input.scope.runId) throw new Error(`context record run scope is required for ${input.id}`)
  if (input.scope.visibility === 'split' && !input.scope.split) throw new Error(`context record split scope is required for ${input.id}`)
}

export function sealContextRecord(input: ContextRecordInput): ContextRecord {
  assertRecordInput(input)
  const clone = normalized(input) as ContextRecordInput
  return { ...clone, contentHash: contextHash(clone) }
}

export function verifyContextRecord(record: ContextRecord): void {
  const { contentHash, ...input } = record
  const expected = sealContextRecord(input).contentHash
  if (contentHash !== expected) throw new Error(`context record hash mismatch for ${record.id}@${record.version}`)
}
