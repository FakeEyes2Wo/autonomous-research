import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

appendFileSync(process.env.EXECUTION_COUNTER, `${process.pid}\n`)
if (process.env.SPAWN_DESCENDANT === '1') {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}
if (process.env.LOG_BYTES) process.stdout.write('x'.repeat(Number(process.env.LOG_BYTES)))
setTimeout(() => {
  mkdirSync(process.env.AUTORESEARCH_ARTIFACT_DIR, { recursive: true })
  writeFileSync(join(process.env.AUTORESEARCH_ARTIFACT_DIR, 'result.txt'), 'x'.repeat(Number(process.env.ARTIFACT_BYTES ?? 6)))
  process.exit(0)
}, Number(process.env.JOB_DELAY ?? 300))
