import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { validateLocalBudget } from './budget.js'
import { terminal, type JobRecord, type JobReceipt, type JobSpec, type RuntimeLimits } from './contracts.js'

const port = parentPort!
const db = new DatabaseSync(join(workerData.root, 'jobs.sqlite'))
db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;')
function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const value = fn(); db.exec('COMMIT'); return value } catch (error) { db.exec('ROLLBACK'); throw error }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
function get(jobId: string): JobRecord {
  const row = db.prepare('SELECT body FROM jobs WHERE id=?').get(jobId)
  if (!row) throw new Error(`unknown job ${jobId}`)
  return JSON.parse(String(row.body))
}
function save(job: JobRecord): JobRecord {
  db.prepare('UPDATE jobs SET status=?,body=? WHERE id=?').run(job.receipt.status, JSON.stringify(job), job.spec.id)
  db.prepare('UPDATE leases SET fence=?,owner=?,expires_at=? WHERE job_id=?').run(job.fence, job.owner, job.leaseUntil, job.spec.id)
  return job
}
function fenced(jobId: string, fence: number): JobRecord {
  const job = get(jobId)
  if (job.fence !== fence) throw new Error('stale fence')
  return job
}
function accept(job: JobRecord, receipt: JobReceipt, now: number): JobRecord {
  if (receipt.jobId !== job.spec.id || receipt.inputHash !== job.spec.inputHash || receipt.protocolHash !== job.spec.protocolHash) throw new Error('receipt identity/hash conflict')
  if (job.receipt.backendId && receipt.backendId !== job.receipt.backendId) throw new Error('receipt backend identity conflict')
  if (!['submitting', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'unknown'].includes(receipt.status)) throw new Error('invalid receipt transition to queued/unsupported status')
  if (terminal(job.receipt.status)) return job
  if (job.receipt.status === 'cancel_requested' && ['running', 'submitting', 'queued'].includes(receipt.status)) return job
  job.receipt = receipt
  db.prepare('INSERT OR IGNORE INTO receipts(job_id,digest,body) VALUES(?,?,?)').run(job.spec.id, createHash('sha256').update(canonical(receipt)).digest('hex'), JSON.stringify(receipt))
  if (terminal(receipt.status)) {
    db.prepare('INSERT OR IGNORE INTO usage(job_id,wall_ms,cpu_seconds,gpu_seconds,cost_micros) VALUES(?,?,NULL,NULL,NULL)').run(job.spec.id, job.startedAt === null ? 0 : Math.max(0, now - job.startedAt))
    db.prepare('DELETE FROM reservations WHERE job_id=?').run(job.spec.id)
    db.prepare('UPDATE attempts SET status=? WHERE job_id=?').run(receipt.status, job.spec.id)
    db.prepare('UPDATE outbox SET state=? WHERE job_id=?').run('finished', job.spec.id)
  }
  return save(job)
}
function budget() {
  const reserved = db.prepare('SELECT coalesce(sum(wall_ms),0) AS wall,count(*) AS count FROM reservations').get()!
  const used = db.prepare('SELECT coalesce(sum(wall_ms),0) AS wall FROM usage').get()!
  return { reservedWallMs: Number(reserved.wall), activeJobs: Number(reserved.count), settledWallMs: Number(used.wall), cpuSeconds: null, gpuSeconds: null, costMicros: null }
}

