import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as core from '../../dist/research/index.js'
import { hashBytes } from '../../dist/research/records.js'
import { atomicWriteJson } from '../../dist/core/utils.js'
import { createInitialState, saveState } from '../../dist/core/state.js'
import { enqueueRetirement, persistRetirementMemory } from '../../dist/cleanup/queue.js'
import { enqueueRefutedDirection } from '../../dist/cleanup/index.js'
import { executeCleanupTask } from '../../dist/cleanup/executor.js'
import { loadDirectionManifest, openDirectionManifest, registerManagedArtifact } from '../../dist/cleanup/manifest.js'
import { registerDirectionCycleArtifacts } from '../../dist/cleanup/registration.js'
import { loadSourceTombstones } from '../../dist/cleanup/tombstones.js'

const at = '2026-09-12T00:00:00.000Z'

function baseSnapshot() {
  const base = { version: 1, created_at: at, source_refs: [] }
  const claim = core.sealRecord({ ...base, id: 'claim', statement: 'unknown benefit', scope: 'tasks', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: 'intake' })
  const hypothesis = core.sealRecord({ ...base, id: 'hypothesis', statement: 'test benefit', claim: { id: claim.id, version: 1 }, parents: [], mechanism: '', alternatives: [], prediction: '', falsification: '', measurement: '', decision_rule: '', scope: 'tasks', mode: 'unknown', status: 'proposed' })
  const protocol = core.sealRecord({ ...base, id: 'protocol', hypothesis: { id: hypothesis.id, version: 1 }, metric: '', controls: [], sample: '', split: 'heldout', seeds: [], budget: { unit: 'unknown', limit: 0, tolerance: 0 }, stopping_rule: 'bounded', failure_policy: 'exclude_from_mechanism', missing_policy: 'unknown', duplicate_policy: 'block_conflicts', fingerprints: { code: 'code', data: 'data', treatment: 'treatment', model: 'model' }, provenance: 'known', decision_rule: 'paired_sign_test_v1' })
  return { base, claim, hypothesis, protocol }
}

async function judgedSnapshot(store: core.ResearchStore, polarity: 'supports' | 'opposes' = 'opposes', claimVersion = 1) {
  const { base, claim: proposedClaim } = baseSnapshot()
  const claim = core.sealRecord({ ...proposedClaim, version: claimVersion })
  const hypothesis = core.sealRecord({ ...base, id: 'hypothesis', version: claimVersion, statement: 'test benefit', claim: { id: claim.id, version: claimVersion }, parents: [], mechanism: '', alternatives: [], prediction: '', falsification: '', measurement: '', decision_rule: 'paired_sign_test_v1', scope: 'tasks', mode: 'unknown', status: 'proposed' })
  const protocol = core.sealRecord({ ...base, id: 'protocol', hypothesis: { id: hypothesis.id, version: claimVersion }, metric: '', controls: [], sample: '', split: 'heldout', seeds: [], budget: { unit: 'unknown', limit: 0, tolerance: 0 }, stopping_rule: 'bounded', failure_policy: 'exclude_from_mechanism', missing_policy: 'unknown', duplicate_policy: 'block_conflicts', fingerprints: { code: 'code', data: 'data', treatment: 'treatment', model: 'model' }, provenance: 'known', decision_rule: 'paired_sign_test_v1' })
  const artifact = await store.captureBytes('raw source bytes', 'raw')
  const analysis = await store.captureBytes('analysis bytes', 'analysis')
  const evidence = core.sealRecord({ id: 'e1', version: 1, created_at: at, source_refs: [], target_claim: { id: claim.id, version: claimVersion }, protocol_hash: protocol.content_hash, attempt_id: 'a1', artifacts: [artifact], analysis, validity: 'valid', polarity, execution: 'completed', observation: 'validated comparison', split: protocol.split, mode: 'formal', fingerprints: protocol.fingerprints, validation: { method: protocol.decision_rule, passed: true, issues: [] } })
  const assessment = core.assessEvidence({ claim, hypothesis, protocol, evidence: [evidence], createdAt: at })
  const updatedClaim = core.sealRecord({ ...claim, status: assessment.claim_status, supporting_evidence_ids: assessment.supporting_evidence_ids, opposing_evidence_ids: assessment.opposing_evidence_ids })
  const snapshot = core.sealRecord({ ...base, id: `snapshot-${claimVersion}`, schema: 'autoresearch/research-snapshot/v1', branch_id: 'main', claims: [updatedClaim], hypotheses: [hypothesis], protocol, evidence: [evidence], active_claim: { id: updatedClaim.id, version: updatedClaim.version }, active_hypothesis: { id: hypothesis.id, version: claimVersion }, assessment, budget: { revisions: 0, repairs: 0, tokens: 123 } })
  return { snapshot, artifact }
}

