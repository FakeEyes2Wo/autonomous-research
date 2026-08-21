import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = 'C:/Users/80163/Desktop/挑战杯_2026/Athena/athena_ts/node_modules/typescript/lib/tsc.js'
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