try {
  transaction(() => {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > 1) throw new Error('job schema is newer than supported version')
    db.exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,spec_hash TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL REFERENCES jobs(id),status TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS leases(job_id TEXT PRIMARY KEY REFERENCES jobs(id),fence INTEGER NOT NULL,owner TEXT,expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS reservations(job_id TEXT PRIMARY KEY REFERENCES jobs(id),wall_ms INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS usage(job_id TEXT PRIMARY KEY REFERENCES jobs(id),wall_ms INTEGER NOT NULL,cpu_seconds REAL,gpu_seconds REAL,cost_micros INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS receipts(job_id TEXT NOT NULL REFERENCES jobs(id),digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(job_id,digest)) STRICT;
      CREATE TABLE IF NOT EXISTS outbox(submission_key TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL REFERENCES jobs(id),state TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS request_links(request_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id)) STRICT;
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL) STRICT;
      PRAGMA user_version=1;`)
    const limits: RuntimeLimits = { maxReservedWallMs: Number.MAX_SAFE_INTEGER, maxConcurrentJobs: 1, ...workerData.limits }
    if (!Number.isSafeInteger(limits.maxReservedWallMs) || limits.maxReservedWallMs < 1 || !Number.isSafeInteger(limits.maxConcurrentJobs) || limits.maxConcurrentJobs < 1) throw new Error('invalid runtime limits')
    db.prepare('INSERT OR IGNORE INTO settings(id,body) VALUES(1,?)').run(JSON.stringify(limits))
    if (workerData.limits) {
      const stored = JSON.parse(String(db.prepare('SELECT body FROM settings WHERE id=1').get()!.body))
      for (const [key, value] of Object.entries(workerData.limits)) if (stored[key] !== value) throw new Error('runtime limits conflict with persisted limits')
    }
  })
  port.postMessage({ type: 'ready' })
} catch (error) { port.postMessage({ type: 'ready', error: String(error) }); db.close(); port.close() }

function dispatch(action: string, data: any): unknown {
  if (action === 'get') return get(data.jobId)
  if (action === 'list') return db.prepare('SELECT body FROM jobs ORDER BY id').all().map(row => JSON.parse(String(row.body)))
  if (action === 'budget') return budget()
  if (action === 'enqueue') {
    const spec: JobSpec = data.spec
    for (const key of ['id', 'attemptId', 'taskId', 'inputHash', 'protocolHash', 'executable', 'cwd'] as const) if (typeof spec[key] !== 'string' || !spec[key]) throw new Error(`invalid job ${key}`)
    if (!Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string')) throw new Error('invalid job args')
    if (!spec.env || Object.values(spec.env).some(value => typeof value !== 'string')) throw new Error('invalid job env')
    validateLocalBudget(spec.budget)
    const hash = createHash('sha256').update(canonical(spec)).digest('hex')
    const old = db.prepare('SELECT spec_hash FROM jobs WHERE id=?').get(spec.id)
    if (old) { if (old.spec_hash !== hash) throw new Error('job spec conflict'); return get(spec.id) }
    const job: JobRecord = { spec, specHash: hash, receipt: { jobId: spec.id, backendId: '', status: 'queued', inputHash: spec.inputHash, protocolHash: spec.protocolHash, heartbeatAt: null, progressAt: null, exitCode: null, artifactManifestHash: null }, fence: 0, owner: null, leaseUntil: 0, startedAt: null, deadlineAt: null, identity: null, executionClaimed: false, cancellationReason: null, requestIds: [], logs: [] }
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(spec.id, hash, 'queued', JSON.stringify(job))
    db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(spec.attemptId, spec.id, 'queued')
    db.prepare('INSERT INTO leases VALUES(?,0,NULL,0)').run(spec.id)
    return job
  }
  if (action === 'claim') {
    const job = get(data.jobId)
    if (job.owner !== null && job.owner !== data.owner && job.leaseUntil > data.now) throw new Error('job lease busy')
    job.fence++; job.owner = data.owner; job.leaseUntil = data.now + data.leaseMs
    return save(job)
  }
  if (action === 'linkRequest') {
    const job = get(data.jobId)
    const linked = db.prepare('SELECT job_id FROM request_links WHERE request_id=?').get(data.requestId)
    if (linked && linked.job_id !== data.jobId) throw new Error('request ID already linked to another job')
    db.prepare('INSERT OR IGNORE INTO request_links VALUES(?,?)').run(data.requestId, data.jobId)
    if (!job.requestIds.includes(data.requestId)) job.requestIds.push(data.requestId)
    save(job); return
  }
  if (action === 'claimExecution' || action === 'supervisorUpdate') {
    const job = get(data.jobId)
    if (!job.identity || job.identity.nonce !== data.nonce) throw new Error('supervisor identity mismatch')
    if (action === 'claimExecution') {
      if (job.executionClaimed || terminal(job.receipt.status)) return false
      job.executionClaimed = true; job.identity.pid = data.pid; save(job); return true
    }
    if (data.logs) job.logs = data.logs
    if (data.reason) job.cancellationReason = data.reason
    return data.receipt ? accept(job, data.receipt, data.now) : save(job)
  }
  const job = fenced(data.jobId, data.fence)
  if (action === 'release') { job.owner = null; job.leaseUntil = 0; save(job); return }
  if (action === 'beginSubmission') {
    if (job.receipt.status !== 'queued') return job
    const limits: RuntimeLimits = JSON.parse(String(db.prepare('SELECT body FROM settings WHERE id=1').get()!.body))
    const current = budget()
    if (current.activeJobs >= limits.maxConcurrentJobs || current.reservedWallMs + current.settledWallMs + job.spec.budget.wallMs > limits.maxReservedWallMs) throw new Error('runtime budget/capacity exhausted')
    db.prepare('INSERT INTO reservations VALUES(?,?)').run(job.spec.id, job.spec.budget.wallMs)
    db.prepare('INSERT INTO outbox VALUES(?,?,?)').run(job.spec.id, job.spec.id, 'submitting')
    job.startedAt = data.now; job.deadlineAt = data.now + job.spec.budget.wallMs; job.receipt.status = 'submitting'
    db.prepare('UPDATE attempts SET status=? WHERE job_id=?').run('submitting', job.spec.id)
    return save(job)
  }
  if (action === 'prepareSpawn') {
    if (job.identity !== null || job.receipt.status !== 'submitting') return false
    job.identity = data.identity; job.receipt.backendId = data.identity.startupId
    save(job); return true
  }
  if (action === 'markUnknown') {
    if (terminal(job.receipt.status)) return job
    job.receipt.status = 'unknown'; job.cancellationReason ??= data.reason
    return save(job)
  }
  if (action === 'requestCancel') {
    if (terminal(job.receipt.status)) return job
    job.cancellationReason = data.reason
    if (job.receipt.status === 'queued') return accept(job, { ...job.receipt, status: 'cancelled' }, Date.now())
    job.receipt.status = 'cancel_requested'; return save(job)
  }
  if (action === 'acceptReceipt') return accept(job, data.receipt, data.now)
  throw new Error(`unsupported job store operation ${action}`)
}
port.on('message', ({ id, action, data }) => {
  try {
    if (action === 'close') { db.close(); port.postMessage({ id, result: null }); port.close(); return }
    const result = transaction(() => dispatch(action, data))
    port.postMessage({ id, result })
  } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
})
