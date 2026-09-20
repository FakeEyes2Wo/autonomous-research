import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * User-requested project extension informed by SoL-Pi: Recursively Scaling
 * Auto-Research Loops for Efficient Agent Harness, §§2.1–2.2
 * (https://arxiv.org/html/2609.20519v1#S2). The paper does not propose this
 * direction-memory or cleanup behavior.
 */
const SCHEMA = 'autoresearch/direction-memory/v1' as const
const MAX_ID = 80
const MAX_IDEA = 240
const MAX_REASON = 240
const MAX_AVOID = 240
const MAX_ASSUMPTION = 180
const memoryLocks = new Map<string, Promise<void>>()

export type DirectionMemoryReasonCode = 'confirmed_error' | 'explicit_abandonment'

export interface DirectionMemoryInput {
  readonly idea: string
  readonly eliminationReason: string
  readonly avoid: string
  readonly reasonCode: DirectionMemoryReasonCode
  readonly mechanismKey?: string
  readonly changedAssumption?: string
}

export interface DirectionMemoryRecord extends DirectionMemoryInput {
  readonly id: string
  readonly version: number
  readonly createdAt: string
  readonly ideaKey: string
}

interface DirectionMemoryDocument {
  readonly schema: typeof SCHEMA
  readonly projectId: string
  readonly records: readonly DirectionMemoryRecord[]
}

export interface DirectionMemoryQuery {
  readonly idea?: string
  readonly mechanismKey?: string
}

export interface DirectionMemorySelectionHints {
  readonly avoidedMechanismKeys: string[]
  readonly directionMemoryIds: string[]
  readonly directionMemoryMatches: Record<string, string[]>
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function compactText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`direction memory ${name} must be a string`)
  const text = normalize(value)
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`direction memory ${name} must be compact`)
  // A direction memory is deliberately a deny-list summary, never a report or
  // a recipe. Reject structured payload markers so callers cannot slice worker
  // data into this project-level record accidentally. Ordinary research terms
  // such as “loss” remain valid in a compact idea.
  if (/(?:\bfull (?:worker )?report\b|\braw (?:output|response)\b|\bworker (?:code|report)\b|https?:\/\/|(?:file|git|ssh):\/\/|```|(?:^|\s)[[{]\s*["']?[A-Za-z_$][\w$-]*["']?\s*:|\b(?:const|let|var|function|class|import|export|def|return)\s+[A-Za-z_$]|\b(?:console\.log|print)\s*\(|=>)/iu.test(text) ||
    /(?:^|\s)(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]|~[\\/]|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)(?:\s|$)/u.test(text)) {
    throw new Error(`direction memory ${name} contains forbidden experimental detail`)
  }
  if ((name === 'eliminationReason' || name === 'avoid') && /(?:\b(?:n|trial|fold|round|run)\b\s*[=:]?\s*\d+|[-+]?\d+(?:\.\d+)?%)/iu.test(text)) {
    throw new Error(`direction memory ${name} contains quantitative detail`)
  }
  return text
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`)
}

function recordId(input: DirectionMemoryInput, ideaKey: string): string {
  return `direction-${digest(JSON.stringify({ ideaKey, mechanismKey: input.mechanismKey ?? null })).slice(0, 32)}`
}

function normalizeInput(value: DirectionMemoryInput): Omit<DirectionMemoryRecord, 'id' | 'version' | 'createdAt'> {
  const raw = value as unknown as Record<string, unknown>
  assertKeys(raw, ['idea', 'eliminationReason', 'avoid', 'reasonCode', 'mechanismKey', 'changedAssumption'], 'input')
  const idea = compactText(value.idea, 'idea', MAX_IDEA)
  const eliminationReason = compactText(value.eliminationReason, 'eliminationReason', MAX_REASON)
  const avoid = compactText(value.avoid, 'avoid', MAX_AVOID)
  if (value.reasonCode !== 'confirmed_error' && value.reasonCode !== 'explicit_abandonment') throw new Error('direction memory reasonCode is invalid')
  let mechanismKey: string | undefined
  if (value.mechanismKey !== undefined) {
    if (typeof value.mechanismKey !== 'string' || !/^[a-f0-9]{64}$/u.test(value.mechanismKey)) throw new Error('direction memory mechanismKey is invalid')
    mechanismKey = value.mechanismKey
  }
  const changedAssumption = value.changedAssumption === undefined ? undefined : compactText(value.changedAssumption, 'changedAssumption', MAX_ASSUMPTION)
  const ideaKey = digest(idea.toLowerCase())
  return { idea, ideaKey, eliminationReason, avoid, reasonCode: value.reasonCode, ...(mechanismKey ? { mechanismKey } : {}), ...(changedAssumption ? { changedAssumption } : {}) }
}

