import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../../dist/research/index.js'

const at = '2026-09-12T00:00:00.000Z'
function snapshot(id = 'initial') {
  const base = { version: 1, created_at: at, source_refs: [] }
  const claim = core.sealRecord({ ...base, id: 'claim', statement: 'unknown benefit', scope: 'tasks', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: 'intake' })
  const hypothesis = core.sealRecord({ ...base, id: 'hypothesis', statement: 'test benefit', claim: { id: claim.id, version: 1 }, parents: [], mechanism: '', alternatives: [], prediction: '', falsification: '', measurement: '', decision_rule: '', scope: 'tasks', mode: 'unknown', status: 'proposed' })
  const protocol = core.sealRecord({ ...base, id: 'protocol', hypothesis: { id: hypothesis.id, version: 1 }, metric: '', controls: [], sample: '', split: 'unknown', seeds: [], budget: { unit: 'unknown', limit: 0, tolerance: 0 }, stopping_rule: 'bounded', failure_policy: 'exclude_from_mechanism', missing_policy: 'unknown', duplicate_policy: 'block_conflicts', fingerprints: { code: 'unknown', data: 'unknown', treatment: 'unknown', model: 'unknown' }, provenance: 'unknown', decision_rule: '' })
  return core.sealRecord({ ...base, id, schema: 'autoresearch/research-snapshot/v1', branch_id: 'main', claims: [claim], hypotheses: [hypothesis], protocol, evidence: [], active_claim: { id: claim.id, version: 1 }, active_hypothesis: { id: hypothesis.id, version: 1 }, budget: { revisions: 0, repairs: 0, tokens: 123 } })
}

async function workspace(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'ar-research-store-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('source capture preserves immutable bytes when live outputs append', async () => workspace(async (dir) => {
  assert.equal(typeof core.ResearchStore, 'function', 'research store must exist')
  const store = new core.ResearchStore(dir)
  await writeFile(join(dir, 'raw.json'), 'abc')
  const ref = await store.captureSource('raw.json', 'raw')
  assert.equal(ref.hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.notEqual(ref.path, 'raw.json')
  const initial = core.sealRecord({ ...snapshot(), source_refs: [ref] })
  await store.commit(initial)
  await writeFile(join(dir, 'raw.json'), 'new data')
  assert.equal((await store.loadCurrent()).id, 'initial')
  await writeFile(join(dir, ref.path), 'tampered')
  await assert.rejects(() => store.loadCurrent(), /source hash mismatch/i)
}))

test('commits recover an orphan manifest and replay without duplicate revisions or pointer rollback', async () => workspace(async (dir) => {
  assert.equal(typeof core.ResearchStore, 'function', 'research store must exist')
  const store = new core.ResearchStore(dir)
  const first = snapshot()
  await store.commit(first)
  const next = core.sealRecord({ ...first, id: 'second', version: 2, parent_snapshot_id: first.id, budget: { ...first.budget, tokens: 150 } })
  await mkdir(join(dir, 'research', 'snapshots', next.id), { recursive: true })
  await writeFile(join(dir, 'research', 'snapshots', next.id, 'manifest.json'), JSON.stringify(next))
  await store.commit(next)
  await store.commit(next)
  await store.commit(first)
  assert.equal((await store.loadCurrent()).id, 'second')
  assert.equal((await store.loadCurrent()).budget.tokens, 150)
  assert.equal((await readdir(join(dir, 'research', 'snapshots'))).length, 2)
  await assert.rejects(() => store.commit(core.sealRecord({ ...next, budget: { ...next.budget, tokens: 999 } })), /immutable|conflict/i)
  await assert.rejects(() => store.commit(core.sealRecord({ ...next, id: 'stale-child' })), /parent|stale/i)
}))

test('parallel writers cannot advance two siblings or overwrite canonical history', async () => workspace(async (dir) => {
  assert.equal(typeof core.ResearchStore, 'function', 'research store must exist')
  const first = snapshot()
  await new core.ResearchStore(dir).commit(first)
  const results = await Promise.allSettled(['left', 'right'].map((id) => new core.ResearchStore(dir).commit(core.sealRecord({ ...first, id, version: 2, parent_snapshot_id: first.id }))))
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
}))

