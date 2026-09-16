import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assembleResearchContext,
  sealContextRecord,
  selectContextRecords,
  type ContextRecordInput,
  type ResearchContextScope,
} from '../../dist/research-context/index.js'
import { FileMemoryStore } from '../../dist/memory/index.js'

const requestScope: ResearchContextScope = { projectId: 'project-a', branchId: 'branch-a', runId: 'run-a', split: 'train' }

function record(id: string, overrides: Partial<ContextRecordInput> = {}) {
  return sealContextRecord({
    id,
    version: 1,
    layer: 2,
    kind: 'evidence',
    scope: { visibility: 'branch', projectId: 'project-a', branchId: 'branch-a' },
    payload: { observation: id },
    topicIds: ['claim-1'],
    polarity: 'supporting',
    source: { recordType: 'Evidence' },
    ...overrides,
  })
}

test('research context filters scope and role before deterministic ranking', () => {
  const eligible = record('eligible', { accessRoles: ['planner'] })
  const otherBranch = record('other-branch', { scope: { visibility: 'branch', projectId: 'project-a', branchId: 'branch-b' } })
  const otherSplit = record('other-split', { scope: { visibility: 'split', projectId: 'project-a', branchId: 'branch-a', split: 'test' } })
  const otherRole = record('other-role', { accessRoles: ['paper-writer'] })
  const projectConstraint = record('project-constraint', {
    layer: 0,
    kind: 'constraint',
    required: true,
    scope: { visibility: 'project', projectId: 'project-a' },
    payload: { rule: 'fixed rubric' },
  })
  const first = selectContextRecords(
    [otherRole, otherSplit, eligible, otherBranch, projectConstraint],
    { role: 'planner', stage: 'design', scope: requestScope },
    { maxInputTokens: 1_000 },
  )
  const second = selectContextRecords(
    [projectConstraint, otherBranch, eligible, otherSplit, otherRole],
    { role: 'planner', stage: 'design', scope: requestScope },
    { maxInputTokens: 1_000 },
  )
  assert.deepEqual(first.selected.map((entry) => entry.record.id), ['project-constraint', 'eligible'])
  assert.deepEqual(second.selected.map((entry) => entry.record.id), ['project-constraint', 'eligible'])
  assert.deepEqual(first.selected.map((entry) => entry.record.contentHash), second.selected.map((entry) => entry.record.contentHash))
  assert.deepEqual(first.excluded.map((entry) => [entry.id, entry.reason]).sort(), [
    ['other-branch', 'scope'],
    ['other-role', 'access'],
    ['other-split', 'scope'],
  ])
})

test('research context preserves older opposing evidence and all sides of an unresolved conflict', () => {
  const current = record('support-new', { required: true, payload: { observation: 'positive', createdAt: '2026-09-12' } })
  const opposing = record('oppose-old', { polarity: 'opposing', payload: { observation: 'negative', createdAt: '2024-01-01' }, conflictIds: ['conflict-1'], unresolvedConflict: true })
  const otherSide = record('support-old', { payload: { observation: 'mixed' }, topicIds: ['other-topic'], conflictIds: ['conflict-1', 'conflict-2'], unresolvedConflict: true })
  const chainedSide = record('oppose-other', { polarity: 'opposing', payload: { observation: 'other boundary' }, topicIds: ['other-topic'], conflictIds: ['conflict-2'], unresolvedConflict: true })
  const selection = selectContextRecords(
    [chainedSide, current, otherSide, opposing],
    { role: 'supervisor', stage: 'assess', scope: requestScope, focusRecordIds: ['support-new'] },
    { maxInputTokens: 2_000 },
  )
  assert.deepEqual(new Set(selection.selected.map((entry) => entry.record.id)), new Set(['support-new', 'oppose-old', 'support-old', 'oppose-other']))
  assert.equal(selection.selected.find((entry) => entry.record.id === 'oppose-old')?.reason, 'opposing-evidence')
  assert.equal(selection.selected.find((entry) => entry.record.id === 'oppose-other')?.reason, 'unresolved-conflict')
})