function normalizeRecord(value: unknown): DirectionMemoryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('direction memory record is malformed')
  const raw = value as Record<string, unknown>
  assertKeys(raw, ['id', 'version', 'createdAt', 'ideaKey', 'idea', 'eliminationReason', 'avoid', 'reasonCode', 'mechanismKey', 'changedAssumption'], 'record')
  if (typeof raw.id !== 'string' || raw.id.length > MAX_ID || !/^direction-[a-f0-9]{32}$/u.test(raw.id)) throw new Error('direction memory id is malformed')
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) throw new Error(`direction memory version is malformed for ${raw.id}`)
  if (typeof raw.createdAt !== 'string' || !raw.createdAt) throw new Error(`direction memory createdAt is malformed for ${raw.id}`)
  const input = normalizeInput({
    idea: raw.idea as string,
    eliminationReason: raw.eliminationReason as string,
    avoid: raw.avoid as string,
    reasonCode: raw.reasonCode as DirectionMemoryReasonCode,
    ...(raw.mechanismKey === undefined ? {} : { mechanismKey: raw.mechanismKey as string }),
    ...(raw.changedAssumption === undefined ? {} : { changedAssumption: raw.changedAssumption as string }),
  })
  if (raw.ideaKey !== input.ideaKey || raw.id !== recordId(input, input.ideaKey)) throw new Error(`direction memory identity mismatch for ${raw.id}`)
  return { ...input, id: raw.id, version: raw.version as number, createdAt: raw.createdAt as string }
}

function latestRecords(records: readonly DirectionMemoryRecord[]): DirectionMemoryRecord[] {
  const latest = new Map<string, DirectionMemoryRecord>()
  for (const record of records) {
    const previous = latest.get(record.id)
    if (!previous || record.version > previous.version) latest.set(record.id, record)
  }
  return [...latest.values()].sort((left, right) => left.id.localeCompare(right.id))
}

