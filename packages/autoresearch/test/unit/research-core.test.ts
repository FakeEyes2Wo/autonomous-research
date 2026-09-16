import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../../dist/research/index.js'

const at = '2026-09-12T00:00:00.000Z'
const fp = { code: 'code-v1', data: 'data-v1', treatment: 'arm-v1', model: 'model-v1' }
const base = (id: string) => ({ id, version: 1, created_at: at, source_refs: [] })
function fixture() {
  assert.equal(typeof core.sealRecord, 'function', 'versioned sealing must exist')
  const claim = core.sealRecord({ ...base('c'), statement: 'A improves success', scope: 'test tasks', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: '' })
  const hypothesis = core.sealRecord({ ...base('h'), statement: 'A beats B', claim: { id: 'c', version: 1 }, parents: [], mechanism: 'relevant recall', alternatives: ['extra tokens'], prediction: 'positive effect', falsification: 'negative interval', measurement: 'success', decision_rule: 'interval-v1', scope: 'test tasks', mode: 'formal', status: 'proposed' })
  const protocol = core.sealRecord({ ...base('p'), hypothesis: { id: 'h', version: 1 }, metric: 'success', controls: ['B'], sample: '100 held-out tasks', split: 'held-out', seeds: [1], budget: { unit: 'tokens', limit: 100, tolerance: 0.05 }, stopping_rule: '100 tasks', failure_policy: 'exclude_from_mechanism', missing_policy: 'inconclusive', duplicate_policy: 'block_conflicts', fingerprints: fp, provenance: 'known', decision_rule: 'paired_sign_test_v1' })
  const evidence = core.sealRecord({ ...base('e'), target_claim: { id: 'c', version: 1 }, protocol_hash: protocol.content_hash, attempt_id: 'a1', unit_id: 'u1', artifacts: [{ id: 'raw', path: 'raw.json', hash: 'abc' }], analysis: { id: 'analysis', path: 'analysis.js', hash: 'def' }, validity: 'valid', polarity: 'opposes', execution: 'completed', observation: 'negative interval', sample_size: 100, effect: -0.2, interval: [-0.3, -0.1], split: 'held-out', mode: 'formal', fingerprints: fp, validation: { method: 'paired_sign_test_v1', passed: true, issues: [] } })
  return { claim, hypothesis, protocol, evidence: [evidence], createdAt: at }
}

