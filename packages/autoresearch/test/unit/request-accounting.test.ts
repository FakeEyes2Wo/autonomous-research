import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installRequestAccounting, registerOwnedSession } from '../../dist/providers/request-accounting.js'
import { openRequestLedger } from '../../dist/policy/request-ledger.js'

test('llm stream accounting wraps owned sessions and passes unrelated sessions through', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-request-accounting-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({
    runDir,
    runId: 'run-accounting',
    config: { maxInputTokens: 1000, maxOutputTokens: 20, maxRunTokens: 1000, maxRoleCalls: 5, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 },
  })
  let listener: ((options: unknown, next: (options?: unknown) => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const ctx = { on(_event: string, callback: typeof listener) { listener = callback; return () => undefined } }
  const disposeAccounting = installRequestAccounting(ctx as never)
  const release = registerOwnedSession('owned-session', {
    ledger,
    runId: 'run-accounting',
    taskId: 'task-1',
    role: 'planner',
    tier: 'standard',
    childId: 'owned-session',
    capabilityStatus: 'limited',
    maxOutputTokens: 5,
  })
  const chunks = async function* () {
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
    yield { type: 'finish', reason: 'completed' }
  }
  assert.ok(listener)
  const owned = listener!({ provider: 'cpa', model: 'gpt', messages: [], sessionId: SessionId('owned-session'), maxTokens: 5 }, () => chunks())
  const received: unknown[] = []
  for await (const chunk of owned) received.push(chunk)
  assert.equal(received.length, 2)
  const snapshot = await ledger.snapshot()
  assert.equal(Object.keys(snapshot.requests).length, 1)
  assert.equal(snapshot.totals.committedTokens, 5)
  assert.equal(Object.values(snapshot.requests)[0]?.usage?.totalTokens, 5)
  assert.equal(snapshot.capabilityStatus, 'limited')
  const unrelated = listener!({ provider: 'other', model: 'gpt', messages: [], sessionId: SessionId('unrelated') }, () => chunks())
  const unrelatedChunks: unknown[] = []
  for await (const chunk of unrelated) unrelatedChunks.push(chunk)
  assert.equal(unrelatedChunks.length, 2)
  release()
  disposeAccounting()
})

test('owned stream rejects a native output cap above the selected route cap', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-request-cap-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir, runId: 'run-cap', config: { maxInputTokens: 100, maxOutputTokens: 100, maxRunTokens: 1000, maxRoleCalls: 2, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 } })
  let listener: ((options: never, next: (options?: never) => AsyncIterable<never>) => AsyncIterable<never>) | undefined
  const ctx = { on(_event: string, callback: typeof listener) { listener = callback; return () => undefined } }
  installRequestAccounting(ctx as never)
  const release = registerOwnedSession('capped', { ledger, runId: 'run-cap', taskId: 'task', role: 'planner', tier: 'standard', childId: 'capped', maxOutputTokens: 4, capabilityStatus: 'limited' })
  await assert.rejects(async () => {
    for await (const _chunk of listener!({ sessionId: SessionId('capped'), messages: [], maxTokens: 5 } as never, async function* () { yield undefined as never })) { /* expected rejection */ }
  }, (error: Error & { code?: string }) => error.code === 'BUDGET_EXHAUSTED')
  release()
})
