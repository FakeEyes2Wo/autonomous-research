import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runControlledRecallBenchmark } from '../fixtures/idea-survey-recall.ts'

test('controlled varied-query discovery preserves all four anchor identities through reviewed context and resumes without calls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'idea-survey-recall-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const summary = await runControlledRecallBenchmark(directory)
  const reference = summary.results.filter(row => row.variant === 'single-literal-query-reference')
  const varied = summary.results.filter(row => row.variant === 'multiround-multifacet-controller')
  const all = (rows: typeof reference, stage: 'collected' | 'retained' | 'shortlisted' | 'reviewed') => [...new Set(rows.flatMap(row => row[stage]))].sort()
  assert.deepEqual(all(reference, 'collected'), ['CaMeL', 'RAG'])
  for (const stage of ['collected', 'retained', 'shortlisted', 'reviewed'] as const) assert.deepEqual(all(varied, stage), ['CaMeL', 'Macaroons', 'RAG', 'REST'])
  assert.equal(reference.reduce((sum, row) => sum + row.actualHttpAttempts, 0), 6)
  assert.equal(varied.reduce((sum, row) => sum + row.actualHttpAttempts, 0), 72)
  for (const row of varied) {
    assert.equal(row.rounds, 3); assert.equal(row.queries, 12); assert.equal(row.plannerCallbackCalls, 3)
    assert.equal(row.firstSeenRound[row.scenario === 'authority' ? 'Macaroons' : 'REST'], 2)
    assert.equal(row.firstSeenRound[row.scenario === 'authority' ? 'CaMeL' : 'RAG'], 1)
    assert.ok(row.reviewerCallbackCalls >= 1 && row.reviewerCallbackCalls <= 3)
    assert.ok(row.literalDecoysCollected >= 2); assert.ok(row.verifiedSourceHashes > 0)
    assert.deepEqual(row.resumeDelta, { http: 0, planner: 0, reviewer: 0 })
    assert.equal(row.liveHttpCalls, 0); assert.equal(row.paidModelCalls, 0)
  }
})
