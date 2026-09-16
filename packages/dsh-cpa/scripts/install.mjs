import { install, uninstall } from '../src/index.mjs'
import { has, loadConfig as loadConfigFile, valueAfter } from './cli.mjs'

const dshHome = valueAfter('--dsh-home')
const settingsPath = valueAfter('--settings')
const configPath = valueAfter('--config')
const isUninstall = has('--uninstall')
const dryRun = !has('--apply')

const plan = isUninstall
  ? await uninstall({ dshHome, settingsPath, dryRun })
  : await install({ config: await loadConfigFile(configPath), dshHome, settingsPath, dryRun })
console.log((dryRun ? 'DRY-RUN ' : 'APPLIED ') + plan.operation + ': ' + plan.settingsPath)
for (const change of plan.changes) console.log('  ' + change.action + ' ' + change.id)
for (const error of plan.errors) console.error('  CONFLICT ' + error.id + ': ' + error.message)
if (!plan.changes.length && !plan.errors.length) console.log('  no changes')
if (plan.errors.length) process.exitCode = 2