test('deleted source blobs remain loadable through a trusted tombstone but cannot enter a new formal commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-research-tombstone-'))
  const projectDir = join(root, 'project')
  const runDir = join(root, 'run')
  await mkdir(projectDir, { recursive: true })
  await mkdir(runDir, { recursive: true })
  try {
    const project = resolve(projectDir)
    await atomicWriteJson(join(runDir, '.autoresearch', 'project-identity.json'), { version: 1, projectDir: project, projectId: hashBytes(JSON.stringify({ projectDir: project })), workflow: 'research', validation: 'bounded-supplementary', options: {} })
    const state = await createInitialState(runDir); state.status = 'COMPLETED'; await saveState(runDir, state)
    const store = new core.ResearchStore(runDir)
    const { snapshot, artifact } = await judgedSnapshot(store)
    await store.commit(snapshot)
    const direction = { projectId: project, branchId: snapshot.branch_id, claim: { id: snapshot.active_claim.id, version: 1 }, hypothesis: snapshot.active_hypothesis, protocolHash: snapshot.protocol.content_hash }
    const manifest = await openDirectionManifest(runDir, direction)
    const registered = await registerManagedArtifact(runDir, manifest.id, { relativePath: artifact.path!, sourceId: artifact.id, kind: 'research-output', producer: 'autoresearch-controller' })
    const pending = await enqueueRefutedDirection({ projectDir: project, runDir, snapshot })
    assert.ok(pending)
    const task = await persistRetirementMemory(project, pending)
    const result = await executeCleanupTask(project, task)
    assert.equal(result.task.state, 'completed')
    assert.equal(await store.loadCurrent().then(value => value?.id), snapshot.id)
    const next = core.sealRecord({ ...snapshot, id: 'next', version: 2, parent_snapshot_id: snapshot.id, budget: { ...snapshot.budget, tokens: 124 } })
    await assert.rejects(() => store.commit(next), /tombstoned|formal evidence|admissible/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cleanup refuses explicit abandonment of a canonically supported direction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-research-supported-cleanup-'))
  const projectDir = join(root, 'project')
  const runDir = join(root, 'run')
  await mkdir(projectDir, { recursive: true }); await mkdir(runDir, { recursive: true })
  try {
    const project = resolve(projectDir)
    await atomicWriteJson(join(runDir, '.autoresearch', 'project-identity.json'), { version: 1, projectDir: project, projectId: hashBytes(JSON.stringify({ projectDir: project })), workflow: 'research', validation: 'bounded-supplementary', options: {} })
    const state = await createInitialState(runDir); state.status = 'COMPLETED'; await saveState(runDir, state)
    const store = new core.ResearchStore(runDir)
    const { snapshot, artifact } = await judgedSnapshot(store, 'supports', 2)
    await store.commit(snapshot)
    const direction = { projectId: project, branchId: snapshot.branch_id, claim: { id: snapshot.active_claim.id, version: 1 }, hypothesis: snapshot.active_hypothesis, protocolHash: snapshot.protocol.content_hash }
    const opened = await openDirectionManifest(runDir, direction)
    const registered = await registerManagedArtifact(runDir, opened.id, { relativePath: artifact.path!, sourceId: artifact.id, kind: 'research-output', producer: 'autoresearch-controller' })
    const manifest = await loadDirectionManifest(runDir, opened.id)
    const pending = await enqueueRetirement({ projectDir: project, runDir, direction, disposition: 'abandoned', idea: 'A supported direction', reason: 'Explicitly abandoned by the user', avoidRepeat: 'Do not retry this exact direction', targets: [registered], manifestId: manifest.id, manifestHash: manifest.contentHash })
    const task = await persistRetirementMemory(project, pending)
    const result = await executeCleanupTask(project, task)
    assert.equal(result.task.state, 'blocked')
    assert.match(result.blocked.join(' '), /supported/i)
    assert.equal((await store.loadCurrent()).id, snapshot.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('real cycle registration preserves same-byte source aliases after cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ar-research-tombstone-alias-'))
  const projectDir = join(root, 'project')
  const runDir = join(root, 'run')
  await mkdir(projectDir, { recursive: true })
  await mkdir(runDir, { recursive: true })
  try {
    const project = resolve(projectDir)
    await atomicWriteJson(join(runDir, '.autoresearch', 'project-identity.json'), { version: 1, projectDir: project, projectId: hashBytes(JSON.stringify({ projectDir: project })), workflow: 'research', validation: 'bounded-supplementary', options: {} })
    const state = await createInitialState(runDir); state.status = 'COMPLETED'; await saveState(runDir, state)
    const store = new core.ResearchStore(runDir)
    const { base, claim, hypothesis, protocol } = baseSnapshot()
    const bytes = Buffer.from('same source bytes')
    const sourceHash = hashBytes(bytes)
    const sourceA = { id: 'raw-a', path: 'research/sources/alias', hash: sourceHash }
    const sourceB = { id: 'raw-b', path: 'research/sources/alias', hash: sourceHash }
    await mkdir(join(runDir, 'research', 'sources'), { recursive: true })
    await writeFile(join(runDir, sourceA.path), bytes)
    const snapshot = core.sealRecord({ ...base, source_refs: [sourceA, sourceB], id: 'alias-snapshot-1', schema: 'autoresearch/research-snapshot/v1', branch_id: 'main', claims: [claim], hypotheses: [hypothesis], protocol, evidence: [], active_claim: { id: claim.id, version: 1 }, active_hypothesis: { id: hypothesis.id, version: 1 }, budget: { revisions: 0, repairs: 0, tokens: 123 } })
    await store.commit(snapshot)
    const direction = { projectId: project, branchId: snapshot.branch_id, claim: snapshot.active_claim, hypothesis: snapshot.active_hypothesis, protocolHash: snapshot.protocol.content_hash }
    const opened = await openDirectionManifest(runDir, direction)
    await registerDirectionCycleArtifacts({ runDir, cycle: 1, direction, snapshot })
    const manifest = await loadDirectionManifest(runDir, opened.id)
    assert.equal(manifest.artifacts.filter(item => item.relativePath === sourceA.path).length, 1)
    const pending = await enqueueRetirement({ projectDir: project, runDir, direction, disposition: 'abandoned', idea: 'Alias direction', reason: 'Explicitly abandoned by the user', avoidRepeat: 'Do not retry this exact direction', targets: manifest.artifacts.filter(item => item.ownership === 'direction'), manifestId: manifest.id, manifestHash: manifest.contentHash })
    const task = await persistRetirementMemory(project, pending)
    const result = await executeCleanupTask(project, task)
    assert.equal(result.task.state, 'completed')
    assert.equal((await loadSourceTombstones(runDir)).length, 1)
    assert.equal((await store.loadCurrent()).id, snapshot.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})
