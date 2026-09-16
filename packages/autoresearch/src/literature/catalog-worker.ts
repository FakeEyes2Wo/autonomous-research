import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

import type { SqlStatement } from './contracts.js'

const CURRENT_SCHEMA_VERSION = 3

interface WorkerInput {
  root: string
  databasePath: string
}

interface WorkerRequest {
  requestId: number
  type: 'transact' | 'close'
  statements?: SqlStatement[]
}

function errorPayload(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
  return { name: 'Error', message: String(error) }
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function sourceObjectIsValid(root: string, value: unknown): number {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return 0
  try {
    const bytes = readFileSync(join(root, 'objects', value.slice(0, 2), value.slice(2)))
    return createHash('sha256').update(bytes).digest('hex') === value ? 1 : 0
  } catch {
    return 0
  }
}

function createGenerationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE index_generations (
      id TEXT PRIMARY KEY,
      manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64 AND manifest_hash = lower(manifest_hash)),
      corpus_hash TEXT NOT NULL CHECK (length(corpus_hash) = 64 AND corpus_hash = lower(corpus_hash)),
      config_hash TEXT NOT NULL CHECK (length(config_hash) = 64 AND config_hash = lower(config_hash)),
      status TEXT NOT NULL CHECK (status IN ('building','validated','active','retired','failed')),
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    CREATE TABLE index_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      active_generation_id TEXT REFERENCES index_generations(id)
    ) STRICT;
    INSERT INTO index_state(singleton,active_generation_id) VALUES(1,NULL);
    CREATE TABLE generation_pins (
      run_id TEXT NOT NULL,
      generation_id TEXT NOT NULL REFERENCES index_generations(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id,generation_id)
    ) STRICT;
  `)
}

async function migrate(database: DatabaseSync, input: WorkerInput): Promise<void> {
  database.exec('BEGIN IMMEDIATE')
  try {
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (![0, 1, 2, CURRENT_SCHEMA_VERSION].includes(version)) {
      const code = version > CURRENT_SCHEMA_VERSION ? 'SCHEMA_TOO_NEW' : 'SCHEMA_UNSUPPORTED'
      throw codedError(`catalog schema ${version} is not supported by schema ${CURRENT_SCHEMA_VERSION}`, code)
    }
    if (version === 1) await writeConsistentV1Backup(input.databasePath)
    if (version === 0) {
      database.exec(`
        CREATE TABLE works (
          id TEXT PRIMARY KEY,
          body TEXT NOT NULL CHECK (json_valid(body))
        ) STRICT;
        CREATE TABLE aliases (
          kind TEXT NOT NULL,
          value TEXT NOT NULL,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          PRIMARY KEY (kind, value)
        ) STRICT;
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          raw_hash TEXT NOT NULL CHECK (length(raw_hash) = 64 AND raw_hash = lower(raw_hash)),
          body TEXT NOT NULL CHECK (json_valid(body))
        ) STRICT;
        CREATE TABLE spans (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          body TEXT NOT NULL CHECK (json_valid(body))
        ) STRICT;
        CREATE TABLE cards (
          id TEXT NOT NULL,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          body TEXT NOT NULL CHECK (json_valid(body)),
          PRIMARY KEY (id, revision)
        ) STRICT;
        CREATE TABLE imports (
          input_hash TEXT PRIMARY KEY,
          body TEXT NOT NULL CHECK (json_valid(body))
        ) STRICT;
        CREATE TABLE source_events (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          body TEXT NOT NULL CHECK (json_valid(body))
        ) STRICT;
        CREATE TABLE parse_reports (
          document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
          body TEXT NOT NULL CHECK (json_valid(body))
        ) STRICT;
        CREATE TRIGGER documents_require_source_object_insert
          BEFORE INSERT ON documents
          WHEN source_object_valid(NEW.raw_hash) = 0
        BEGIN
          SELECT RAISE(ABORT, 'SOURCE_OBJECT_MISSING_OR_CORRUPT');
        END;
        CREATE TRIGGER documents_require_source_object_update
          BEFORE UPDATE OF raw_hash ON documents
          WHEN source_object_valid(NEW.raw_hash) = 0
        BEGIN
          SELECT RAISE(ABORT, 'SOURCE_OBJECT_MISSING_OR_CORRUPT');
        END;
      `)
      createGenerationSchema(database)
      database.exec('PRAGMA user_version = 2')
    } else if (version === 1) {
      createGenerationSchema(database)
      database.exec('PRAGMA user_version = 2')
    }
    if (version < 3) {
      database.exec(`
        CREATE TABLE retrieval_receipts (
          id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES index_generations(id),
          body TEXT NOT NULL CHECK(json_valid(body)), body_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE exposures (
          id TEXT PRIMARY KEY, previous_id TEXT UNIQUE REFERENCES exposures(id),
          retrieval_receipt_id TEXT NOT NULL REFERENCES retrieval_receipts(id),
          body TEXT NOT NULL CHECK(json_valid(body)), body_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE acquisition_receipts (
          id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id),
          body TEXT NOT NULL CHECK(json_valid(body)), body_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE metadata_receipts (
          id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)), body_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE search_receipts (
          id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)), body_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE ingestion_records (
          document_id TEXT PRIMARY KEY REFERENCES documents(id),
          document_hash TEXT NOT NULL, parse_report_hash TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 3;
      `)
    }
    database.exec('CREATE VIRTUAL TABLE temp.catalog_fts5_probe USING fts5(body); DROP TABLE temp.catalog_fts5_probe;')
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the migration failure.
    }
    throw error
  }
}

async function writeConsistentV1Backup(databasePath: string): Promise<void> {
  const backupPath = `${databasePath}.v1.backup`
  const temporary = `${backupPath}.${process.pid}.${randomUUID()}.tmp`
  const source = new DatabaseSync(databasePath, { readOnly: true })
  try {
    await backup(source, temporary)
  } finally {
    source.close()
  }
  try {
    const candidate = new DatabaseSync(temporary, { readOnly: true })
    try {
      const version = Number(candidate.prepare('PRAGMA user_version').get()?.user_version ?? -1)
      const check = candidate.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined
      if (version !== 1 || check?.integrity_check !== 'ok') {
        throw codedError('v1 catalog backup failed validation', 'CATALOG_BACKUP_INVALID')
      }
    } finally {
      candidate.close()
    }
    await rename(temporary, backupPath)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function openDatabase(input: WorkerInput): Promise<DatabaseSync> {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(input.databasePath, { timeout: 1000 })
    database.function('source_object_valid', value => sourceObjectIsValid(input.root, value))
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;')
    await migrate(database, input)
    return database
  } catch (error) {
    database?.close()
    const code = (error as { code?: unknown }).code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || /not a database|malformed|disk image/i.test(message)) {
      throw codedError(`catalog is corrupt: ${message}`, 'CATALOG_CORRUPT')
    }
    throw error
  }
}

const TRANSACTION_CONTROL_KEYWORDS = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
])

function leadingSqlKeyword(sql: string): string {
  let remaining = sql
  while (true) {
    remaining = remaining.replace(/^[\s\uFEFF;]+/u, '')
    if (remaining.startsWith('--')) {
      const lineEnd = remaining.search(/[\r\n]/u)
      if (lineEnd < 0) return ''
      remaining = remaining.slice(lineEnd + 1)
      continue
    }
    if (remaining.startsWith('/*')) {
      const commentEnd = remaining.indexOf('*/', 2)
      if (commentEnd < 0) return ''
      remaining = remaining.slice(commentEnd + 2)
      continue
    }
    return /^[A-Za-z]+/u.exec(remaining)?.[0]?.toUpperCase() ?? ''
  }
}

function validateStatements(statements: SqlStatement[]): void {
  if (!Array.isArray(statements)) throw new TypeError('statements must be an array')
  statements.forEach((statement, index) => {
    if (typeof statement?.sql !== 'string' || statement.sql.trim() === '') {
      throw new TypeError(`statements[${index}].sql must be a non-empty string`)
    }
    if (!Array.isArray(statement.params)) throw new TypeError(`statements[${index}].params must be an array`)
    const keyword = leadingSqlKeyword(statement.sql)
    if (TRANSACTION_CONTROL_KEYWORDS.has(keyword)) {
      throw codedError(
        `transaction-control SQL is not allowed in statements[${index}]: ${keyword}`,
        'TRANSACTION_CONTROL_FORBIDDEN',
      )
    }
  })
}

function transact(database: DatabaseSync, statements: SqlStatement[]): Record<string, unknown>[][] {
  validateStatements(statements)
  database.exec('BEGIN IMMEDIATE')
  try {
    const results = statements.map(statement => {
      return database.prepare(statement.sql).all(...statement.params) as Record<string, unknown>[]
    })
    database.exec('COMMIT')
    return results
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the statement failure.
    }
    throw error
  }
}

const port = parentPort
if (port === null) throw new Error('catalog worker requires a parent port')

let database: DatabaseSync
try {
  database = await openDatabase(workerData as WorkerInput)
  port.postMessage({ type: 'ready' })
} catch (error) {
  port.postMessage({ type: 'ready', error: errorPayload(error) })
  port.close()
  throw error
}

port.on('message', (request: WorkerRequest) => {
  try {
    if (request.type === 'close') {
      database.close()
      port.postMessage({ type: 'response', requestId: request.requestId, result: null })
      port.close()
      return
    }
    const result = transact(database, request.statements ?? [])
    port.postMessage({ type: 'response', requestId: request.requestId, result })
  } catch (error) {
    port.postMessage({ type: 'response', requestId: request.requestId, error: errorPayload(error) })
  }
})
