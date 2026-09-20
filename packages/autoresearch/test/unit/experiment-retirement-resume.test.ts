import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hashBytes } from '../../dist/research/records.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../../dist/research/index.js'
import { loadState, saveState } from '../../dist/core/state.js'
import { runExperimentTask } from '../../dist/experiment/runner.js'
import { openDirectionManifest, registerManagedArtifact, loadDirectionManifest } from '../../dist/cleanup/manifest.js'
import { enqueueRetirement, listCleanupTasks } from '../../dist/cleanup/queue.js'
import { advanceCleanupQueue } from '../../dist/cleanup/index.js'
import { FakeAgentProvider } from '../integration/fake-agent-provider.ts'

const context = () => ({ parent: { id: 'retirement-test', session: { id: 'retirement-test' } }, signal: new AbortController().signal })
const at = '2026-09-20T00:00:00.000Z'

async function makeRefutedSnapshot(store: InstanceType<typeof core.ResearchStore>, source: { id: string; path: string; hash: string }) {
  const base = { version: 1, created_at: at, source_refs: [] }
  const claim = core.sealRecord({ ...base, id: 'claim', statement: 'temporary benefit', scope: 'tasks', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: 'intake' })
  const hypothesis = core.sealRecord({ ...base, id: 'hypothesis', statement: 'temporary direction', claim: { id: claim.id, version: 1 }, parents: [], mechanism: 'temporary mechanism', alternatives: [], prediction: 'benefit', falsification: 'no benefit', measurement: 'metric', decision_rule: 'paired_sign_test_v1', scope: 'tasks', mode: 'unknown', status: 'proposed' })
  const protocol = core.sealRecord({ ...base, id: 'protocol', hypothesis: { id: hypothesis.id, version: 1 }, metric: 'metric', controls: [], sample: 'bounded', split: 'heldout', seeds: [1], budget: { unit: 'run', limit: 1, tolerance: 0 }, stopping_rule: 'bounded', failure_policy: 'exclude_from_mechanism', missing_policy: 'unknown', duplicate_policy: 'block_conflicts', fingerprints: { code: 'code', data: 'data', treatment: 'treatment', model: 'model' }, provenance: 'known', decision_rule: 'paired_sign_test_v1' })
  const artifact = await store.captureBytes('raw retirement bytes', 'raw')
  const analysis = await store.captureBytes('analysis retirement bytes', 'analysis')
  const evidence = core.sealRecord({ id: 'evidence', version: 1, created_at: at, source_refs: [], target_claim: { id: claim.id, version: 1 }, protocol_hash: protocol.content_hash, attempt_id: 'attempt', artifacts: [artifact], analysis, validity: 'valid', polarity: 'opposes', execution: 'completed', observation: 'validated opposing result', split: protocol.split, mode: 'formal', fingerprints: protocol.fingerprints, validation: { method: protocol.decision_rule, passed: true, issues: [] } })
  const assessment = core.assessEvidence({ claim, hypothesis, protocol, evidence: [evidence], createdAt: at })
  const updatedClaim = core.sealRecord({ ...claim, version: 2, parents: [{ id: claim.id, version: 1 }], status: assessment.claim_status, opposing_evidence_ids: assessment.opposing_evidence_ids })
  const snapshot = core.sealRecord({ ...base, id: 'retired-snapshot', schema: 'autoresearch/research-snapshot/v1', branch_id: 'retirement-test', source_refs: [source], claims: [claim, updatedClaim], hypotheses: [hypothesis], protocol, evidence: [evidence], active_claim: { id: updatedClaim.id, version: updatedClaim.version }, active_hypothesis: { id: hypothesis.id, version: 1 }, assessment, budget: { revisions: 0, repairs: 0, tokens: 1 } })
  await store.commit(snapshot)
  return snapshot
}

test('retired experiment resume skips deleted research output binding but still advances cleanup', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'ar-experiment-retirement-project-'))
  const runDir = join(projectDir, 'run')
  t.after(() => rm(projectDir, { recursive: true, force: true }))

  const provider = new FakeAgentProvider({ decisions: ['finish'] })
  const first = await runExperimentTask({ provider }, { runDir, projectDir, task: 'Retirement resume fixture', maxRounds: 1, agentContext: context() })
  assert.equal(first.status, 'completed')

  // Replace the ordinary experiment research view with a canonical retired
  // snapshot so the wrapper resume exercises the deleted source path.
  await rm(join(runDir, 'research'), { recursive: true, force: true })
  await rm(join(runDir, 'CURRENT.json'), { force: true })
  const sourcePath = 'research/idea-generation-evaluations.json'
  const sourceText = JSON.stringify({ evaluations: [{ id: 'idea-1', raw: { statement: 'retired idea' }, revised: null, status: 'deferred' }] })
  await mkdir(join(runDir, 'research'), { recursive: true })
  await writeFile(join(runDir, sourcePath), sourceText, 'utf8')
  const snapshot = await makeRefutedSnapshot(new core.ResearchStore(runDir), { id: 'idea-generation-evaluations', path: sourcePath, hash: hashBytes(sourceText) })
  const savedState = await loadState(runDir)
  assert.ok(savedState)
  savedState!.status = 'COMPLETED'
  await saveState(runDir, savedState!)

  const direction = { projectId: projectDir, branchId: snapshot.branch_id, claim: snapshot.active_claim, hypothesis: snapshot.active_hypothesis, protocolHash: snapshot.protocol.content_hash }
  const manifest = await openDirectionManifest(runDir, direction)
  const managed = await registerManagedArtifact(runDir, manifest.id, { relativePath: sourcePath, sourceId: 'idea-generation-evaluations', kind: 'research-output', producer: 'retirement-fixture' })
  const currentManifest = await loadDirectionManifest(runDir, manifest.id)
  await enqueueRetirement({ projectDir, runDir, direction, disposition: 'refuted', idea: 'retired idea', reason: 'formal refutation', avoidRepeat: 'do not retry', targets: [managed], manifestId: manifest.id, manifestHash: currentManifest.contentHash })
  savedState!.status = 'COMPLETED'
  await saveState(runDir, savedState!)
  const cleanup = await advanceCleanupQueue(projectDir)
  assert.equal(cleanup[0]?.state, 'completed')
  await assert.rejects(() => readFile(join(runDir, sourcePath), 'utf8'), /ENOENT/)

  savedState!.status = 'PAUSED'
  await saveState(runDir, savedState!)
  const callsBeforeResume = provider.calls.length
  const resumed = await runExperimentTask({ provider }, { runDir, projectDir, task: 'Retirement resume fixture', maxRounds: 1, agentContext: context() })
  assert.equal(resumed.status, 'paused')
  assert.match(resumed.reason ?? '', /direction retired/i)
  assert.equal(provider.calls.length, callsBeforeResume)
  assert.equal((await listCleanupTasks(projectDir))[0]?.state, 'completed')
})
