import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateProjectSettings, validateProjectSettingsCandidate } from '../../dist/settings/migration.js'

test('settings validation rejects invalid nested values instead of migrating them to defaults', () => {
  const result = validateProjectSettingsCandidate({ version: 2, workflow: { mode: 'typo', unexpected: true }, budget: { maxRoleCalls: 'abc', maxRunTokens: -1 } })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((item) => item.path === '/workflow/mode' && item.code === 'ENUM'))
  assert.ok(result.errors.some((item) => item.path === '/workflow/unexpected' && item.code === 'UNKNOWN_FIELD'))
  assert.ok(result.errors.some((item) => item.path === '/budget/maxRoleCalls' && item.code === 'POSITIVE_INTEGER'))
  assert.ok(result.errors.some((item) => item.path === '/budget/maxRunTokens' && item.code === 'POSITIVE_INTEGER'))
})

test('settings validation checks object types, route pairs, and escalation signals', () => {
  const result = validateProjectSettingsCandidate({ version: 2, modelRouting: { enabled: true, roles: { worker: { provider: 'p', escalateOn: ['context_truncated'] } } }, budget: { context: [] } })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((item) => item.path === '/modelRouting/roles/worker' && item.code === 'ROUTE_PAIR'))
  assert.ok(result.errors.some((item) => item.path === '/modelRouting/roles/worker/escalateOn' && item.code === 'ESCALATION_SIGNAL'))
  assert.ok(result.errors.some((item) => item.path === '/budget/context' && item.code === 'TYPE'))
})

test('missing optional v1 fields still migrate compatibly and remain legacy', () => {
  const result = validateProjectSettingsCandidate({ version: 1, model: { useGlobal: true } })
  assert.equal(result.valid, true)
  assert.equal(result.settings?.version, 2)
  assert.equal(result.settings?.workflow.mode, 'legacy')
  assert.equal(migrateProjectSettings({ version: 1 }).workflow.mode, 'legacy')
})
