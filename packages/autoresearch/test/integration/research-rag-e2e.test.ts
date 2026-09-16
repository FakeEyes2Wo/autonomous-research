import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { literatureFixture } from '../helpers/literature-context.ts'
import { ResearchStore, sealRecord, assessEvidence } from '../../dist/research/index.js'
import { SubagentRoleAgentProvider } from '../../dist/providers/subagent-provider.js'
import { DEFAULT_PROJECT_SETTINGS } from '../../dist/settings/schema.js'
import { createClaimAssessment, saveClaimAssessment } from '../../dist/literature/claim-assessment.js'
import { createInitialState } from '../../dist/core/state.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createRunContext } from '../../dist/service/context.js'
import { runSupervisor } from '../../dist/experiment/steps.js'
import { writeResearchReport } from '../../dist/service/research-cycle.js'
import { validateScientificEvidence } from '../../dist/experiment/evidence-validator.js'
import { freezeTaskGraph } from '../../dist/experiment/task-graph.js'
import { advanceExperimentGraph } from '../../dist/experiment/runtime-adapter.js'
import { createLocalExperimentRuntime } from '../../dist/runtime/local-authority.js'
import { openJobStore } from '../../dist/runtime/job-store.js'

test('grounded revision carries a validated development negative into fresh durable validation', { skip: process.platform !== 'win32', timeout: 60000 }, async t => literatureFixture(async f => {
  t.mock.method(os, 'homedir', () => f.project); syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const store = new ResearchStore(f.runDir)
  const base = { version: 1, created_at: '2026-09-16T00:00:00Z', source_refs: [] }
  const claim = sealRecord({ ...base, id: 'claim', statement: 'alpha improves success', scope: 'controlled tasks', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: 'literature motivates a test' })
  const hypothesis = sealRecord({ ...base, id: 'hypothesis', statement: claim.statement, claim: { id: claim.id, version: 1 }, parents: [], mechanism: 'alpha', alternatives: ['volume'], prediction: 'more successes', falsification: 'fewer successes', measurement: 'success', decision_rule: 'paired_sign_test_v1', scope: claim.scope, mode: 'exploratory', status: 'proposed' })
  const protocol = sealRecord({ ...base, id: 'dev-protocol', hypothesis: { id: hypothesis.id, version: 1 }, metric: 'success', controls: ['control'], sample: '8 independent tasks', split: 'development', seeds: [], budget: { unit: 'task-pair', limit: 8, tolerance: 0 }, stopping_rule: '8 pairs', failure_policy: 'exclude_from_mechanism', missing_policy: 'inconclusive', duplicate_policy: 'block_conflicts', fingerprints: { code: 'dev-code', data: 'dev-data', treatment: 'alpha', model: 'controlled' }, provenance: 'known', decision_rule: 'paired_sign_test_v1' })
  const initial = await store.commit(sealRecord({ ...base, id: 'initial', schema: 'autoresearch/research-snapshot/v1', branch_id: 'main', claims: [claim], hypotheses: [hypothesis], protocol, evidence: [], active_claim: { id: claim.id, version: 1 }, active_hypothesis: { id: hypothesis.id, version: 1 }, budget: { revisions: 0, repairs: 0, tokens: 0 } }))
  const observations = (p: any, positive: boolean) => ({ schema: 'autoresearch/paired-outcomes/v1', protocol_hash: p.content_hash, split: p.split, fingerprints: p.fingerprints, unit: 'task-pair', cost: 8, units: Array.from({ length: 8 }, (_, i) => ({ id: `${p.split}-${i}`, control: positive ? 0 : 1, treatment: positive ? 1 : 0 })) })
  const raw = observations(protocol, false)
  const validated = validateScientificEvidence(raw, protocol, initial)
  assert.equal(validated.validity, 'valid'); assert.equal(validated.polarity, 'opposes')
  const rawRef = await store.captureBytes(JSON.stringify(raw), 'dev-observations')
  const validatorRef = await store.captureBytes(await readFile(resolve('dist/experiment/evidence-validator.js')), 'dev-validator')
  const negative = sealRecord({ ...base, id: 'dev-negative', target_claim: initial.active_claim, protocol_hash: protocol.content_hash, attempt_id: 'dev-attempt', artifacts: [rawRef], analysis: validatorRef, ...validated, execution: 'completed', split: protocol.split, mode: 'exploratory', fingerprints: protocol.fingerprints, source_refs: [rawRef, validatorRef] })
  const assessment = assessEvidence({ claim, hypothesis, protocol, evidence: [negative] })
  const measured = await store.commit(sealRecord({ ...initial, id: 'measured', version: 2, parent_snapshot_id: initial.id, evidence: [negative], assessment }), initial.content_hash)
  const span = f.document.spans[1]
  await saveClaimAssessment(f.runDir, createClaimAssessment({ claimId: claim.id, spanIds: [span.id], relation: 'refutes', conditions: [], assessor: 'human', assessorVersion: 'fixture-v1' }, f.document.spans), f.document.spans)
  const proposal = { statement: 'Only relevant alpha improves success', scope: 'fresh independent tasks', mechanism: 'relevance', intervention: 'gate alpha', prediction: 'gating improves success', falsification: 'gating harms success', measurement: 'success', decision_rule: 'paired_sign_test_v1', evidence_ids: [negative.id], sourceSpanIds: [span.id], alternatives: ['volume'], distinguishes: ['volume'], unresolvedConstraints: [], rationale: 'development negative and external counterexample require a relevance gate', parent: initial.active_hypothesis, changedAssumption: 'relevance matters', feasible: true, estimatedCost: null }
  let prompt = ''
  const provider = new SubagentRoleAgentProvider({ async start(_name: string, input: any) {
    prompt = input.prompt[0].text
    return { id: 'controlled-reviser', result: Promise.resolve({ stopReason: 'completed', structured: { action: 'revise', reason: 'new testable mechanism', candidates: [proposal] }, output: [] }), async dispose() {} }
  } } as never)
  const state = await createInitialState(f.runDir, 'run'), tree = await ResearchTree.load(f.runDir)
  const context = { parent: { id: 'main', session: { id: 'main' } }, signal: new AbortController().signal, projectDir: f.project, runId: 'run', policySnapshot: { ...structuredClone(DEFAULT_PROJECT_SETTINGS), literature: f.input.settings } }
  const ctx = createRunContext({ provider, maxCycles: 3 }, f.runDir, state, tree, context)
  await writeResearchReport(ctx, measured)
  assert.equal((await runSupervisor(ctx, { planText: 'Revise using the development result and registered counterevidence' })).action, 'revise')
  assert.ok(prompt.includes(negative.observation) && prompt.includes(span.evidenceText))
  const successor = (await store.loadCurrent())!
  const revised = successor.hypotheses.at(-1)!
  assert.deepEqual(revised.parents, [initial.active_hypothesis])
  assert.ok(revised.discovery_source_ids.includes(negative.id) && revised.discovery_source_ids.includes(span.id))
  assert.notEqual(revised.status, 'supported')
  assert.equal((await store.loadSnapshot(measured.id)).content_hash, measured.content_hash)
  // The controller freezes a fresh validation contract; the fake model never supplies evidence status.
  const formal = sealRecord({ ...successor.protocol, id: 'fresh-protocol', provenance: 'known', split: 'fresh-heldout', budget: protocol.budget, fingerprints: { code: 'gate-code', data: 'fresh-data', treatment: 'gated-alpha', model: 'controlled' } })
  const frozen = await store.commit(sealRecord({ ...successor, id: 'validation-ready', version: successor.version + 1, parent_snapshot_id: successor.id, protocol: formal, decision: undefined, assessment: undefined }), successor.content_hash)
  const rawPath = join(f.runDir, 'fresh-observations.json'), counter = join(f.runDir, 'execution-counts.txt')
  await writeFile(rawPath, JSON.stringify(observations(formal, true)))
  const input = await store.captureSource('fresh-observations.json', 'fresh-validation-input')
  const tasks = ['baseline', 'formal'].map((stage, index) => ({ id: stage, dependsOn: index ? ['baseline'] : [], stage, protocolHash: formal.content_hash, inputHash: input.hash, validatorId: index ? 'paired_sign_test_v1' : 'artifact_integrity_v1', inputs: [input], outputs: [{ relativePath: 'result.json', kind: index ? 'paired-outcomes' : 'preparation', maxBytes: 4000 }], split: formal.split, exposure: index ? 'heldout' : 'none', job: { id: `job-${stage}`, attemptId: `attempt-${stage}`, taskId: stage, protocolHash: formal.content_hash, inputHash: input.hash, executable: process.execPath, args: [resolve('test/fixtures/jobs/paired-outcomes-job.mjs')], cwd: f.runDir, env: { RAW_FILE: join(f.runDir, input.path), EXECUTION_COUNTER: counter, TASK_ID: stage }, budget: { wallMs: 15000, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 1000, maxArtifactBytes: 4000 }, checkpoint: null } }))
  const graph = await freezeTaskGraph({ runDir: f.runDir, id: 'fresh-validation', goal: revised.statement, snapshot: frozen, tasks, maxReservedWallMs: 30000 })
  const runtime = await createLocalExperimentRuntime({ projectRoots: [f.project], executables: [process.execPath], envNames: ['RAW_FILE', 'EXECUTION_COUNTER', 'TASK_ID'], maxWallMs: 15000, maxRunWallMs: 30000, maxLogBytes: 1000, maxArtifactBytes: 4000 }, f.project)
  let outcome: any
  const deadline = Date.now() + 45000
  do {
    outcome = await advanceExperimentGraph({ runDir: f.runDir, graph, runtime })
    assert.notEqual(outcome.status, 'paused', outcome.reason)
    if (outcome.status !== 'completed') await new Promise(resolve => setTimeout(resolve, 100))
  } while (outcome.status !== 'completed' && Date.now() < deadline)
  assert.equal(outcome.status, 'completed')
  await advanceExperimentGraph({ runDir: f.runDir, graph, runtime })
  const final = (await store.loadCurrent())!
  const evidence = final.evidence.filter(e => e.protocol_hash === formal.content_hash)
  assert.equal(evidence.length, 1); assert.equal(evidence[0].validity, 'valid'); assert.equal(evidence[0].polarity, 'supports')
  assert.equal(final.evidence.find(e => e.id === negative.id)?.content_hash, negative.content_hash)
  assert.deepEqual((await readFile(counter, 'utf8')).trim().split('\n').map(line => line.split(':')[0]).sort(), ['baseline', 'formal'])
  const reopened = await openJobStore(join(f.runDir, 'runtime', 'jobs'))
  try { assert.equal((await reopened.list()).length, 2); assert.ok((await reopened.budget()).settledWallMs > 0); assert.equal((await reopened.budget()).activeJobs, 0) }
  finally { await reopened.close() }
  assert.ok((await readFile(join(f.runDir, 'HANDOFF.md'), 'utf8')).includes(final.content_hash))
  const [exposures] = await f.catalog.transact([{ sql: 'SELECT body FROM exposures', params: [] }])
  assert.ok(exposures.some(row => { const e = JSON.parse(String(row.body)); return e.status === 'sent' && e.spanIds.includes(span.id) }))
}))
