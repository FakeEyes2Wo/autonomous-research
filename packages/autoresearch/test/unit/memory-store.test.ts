import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileMemoryStore, recordResearchExperience, type MemoryRecordInput } from '../../dist/memory/index.js'

const base = (id: string, overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput => ({
  id,
  version: 1,
  kind: 'observation',
  scope: { visibility: 'branch', projectId: 'project-a', branchId: 'branch-a' },
  content: { observation: `observed ${id}` },
  provenance: { sourceIds: [`source-${id}`], sourceHashes: { [`source-${id}`]: id.padEnd(64, '0').slice(0, 64) }, createdAt: '2026-09-12T00:00:00.000Z' },
  applicability: { appliesWhen: ['same protocol'], doesNotApplyWhen: ['different treatment'] },
  assessment: { status: 'candidate', method: 'captured event', supportingSourceIds: [], opposingSourceIds: [] },
  dependencies: [],
  topicIds: ['claim-1'],
  ...overrides,
})

test('memory append is idempotent but rejects a mismatched replay', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-memory-idempotent-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const store = new FileMemoryStore(runDir)
  const first = await store.append(base('memory-1'))
  const replay = await store.append(base('memory-1'))
  assert.equal(first.appended, true)
  assert.equal(replay.appended, false)
  assert.equal(replay.record.contentHash, first.record.contentHash)
  await assert.rejects(
    () => store.append(base('memory-1', { content: { observation: 'changed replay' } })),
    (error: Error & { code?: string }) => error.code === 'MEMORY_CONFLICT',
  )
})

test('memory store rejects a record whose persisted content no longer matches its hash', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-memory-hash-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const store = new FileMemoryStore(runDir)
  await store.append(base('memory-hash'))
  const raw = await readFile(store.path, 'utf8')
  await writeFile(store.path, raw.replace('observed memory-hash', 'tampered memory-hash'), 'utf8')
  await assert.rejects(() => store.readAll(), /memory hash mismatch/)
})

test('memory query enforces explicit visibility and keeps disputed opposing observations', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-memory-scope-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const store = new FileMemoryStore(runDir)
  await store.append(base('project-rule', { kind: 'decision', scope: { visibility: 'project', projectId: 'project-a' }, content: { decision: 'fixed budget', rationale: 'user constraint' }, assessment: { status: 'validated_in_scope', method: 'explicit instruction', supportingSourceIds: ['source-project-rule'], opposingSourceIds: [] } }))
  await store.append(base('opposing', { polarity: 'opposing', assessment: { status: 'disputed', method: 'conflicting replications', supportingSourceIds: [], opposingSourceIds: ['source-opposing'] } }))
  await store.append(base('other-branch', { scope: { visibility: 'branch', projectId: 'project-a', branchId: 'branch-b' } }))
  await store.append(base('test-only', { scope: { visibility: 'split', projectId: 'project-a', branchId: 'branch-a', split: 'test' } }))
  const records = await store.query({ scope: { projectId: 'project-a', branchId: 'branch-a', runId: 'run-a', split: 'train' }, role: 'supervisor' })
  assert.deepEqual(new Set(records.map((entry) => entry.id)), new Set(['project-rule', 'opposing']))
  assert.equal(records.find((entry) => entry.id === 'opposing')?.assessment.status, 'disputed')
})

test('invalidating a source appends invalidated versions of dependent summaries', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-memory-invalidate-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const store = new FileMemoryStore(runDir)
  const source = (await store.append(base('source-memory', { assessment: { status: 'validated_in_scope', method: 'reproduced', supportingSourceIds: ['source-source-memory'], opposingSourceIds: [] } }))).record
  const firstSummary = (await store.append(base('dependent-summary', {
    kind: 'interpretation',
    summary: true,
    content: { observation: 'source result', interpretation: 'general lesson' },
    dependencies: [{ id: source.id, version: source.version, contentHash: source.contentHash }],
    assessment: { status: 'validated_in_scope', method: 'source review', supportingSourceIds: ['source-source-memory'], opposingSourceIds: [] },
  }))).record
  await store.append(base('second-summary', {
    kind: 'interpretation',
    summary: true,
    content: { observation: 'source result', interpretation: 'higher-level lesson' },
    dependencies: [{ id: firstSummary.id, version: firstSummary.version, contentHash: firstSummary.contentHash }],
    assessment: { status: 'validated_in_scope', method: 'summary review', supportingSourceIds: ['source-source-memory'], opposingSourceIds: [] },
  }))
  await store.transition('source-memory', 'invalidated', { method: 'invalid scorer', opposingSourceIds: ['audit-1'] })
  await store.transition('source-memory', 'invalidated', { method: 'invalid scorer', opposingSourceIds: ['audit-1'] })
  const history = await store.readAll()
  const latestSummary = history.filter((entry) => entry.id === 'dependent-summary').at(-1)
  const secondSummary = history.filter((entry) => entry.id === 'second-summary').at(-1)
  assert.equal(history.filter((entry) => entry.id === 'source-memory').length, 2)
  assert.equal(history.filter((entry) => entry.id === 'dependent-summary').length, 2)
  assert.equal(history.filter((entry) => entry.id === 'second-summary').length, 2)
  assert.equal(latestSummary?.version, 2)
  assert.equal(latestSummary?.assessment.status, 'invalidated')
  assert.match(latestSummary?.assessment.method ?? '', /dependency source-memory@1 invalidated/)
  assert.equal(secondSummary?.assessment.status, 'invalidated')
})

test('research experience recording separates observations, interpretations, and committed decisions idempotently', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-memory-experience-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const input = {
    scope: { visibility: 'run', projectId: 'project-a', branchId: 'branch-a', runId: 'run-a' },
    createdAt: '2026-09-12T12:00:00.000Z',
    snapshot: { id: 'snapshot-1', version: 1, contentHash: 'a'.repeat(64) },
    protocolHash: 'b'.repeat(64),
    evidence: [{
      id: 'evidence-1', version: 1, contentHash: 'c'.repeat(64), observation: 'metric fell by 0.2', interpretation: 'mechanism may be wrong',
      polarity: 'opposes', validity: 'valid', mode: 'formal', split: 'held-out',
    }],
    assessment: { id: 'assessment-1', version: 1, contentHash: 'd'.repeat(64), reason: 'valid opposing interval' },
    decision: { id: 'decision-1', version: 1, contentHash: 'e'.repeat(64), action: 'revise', reason: 'test a competing mechanism' },
  } as const
  await recordResearchExperience(runDir, input)
  await recordResearchExperience(runDir, input)
  const records = await new FileMemoryStore(runDir).readAll()
  assert.deepEqual(records.map((entry) => [entry.id, entry.kind, entry.assessment.status]), [
    ['observation:evidence-1', 'observation', 'validated_in_scope'],
    ['interpretation:evidence-1', 'interpretation', 'candidate'],
    ['assessment:assessment-1', 'interpretation', 'candidate'],
    ['decision:decision-1', 'decision', 'validated_in_scope'],
  ])
  assert.equal(records.find((entry) => entry.id === 'interpretation:evidence-1')?.content.observation, 'metric fell by 0.2')
})
