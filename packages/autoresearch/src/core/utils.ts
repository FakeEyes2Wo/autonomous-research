import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile, readFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export type ErrorKind = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'STATE_CORRUPT' | 'AGENT_FAILED' | 'LEAKAGE' | 'UNKNOWN'

export class AutoResearchError extends Error {
  readonly kind: ErrorKind
  constructor(message: string, kind: ErrorKind = 'UNKNOWN') {
    super(message)
    this.name = 'AutoResearchError'
    this.kind = kind
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`
}

export function newRunId(): string {
  return `ar_${randomUUID().slice(0, 8)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await ensureDir(dirname(file))
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

export async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    throw new AutoResearchError(`cannot read ${file}: ${String(error)}`, 'STATE_CORRUPT')
  }
}

export async function writeText(file: string, content: string): Promise<void> {
  await ensureDir(dirname(file))
  await writeFile(file, content, 'utf8')
}

export async function readText(file: string): Promise<string> {
  return readFile(file, 'utf8')
}

export function safeResolve(runDir: string, ...parts: string[]): string {
  const root = resolve(runDir)
  const target = resolve(root, ...parts)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new AutoResearchError(`path escapes run dir: ${target}`, 'INVALID_ARGUMENT')
  }
  return target
}
