import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateProjectSettings } from '../../dist/settings/migration.js'
import { effectiveCurrentIdeaSearch, selectCurrentIdea } from '../../dist/research/current-idea.js'
import { fingerprintIdea } from '../../dist/literature/discovery/contracts.js'

const canonicalSnapshot = (patch: Record<string, unknown> = {}) => ({
  active_hypothesis: { id: 'hypothesis-active', version: 7 },
  hypotheses: [{ id: 'hypothesis-active', version: 7, created_at: '2026-01-01T00:00:00.000Z', content_hash: 'hash-a', source_refs: [], statement: 'Contextual delegated authorization', claim: { id: 'claim-1', version: 4 }, parents: [], mechanism: 'contextual caveats restrict bearer tokens', alternatives: ['static allowlist'], prediction: 'unauthorized effects decrease', falsification: 'unauthorized effects remain unchanged', measurement: 'unauthorized action rate', decision_rule: 'paired_sign_test_v1', scope: 'cloud authorization', mode: 'exploratory', status: 'proposed', ...patch }],
  decision: undefined,
})

const ideaState = (patch: Record<string, unknown> = {}) => ({
  intakeIdea: 'delegated authorization with contextual restrictions', profile: 'security systems', snapshot: canonicalSnapshot(patch),
})

test('new settings enable current idea search while explicit never disables only that search', () => {
  const settings = migrateProjectSettings({ version: 2 })
  assert.equal(settings.workflow.currentIdeaSearch, 'enabled')
  assert.equal(effectiveCurrentIdeaSearch(settings), 'enabled')
  assert.equal(effectiveCurrentIdeaSearch({ ...settings, workflow: { ...settings.workflow, currentIdeaSearch: 'never' } }), 'never')
})

test('historical policies without the search field stay off, including an existing run without a snapshot', () => {
  const settings = migrateProjectSettings({ version: 2 })
  assert.equal(effectiveCurrentIdeaSearch(settings, { workflow: {} }, true), 'never')
  assert.equal(effectiveCurrentIdeaSearch(settings, { workflow: {} }), 'never')
  assert.equal(effectiveCurrentIdeaSearch(settings, undefined, true), 'never')
})

test('canonical hypothesis semantic fields change the target while record IDs and timestamps do not', () => {
  const before = selectCurrentIdea(ideaState())
  const metadataSnapshot = canonicalSnapshot()
  metadataSnapshot.active_hypothesis = { id: 'different-record', version: 99 }
  metadataSnapshot.hypotheses = [{ ...metadataSnapshot.hypotheses[0], id: 'different-record', version: 99, created_at: '2030-01-01T00:00:00.000Z', content_hash: 'different-hash' }]
  const metadataOnly = selectCurrentIdea({ ...ideaState(), snapshot: metadataSnapshot })
  assert.equal(fingerprintIdea(before), fingerprintIdea(metadataOnly))
  for (const field of ['mechanism', 'prediction', 'falsification', 'measurement', 'scope', 'decision_rule'] as const) {
    const changed = selectCurrentIdea(ideaState({ [field]: `changed ${field}` }))
    assert.notEqual(fingerprintIdea(before), fingerprintIdea(changed), field)
  }
})