test('corrupt pointers, stale hashes and changed historical versions fail explicitly', async () => workspace(async (dir) => {
  assert.equal(typeof core.ResearchStore, 'function', 'research store must exist')
  const store = new core.ResearchStore(dir)
  const first = snapshot()
  await store.commit(first)
  const changed = core.sealRecord({ ...first.claims[0], statement: 'rewrite history' })
  await assert.rejects(() => store.commit(core.sealRecord({ ...first, id: 'child', version: 2, parent_snapshot_id: first.id, claims: [changed] })), /historical|lineage/i)
  await writeFile(join(dir, 'CURRENT.json'), '{')
  await assert.rejects(() => store.loadCurrent(), /JSON|corrupt|parse/i)
}))

test('record-to-record references cannot claim a false content hash', async () => workspace(async (dir) => {
  const store = new core.ResearchStore(dir)
  const first = snapshot()
  const changed = core.sealRecord({ ...first, source_refs: [{ id: 'claim', hash: 'invented' }] })
  await assert.rejects(() => store.commit(changed), /reference|source hash/i)
}))

test('duplicate record versions cannot smuggle a second historical statement', async () => workspace(async (dir) => {
  const store = new core.ResearchStore(dir)
  const first = snapshot()
  const forged = core.sealRecord({ ...first.claims[0], statement: 'unsupported override' })
  await assert.rejects(() => store.commit(core.sealRecord({ ...first, claims: [...first.claims, forged] })), /duplicate|lineage|identity/i)
}))

test('a canonical supported claim cannot be bootstrapped from narration alone', async () => workspace(async (dir) => {
  const store = new core.ResearchStore(dir)
  const first = snapshot()
  const claim = core.sealRecord({ ...first.claims[0], status: 'supported', reason: 'model says it works' })
  await assert.rejects(() => store.commit(core.sealRecord({ ...first, claims: [claim] })), /scientific|evidence|provenance/i)
}))

test('source capture rejects traversal and realpath escapes', async () => workspace(async (dir) => {
  assert.equal(typeof core.ResearchStore, 'function', 'research store must exist')
  const store = new core.ResearchStore(dir)
  await assert.rejects(() => store.captureSource('../secret'), /escapes|containment/i)
  const outside = await mkdtemp(join(tmpdir(), 'ar-outside-'))
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(dir, 'outside-link'), 'junction')
    await assert.rejects(() => store.captureSource('outside-link/secret.txt'), /escapes|containment/i)
  } finally { await rm(outside, { recursive: true, force: true }) }
}))

test('failure report import creates unverified target provenance without altering terminal history', async () => workspace(async (dir) => {
  assert.equal(typeof core.importFailureReport, 'function', 'explicit historical report import must exist')
  const source = join(dir, 'terminal')
  const target = join(dir, 'new-run')
  await mkdir(source)
  await writeFile(join(source, 'state.json'), '{"status":"FAILED"}')
  await writeFile(join(source, 'FAILURE_REPORT.md'), 'The hypothesis failed.')
  const result = await core.importFailureReport({ sourceRunId: 'old-run', sourcePath: join(source, 'FAILURE_REPORT.md'), targetRunDir: target, branchId: 'imported' })
  assert.equal(result.provenance, 'unknown')
  assert.equal(result.source_run_id, 'old-run')
  assert.equal(result.source_refs[0].hash, core.hashBytes('The hypothesis failed.'))
  assert.equal(await readFile(join(source, 'state.json'), 'utf8'), '{"status":"FAILED"}')
  assert.deepEqual((await readdir(source)).sort(), ['FAILURE_REPORT.md', 'state.json'])
  await assert.rejects(() => core.importFailureReport({ sourceRunId: 'old-run', sourcePath: join(source, 'FAILURE_REPORT.md'), targetRunDir: source, branchId: 'bad' }), /distinct|source/i)
  await assert.rejects(() => core.importFailureReport({ sourceRunId: 'old-run', sourcePath: join(source, 'FAILURE_REPORT.md'), targetRunDir: join(source, 'new', 'nested'), branchId: 'bad' }), /distinct|source/i)
  assert.deepEqual((await readdir(source)).sort(), ['FAILURE_REPORT.md', 'state.json'])
}))

