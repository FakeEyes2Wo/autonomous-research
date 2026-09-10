import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { DEFAULT_CONFIG, install, nativeConfigToConfig, uninstall } from '../src/index.mjs'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const valueAfter = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const dshHome = valueAfter('--dsh-home')
const settingsPath = valueAfter('--settings')
const configPath = valueAfter('--config')
const isUninstall = has('--uninstall')
const dryRun = !has('--apply')

async function loadConfig() {
  if (!configPath) return DEFAULT_CONFIG
  let config = parse(await readFile(configPath, 'utf8'))
  return nativeConfigToConfig(config)
}

const plan = isUninstall
  ? await uninstall({ dshHome, settingsPath, dryRun })
  : await install({ config: await loadConfig(), dshHome, settingsPath, dryRun })
console.log((dryRun ? 'DRY-RUN ' : 'APPLIED ') + plan.operation + ': ' + plan.settingsPath)
for (const change of plan.changes) console.log('  ' + change.action + ' ' + change.id)
for (const error of plan.errors) console.error('  CONFLICT ' + error.id + ': ' + error.message)
if (!plan.changes.length && !plan.errors.length) console.log('  no changes')
if (plan.errors.length) process.exitCode = 2
