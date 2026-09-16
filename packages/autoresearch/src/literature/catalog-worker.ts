import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

import type { SqlStatement } from './contracts.js'

const CURRENT_SCHEMA_VERSION = 1

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

function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > CURRENT_SCHEMA_VERSION) {
      throw codedError(
        `catalog schema ${version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
        'SCHEMA_TOO_NEW',
      )
    }
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
        PRAGMA user_version = 1;
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

function openDatabase(input: WorkerInput): DatabaseSync {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(input.databasePath, { timeout: 1000 })
    database.function('source_object_valid', value => sourceObjectIsValid(input.root, value))
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;')
    migrate(database)
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
  database = openDatabase(workerData as WorkerInput)
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
