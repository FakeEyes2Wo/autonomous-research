import test from 'node:test'
import assert from 'node:assert/strict'

const api = await import('../../dist/research/continuation.js').catch(() => ({})) as any
const context = { goal: 'Deliver an implementation and independently check it', profile: 'Preserve existing behavior', rubric: 'Check boundary cases', maxCycles: 8 }
const input = { criteria: [
  { id: 'implementation', required: true, text: 'Deliver the implementation', evidenceKind: 'artifact' },
  { id: 'boundaries', required: true, text: 'Independently check boundary cases', evidenceKind: 'review' },
] }
const ref = { id: 'result', path: 'research/sources/abc', hash: 'a'.repeat(64) }

test('round1 derived-only conditional scientific applicability supports static artifact and formal review goals without waiving mixed science', () => {
  for (const goal of ['Audit static code without empirical performance claims', 'Deliver an artifact', 'Independently review a formal proof']) {
    const contract = api.freezeAcceptance(undefined, { ...context, goal })
    const decision = { action: 'complete', reason: 'Full scope reviewed', criteria: [{ id: 'goal-coverage', status: 'met', sourceRefs: [ref] }, { id: 'scientific-claims', status: 'not_applicable', rationale: 'The frozen goal and captured result make no empirical claims; all obligations are static inspection or deductive review.', sourceRefs: [ref] }], blockers: [], unsupportedClaims: [], followups: [] }
    assert.deepEqual(api.validateCoverage(contract, decision, [ref], false, [], false), [])
    assert.ok(api.validateCoverage(contract, decision, [ref], false, [], true).length, 'known formal scientific obligations cannot be waived')
    assert.ok(api.validateCoverage(contract, { ...decision, criteria: decision.criteria.map(c => ({ ...c, rationale: '' })) }, [ref], false, [], false).length)
    assert.ok(api.validateCoverage(contract, { ...decision, unsupportedClaims: ['A performance claim is unproven'] }, [ref], false, [], false).length)
  }
  const explicit = api.freezeAcceptance({ criteria: [{ id: 'scientific-claims', required: true, text: 'Validate empirical performance', evidenceKind: 'scientific' }] }, context)
  const waiver = { action: 'complete', reason: 'Unjustified waiver', criteria: [{ id: 'scientific-claims', status: 'not_applicable', rationale: 'Skip science', sourceRefs: [ref] }], blockers: [], unsupportedClaims: [], followups: [] }
  assert.ok(api.validateCoverage(explicit, waiver, [ref], false, [], false).length)
  const mixed = api.freezeAcceptance({ criteria: [input.criteria[0], { id: 'science', required: true, text: 'Validate measured performance', evidenceKind: 'scientific' }] }, context)
  const complete = { action: 'complete', reason: 'Artifact plus admitted science', criteria: mixed.criteria.map(c => ({ id: c.id, status: 'met', sourceRefs: [ref] })), blockers: [], unsupportedClaims: [], followups: [] }
  assert.ok(api.validateCoverage(mixed, complete, [ref], false, [], true).length)
  assert.deepEqual(api.validateCoverage(mixed, complete, [ref], true, [ref], true), [])
})

test('acceptance freezes explicit criteria and all derived goal/profile/rubric bytes', () => {
  assert.equal(typeof api.freezeAcceptance, 'function', 'frozen acceptance API must exist')
  const explicit = api.freezeAcceptance(input, context)
  assert.equal(explicit.origin, 'explicit')
  assert.equal(explicit.maxCycles, 8)
  assert.ok(Object.isFrozen(explicit.criteria[0]))
  const derived = api.freezeAcceptance(undefined, context)
  assert.equal(derived.origin, 'derived')
  assert.deepEqual(derived.goalProfileRubric, { goal: context.goal, profile: context.profile, rubric: context.rubric })
  assert.notEqual(derived.hash, api.freezeAcceptance(undefined, { ...context, rubric: 'Different criterion' }).hash)
  for (const criteria of [[], [input.criteria[0], input.criteria[0]], [{ text: 'Missing ID', required: true, evidenceKind: 'artifact' }], [{ ...input.criteria[0], evidenceKind: 'guess' }]]) {
    assert.throws(() => api.freezeAcceptance({ criteria }, context), /acceptance/i)
  }
})

