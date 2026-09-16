// Trusted bounded local workload; never calls a model or network service.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const log = event => appendFileSync(process.env.SOAK_EXECUTIONS, JSON.stringify({ ...event, jobId: process.env.SOAK_JOB_ID, pid: process.pid, at: new Date().toISOString() }) + '\n')
log({ type: 'execution' })
process.stdout.write('x'.repeat(Number(process.env.LOG_BYTES ?? 8192)))
setTimeout(() => {
  mkdirSync(process.env.AUTORESEARCH_ARTIFACT_DIR, { recursive: true })
  writeFileSync(join(process.env.AUTORESEARCH_ARTIFACT_DIR, 'result.json'), JSON.stringify({ jobId: process.env.SOAK_JOB_ID, completed: true }))
  log({ type: 'completion' })
}, Number(process.env.JOB_DELAY))
