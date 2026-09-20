import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, mkdir, rename, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

export const STATE_FILE = 'state.json'
export const EVENTS_FILE = 'events.jsonl'
export const RESEARCH_TREE_FILE = 'research_tree.json'
export const HYPOTHESIS_POOL_FILE = 'hypothesis_pool.json'
export const EVIDENCE_CHAIN_FILE = 'evidence_chain.json'
export const RUBRIC_FILE = 'RUBRIC.md'
export const PLAN_PREFIX = 'PLAN-v'
export const DECISION_FILE = 'DECISION.md'
export const FAILURE_REPORT_FILE = 'FAILURE_REPORT.md'
export const WORK_DIR = 'work'
export const INPUT_DIR = 'input'
export const IDEA_FILE = 'idea.md'
export const PROFILE_FILE = 'PROFILE.md'
export const DEFAULT_MAX_CYCLES = 5
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn'

export const ERROR_KINDS = ['INVALID_ARGUMENT', 'NOT_FOUND', 'STATE_CORRUPT', 'AGENT_FAILED', 'LEAKAGE', 'UNKNOWN'] as const
export type ErrorKind = typeof ERROR_KINDS[number]

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

/**
 * Read a text file, treating only a missing file as an optional result.
 * Any other I/O error is intentionally propagated.
 */
export async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await readText(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function safeResolve(runDir: string, ...parts: string[]): string {
  const root = resolve(runDir)
  const target = resolve(root, ...parts)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new AutoResearchError(`path escapes run dir: ${target}`, 'INVALID_ARGUMENT')
  }
  return target
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = typeof LOG_LEVELS[number]

export class Logger {
  private static readonly active = new Set<Promise<void>>()
  private readonly file?: string

  constructor(runDir?: string) {
    if (runDir) this.file = join(runDir, 'logs', 'run.log')
  }

  private async write(level: LogLevel, message: string): Promise<void> {
    const line = `[${nowIso()}] [${level.toUpperCase()}] ${message}`
    console.log(line)
    if (!this.file) return
    try {
      await ensureDir(dirname(this.file))
      await appendFile(this.file, `${line}\n`, 'utf8')
    } catch (error) {
      console.error(`[logger] failed to write log file: ${String(error)}`)
    }
  }

  private enqueue(level: LogLevel, message: string): void {
    const pending = this.write(level, message)
    Logger.active.add(pending)
    void pending.finally(() => Logger.active.delete(pending)).catch(() => undefined)
  }

  async flush(): Promise<void> {
    while (Logger.active.size) await Promise.allSettled([...Logger.active])
  }

  static async flushAll(): Promise<void> {
    while (Logger.active.size) await Promise.allSettled([...Logger.active])
  }

  debug(message: string): void { this.enqueue('debug', message) }

  info(message: string): void { this.enqueue('info', message) }

  warn(message: string): void { this.enqueue('warn', message) }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    this.enqueue('error', `${message}${detail ? `\n${detail}` : ''}`)
  }
}

export async function flushLoggers(): Promise<void> {
  await Logger.flushAll()
}

export function createLogger(runDir?: string): Logger {
  return new Logger(runDir)
}

export async function withRetry<T>(operation: () => Promise<T>, label: string, attempts = 2): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed: ${String(lastError)}`)
}
