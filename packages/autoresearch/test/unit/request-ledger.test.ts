import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LedgerBudgetExceededError, openRequestLedger, type LedgerBudgetConfig, type RequestDescriptor } from '../../dist/policy/request-ledger.js'
import { runBudgetedStream } from '../../dist/policy/llm-budget.js'

const config: LedgerBudgetConfig = { maxInputTokens: 20, maxOutputTokens: 30, maxRunTokens: 60, maxRoleCalls: 2, maxRetriesPerCall: 1, maxUpgradesPerTask: 1 }
const request = (id: string, overrides: Partial<RequestDescriptor> = {}): RequestDescriptor => ({ requestId: id, taskId: 'task-1', childId: 'child-1', role: 'worker', tier: 'standard', kind: 'worker', estimatedInputTokens: 10, maxOutputTokens: 20, ...overrides })

test('ledger separates role starts from multi-request child work and makes reserve idempotent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-1', config })
  assert.equal((await ledger.beginRole({ roleStartId: 'role-1', taskId: 'task-1', role: 'worker', tier: 'standard', childId: 'child-1' })).created, true)
  assert.equal((await ledger.beginRole({ roleStartId: 'role-1', taskId: 'task-1', role: 'worker', tier: 'standard', childId: 'child-1' })).created, false)
  const first = await ledger.beginRequest(request('req-1'))
  assert.equal(first.totalReservedTokens, 30)
  assert.equal((await ledger.beginRequest(request('req-1'))).created, false)
  const usage = await ledger.settleRequest('req-1', { inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, outputTokens: 4, reasoningTokens: 99, usageSource: 'provider', stopReason: 'stop' })
  assert.equal(usage.totalTokens, 10)
  assert.equal((await ledger.snapshot()).totals.committedTokens, 10)
  assert.equal((await ledger.recordTaskUpgrade('task-1', 'evidence_conflict')).allowed, true)
  assert.equal((await ledger.recordTaskUpgrade('task-1', 'quality_low')).allowed, false)
})

test('provider-authoritative totalTokens settles without requiring every component', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-total-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-total', config })
  await ledger.beginRequest(request('req-total'))
  const usage = await ledger.settleRequest('req-total', {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    usageSource: 'provider',
    stopReason: 'completed',
  })
  assert.equal(usage.totalTokens, 5)
  assert.equal((await ledger.snapshot()).totals.committedTokens, 5)
})

test('unknown usage retains the full reservation and pending requests recover conservatively', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-recover-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const localConfig = { ...config, maxRunTokens: 90 }
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-2', config: localConfig })
  await ledger.beginRequest(request('req-unknown'))
  const reopened = await openRequestLedger({ runDir: dir, runId: 'run-2', config: localConfig })
  assert.equal((await reopened.snapshot()).pendingRequests, 1)
  assert.equal(await reopened.recoverPending('cancelled'), 1)
  const snapshot = await reopened.snapshot()
  assert.equal(snapshot.pendingRequests, 0)
  assert.equal(snapshot.totals.committedTokens, 30)
  assert.equal(snapshot.capabilityStatus, 'limited')
  await reopened.beginRequest(request('req-zero'))
  await reopened.settleRequest('req-zero', { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, usageSource: 'unknown', stopReason: 'cancelled' })
  assert.equal((await reopened.snapshot()).totals.committedTokens, 60)
})

test('output is reserved before concurrent requests and budget exhaustion is typed/recoverable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-budget-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const a = await openRequestLedger({ runDir: dir, runId: 'run-3', config: { ...config, maxRunTokens: 40 } })
  const b = await openRequestLedger({ runDir: dir, runId: 'run-3', config: { ...config, maxRunTokens: 40 } })
  const results = await Promise.allSettled([a.beginRequest(request('req-a', { maxOutputTokens: 30 })), b.beginRequest(request('req-b', { maxOutputTokens: 30 }))])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason instanceof LedgerBudgetExceededError).length, 1)
  const roleLimit = await a.beginRole({ roleStartId: 'role-a', taskId: 'task-1', role: 'worker', tier: 'standard' })
  assert.equal(roleLimit.roleStarts, 1)
})

