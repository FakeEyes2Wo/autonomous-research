import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateProjectSettings, validateProjectSettingsCandidate } from '../../dist/settings/migration.js'
import { createPolicySnapshot, frozenLiteratureSettings } from '../../dist/policy/model-routing.js'

test('literature defaults off, freezes in new policy, and enforces bounded lexical settings', () => {
  assert.deepEqual(migrateProjectSettings({ version: 1 }).literature, { mode: 'off', maxResults: 8, maxContextChars: 12000 })
  const settings = migrateProjectSettings({ version: 2, literature: { mode: 'lexical', maxResults: 10, maxContextChars: 2000 } })
  assert.deepEqual(createPolicySnapshot(settings).literature, settings.literature)
  assert.deepEqual(frozenLiteratureSettings(undefined), { mode: 'off', maxResults: 8, maxContextChars: 12000 })
  assert.throws(() => frozenLiteratureSettings({ mode: 'hybrid', maxResults: 8, maxContextChars: 12000 }), /literature/)
  for (const literature of [{ mode: 'hybrid' }, { maxResults: 0 }, { maxResults: 51 }, { maxResults: 1.5 }, { maxContextChars: 999 }, { maxContextChars: 100001 }]) {
    assert.equal(validateProjectSettingsCandidate({ version: 2, literature }).valid, false)
  }
  assert.equal(validateProjectSettingsCandidate({ version: 2, literature: { mode: 'lexical', maxResults: 40, maxContextChars: 100000 } }).valid, true)
  assert.equal(validateProjectSettingsCandidate({ version: 2, literature: { mode: 'lexical', maxResults: 41 } }).valid, false)
})

test('settings validation rejects invalid nested values instead of migrating them to defaults', () => {
  const result = validateProjectSettingsCandidate({ version: 2, workflow: { mode: 'typo', unexpected: true }, budget: { maxRoleCalls: 'abc', maxRunTokens: -1 } })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((item) => item.path === '/workflow/mode' && item.code === 'ENUM'))
  assert.ok(result.errors.some((item) => item.path === '/workflow/unexpected' && item.code === 'UNKNOWN_FIELD'))
  assert.ok(result.errors.some((item) => item.path === '/budget/maxRoleCalls' && item.code === 'POSITIVE_INTEGER'))
  assert.ok(result.errors.some((item) => item.path === '/budget/maxRunTokens' && item.code === 'POSITIVE_INTEGER'))
})

test('current idea search validation matches engine bounds and cross-field invariants', () => {
  const tooMany = validateProjectSettingsCandidate({ version: 2, budget: { currentIdeaSearch: { maxRequests: 1001 } } })
  assert.equal(tooMany.valid, false)
  const inconsistentDefaults = validateProjectSettingsCandidate({ version: 2, budget: { currentIdeaSearch: { maxRounds: 1 } } })
  assert.equal(inconsistentDefaults.valid, false)
  const nearestOverflow = validateProjectSettingsCandidate({ version: 2, budget: { currentIdeaSearch: { maxCandidates: 1 } } })
  assert.equal(nearestOverflow.valid, false)
  const bounded = validateProjectSettingsCandidate({ version: 2, budget: { currentIdeaSearch: { minRounds: 1, maxRounds: 1, maxCandidates: 1, nearestLimit: 1, maxRequests: 1, queriesPerRound: 1, maxDurationMs: 1000 } } })
  assert.equal(bounded.valid, true)
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
