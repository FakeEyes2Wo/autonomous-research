import { appendFile, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

await appendFile(process.env.EXECUTION_COUNTER, `${process.env.TASK_ID}:${process.pid}\n`)
await mkdir(process.env.AUTORESEARCH_ARTIFACT_DIR, { recursive: true })
await copyFile(process.env.RAW_FILE, join(process.env.AUTORESEARCH_ARTIFACT_DIR, 'result.json'))