test('research context rejects a required record with a stale source dependency', () => {
  const dependency = record('source', { version: 2 })
  const staleSummary = record('summary', {
    kind: 'summary',
    dependencies: [{ id: 'source', version: 1, contentHash: '0'.repeat(64) }],
  })
  const dependentSummary = record('dependent-summary', {
    kind: 'summary',
    required: true,
    dependencies: [{ id: staleSummary.id, version: staleSummary.version, contentHash: staleSummary.contentHash }],
  })
  assert.throws(
    () => selectContextRecords([dependency, staleSummary, dependentSummary], { role: 'planner', stage: 'design', scope: requestScope }, { maxInputTokens: 1_000 }),
    (error: Error & { code?: string }) => error.code === 'STALE_CONTEXT_DEPENDENCY',
  )
})

test('research context never truncates a required record or conflict closure', () => {
  const support = record('support', { required: true, payload: { observation: 's'.repeat(400) }, conflictIds: ['c'], unresolvedConflict: true })
  const oppose = record('oppose', { polarity: 'opposing', payload: { observation: 'o'.repeat(400) }, conflictIds: ['c'], unresolvedConflict: true })
  assert.throws(
    () => selectContextRecords([support, oppose], { role: 'supervisor', stage: 'assess', scope: requestScope }, { maxInputTokens: 10 }),
    (error: Error & { code?: string }) => error.code === 'CONTEXT_INSUFFICIENT',
  )
})

test('context assembly writes an idempotent manifest for the exact rendered records', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-context-manifest-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const constraint = record('constraint', { layer: 0, kind: 'constraint', required: true, payload: { rule: 'do not expose test answers' } })
  const request = {
    stage: 'execute',
    scope: requestScope,
    snapshot: { id: 'snapshot-1', contentHash: 'a'.repeat(64) },
    requiredRecordIds: ['constraint'],
    records: [constraint],
  } as const
  const first = await assembleResearchContext({ runDir, role: 'research-worker', taskId: 'worker-1', request, budget: { maxInputTokens: 1_000 } })
  const replay = await assembleResearchContext({ runDir, role: 'research-worker', taskId: 'worker-1', request, budget: { maxInputTokens: 1_000 } })
  assert.equal(replay.manifest.callId, first.manifest.callId)
  assert.equal(replay.manifest.contentHash, first.manifest.contentHash)
  assert.match(first.rendered, /do not expose test answers/)
  const raw = await readFile(join(runDir, 'context', `${first.manifest.callId}.json`), 'utf8')
  const persisted = JSON.parse(raw) as typeof first.manifest
  assert.equal(persisted.contentHash, first.manifest.contentHash)
  assert.deepEqual(persisted.selected.map((entry) => entry.id), ['constraint'])
  assert.equal(persisted.snapshot?.contentHash, 'a'.repeat(64))
})

test('context assembly accepts an unchanged dependent memory record', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-context-memory-dependency-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const store = new FileMemoryStore(runDir)
  const scope = { visibility: 'run' as const, projectId: 'project-a', branchId: 'branch-a', runId: 'run-a' }
  const source = (await store.append({
    id: 'source', version: 1, kind: 'observation', scope, content: { observation: 'measured value' },
    provenance: { sourceIds: ['evidence'], sourceHashes: { evidence: 'a'.repeat(64) }, createdAt: '2026-09-12T00:00:00.000Z' },
    applicability: { appliesWhen: ['same protocol'], doesNotApplyWhen: ['changed scorer'] },
    assessment: { status: 'validated_in_scope', method: 'formal validation', supportingSourceIds: ['evidence'], opposingSourceIds: [] }, dependencies: [], topicIds: ['claim-1'],
  })).record
  await store.append({
    id: 'summary', version: 1, kind: 'interpretation', summary: true, scope, content: { observation: 'measured value', interpretation: 'bounded lesson' },
    provenance: { sourceIds: ['evidence'], sourceHashes: { evidence: 'a'.repeat(64) }, createdAt: '2026-09-12T00:00:00.000Z' },
    applicability: { appliesWhen: ['same protocol'], doesNotApplyWhen: ['changed scorer'] },
    assessment: { status: 'validated_in_scope', method: 'reviewed summary', supportingSourceIds: ['evidence'], opposingSourceIds: [] },
    dependencies: [{ id: source.id, version: source.version, contentHash: source.contentHash }], topicIds: ['claim-1'],
  })
  const result = await assembleResearchContext({
    runDir,
    role: 'supervisor',
    taskId: 'memory-dependency',
    request: { stage: 'assess', scope: requestScope, requiredRecordIds: ['memory:summary'], records: [] },
    budget: { maxInputTokens: 2_000 },
  })
  assert.deepEqual(new Set(result.selection.selected.map((entry) => entry.record.id)), new Set(['memory:source', 'memory:summary']))
})