async function judgedSnapshot(store, polarity = 'opposes') {
  const first = snapshot()
  const protocol = core.sealRecord({ ...first.protocol, provenance: 'known', decision_rule: 'paired_sign_test_v1', split: 'heldout', fingerprints: { code: 'c1', data: 'd1', treatment: 't1', model: 'm1' } })
  const row = core.sealRecord({ id: 'e1', version: 1, created_at: at, source_refs: [], target_claim: first.active_claim, protocol_hash: protocol.content_hash, attempt_id: 'a1', artifacts: [await store.captureBytes('raw', 'raw')], analysis: await store.captureBytes('analysis', 'analysis'), validity: 'valid', polarity, execution: 'completed', observation: 'validated comparison', split: protocol.split, mode: 'formal', fingerprints: protocol.fingerprints, validation: { method: protocol.decision_rule, passed: true, issues: [] } })
  const assessment = core.assessEvidence({ claim: first.claims[0], hypothesis: first.hypotheses[0], protocol, evidence: [row], createdAt: at })
  const claim = core.sealRecord({ ...first.claims[0], version: 2, parents: [first.active_claim], status: assessment.claim_status, supporting_evidence_ids: assessment.supporting_evidence_ids, opposing_evidence_ids: assessment.opposing_evidence_ids })
  return core.sealRecord({ ...first, protocol, evidence: [row], assessment, claims: [...first.claims, claim], active_claim: { id: claim.id, version: 2 } })
}

test('canonical judgment cannot invert evidence or omit its matching assessment and protocol', async () => {
  for (const polarity of ['supports', 'opposes']) await workspace(async (dir) => {
    const store = new core.ResearchStore(dir)
    const valid = await judgedSnapshot(store, polarity)
    const invert = core.sealRecord({ ...valid.claims[1], status: polarity === 'supports' ? 'refuted' : 'supported', supporting_evidence_ids: ['e1'], opposing_evidence_ids: ['e1'] })
    await assert.rejects(() => store.commit(core.sealRecord({ ...valid, claims: [valid.claims[0], invert] })), /scientific|assessment|evidence/i)
    await assert.rejects(() => store.commit(core.sealRecord({ ...valid, assessment: undefined })), /scientific|assessment/i)
    await assert.rejects(() => store.commit(core.sealRecord({ ...valid, protocol: core.sealRecord({ ...valid.protocol, id: 'other', metric: 'different' }) })), /scientific|protocol|assessment/i)
    await store.commit(valid)
    const next = core.sealRecord({ ...valid, id: 'next', version: 2, parent_snapshot_id: valid.id, assessment: undefined, protocol: core.sealRecord({ ...valid.protocol, id: 'next-protocol', metric: 'new question' }) })
    await store.commit(next)
    assert.equal((await store.loadCurrent()).claims[1].status, polarity === 'supports' ? 'supported' : 'refuted')
  })
})

test('protocol assessment and failure identities cannot be rewritten after an intervening snapshot', async () => {
  for (const field of ['protocol', 'assessment', 'failure']) await workspace(async (dir) => {
    const store = new core.ResearchStore(dir)
    const first = await judgedSnapshot(store)
    await store.commit(first)
    const middle = core.sealRecord({ ...first, id: 'middle', version: 2, parent_snapshot_id: first.id, assessment: undefined, protocol: core.sealRecord({ ...first.protocol, id: 'middle-protocol' }) })
    await store.commit(middle)
    const patch = field === 'protocol' ? { protocol: core.sealRecord({ ...first.protocol, metric: 'changed without version' }) }
      : field === 'assessment' ? { assessment: core.sealRecord({ ...first.assessment, reason: 'changed without version' }) }
      : { assessment: core.sealRecord({ ...first.assessment, id: 'new-assessment', failures: [core.sealRecord({ ...first.assessment.failures[0], minimal_diagnostic: 'changed without version' })] }) }
    await assert.rejects(() => store.commit(core.sealRecord({ ...middle, ...patch, id: 'bad-child', version: 3, parent_snapshot_id: middle.id })), /immutable|identity|lineage/i)
    assert.equal((await store.loadCurrent()).id, 'middle')
  })
})
