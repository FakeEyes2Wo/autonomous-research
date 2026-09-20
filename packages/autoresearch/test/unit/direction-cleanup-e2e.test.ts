import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { createInitialState, saveState } from '../../dist/core/state.js'
import { loadDirectionManifest, openDirectionManifest, registerManagedArtifact } from '../../dist/cleanup/manifest.js'
import { enqueueRetirement, persistRetirementMemory } from '../../dist/cleanup/queue.js'
import { advanceCleanupQueue, enqueueRefutedDirection } from '../../dist/cleanup/index.js'
import { directionId } from '../../dist/cleanup/direction-id.js'
import { hashBytes } from '../../dist/research/records.js'
import * as core from '../../dist/research/index.js'
import { artifactHash } from '../../dist/project/inventory.js'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { mechanismKey } from '../../dist/research/candidates.js'
import { selectCandidate } from '../../dist/research/selection.js'
import { ProjectDirectionMemoryStore, selectionHintsForMechanisms } from '../../dist/memory/direction-memory.js'

const at = '2026-09-12T00:00:00.000Z'

async function makeRefutedSnapshot(store: InstanceType<typeof core.ResearchStore>) {
  const base = { version: 1, created_at: at, source_refs: [] }
  const claim = core.sealRecord({ ...base, id: 'claim', statement: 'temporary benefit', scope: 'tasks', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: 'intake' })
  const hypothesis = core.sealRecord({ ...base, id: 'hypothesis', statement: 'A direction created by the service E2E', claim: { id: claim.id, version: 1 }, parents: [], mechanism: 'temporary mechanism', alternatives: [], prediction: 'benefit', falsification: 'no benefit', measurement: 'metric', decision_rule: 'paired_sign_test_v1', scope: 'tasks', mode: 'unknown', status: 'proposed' })
  const protocol = core.sealRecord({ ...base, id: 'protocol', hypothesis: { id: hypothesis.id, version: 1 }, metric: 'metric', controls: [], sample: 'bounded', split: 'heldout', seeds: [1], budget: { unit: 'run', limit: 1, tolerance: 0 }, stopping_rule: 'bounded', failure_policy: 'exclude_from_mechanism', missing_policy: 'unknown', duplicate_policy: 'block_conflicts', fingerprints: { code: 'code', data: 'data', treatment: 'treatment', model: 'model' }, provenance: 'known', decision_rule: 'paired_sign_test_v1' })
  const artifact = await store.captureBytes('raw service E2E bytes', 'raw')
  const analysis = await store.captureBytes('analysis service E2E bytes', 'analysis')
  const evidence = core.sealRecord({ id: 'evidence', version: 1, created_at: at, source_refs: [], target_claim: { id: claim.id, version: 1 }, protocol_hash: protocol.content_hash, attempt_id: 'attempt', artifacts: [artifact], analysis, validity: 'valid', polarity: 'opposes', execution: 'completed', observation: 'validated opposing result', split: protocol.split, mode: 'formal', fingerprints: protocol.fingerprints, validation: { method: protocol.decision_rule, passed: true, issues: [] } })
  const assessment = core.assessEvidence({ claim, hypothesis, protocol, evidence: [evidence], createdAt: at })
  const updatedClaim = core.sealRecord({ ...claim, version: 2, parents: [{ id: claim.id, version: 1 }], status: assessment.claim_status, opposing_evidence_ids: assessment.opposing_evidence_ids })
  const snapshot = core.sealRecord({ ...base, id: 'service-e2e-snapshot', schema: 'autoresearch/research-snapshot/v1', branch_id: 'main', claims: [claim, updatedClaim], hypotheses: [hypothesis], protocol, evidence: [evidence], active_claim: { id: updatedClaim.id, version: updatedClaim.version }, active_hypothesis: { id: hypothesis.id, version: 1 }, assessment, budget: { revisions: 0, repairs: 0, tokens: 1 } })
  await store.commit(snapshot)
  return { snapshot, artifact }
}