test('stream adapter wraps frozen options without changing them and settles usage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-stream-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-4', config })
  const options = Object.freeze({ maxTokens: 20, sessionId: 's-1' })
  const seen: unknown[] = []
  const chunks: string[] = []
  for await (const chunk of runBudgetedStream({ ledger, descriptor: request('req-stream'), options, next: async function* (received) { seen.push(received); yield 'part'; yield { usage: true } as unknown as string }, usageFromChunk: (chunk) => typeof chunk === 'object' ? { inputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 3 } : undefined })) chunks.push(chunk)
  assert.deepEqual(seen[0], options)
  assert.deepEqual(chunks, ['part', { usage: true } as unknown as string])
  assert.equal((await ledger.snapshot()).totals.committedTokens, 6)
})

test('stream consumer cancellation settles reservation and provider errors preserve observed usage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-cancel-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-5', config })
  const iterator = runBudgetedStream({ ledger, descriptor: request('req-break'), options: {}, next: async function* () { yield 'one' }, usageFromChunk: () => ({ inputTokens: 1, outputTokens: 1 }) })
  await iterator.next()
  await iterator.return(undefined)
  assert.equal((await ledger.snapshot()).pendingRequests, 0)
  const failing = runBudgetedStream({ ledger, descriptor: request('req-error'), options: {}, next: async function* () { yield { usage: true }; throw new Error('transport') }, usageFromChunk: (chunk) => typeof chunk === 'object' ? { inputTokens: 2, outputTokens: 3 } : undefined })
  await assert.rejects(async () => { for await (const _chunk of failing) void _chunk })
  const snapshot = await ledger.snapshot()
  assert.equal(snapshot.pendingRequests, 0)
  assert.equal(snapshot.totals.committedTokens, 60)
  assert.equal(snapshot.requests['req-error'].usage?.usageSource, 'provider')
  assert.equal(snapshot.capabilityStatus, 'limited')
})

test('stream adapter refuses duplicate dispatch unless recovery explicitly opts in', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-duplicate-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-6', config })
  let calls = 0
  const input = { ledger, descriptor: request('req-once'), options: {}, next: async function* () { calls += 1; yield 'ok' } }
  for await (const _chunk of runBudgetedStream(input)) void _chunk
  await assert.rejects(async () => { for await (const _chunk of runBudgetedStream(input)) void _chunk }, (error: { code?: string }) => error.code === 'REQUEST_CONFLICT')
  assert.equal(calls, 1)
})

test('corrupt totals fail closed and unsafe dictionary keys are rejected', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-corrupt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-7', config })
  await ledger.beginRequest(request('req-safe'))
  const path = join(dir, 'request-ledger.json')
  const text = await readFile(path, 'utf8')
  await writeFile(path, text.replace('"reservedTokens": 30', '"reservedTokens": 0'), 'utf8')
  await assert.rejects(() => ledger.snapshot(), (error: { code?: string }) => error.code === 'LEDGER_CORRUPT')
  const clean = await openRequestLedger({ runDir: join(dir, 'new'), runId: 'run-8', config })
  await assert.rejects(() => clean.beginRequest(request('__proto__')), (error: { code?: string }) => error.code === 'REQUEST_CONFLICT')
})

test('input estimates above the effective cap are rejected instead of silently clipped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-input-cap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-9', config })
  await assert.rejects(() => ledger.beginRequest(request('req-too-large', { estimatedInputTokens: 21, maxInputTokens: 20 })), (error: { code?: string }) => error.code === 'BUDGET_EXHAUSTED')
  await assert.rejects(() => ledger.beginRequest(request('req-retry-limit', { attempt: 3 })), (error: { code?: string }) => error.code === 'RETRY_LIMIT')
  assert.equal((await ledger.snapshot()).pendingRequests, 0)
})

