import test from 'node:test'
import assert from 'node:assert/strict'

const api = await import('../../dist/literature/discovery/index.js').catch(() => ({})) as any
export const idea = { statement: 'Scoped capabilities for retrieved instructions', profile: 'Security research', scope: 'retrieved instructions in delegated execution', mechanism: 'attenuate authority before execution', prediction: 'contextual restrictions reduce unauthorized effects', falsification: 'unrestricted execution performs equally safely', measurement: 'unauthorized action rate', decisionRule: 'paired_sign_test_v1', alternatives: ['static allowlist'], assumptions: ['untrusted retrieval'], terminology: ['capability'], crossDomainAnalogs: ['information flow'], source: 'given-idea' }
test('semantic target ignores execution and source identifiers, preserves mechanism', () => {
  assert.equal(typeof api.fingerprintIdea, 'function')
  assert.equal(api.fingerprintIdea(idea), api.fingerprintIdea({ ...idea, source: 'revision', runId: 'new', cycle: 42, sourceIds: ['volatile'] }))
  assert.notEqual(api.fingerprintIdea(idea), api.fingerprintIdea({ ...idea, mechanism: 'detect suspicious words' }))
})
test('planner deduplicates whitespace/case and rejects a first round without diverse facets', async () => {
  assert.equal(typeof api.planDiscoveryQueries, 'function')
  const input = { idea, round: 1, priorQueries: [], priorCoverage: [], maxQueries: 4 }
  await assert.rejects(api.planDiscoveryQueries({ ...input, callback: async () => [{ text: 'capability security', dimensions: ['mechanism'] }] }), /divers/i)
  const queries = await api.planDiscoveryQueries({ ...input, callback: async () => [{ text: 'capability security', dimensions: ['mechanism'] }, { text: ' Capability   SECURITY ', dimensions: ['mechanism'] }, { text: 'untrusted retrieval attacks', dimensions: ['problem'] }] })
  assert.equal(queries.length, 2)
  assert.ok(queries.every((q: any) => q.origin === 'model' && q.id))
})
test('malformed query entries are recorded as rejections while valid entries survive', () => {
  const rejected: any[] = []
  const queries = api.validateDiscoveryQueries([null, 42, 'query', { text: 'valid one', dimensions: ['mechanism'] }, { text: 'valid two', dimensions: ['problem'] }], { round: 1, priorQueries: [], priorCoverage: [], maxQueries: 4 }, rejected)
  assert.equal(queries.length, 2); assert.equal(rejected.length, 3)
})