test('refuted cleanup preserves the selected raw intervention/outcome mechanism key for future selection', async t => {
  const project = await mkdtemp(join(tmpdir(), 'ar-cleanup-mechanism-key-project-'))
  const run = join(project, 'run')
  await mkdir(run, { recursive: true })
  t.after(() => rm(project, { recursive: true, force: true }))
  const store = new core.ResearchStore(run)
  const { snapshot: parent } = await makeRefutedSnapshot(store)
  const oldHypothesis = parent.hypotheses[0]!
  const hypothesis = core.sealRecord({ ...oldHypothesis, version: 2, statement: 'A revised direction', claim: parent.active_claim, parents: [{ id: oldHypothesis.id, version: oldHypothesis.version }], mechanism: 'gating', prediction: 'accuracy improves', falsification: 'accuracy does not improve', measurement: 'loss', scope: 'tasks' })
  const protocol = core.sealRecord({ ...parent.protocol, version: 2, hypothesis: { id: hypothesis.id, version: hypothesis.version } })
  const raw = { statement: hypothesis.statement, scope: hypothesis.scope, mechanism: hypothesis.mechanism, intervention: 'apply a relevance gate', outcomeVariable: 'task accuracy', measurement: hypothesis.measurement, decision_rule: hypothesis.decision_rule }
  const expectedKey = mechanismKey({ mechanism: raw.mechanism, intervention: raw.intervention, outcome: raw.outcomeVariable, conditions: [raw.scope, raw.decision_rule] })
  const candidate = { id: 'candidate-selected', parent: { id: oldHypothesis.id, version: oldHypothesis.version }, mechanismKey: expectedKey, changedAssumption: 'relevance gating', prediction: hypothesis.prediction, disconfirmingObservation: hypothesis.falsification, sourceEvidenceIds: ['evidence'], sourceSpanIds: [], distinguishes: ['relevance'], unresolvedConstraints: [], estimatedCost: 1, feasible: true, status: 'selected' as const }
  const batch = core.sealRecord({ id: 'candidate-batch-1', version: 1, created_at: at, source_refs: [], snapshotHash: parent.content_hash, proposalSnapshotHash: parent.content_hash,
    selection: { policyVersion: 'rules-v1' as const, candidateIds: [candidate.id], selectedId: candidate.id, reasons: { [candidate.id]: ['selected'] }, snapshotHash: parent.content_hash, stopReason: null },
    selectionInput: { snapshotHash: parent.content_hash, remainingCost: 1, testedMechanismKeys: [], registeredAlternatives: [] },
    entries: [{ raw, candidate, revision: { statement: hypothesis.statement, scope: hypothesis.scope, mechanism: hypothesis.mechanism, alternatives: [], prediction: hypothesis.prediction, falsification: hypothesis.falsification, measurement: hypothesis.measurement, decision_rule: hypothesis.decision_rule, evidence_ids: [], rationale: 'changed assumption' }, admissionReasons: [], reasons: ['selected'] }], basis: [] })
  const assessment = core.sealRecord({ ...parent.assessment!, id: 'assessment-successor', version: parent.assessment!.version + 1, claim: parent.active_claim, protocol_hash: protocol.content_hash })
  const snapshot = core.sealRecord({ ...parent, id: 'service-e2e-successor', version: 2, parent_snapshot_id: parent.id, hypotheses: [oldHypothesis, hypothesis], active_hypothesis: { id: hypothesis.id, version: hypothesis.version }, protocol, assessment, candidate_batches: [batch] })
  await store.commit(snapshot)
  const projectRoot = await realpath(project)
  const pending = await enqueueRefutedDirection({ projectDir: projectRoot, runDir: run, snapshot })
  assert.equal(pending?.mechanismKey, expectedKey)
  await persistRetirementMemory(projectRoot, pending!)
  const memory = (await new ProjectDirectionMemoryStore(projectRoot).read()).find(record => record.mechanismKey === expectedKey)
  assert.ok(memory)
  const hints = await selectionHintsForMechanisms(projectRoot, [expectedKey])
  assert.deepEqual(hints.avoidedMechanismKeys, [expectedKey])
  const decision = selectCandidate([candidate], { snapshotHash: snapshot.content_hash, remainingCost: 1, testedMechanismKeys: [], registeredAlternatives: [], ...hints })
  assert.equal(decision.selectedId, null)
  assert.match(decision.reasons[candidate.id]!.join(' '), /project_direction_memory/)
})

