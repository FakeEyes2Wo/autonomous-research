import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { DEFAULT_CONFIG, nativeConfigToConfig, runDoctor } from '../src/index.mjs'

const argv = process.argv.slice(2)
const valueAfter = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const configPath = valueAfter('--config')
const network = argv.includes('--network')
let config = DEFAULT_CONFIG
if (configPath) {
  config = parse(await readFile(configPath, 'utf8'))
  config = nativeConfigToConfig(config)
}
const report = await runDoctor(config, { network })
for (const check of report.checks) console.log(check.status.toUpperCase() + ' ' + check.id + ': ' + check.message)
process.exitCode = report.ok ? 0 : 1
