import { runDoctor } from '../src/index.mjs'
import { has, loadConfig, valueAfter } from './cli.mjs'

const configPath = valueAfter('--config')
const network = has('--network')
const config = await loadConfig(configPath)
const report = await runDoctor(config, { network })
for (const check of report.checks) console.log(check.status.toUpperCase() + ' ' + check.id + ': ' + check.message)
process.exitCode = report.ok ? 0 : 1