test('automatic cleanup persists memory, protects live runs, then deletes exact owned output', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-cleanup-e2e-project-'))
  const run = await mkdtemp(join(project, 'run-'))
  const direction = { projectId: project, branchId: 'branch', claim: { id: 'claim', version: 1 }, hypothesis: { id: 'hypothesis', version: 1 }, protocolHash: 'protocol' }
  try {
    const state = await createInitialState(run)
    const projectRoot = await realpath(project)
    await mkdir(join(run, '.autoresearch'), { recursive: true })
    await writeFile(join(run, '.autoresearch', 'project-identity.json'), JSON.stringify({ projectDir: projectRoot, projectId: hashBytes(JSON.stringify({ projectDir: projectRoot })) }))
    const manifest = await openDirectionManifest(run, direction)
    const output = join(run, 'work', 'result.json')
    await mkdir(join(run, 'work'), { recursive: true })
    await writeFile(output, 'owned result')
    const artifact = await registerManagedArtifact(run, manifest.id, { relativePath: 'work/result.json', sourceId: 'owned-result', kind: 'result', producer: 'worker' })
    const currentManifest = await loadDirectionManifest(run, manifest.id)
    const task = await enqueueRetirement({ projectDir: project, runDir: run, direction, disposition: 'refuted', idea: 'A compact idea', reason: 'Validated formal evidence refuted it', avoidRepeat: 'Do not retry the same mechanism', targets: [artifact], manifestId: manifest.id, manifestHash: currentManifest.contentHash })
    state.status = 'RUNNING'
    await saveState(run, state)
    let result = await advanceCleanupQueue(project)
    assert.equal(result[0]?.state, 'waiting_live')
    assert.ok(await readFile(output, 'utf8'))
    state.status = 'COMPLETED'
    await saveState(run, state)
    result = await advanceCleanupQueue(project)
    assert.equal(result[0]?.state, 'completed')
    await assert.rejects(() => readFile(output, 'utf8'), /ENOENT/)
    assert.equal(task.id, result[0]?.id)
    assert.equal((await readFile(join(project, '.autoresearch', 'direction-memory.json'), 'utf8')).includes('A compact idea'), true)
  } finally { await rm(project, { recursive: true, force: true }) }
})

test('AutoResearchService terminal resume enqueues and completes refuted-direction cleanup without redispatch', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-cleanup-service-project-'))
  const run = join(project, 'run')
  await mkdir(run, { recursive: true })
  let providerCalls = 0
  try {
    const projectRoot = await realpath(project)
    await mkdir(join(run, '.autoresearch'), { recursive: true })
    await writeFile(join(run, '.autoresearch', 'project-identity.json'), JSON.stringify({ version: 1, projectDir: projectRoot, projectId: artifactHash({ projectDir: projectRoot }), workflow: 'research', validation: 'bounded-supplementary', options: {} }))
    const state = await createInitialState(run)
    state.status = 'COMPLETED'
    await saveState(run, state)
    const store = new core.ResearchStore(run)
    const { snapshot } = await makeRefutedSnapshot(store)
    const direction = { projectId: projectRoot, branchId: snapshot.branch_id, claim: snapshot.active_claim, hypothesis: snapshot.active_hypothesis, protocolHash: snapshot.protocol.content_hash }
    const output = join(run, 'cycles', 'cycle-1', 'service-owned.json')
    await mkdir(join(run, 'cycles', 'cycle-1'), { recursive: true })
    await writeFile(output, 'service-owned')
    await mkdir(join(run, '.autoresearch', 'directions'), { recursive: true })
    const manifestPath = join(run, '.autoresearch', 'directions', `${directionId(direction)}.json`)
    await writeFile(manifestPath, '{}')
    const service = new AutoResearchService({ run: (async () => { providerCalls++; throw new Error('terminal resume must not dispatch a provider') }) as never })
    const result = await service.run({ runDir: run, projectDir: projectRoot }, { signal: new AbortController().signal } as never)
    assert.equal(result.status, 'COMPLETED')
    assert.equal(providerCalls, 0)
    const queue = await import('../../dist/cleanup/queue.js')
    assert.equal(await readFile(output, 'utf8'), 'service-owned')
    const deferred = await queue.listCleanupTasks(projectRoot)
    assert.equal(deferred.length, 1)
    assert.equal(deferred[0].state, 'blocked')
    await rm(manifestPath)
    await openDirectionManifest(run, direction)
    const resumedAfterRepair = await service.run({ runDir: run, projectDir: projectRoot }, { signal: new AbortController().signal } as never)
    assert.equal(resumedAfterRepair.status, 'COMPLETED')
    assert.equal(providerCalls, 0)
    await assert.rejects(() => readFile(output, 'utf8'), /ENOENT/)
    const tasks = await queue.listCleanupTasks(projectRoot)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].state, 'completed')
    assert.match(await readFile(join(projectRoot, '.autoresearch', 'direction-memory.json'), 'utf8'), /A direction created by the service E2E/)
    const resumed = await service.run({ runDir: run, projectDir: projectRoot }, { signal: new AbortController().signal } as never)
    assert.equal(resumed.status, 'COMPLETED')
    assert.equal(providerCalls, 0)
    assert.equal((await queue.listCleanupTasks(projectRoot)).length, 1)
    await assert.rejects(() => readFile(output, 'utf8'), /ENOENT/)
  } finally { await rm(project, { recursive: true, force: true }) }
})

