import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInitialState } from '../../dist/core/state.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createRunContext } from '../../dist/service/context.js'
import { runIdeaGeneration } from '../../dist/service/steps/idea.js'
import { buildCandidateBatch } from '../../dist/research/candidate-batch.js'
import { ResearchStore } from '../../dist/research/store.js'
import { sealRecord } from '../../dist/research/records.js'
import { SubagentRoleAgentProvider } from '../../dist/providers/subagent-provider.js'
import { openRequestLedger } from '../../dist/policy/request-ledger.js'

const draft = { statement: 'Test a bounded intervention.', intervention: 'Change one parameter.', expected_effect: 'Accuracy rises.', supported_premises: [], predicted_observations: ['Accuracy rises.'], disconfirming_observations: ['Accuracy falls.'], sources: [] }
const review = (pass: boolean) => ({ is_falsifiable: pass, testable_implication: 'Compare accuracy.', unobservable_variables: [], critique: 'Reviewed.', unaddressed_risks: [], fatal_flaw_found: false })
async function fixture(t, provider) {
  const dir = await mkdtemp(join(tmpdir(), 'b2-regression-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const state = await createInitialState(dir)
  const ctx = createRunContext({ provider }, dir, state, await ResearchTree.load(dir), { parent: { id: 'p' }, signal: new AbortController().signal })
  ctx.policySnapshot.workflow.reflexionRounds = 0
  return { dir, ctx }
}
async function evaluations(dir: string) {
  const pointer = JSON.parse(await readFile(join(dir, 'research', 'idea-capture.json'), 'utf8'))
  return Promise.all(pointer.source_refs.filter(ref => ref.id === 'idea-generation-evaluations').map(async ref => ({ ref, capture: JSON.parse(await readFile(join(dir, ref.path), 'utf8')) })))
}

test('new idea review rounds have persisted distinct identities under the production request ledger', async t => {
  let starts = 0
  const provider = new SubagentRoleAgentProvider({ start: async (_name, options) => {
    const structured = options.label === 'idea-generator' ? { hypotheses: [draft] } : review(true)
    return { id: `child-${++starts}`, result: Promise.resolve({ output: [{ type: 'text', text: JSON.stringify(structured) }], stopReason: 'completed' }), dispose: async () => {} }
  } })
  const { dir, ctx } = await fixture(t, provider)
  ctx.context.requestLedger = await openRequestLedger({ runDir: dir, runId: ctx.state.runId, config: { maxInputTokens: 24000, maxOutputTokens: 8000, maxRunTokens: 120000, maxRoleCalls: 20, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 } })
  ctx.context.runId = ctx.state.runId
  await runIdeaGeneration(ctx, { idea: 'test', profile: '' })
  await runIdeaGeneration(ctx, { idea: 'test', profile: '', feedback: 'Please reassess this retained idea.' })
  assert.equal(starts, 4)
  const captures = await evaluations(dir)
  assert.equal(captures.length, 2)
  assert.notEqual(captures[0].capture.reviewAttemptId, captures[1].capture.reviewAttemptId)
  assert.equal(captures[0].capture.evaluations[0].id, captures[1].capture.evaluations[0].id)
  for (const { capture } of captures) {
    assert.equal(typeof capture.reviewAttemptId, 'string')
    const attempt = JSON.parse(await readFile(join(dir, capture.reviewAttemptSource.path), 'utf8'))
    assert.equal(attempt.id, capture.reviewAttemptId)
  }
  assert.equal((await ctx.context.requestLedger.snapshot()).totals.roleStarts, 4)
})

test('a repeated proposal uses its latest immutable evaluation in live and saved tree projections', async t => {
  let pass = false
  const provider = { run: async role => ({ stopReason: 'completed', text: '', structured: role === 'idea-generator' ? { hypotheses: [draft] } : { ...review(pass), revised: { statement: pass ? 'New reviewed statement.' : draft.statement } } }) }
  const { dir, ctx } = await fixture(t, provider)
  for (const next of [false, true, false]) {
    pass = next
    await runIdeaGeneration(ctx, { idea: 'test', profile: '', feedback: `Reassess: ${next}` })
    const latest = (await evaluations(dir)).at(-1)!
    const entry = latest.capture.evaluations[0]
    const node = ctx.tree.get(entry.id)
    assert.equal(node.status, next ? 'eligible' : 'rejected')
    assert.equal(node.content, next ? 'New reviewed statement.' : draft.statement)
    assert.ok(node.artifacts?.includes(latest.ref.path))
    assert.equal((await ResearchTree.load(dir)).get(entry.id).status, node.status)
  }
  assert.deepEqual((await evaluations(dir)).map(e => e.capture.evaluations[0].status), ['rejected', 'eligible', 'rejected'])
})

test('a model cannot reparent a stale proposal; an explicitly new controller-bound proposal can use the new parent', async t => {
  const { dir } = await fixture(t, { run: async () => { throw new Error('unused') } })
  const store = new ResearchStore(dir)
  const source = await store.captureBytes('Registered evidence bytes', 'registered-span')
  const parent = sealRecord({ id: 'current-v2', version: 2, created_at: '2026-09-16T00:00:00Z', source_refs: [], active_hypothesis: { id: 'h', version: 2 }, hypotheses: [{ id: 'h', version: 2, statement: 'old statement', prediction: 'old prediction' }], assessment: { admissible_evidence_ids: [], category: 'insufficient_evidence' } })
  const proposal = { parent: { id: 'h', version: 2 }, statement: 'new statement', scope: 'tasks', mechanism: 'new mechanism', measurement: 'accuracy', decision_rule: 'compare accuracy', rationale: 'a changed assumption', prediction: 'new prediction', falsification: 'opposite result', alternatives: [], evidence_ids: [], sourceSpanIds: [source.id] }
  const input = { id: 'batch', parent, proposalParent: { id: 'h', version: 1 }, proposalSnapshotHash: 'original-v1-hash', rawCandidates: [proposal], rawSource: await store.captureBytes(JSON.stringify(proposal), 'proposal'), registeredSpans: [source], selectionInput: { snapshotHash: parent.content_hash, remainingCost: null, testedMechanismKeys: [], registeredAlternatives: [], exploratoryBudget: { policy: 'controller-caps-v1', remainingCycles: 2, remainingRoleCalls: null, remainingTokens: null } } }
  const rejected = buildCandidateBatch(input as any)
  assert.equal(rejected.entries[0].candidate.status, 'rejected')
  assert.equal(rejected.entries[0].candidate.parent.version, 1)
  assert.deepEqual(rejected.entries[0].raw, proposal)
  assert.ok(rejected.entries[0].admissionReasons.includes('proposal_parent_mismatch'))
  assert.ok(rejected.entries[0].admissionReasons.includes('parent_version'))
  assert.equal(buildCandidateBatch({ ...input, proposalParent: { id: 'h', version: 2 }, proposalSnapshotHash: parent.content_hash } as any).entries[0].candidate.status, 'selected')
})

test('validated exploratory observations can motivate a candidate without becoming formal evidence', async t => {
  const { dir } = await fixture(t, { run: async () => { throw new Error('unused') } })
  const store = new ResearchStore(dir)
  const proposal = { statement: 'new statement', scope: 'fresh tasks', mechanism: 'new mechanism', measurement: 'accuracy', decision_rule: 'paired_sign_test_v1', rationale: 'development result suggests revision', prediction: 'new prediction', falsification: 'opposite result', alternatives: [], evidence_ids: ['dev'], sourceSpanIds: [] }
  const parent = sealRecord({ id: 'current', version: 1, created_at: '2026-09-16T00:00:00Z', source_refs: [], active_hypothesis: { id: 'h', version: 1 }, hypotheses: [{ id: 'h', version: 1, statement: 'old statement', prediction: 'old prediction' }], protocol: { provenance: 'known' }, evidence: [{ id: 'dev', mode: 'exploratory', validity: 'valid' }], assessment: { admissible_evidence_ids: [], category: 'insufficient_evidence', excluded_evidence: [{ id: 'dev', reasons: ['unknown_or_exploratory_provenance'] }] } })
  const input = { id: 'batch', parent, proposalParent: parent.active_hypothesis, proposalSnapshotHash: parent.content_hash, rawCandidates: [proposal], rawSource: await store.captureBytes(JSON.stringify(proposal), 'proposal'), selectionInput: { snapshotHash: parent.content_hash, remainingCost: null, testedMechanismKeys: [], registeredAlternatives: [], exploratoryBudget: { policy: 'controller-caps-v1', remainingCycles: 2, remainingRoleCalls: null, remainingTokens: null } } }
  assert.equal(buildCandidateBatch(input as any).entries[0].candidate.status, 'selected')
  assert.deepEqual(parent.assessment.admissible_evidence_ids, [])
  for (const reason of ['execution_error', 'invalid_measurement', 'domain_validation_missing_or_failed', 'missing_source_provenance', 'discovery_data_reused']) {
    const invalid = sealRecord({ ...parent, assessment: { ...parent.assessment, excluded_evidence: [{ id: 'dev', reasons: ['unknown_or_exploratory_provenance', reason] }] } })
    assert.equal(buildCandidateBatch({ ...input, parent: invalid } as any).entries[0].candidate.status, 'rejected', reason)
  }
})