test('complete requires every required criterion, exact admitted byte refs, no blockers or unsupported claims', () => {
  assert.equal(typeof api.validateCoverage, 'function')
  const contract = api.freezeAcceptance(input, context)
  const complete = { action: 'complete', reason: 'Both independently checked', criteria: input.criteria.map(c => ({ id: c.id, status: 'met', sourceRefs: [ref] })), blockers: [], unsupportedClaims: [], followups: [] }
  assert.deepEqual(api.validateCoverage(contract, complete, [ref], false), [])
  assert.ok(api.validateCoverage(contract, { ...complete, criteria: complete.criteria.slice(0, 1) }, [ref], true).length)
  assert.ok(api.validateCoverage(contract, { ...complete, blockers: ['unfinished'] }, [ref], true).length)
  assert.ok(api.validateCoverage(contract, { ...complete, unsupportedClaims: ['unproven'] }, [ref], true).length)
  assert.ok(api.validateCoverage(contract, complete, [{ ...ref, hash: 'b'.repeat(64) }], true).length)
  assert.ok(api.validateCoverage(contract, { ...complete, criteria: [...complete.criteria, { id: 'invented', status: 'met', sourceRefs: [ref] }] }, [ref], true).length)
  const science = api.freezeAcceptance({ criteria: [{ ...input.criteria[0], evidenceKind: 'scientific' }] }, context)
  assert.ok(api.validateCoverage(science, { ...complete, criteria: complete.criteria.slice(0, 1) }, [ref], false).length)
})

test('review identity excludes ledger spending and snapshot/decision wording, but includes actual evidence and control revision', () => {
  assert.equal(typeof api.continuationInputHash, 'function')
  const basis = { acceptance: api.freezeAcceptance(input, context), assessmentAndEvidence: { sourceRefs: [ref] }, queue: [], controlRevision: { revision: 0, maxCycles: 8 } }
  const hash = api.continuationInputHash(basis)
  assert.equal(hash, api.continuationInputHash({ ...basis, ledger: { roleStarts: 9 }, snapshotHash: 'new', decision: 'new wording' }))
  assert.notEqual(hash, api.continuationInputHash({ ...basis, assessmentAndEvidence: { sourceRefs: [{ ...ref, hash: 'b'.repeat(64) }] } }))
  assert.notEqual(hash, api.continuationInputHash({ ...basis, controlRevision: { revision: 1, maxCycles: 9 } }))
})

test('followup dedup ignores rewording and completed items reopen only on relevant new bytes with a declared condition', () => {
  assert.equal(typeof api.mergeFollowups, 'function')
  const contract = api.freezeAcceptance(input, context)
  const proposal = { kind: 'investigate', criterionIds: ['boundaries'], task: 'Inspect the null input boundary', changedCondition: '', sourceRefs: [ref] }
  const first = api.mergeFollowups([], [proposal], contract, [ref])
  assert.equal(first.length, 1)
  const completed = [{ ...first[0], status: 'completed' }]
  assert.equal(api.mergeFollowups(completed, [{ ...proposal, task: 'Inspect null handling again' }], contract, [ref])[0].status, 'completed')
  const changed = { ...ref, hash: 'b'.repeat(64) }
  assert.equal(api.mergeFollowups(completed, [{ ...proposal, sourceRefs: [changed] }], contract, [changed])[0].status, 'completed')
  const reopened = api.mergeFollowups(completed, [{ ...proposal, sourceRefs: [changed], changedCondition: 'Implementation bytes changed' }], contract, [changed])
  assert.equal(reopened[0].status, 'pending')
  assert.equal(reopened[0].fingerprint, first[0].fingerprint)
  assert.equal(reopened[0].generation, 1)
})