test('PAUSED resume recognizes a completed retired direction before provider dispatch', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ar-cleanup-paused-project-'))
  const run = join(project, 'run')
  await mkdir(run, { recursive: true })
  let providerCalls = 0
  try {
    const projectRoot = await realpath(project)
    await mkdir(join(run, '.autoresearch'), { recursive: true })
    await writeFile(join(run, '.autoresearch', 'project-identity.json'), JSON.stringify({ version: 1, projectDir: projectRoot, projectId: artifactHash({ projectDir: projectRoot }), workflow: 'research', validation: 'bounded-supplementary', options: {} }))
    const state = await createInitialState(run)
    state.status = 'PAUSED'
    await saveState(run, state)
    const store = new core.ResearchStore(run)
    const { snapshot } = await makeRefutedSnapshot(store)
    const direction = { projectId: projectRoot, branchId: snapshot.branch_id, claim: snapshot.active_claim, hypothesis: snapshot.active_hypothesis, protocolHash: snapshot.protocol.content_hash }
    const manifest = await openDirectionManifest(run, direction)
    const output = join(run, 'work', 'paused-owned.json')
    await mkdir(join(run, 'work'), { recursive: true })
    await writeFile(output, 'paused-owned')
    const target = await registerManagedArtifact(run, manifest.id, { relativePath: 'work/paused-owned.json', sourceId: 'paused-output', kind: 'result', producer: 'paused-e2e' })
    const currentManifest = await loadDirectionManifest(run, manifest.id)
    await enqueueRetirement({ projectDir: projectRoot, runDir: run, direction, disposition: 'refuted', idea: 'Paused retired direction', reason: 'Validated formal refutation', avoidRepeat: 'Do not retry this frozen direction', targets: [target], manifestId: manifest.id, manifestHash: currentManifest.contentHash })
    const service = new AutoResearchService({ run: (async () => { providerCalls++; throw new Error('retired PAUSED direction must not dispatch') }) as never })
    const result = await service.run({ runDir: run, projectDir: projectRoot }, { signal: new AbortController().signal } as never)
    assert.equal(result.status, 'PAUSED')
    assert.match(result.lastError ?? '', /direction retired/i)
    assert.equal(providerCalls, 0)
    await assert.rejects(() => readFile(output, 'utf8'), /ENOENT/)
    const resumed = await service.run({ runDir: run, projectDir: projectRoot }, { signal: new AbortController().signal } as never)
    assert.equal(resumed.status, 'PAUSED')
    assert.equal(providerCalls, 0)
  } finally { await rm(project, { recursive: true, force: true }) }
})