test('reusing a request id with different attribution is rejected', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-request-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-identity', config })
  await ledger.beginRequest(request('req-identity', { role: 'planner', kind: 'role', provider: 'provider-a', model: 'model-a' }))
  await assert.rejects(
    () => ledger.beginRequest(request('req-identity', { role: 'worker', kind: 'worker', provider: 'provider-b', model: 'model-b' })),
    (error: { code?: string }) => error.code === 'REQUEST_CONFLICT',
  )
})

test('reusing a role start id with a different tier is rejected', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-role-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-role-identity', config })
  await ledger.beginRole({ roleStartId: 'role-identity', taskId: 'task-1', role: 'worker', tier: 'standard', childId: 'child-1' })
  await assert.rejects(
    () => ledger.beginRole({ roleStartId: 'role-identity', taskId: 'task-1', role: 'worker', tier: 'deep', childId: 'child-1' }),
    (error: { code?: string }) => error.code === 'REQUEST_CONFLICT',
  )
})

test('reusing a request id accepts omitted fields when defaults and reservation are equivalent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-request-defaults-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir: dir, runId: 'run-request-defaults', config: { ...config, maxRunTokens: 100 } })
  const base: RequestDescriptor = { requestId: 'req-defaults', taskId: 'task-1', role: 'worker', tier: 'standard', kind: 'worker', childId: 'child-1' }
  assert.equal((await ledger.beginRequest(base)).created, true)
  assert.equal((await ledger.beginRequest({
    ...base,
    estimatedInputTokens: config.maxInputTokens,
    maxInputTokens: config.maxInputTokens,
    maxOutputTokens: config.maxOutputTokens,
    attempt: 1,
    cacheHit: false,
    contextTruncated: [],
    capabilityStatus: 'limited',
  })).created, false)
  const capBase: RequestDescriptor = { ...base, requestId: 'req-caps', estimatedInputTokens: 10, maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens }
  assert.equal((await ledger.beginRequest(capBase)).created, true)
  await assert.rejects(
    () => ledger.beginRequest({ ...capBase, maxInputTokens: 15, attempt: 1, cacheHit: false, contextTruncated: [], capabilityStatus: 'limited' }),
    (error: { code?: string }) => error.code === 'REQUEST_CONFLICT',
  )
  await assert.rejects(
    () => ledger.beginRequest({ ...capBase, maxInputTokens: 5, attempt: 1, cacheHit: false, contextTruncated: [], capabilityStatus: 'limited' }),
    (error: { code?: string }) => error.code === 'REQUEST_CONFLICT',
  )
})

test('separate node processes serialize reservations through the ledger lock', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-ledger-process-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/policy/request-ledger.js')).href
  const script = `import { openRequestLedger } from ${JSON.stringify(moduleUrl)}; const ledger = await openRequestLedger({runDir:${JSON.stringify(dir)},runId:'run-process',config:{maxInputTokens:20,maxOutputTokens:30,maxRunTokens:40,maxRoleCalls:3,maxUpgradesPerTask:1}}); try { await ledger.beginRequest({requestId:process.argv[1],taskId:'task',childId:process.argv[1],role:'worker',tier:'standard',kind:'worker',estimatedInputTokens:10,maxOutputTokens:30}); console.log('reserved') } catch (error) { console.log(error.code ?? 'error') }`
  const run = (id: string) => new Promise<string>((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script, id], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += String(chunk) }); child.on('error', reject); child.on('close', () => resolve(output.trim())) })
  const outputs = await Promise.all([run('process-a'), run('process-b')])
  assert.equal(outputs.filter((output) => output === 'reserved').length, 1)
  assert.equal(outputs.filter((output) => output === 'BUDGET_EXHAUSTED').length, 1)
})
