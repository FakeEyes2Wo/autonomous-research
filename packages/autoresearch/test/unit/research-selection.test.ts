import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectCandidate } from '../../dist/research/selection.js'
import { assessCandidate, mechanismKey, type ResearchCandidate } from '../../dist/research/candidates.js'

const make = (id: string, patch: Partial<ResearchCandidate> = {}): ResearchCandidate => ({ id, parent: { id: 'h', version: 2 }, mechanismKey: id, changedAssumption: 'intervention scope', prediction: 'accuracy increases', disconfirmingObservation: 'accuracy decreases', sourceEvidenceIds: ['e1'], sourceSpanIds: [], distinguishes: ['A'], unresolvedConstraints: [], estimatedCost: 1, feasible: true, status: 'eligible', ...patch })
const input = { snapshotHash: 'snapshot', remainingCost: 2, testedMechanismKeys: [], registeredAlternatives: ['A', 'B'] }

test('selection retains all candidates and is invariant to arrival order', () => {
  const candidates = [make('a', { estimatedCost: 2, distinguishes: ['A', 'B'] }), make('b'), make('c', { feasible: false, estimatedCost: 0 })]
  assert.equal(selectCandidate(candidates, input).selectedId, 'a')
  assert.deepEqual(selectCandidate(candidates, input), selectCandidate([...candidates].reverse(), input))
  assert.deepEqual(selectCandidate(candidates, input).candidateIds, ['a', 'b', 'c'])
})

test('unregistered alternatives and repeated alternatives never increase preference', () => {
  const decision = selectCandidate([make('b', { distinguishes: ['A', 'A', 'made-up'] }), make('a')], input)
  assert.equal(decision.selectedId, 'a')
  assert.ok(decision.reasons.b.includes('unregistered_alternatives'))
})

test('unknown cost, rejected and unresolved candidates are never silently selected', () => {
  for (const patch of [{ estimatedCost: NaN }, { estimatedCost: -1 }, { estimatedCost: 1.5 }, { status: 'rejected' as const }, { unresolvedConstraints: ['dataset missing'] }, { feasible: false }]) {
    assert.equal(selectCandidate([make('a', patch)], input).selectedId, null)
  }
  assert.equal(selectCandidate([make('a', { estimatedCost: 3 })], input).stopReason, 'budget')
  assert.equal(selectCandidate([make('a', { feasible: false })], input).stopReason, 'no_feasible_candidate')
  assert.throws(() => selectCandidate([make('a'), make('a')], input), /DUPLICATE_CANDIDATE/)
})

test('novel mechanisms precede cost, then stable ID; deferred candidates can be reconsidered', () => {
  const decision = selectCandidate([make('old', { estimatedCost: 0 }), make('new', { estimatedCost: 2, status: 'deferred' })], { ...input, testedMechanismKeys: ['old'] })
  assert.equal(decision.selectedId, 'new')
  assert.equal(selectCandidate([make('b'), make('a')], input).selectedId, 'a')
})

test('admission validates registered sources and exact parent version without discarding rejected candidates', () => {
  const scope = { parent: { id: 'h', version: 2 }, evidenceIds: ['e1'], spanIds: ['s1'] }
  assert.deepEqual(assessCandidate(make('a'), scope), [])
  assert.ok(assessCandidate(make('a', { sourceEvidenceIds: ['fabricated'] }), scope).includes('unregistered_evidence'))
  assert.ok(assessCandidate(make('a', { sourceSpanIds: ['fabricated'] }), scope).includes('unregistered_span'))
  assert.ok(assessCandidate(make('a', { parent: { id: 'h', version: 1 } }), scope).includes('parent_version'))
  assert.ok(assessCandidate(make('a', { prediction: '' }), scope).includes('prediction'))
})

test('mechanism identity normalizes exact wording and binds intervention and protocol conditions', () => {
  const value = { mechanism: ' Memory  Gating ', intervention: 'prune', outcome: 'accuracy', conditions: ['dev', 'budget60'] }
  assert.equal(mechanismKey(value), mechanismKey({ ...value, mechanism: 'memory gating', conditions: ['budget60', 'dev'] }))
  assert.notEqual(mechanismKey(value), mechanismKey({ ...value, intervention: 'expand' }))
})

test('unknown monetary cost requires explicit caps and remains null in serialized audit data', () => {
  const fallback = { ...input, remainingCost: null, exploratoryBudget: { policy: 'controller-caps-v1' as const, remainingCycles: 2, remainingRoleCalls: 6, remainingTokens: 2000 } }
  const candidate = make('unknown', { estimatedCost: null })
  assert.equal(selectCandidate([candidate], fallback).selectedId, 'unknown')
  assert.equal(JSON.parse(JSON.stringify(candidate)).estimatedCost, null)
  assert.match(selectCandidate([candidate], fallback).reasons.unknown.join(' '), /no_monetary_guarantee/)
  assert.equal(selectCandidate([candidate], { ...fallback, remainingCost: 100 }).selectedId, null)
  assert.equal(selectCandidate([candidate], { ...fallback, exploratoryBudget: { ...fallback.exploratoryBudget, remainingTokens: 0 } }).stopReason, 'budget')
  assert.equal(selectCandidate([candidate], { ...fallback, exploratoryBudget: undefined }).selectedId, null)
})

test('project direction memory hard-excludes an exact mechanism while allowing a changed mechanism', () => {
  const blocked = make('blocked', { mechanismKey: 'same-mechanism' })
  const changed = make('changed', { mechanismKey: 'new-mechanism' })
  const decision = selectCandidate([blocked, changed], {
    ...input,
    avoidedMechanismKeys: ['same-mechanism'],
    directionMemoryIds: ['memory-1'],
  })
  assert.equal(decision.selectedId, 'changed')
  assert.ok(decision.reasons.blocked.includes('project_direction_memory:memory-1'))
  assert.ok(decision.reasons.changed.includes('selected'))
})

test('a project memory key without a corresponding memory id still blocks deterministically', () => {
  const decision = selectCandidate([make('blocked', { mechanismKey: 'same-mechanism' })], {
    ...input,
    avoidedMechanismKeys: ['same-mechanism'],
  })
  assert.equal(decision.selectedId, null)
  assert.ok(decision.reasons.blocked.includes('project_direction_memory'))
})