test('research context fails when a required conflict has a stale opposing side', () => {
  const support = record('support', { required: true, conflictIds: ['conflict-stale'], unresolvedConflict: true })
  const oppose = record('oppose', {
    polarity: 'opposing',
    conflictIds: ['conflict-stale'],
    unresolvedConflict: true,
    dependencies: [{ id: 'missing-source', version: 1, contentHash: 'a'.repeat(64) }],
  })
  assert.throws(
    () => selectContextRecords([support, oppose], { role: 'supervisor', stage: 'assess', scope: requestScope }, { maxInputTokens: 10_000 }),
    (error: Error & { code?: string }) => error.code === 'STALE_CONTEXT_DEPENDENCY',
  )
})

test('research context rejects missing, filtered, and invalidated focus records', () => {
  const unrelated = record('unrelated')
  const filtered = record('filtered', { scope: { visibility: 'branch', projectId: 'project-a', branchId: 'branch-b' } })
  const invalidated = record('invalidated', { lifecycle: 'invalidated' })
  for (const [focus, records] of [
    ['missing', [unrelated]],
    ['filtered', [unrelated, filtered]],
    ['invalidated', [unrelated, invalidated]],
  ] as const) {
    assert.throws(
      () => selectContextRecords(records, { role: 'planner', stage: 'design', scope: requestScope, focusRecordIds: [focus] }, { maxInputTokens: 10_000 }),
      (error: Error & { code?: string }) => error.code === 'CONTEXT_INSUFFICIENT',
      focus,
    )
  }
})

test('research context accepts a resolved historical conflict but rejects an unresolved singleton', () => {
  const historical = record('historical', {
    required: true,
    conflictIds: ['historical-conflict'],
    unresolvedConflict: false,
  })
  const selection = selectContextRecords(
    [historical],
    { role: 'supervisor', stage: 'assess', scope: requestScope },
    { maxInputTokens: 10_000 },
  )
  assert.deepEqual(selection.selected.map((entry) => entry.record.id), ['historical'])

  const unresolved = record('unresolved', {
    required: true,
    conflictIds: ['unresolved-conflict'],
    unresolvedConflict: true,
  })
  assert.throws(
    () => selectContextRecords([unresolved], { role: 'supervisor', stage: 'assess', scope: requestScope }, { maxInputTokens: 10_000 }),
    (error: Error & { code?: string }) => error.code === 'CONTEXT_INSUFFICIENT',
  )
})

test('one unresolved side makes the relevant conflict closure mandatory', () => {
  const historicalSeed = record('historical-seed', {
    required: true,
    conflictIds: ['mixed-state-conflict'],
    unresolvedConflict: false,
  })
  const unresolvedSide = record('unresolved-side', {
    topicIds: ['different-topic'],
    conflictIds: ['mixed-state-conflict'],
    unresolvedConflict: true,
  })
  const selection = selectContextRecords(
    [historicalSeed, unresolvedSide],
    { role: 'supervisor', stage: 'assess', scope: requestScope },
    { maxInputTokens: 10_000 },
  )
  assert.deepEqual(new Set(selection.selected.map((entry) => entry.record.id)), new Set(['historical-seed', 'unresolved-side']))
  assert.equal(selection.selected.find((entry) => entry.record.id === 'unresolved-side')?.reason, 'unresolved-conflict')
})