async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`
  await assertStoragePath(dirname(dirname(path)), lockPath)
  await mkdir(dirname(lockPath), { recursive: true })
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
        const stale = Date.now() - (await stat(lockPath)).mtimeMs > 60_000
        if (stale) await unlink(lockPath)
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ENOENT') throw probeError
      }
      if (Date.now() >= deadline) throw new Error('direction memory lock timeout')
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15 + Math.floor(Math.random() * 20)))
    }
  }
}

async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = memoryLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise })
  const queued = previous.then(() => current)
  memoryLocks.set(path, queued)
  await previous
  try {
    const releaseFile = await acquireFileLock(path)
    try { return await fn() } finally { await releaseFile() }
  } finally { release(); if (memoryLocks.get(path) === queued) memoryLocks.delete(path) }
}

function projectRoot(projectDir: string): string {
  try { return realpathSync(resolve(projectDir)) } catch (error) { throw new Error(`direction memory project path is unavailable: ${String(error)}`) }
}

async function assertStoragePath(root: string, target: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  let current = root
  const rel = relative(root, target)
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`direction memory storage contains symlink: ${current}`)
      const actual = await realpath(current)
      if (actual !== canonicalRoot && !actual.startsWith(canonicalRoot + sep)) throw new Error(`direction memory storage escapes project: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export class ProjectDirectionMemoryStore {
  readonly projectDir: string
  readonly projectId: string
  readonly path: string

  constructor(projectDir: string) {
    this.projectDir = projectRoot(projectDir)
    this.projectId = digest(this.projectDir)
    this.path = join(this.projectDir, '.autoresearch', 'direction-memory.json')
  }

  async read(): Promise<readonly DirectionMemoryRecord[]> {
    await assertStoragePath(this.projectDir, this.path)
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(this.path, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      if (error instanceof SyntaxError) throw new Error('invalid direction memory JSON')
      throw error
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('direction memory document is malformed')
    const document = parsed as Record<string, unknown>
    assertKeys(document, ['schema', 'projectId', 'records'], 'document')
    if (document.schema !== SCHEMA || document.projectId !== this.projectId || !Array.isArray(document.records)) throw new Error('direction memory document schema or project mismatch')
    const records = document.records.map(normalizeRecord)
    const identities = new Set<string>()
    for (const record of records) {
      const identity = `${record.id}:${record.version}`
      if (identities.has(identity)) throw new Error(`duplicate direction memory version: ${identity}`)
      identities.add(identity)
    }
    return records
  }

  async upsert(input: DirectionMemoryInput): Promise<DirectionMemoryRecord> {
    return withLock(this.path, async () => {
      const records = [...await this.read()]
      const normalized = normalizeInput(input)
      const id = recordId(normalized, normalized.ideaKey)
      const existing = records.filter((record) => record.id === id).sort((left, right) => right.version - left.version)[0]
      const next: DirectionMemoryRecord = {
        ...normalized,
        id,
        version: (existing?.version ?? 0) + 1,
        createdAt: new Date().toISOString(),
      }
      if (existing && existing.idea === next.idea && existing.eliminationReason === next.eliminationReason && existing.avoid === next.avoid && existing.reasonCode === next.reasonCode && existing.mechanismKey === next.mechanismKey && existing.changedAssumption === next.changedAssumption) return existing
      records.push(next)
      records.sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version)
      await mkdir(dirname(this.path), { recursive: true })
      await assertStoragePath(this.projectDir, this.path)
      const document: DirectionMemoryDocument = { schema: SCHEMA, projectId: this.projectId, records }
      const temporary = `${this.path}.${digest(`${Date.now()}-${Math.random()}`)}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
        await rename(temporary, this.path)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      return next
    })
  }

  async match(query: DirectionMemoryQuery): Promise<readonly DirectionMemoryRecord[]> {
    const ideaKey = query.idea === undefined ? undefined : digest(normalize(query.idea).toLowerCase())
    const mechanismKey = query.mechanismKey
    if (mechanismKey !== undefined && !/^[a-f0-9]{64}$/u.test(mechanismKey)) throw new Error('direction memory mechanismKey is invalid')
    return latestRecords(await this.read()).filter((record) => (ideaKey !== undefined && record.ideaKey === ideaKey) || (mechanismKey !== undefined && record.mechanismKey === mechanismKey))
  }
}

export function renderDirectionMemory(records: readonly DirectionMemoryRecord[]): string {
  if (!records.length) return ''
  return ['## Previously eliminated directions', ...latestRecords(records).slice(0, 12).map((record) => `- ${record.idea}: ${record.eliminationReason}. ${record.avoid}.`)].join('\n')
}

export async function selectionHintsForMechanisms(projectDir: string, mechanismKeys?: readonly string[]): Promise<DirectionMemorySelectionHints> {
  const keys = mechanismKeys === undefined ? undefined : new Set(mechanismKeys)
  const records = latestRecords(await new ProjectDirectionMemoryStore(projectDir).read()).filter((record) => record.mechanismKey && (keys === undefined || keys.has(record.mechanismKey)))
  const matches: Record<string, string[]> = {}
  for (const record of records) if (record.mechanismKey) (matches[record.mechanismKey] ??= []).push(record.id)
  for (const ids of Object.values(matches)) ids.sort()
  return {
    avoidedMechanismKeys: [...new Set(records.flatMap((record) => record.mechanismKey ? [record.mechanismKey] : []))].sort(),
    directionMemoryIds: records.map((record) => record.id).sort(),
    directionMemoryMatches: matches,
  }
}