test('sealed records detach input and reject mutation of historical nested content', () => {
  assert.equal(typeof core.sealRecord, 'function', 'versioned sealing must exist')
  const input = { ...base('r'), observations: ['original'] }
  const sealed = core.sealRecord(input)
  input.observations.push('later')
  assert.deepEqual(sealed.observations, ['original'])
  assert.throws(() => sealed.observations.push('overwrite'), TypeError)
  assert.equal(core.hashBytes('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(core.hashContent({ a: 1, b: 2 }), core.hashContent({ b: 2, a: 1 }))
})

test('valid counterevidence refutes under the frozen domain rule', () => {
  const result = core.assessEvidence(fixture())
  assert.equal(result.claim_status, 'refuted')
  assert.equal(result.next_action, 'revise')
  assert.deepEqual(result.opposing_evidence_ids, ['e'])
})

test('conflicting evidence is retained without last-writer-wins support', () => {
  const f = fixture()
  const positive = core.sealRecord({ ...f.evidence[0], id: 'positive', polarity: 'supports', effect: 0.2, interval: [0.1, 0.3] })
  for (const evidence of [[...f.evidence, positive], [positive, ...f.evidence]]) {
    const result = core.assessEvidence({ ...f, evidence })
    assert.equal(result.claim_status, 'inconclusive')
    assert.equal(result.category, 'mixed_evidence')
    assert.deepEqual(result.supporting_evidence_ids, ['positive'])
    assert.deepEqual(result.opposing_evidence_ids, ['e'])
    assert.ok(result.conflicts.length)
  }
})

test('no significant improvement stays inconclusive without becoming equivalence', () => {
  const f = fixture()
  const evidence = [core.sealRecord({ ...f.evidence[0], polarity: 'inconclusive', effect: -0.102, interval: [-0.296, 0.093] })]
  const result = core.assessEvidence({ ...f, evidence })
  assert.equal(result.claim_status, 'inconclusive')
  assert.equal(result.category, 'insufficient_evidence')
})

test('invalid scoring, unknown provenance and treatment mismatch cannot refute mechanism', () => {
  for (const patch of [{ validity: 'invalid' }, { artifacts: [] }, { validation: undefined }, { fingerprints: { ...fp, treatment: 'contaminated' } }]) {
    const f = fixture()
    const result = core.assessEvidence({ ...f, evidence: [core.sealRecord({ ...f.evidence[0], ...patch })] })
    assert.equal(result.claim_status, 'inconclusive')
    assert.deepEqual(result.admissible_evidence_ids, [])
    assert.equal(result.excluded_evidence[0].id, 'e')
  }
})

test('execution faults are outcomes only under a predeclared reliability protocol', () => {
  const f = fixture()
  const error = core.sealRecord({ ...f.evidence[0], execution: 'error' })
  const mechanism = core.assessEvidence({ ...f, evidence: [error] })
  assert.equal(mechanism.category, 'execution_error')
  assert.equal(mechanism.claim_status, 'inconclusive')
  const protocol = core.sealRecord({ ...f.protocol, failure_policy: 'include_as_outcome' })
  const reliability = core.assessEvidence({ ...f, protocol, evidence: [core.sealRecord({ ...error, protocol_hash: protocol.content_hash })] })
  assert.equal(reliability.claim_status, 'refuted')
})

test('bounded repair stops unchanged repeated faults and unknown remote outcomes', () => {
  const f = fixture()
  const input = { ...f, evidence: [core.sealRecord({ ...f.evidence[0], execution: 'error' })] }
  const first = core.assessEvidence(input)
  assert.equal(first.next_action, 'repair')
  assert.equal(core.assessEvidence({ ...input, previousFailureSignature: first.failure_signature }).next_action, 'pause')
  assert.equal(core.assessEvidence({ ...input, repairAttempts: 2, maxRepairAttempts: 2 }).next_action, 'pause')
  assert.equal(core.assessEvidence({ ...input, evidence: [core.sealRecord({ ...f.evidence[0], execution: 'unknown' })] }).next_action, 'pause')
  assert.equal(core.assessEvidence({ ...f, budgetExhausted: true }).category, 'budget_exhausted')
})

test('revision retains judged parent versions and creates exploratory evidence-linked descendants', () => {
  const f = fixture()
  const assessment = core.assessEvidence(f)
  const parent = core.sealRecord({ ...base('s1'), schema: 'autoresearch/research-snapshot/v1', branch_id: 'branch', active_claim: { id: 'c', version: 1 }, active_hypothesis: { id: 'h', version: 1 }, claims: [f.claim], hypotheses: [f.hypothesis], protocol: f.protocol, evidence: f.evidence, assessment, budget: { repairs: 0, revisions: 0, tokens: 123 } })
  const candidate = { statement: 'Only relevant A helps', scope: 'relevant tasks', mechanism: 'relevance gating', alternatives: ['token effect'], prediction: 'gating helps', falsification: 'gating harms', measurement: 'success', decision_rule: 'interval-v2', evidence_ids: ['e'], rationale: 'distinguishes recall from volume' }
  const nextProtocol = core.sealRecord({ ...f.protocol, version: 2, hypothesis: { id: 'h', version: 2 }, decision_rule: 'interval-v2', fingerprints: { ...fp, data: 'fresh-tasks' } })
  const next = core.createRevision({ decisionId: 'decision-1', parentSnapshot: parent, assessment, candidate, nextProtocol, reason: 'test relevance', createdAt: at })
  assert.equal(parent.claims[0].status, 'proposed')
  assert.equal(next.hypotheses[0].statement, 'A beats B')
  assert.equal(next.hypotheses.at(-1).mode, 'exploratory')
  assert.equal(next.hypotheses.at(-1).status, 'proposed')
  assert.deepEqual(next.hypotheses.at(-1).parents, [{ id: 'h', version: 1 }])
  assert.equal(next.decision.parent_snapshot_id, 's1')
  assert.deepEqual(next.decision.evidence_ids, ['e'])
  assert.equal(next.budget.tokens, 123)
  assert.equal(next.budget.revisions, 1)
  assert.notEqual(next.protocol.content_hash, parent.protocol.content_hash)
  assert.throws(() => core.createRevision({ decisionId: 'bad', parentSnapshot: parent, assessment, candidate: { ...candidate, statement: 'A beats B' }, nextProtocol, reason: 'repeat' }), /unchanged/i)
})

test('revision accepts an evaluated claim descendant and pauses when no changed candidate exists', () => {
  const f = fixture()
  const assessment = core.assessEvidence(f)
  const judged = core.sealRecord({ ...f.claim, version: 2, parents: [{ id: 'c', version: 1 }], status: 'refuted', opposing_evidence_ids: ['e'] })
  const parent = core.sealRecord({ ...base('evaluated'), schema: 'autoresearch/research-snapshot/v1', branch_id: 'branch', active_claim: { id: 'c', version: 2 }, active_hypothesis: { id: 'h', version: 1 }, claims: [f.claim, judged], hypotheses: [f.hypothesis], protocol: f.protocol, evidence: f.evidence, assessment, budget: { repairs: 0, revisions: 0 } })
  const next = core.createRevision({ decisionId: 'stop-unchanged', parentSnapshot: parent, assessment, reason: 'no distinguishing candidate', createdAt: at })
  assert.equal(next.decision.action, 'pause')
  assert.deepEqual(next.active_claim, { id: 'c', version: 2 })
  assert.equal(next.budget.revisions, 0)
})

test('an arbitrary validation label does not establish formal evidence', () => {
  const f = fixture()
  const protocol = core.sealRecord({ ...f.protocol, decision_rule: 'model-says-trust-me' })
  const row = core.sealRecord({ ...f.evidence[0], protocol_hash: protocol.content_hash, validation: { method: 'model-says-trust-me', passed: true, issues: [] } })
  const result = core.assessEvidence({ ...f, protocol, evidence: [row] })
  assert.equal(result.claim_status, 'inconclusive')
  assert.deepEqual(result.admissible_evidence_ids, [])
})

test('discovery evidence IDs resolve to source artifacts and fresh data stays admissible', () => {
  const f = fixture()
  const hypothesis = core.sealRecord({ ...f.hypothesis, discovery_source_ids: ['discovery-evidence'] })
  const discovery = core.sealRecord({ ...f.evidence[0], id: 'discovery-evidence', split: 'development', fingerprints: { ...f.evidence[0].fingerprints, data: 'development-data' } })
  const reused = core.assessEvidence({ ...f, hypothesis, discoveryEvidence: [discovery] })
  assert.equal(reused.claim_status, 'inconclusive')
  assert.ok(reused.excluded_evidence[0].reasons.includes('discovery_data_reused'))
  const unresolved = core.assessEvidence({ ...f, hypothesis })
  assert.equal(unresolved.claim_status, 'inconclusive')
  const fresh = core.sealRecord({ ...f.evidence[0], artifacts: [{ id: 'fresh', path: 'fresh.json', hash: 'fresh-hash' }] })
  assert.equal(core.assessEvidence({ ...f, hypothesis, evidence: [fresh], discoveryEvidence: [discovery] }).claim_status, 'refuted')
})

test('assessment and failure IDs distinguish timestamps and changed recovery actions', () => {
  const f = fixture()
  const first = core.assessEvidence(f)
  const later = core.assessEvidence({ ...f, createdAt: '2026-09-13T00:00:00.000Z' })
  assert.notEqual(first.id, later.id)
  assert.notEqual(first.failures[0].id, later.failures[0].id)
  assert.equal(first.failure_signature, later.failure_signature)
  const broken = { ...f, evidence: [core.sealRecord({ ...f.evidence[0], execution: 'error' })] }
  const repair = core.assessEvidence(broken)
  const pause = core.assessEvidence({ ...broken, previousFailureSignature: repair.failure_signature })
  assert.notEqual(repair.id, pause.id)
  assert.notEqual(repair.failures[0].id, pause.failures[0].id)
  assert.equal(repair.failure_signature, pause.failure_signature)
})
