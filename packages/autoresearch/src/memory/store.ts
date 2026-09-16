import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { contextHash, sealContextRecord } from '../research-context/seal.js'
import { contextScopeMatches } from '../research-context/select.js'
import type { ContextRecord } from '../research-context/types.js'
import type { MemoryQuery, MemoryRecord, MemoryRecordInput, MemoryStatus, MemoryTransitionAssessment } from './types.js'

const memoryLocks = new Map<string, Promise<void>>()

class MemoryConflictError extends Error {
  readonly code = 'MEMORY_CONFLICT'
  constructor(message: string) { super(message); this.name = 'MemoryConflictError' }
}

function normalizeMemory(input: MemoryRecordInput): MemoryRecord {
  const { contentHash: _ignored, ...clean } = input as MemoryRecordInput & { readonly contentHash?: string }
  if (!clean.id || clean.id.includes('\u0000')) throw new Error('memory id is required')
  if (!Number.isSafeInteger(clean.version) || clean.version < 1) throw new Error(`invalid memory version for ${clean.id}`)
  if (!clean.provenance.createdAt || clean.provenance.sourceIds.length === 0) throw new Error(`memory provenance is required for ${clean.id}`)
  if (!clean.assessment.method) throw new Error(`memory assessment method is required for ${clean.id}`)
  if (clean.assessment.status === 'validated_in_scope' && clean.assessment.supportingSourceIds.length === 0) throw new Error(`validated memory requires supporting sources for ${clean.id}`)
  if (clean.kind === 'observation' && !clean.content.observation) throw new Error(`observation content is required for ${clean.id}`)
  if (clean.kind === 'interpretation' && (!clean.content.observation || !clean.content.interpretation)) throw new Error(`interpretation requires separated observation and interpretation for ${clean.id}`)
  if (clean.kind === 'procedure' && !clean.content.procedure) throw new Error(`procedure artifact and acceptance are required for ${clean.id}`)
  if (clean.kind === 'decision' && (!clean.content.decision || !clean.content.rationale)) throw new Error(`decision and rationale are required for ${clean.id}`)
  return { ...clean, contentHash: contextHash(clean) }
}

function latestRecords(records: readonly MemoryRecord[]): MemoryRecord[] {
  const latest = new Map<string, MemoryRecord>()
  for (const record of records) {
    const current = latest.get(record.id)
    if (!current || current.version < record.version) latest.set(record.id, record)
  }
  return [...latest.values()].sort((left, right) => left.id.localeCompare(right.id))
}

async function withMemoryLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = memoryLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  memoryLocks.set(path, queued)
  await previous
  try { return await fn() } finally { release(); if (memoryLocks.get(path) === queued) memoryLocks.delete(path) }
}

export class FileMemoryStore {
  readonly path: string

  constructor(runDir: string) {
    this.path = join(runDir, 'research', 'memory.jsonl')
  }