test('round1 a confirmed failed task accepts independently reviewed repair linked through a new criterion source', () => {
  const contract = api.freezeAcceptance(input, context)
  const proposal = { kind: 'investigate', criterionIds: ['boundaries'], task: 'Inspect boundary', changedCondition: '', sourceRefs: [ref] }
  const failed = api.mergeFollowups([], [proposal], contract, [ref]).map(item => ({ ...item, status: 'failed', cycle: 2 }))
  const arrived = { id: 'new-external-review', path: 'research/sources/new', hash: 'b'.repeat(64) }
  const repair = { ...proposal, retryOf: failed[0].fingerprint, kind: 'repair', sourceRefs: [arrived], changedCondition: 'A new independently linked boundary report explains the fix' }
  const retry = api.mergeFollowups(failed, [repair], contract, [arrived])
  assert.equal(retry.length, 1)
  assert.equal(retry[0].fingerprint, failed[0].fingerprint)
  assert.equal(retry[0].generation, 1)
  assert.equal(retry[0].status, 'pending')
  assert.equal(api.mergeFollowups(failed, [{ ...repair, sourceRefs: [{ ...arrived, hash: ref.hash }] }], contract, [{ ...arrived, hash: ref.hash }])[0].status, 'failed', 'path aliases are not new bytes')
  const unknown = failed.map(item => ({ ...item, status: 'running' }))
  assert.deepEqual(api.mergeFollowups(unknown, [repair], contract, [arrived]), unknown, 'an explicit retry target cannot authorize replay of unknown work')
})

test('round2 explicit retryOf selects only its failed target before generic source matches', () => {
  const contract = api.freezeAcceptance(input, context)
  const proposal = { kind: 'repair', criterionIds: ['boundaries'], task: 'Repair A', changedCondition: '', sourceRefs: [ref] }
  const a = { ...api.mergeFollowups([], [proposal], contract, [ref])[0], status: 'completed', cycle: 2 }
  const b = { ...api.mergeFollowups([], [{ ...proposal, kind: 'investigate', task: 'Investigate B' }], contract, [ref])[0], status: 'failed', cycle: 3, failureReason: 'Confirmed failed B' }
  const queue = [a, b], before = structuredClone(queue), aBytes = JSON.stringify(a)
  const changed = { ...ref, hash: 'b'.repeat(64) }
  const repair = { ...proposal, retryOf: b.fingerprint, task: 'Repair B', changedCondition: 'Relevant implementation bytes corrected', sourceRefs: [changed] }
  const result = api.mergeFollowups(queue, [repair], contract, [changed])
  assert.equal(result.length, 2)
  assert.deepEqual(result[0], before[0], 'earlier generic match A must remain unchanged')
  assert.equal(JSON.stringify(result[0]), aBytes)
  assert.equal(result[1].fingerprint, b.fingerprint)
  assert.equal(result[1].status, 'pending')
  assert.equal(result[1].generation, 1)
  assert.equal(result[1].previousAttempts[0].cycle, 3)
  assert.deepEqual(queue, before, 'the input queue is immutable')
  assert.deepEqual(api.mergeFollowups(queue, [{ ...repair, retryOf: 'f'.repeat(64) }], contract, [changed]), before, 'an invalid explicit target cannot fall back to A')
  const unknown = [a, { ...b, status: 'running' }]
  assert.deepEqual(api.mergeFollowups(unknown, [repair], contract, [changed]), unknown, 'an unknown target cannot fall back to A')
  const alias = { ...changed, id: 'alias', path: 'research/sources/alias', hash: ref.hash }
  assert.deepEqual(api.mergeFollowups(queue, [{ ...repair, sourceRefs: [alias] }], contract, [alias]), before, 'same bytes do not reopen either task')
})