  async readAll(): Promise<MemoryRecord[]> {
    try {
      const text = await readFile(this.path, 'utf8')
      return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try {
          const parsed = JSON.parse(line) as MemoryRecord
          const sealed = normalizeMemory(parsed)
          if (parsed.contentHash !== sealed.contentHash) throw new Error(`memory hash mismatch for ${parsed.id}@${parsed.version}`)
          return parsed
        } catch (error) {
          if (error instanceof SyntaxError) throw new Error(`invalid memory JSONL at line ${index + 1}`)
          throw error
        }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async writeAll(records: readonly MemoryRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  private appendTo(records: MemoryRecord[], input: MemoryRecordInput): { record: MemoryRecord; appended: boolean } {
    const sealed = normalizeMemory(input)
    const sameVersion = records.find((record) => record.id === sealed.id && record.version === sealed.version)
    if (sameVersion) {
      if (sameVersion.contentHash === sealed.contentHash) return { record: sameVersion, appended: false }
      throw new MemoryConflictError(`memory replay changed ${sealed.id}@${sealed.version}`)
    }
    const latest = records.filter((record) => record.id === sealed.id).sort((left, right) => right.version - left.version)[0]
    if (latest && sealed.version !== latest.version + 1) throw new MemoryConflictError(`memory version is not sequential for ${sealed.id}@${sealed.version}`)
    records.push(sealed)
    return { record: sealed, appended: true }
  }

  async append(input: MemoryRecordInput): Promise<{ record: MemoryRecord; appended: boolean }> {
    return withMemoryLock(this.path, async () => {
      const records = await this.readAll()
      const result = this.appendTo(records, input)
      if (result.appended) await this.writeAll(records)
      return result
    })
  }

  async transition(id: string, status: MemoryStatus, assessment: MemoryTransitionAssessment): Promise<MemoryRecord> {
    return withMemoryLock(this.path, async () => {
      const records = await this.readAll()
      const current = latestRecords(records).find((record) => record.id === id)
      if (!current) throw new Error(`memory ${id} does not exist`)
      const supportingSourceIds = assessment.supportingSourceIds ?? current.assessment.supportingSourceIds
      const opposingSourceIds = assessment.opposingSourceIds ?? current.assessment.opposingSourceIds
      if (current.assessment.status === status
        && current.assessment.method === assessment.method
        && JSON.stringify(current.assessment.supportingSourceIds) === JSON.stringify(supportingSourceIds)
        && JSON.stringify(current.assessment.opposingSourceIds) === JSON.stringify(opposingSourceIds)) return current
      const createdAt = new Date().toISOString()
      const next = this.appendTo(records, {
        ...current,
        version: current.version + 1,
        provenance: { ...current.provenance, createdAt, derivedFromIds: [...(current.provenance.derivedFromIds ?? []), `${current.id}@${current.version}`] },
        assessment: {
          status,
          method: assessment.method,
          supportingSourceIds,
          opposingSourceIds,
        },
      }).record
      if (status === 'disputed' || status === 'invalidated') {
        const invalidated = [current]
        const processed = new Set<string>()
        while (invalidated.length) {
          const source = invalidated.shift()!
          const dependents = latestRecords(records).filter((record) => record.summary
            && record.assessment.status !== 'invalidated'
            && !processed.has(record.id)
            && record.dependencies.some((dependency) => dependency.id === source.id && dependency.version === source.version && dependency.contentHash === source.contentHash))
          for (const dependent of dependents) {
            processed.add(dependent.id)
            this.appendTo(records, {
              ...dependent,
              version: dependent.version + 1,
              provenance: { ...dependent.provenance, createdAt, derivedFromIds: [...(dependent.provenance.derivedFromIds ?? []), `${dependent.id}@${dependent.version}`] },
              assessment: {
                ...dependent.assessment,
                status: 'invalidated',
                method: `${dependent.assessment.method}; dependency ${source.id}@${source.version} ${status}`,
              },
            })
            invalidated.push(dependent)
          }
        }
      }
      await this.writeAll(records)
      return next
    })
  }

  async query(query: MemoryQuery): Promise<MemoryRecord[]> {
    const statuses = new Set(query.statuses ?? ['candidate', 'validated_in_scope', 'disputed'])
    const topics = new Set(query.topicIds ?? [])
    return latestRecords(await this.readAll()).filter((record) => {
      if (!contextScopeMatches(record, query.scope)) return false
      if (record.accessRoles?.length && !record.accessRoles.includes(query.role)) return false
      if (!statuses.has(record.assessment.status)) return false
      if (topics.size && !record.topicIds.some((topic) => topics.has(topic))) return false
      return true
    })
  }
}

function sealMemoryContextRecord(record: MemoryRecord, dependencies: readonly { id: string; version: number; contentHash: string }[]): ContextRecord {
  return sealContextRecord({
    id: `memory:${record.id}`,
    version: record.version,
    layer: record.kind === 'observation' ? 2 : 3,
    kind: record.summary ? 'summary' : 'memory',
    scope: record.scope,
    payload: {
      memoryId: record.id,
      memoryContentHash: record.contentHash,
      kind: record.kind,
      content: record.content,
      provenance: record.provenance,
      applicability: record.applicability,
      assessment: record.assessment,
    },
    accessRoles: record.accessRoles,
    topicIds: record.topicIds,
    polarity: record.polarity,
    conflictIds: record.conflictIds,
    unresolvedConflict: record.unresolvedConflict,
    dependencies,
    lifecycle: record.assessment.status,
    source: { recordType: `Memory:${record.kind}`, path: 'research/memory.jsonl' },
  })
}

/** Convert a dependency graph together so dependency hashes refer to the sealed context envelopes. */
export function memoryRecordsToContextRecords(records: readonly MemoryRecord[]): ContextRecord[] {
  const rawByIdentity = new Map(records.map((record) => [`${record.id}@${record.version}:${record.contentHash}`, record]))
  const converted = new Map<string, ContextRecord>()
  const visiting = new Set<string>()
  const convert = (record: MemoryRecord): ContextRecord => {
    const key = `${record.id}@${record.version}:${record.contentHash}`
    const existing = converted.get(key)
    if (existing) return existing
    if (visiting.has(key)) throw new Error(`memory dependency cycle at ${record.id}@${record.version}`)
    visiting.add(key)
    const dependencies = record.dependencies.map((dependency) => {
      const rawId = dependency.id.startsWith('memory:') ? dependency.id.slice('memory:'.length) : dependency.id
      const raw = rawByIdentity.get(`${rawId}@${dependency.version}:${dependency.contentHash}`)
      if (!raw) return { ...dependency, id: `memory:${rawId}` }
      const sealed = convert(raw)
      return { id: sealed.id, version: sealed.version, contentHash: sealed.contentHash }
    })
    const sealed = sealMemoryContextRecord(record, dependencies)
    visiting.delete(key)
    converted.set(key, sealed)
    return sealed
  }
  return records.map(convert)
}

export function memoryToContextRecord(record: MemoryRecord, records?: readonly MemoryRecord[]): ContextRecord {
  if (!records && record.dependencies.length) {
    throw new Error(`memory dependency graph is required to convert ${record.id}@${record.version}`)
  }
  const conversionSet = records ?? [record]
  const index = conversionSet.indexOf(record)
  if (index < 0) throw new Error(`memory conversion set does not contain ${record.id}@${record.version}`)
  return memoryRecordsToContextRecords(conversionSet)[index]!
}
