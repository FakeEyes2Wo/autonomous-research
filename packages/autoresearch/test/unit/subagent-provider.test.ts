import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubagentRoleAgentProvider } from '../../dist/providers/subagent-provider.js'
import { openRequestLedger } from '../../dist/policy/request-ledger.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installRequestAccounting, ownedSessionCount } from '../../dist/providers/request-accounting.js'
import { sealContextRecord } from '../../dist/research-context/index.js'
import { FileMemoryStore } from '../../dist/memory/index.js'

const parent = { id: 'parent', session: { id: 'parent-session' } }

function policy(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    model: { useGlobal: true },
    modelRouting: {
      enabled: true,
      defaultTier: 'standard',
      tiers: {
        cheap: { provider: 'cheap-provider', model: 'cheap-model' },
        standard: { provider: 'standard-provider', model: 'standard-model', maxOutputTokens: 600 },
        deep: { provider: 'deep-provider', model: 'deep-model' },
      },
      roles: { planner: { tier: 'standard' }, 'research-worker': { tier: 'deep' } },
    },
    workflow: { mode: 'minimal' },
    budget: {
      maxInputTokens: 2000,
      maxOutputTokens: 321,
      maxRunTokens: 10000,
      maxRoleCalls: 20,
      maxRetriesPerCall: 0,
      jsonRepairAttempts: 1,
      maxUpgradesPerTask: 1,
      context: { treeSummaryTokens: 1, evidenceTokens: 1, paperTokens: 1, failureTokens: 1 },
    },
    ...overrides,
  } as never
}

function context(runDir: string, signal = new AbortController().signal, snapshot = policy()) {
  return { parent, signal, projectDir: runDir, runId: 'run-1', policySnapshot: snapshot }
}

function eventBus() {
  const listeners = new Set<(info: { id: string; stopReason: string; lastAssistantMessage?: Array<{ type: string; text?: string }> }) => void>()
  return {
    on(_event: 'subagent/end', listener: (info: { id: string; stopReason: string; lastAssistantMessage?: Array<{ type: string; text?: string }> }) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(info: { id: string; stopReason: string; lastAssistantMessage?: Array<{ type: string; text?: string }> }) {
      for (const listener of listeners) listener(info)
    },
  }
}

test('one-shot passes role route and global output budget, then disposes', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-route-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  let disposed = 0
  let request: Record<string, unknown> | undefined
  const runtime = {
    async start(_provider: string, value: Record<string, unknown>) {
      request = value
      return {
        id: 'child-one-shot',
        result: Promise.resolve({ output: [{ type: 'text', text: '{"plan":"ok"}' }], stopReason: 'completed' }),
        async dispose() { disposed += 1 },
      }
    },
  }
  const result = await new SubagentRoleAgentProvider(runtime as never).run('planner', { runDir, taskId: 'plan-1' }, context(runDir))
  assert.deepEqual(result.structured, { plan: 'ok' })
  assert.deepEqual(request?.agentOptions, { provider: 'standard-provider', model: 'standard-model', maxTokens: 321 })
  assert.equal(disposed, 1)
})

test('legacy workflow does not disable routing, while disabled routing honors explicit override', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-legacy-route-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  let options: unknown
  const runtime = {
    async start(_provider: string, value: Record<string, unknown>) {
      options = value.agentOptions
      return { id: 'legacy-child', result: Promise.resolve({ output: [{ type: 'text', text: '{"plan":"ok"}' }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  const provider = new SubagentRoleAgentProvider(runtime as never)
  await provider.run('planner', { runDir, taskId: 'legacy-enabled' }, context(runDir, undefined, policy({ workflow: { mode: 'legacy' } })))
  assert.deepEqual(options, { provider: 'standard-provider', model: 'standard-model', maxTokens: 321 })
  await provider.run('planner', { runDir, taskId: 'legacy-disabled' }, context(runDir, undefined, policy({ modelRouting: { ...policy().modelRouting, enabled: false }, model: { useGlobal: false, overrides: { provider: 'override-provider', model: 'override-model' } } })))
  assert.deepEqual(options, { provider: 'override-provider', model: 'override-model', maxTokens: 321 })
})

test('isolated JSON repair does not rerun the original worker prompt', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-repair-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const prompts: string[] = []
  let calls = 0
  const runtime = {
    async start(_provider: string, value: { prompt: Array<{ text?: string }> }) {
      prompts.push(value.prompt[0]?.text ?? '')
      calls += 1
      const text = calls === 1 ? 'not json' : '{"plan":"repaired"}'
      return { id: 'child-' + calls, result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  const result = await new SubagentRoleAgentProvider(runtime as never).run('planner', { runDir, taskId: 'plan-repair' }, context(runDir))
  assert.deepEqual(result.structured, { plan: 'repaired' })
  assert.equal(calls, 2)
  assert.match(prompts[1] ?? '', /not json/)
  assert.doesNotMatch(prompts[1] ?? '', /# Role: planner/)
})

test('JSON repair consumes a separate role-start budget entry', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-repair-ledger-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir, runId: 'run-repair-ledger', config: { maxInputTokens: 1000, maxOutputTokens: 1000, maxRunTokens: 10000, maxRoleCalls: 2, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 } })
  let calls = 0
  const runtime = {
    async start(_provider: string, value: Record<string, unknown>) {
      calls += 1
      const label = String(value.label ?? '')
      assert.equal(label.includes('json-repair'), calls === 2)
      const text = calls === 1 ? 'invalid' : '{"plan":"fixed"}'
      return { id: 'repair-ledger-' + calls, result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  const result = await new SubagentRoleAgentProvider(runtime as never).run('planner', { runDir, taskId: 'repair-ledger-task' }, { ...context(runDir), requestLedger: ledger })
  assert.deepEqual(result.structured, { plan: 'fixed' })
  assert.equal((await ledger.snapshot()).totals.roleStarts, 2)
})

test('continuable listener is installed before start and completed child is not rerun', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-continuable-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bus = eventBus()
  let starts = 0
  const runtime = {
    async startContinuable(spec: { childId?: string }) {
      starts += 1
      bus.emit({ id: spec.childId!, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '{"summary":"done"}' }] })
      return { childId: spec.childId!, messageId: 'message-1' }
    },
    interrupt() {},
  }
  const provider = new SubagentRoleAgentProvider(runtime as never, { context: bus as never })
  const first = await provider.run('research-worker', { runDir, taskId: 'worker-cycle-1' }, context(runDir))
  const second = await provider.run('research-worker', { runDir, taskId: 'worker-cycle-1' }, context(runDir))
  assert.equal(starts, 1)
  assert.match(first.childId ?? '', /^ar-/)
  assert.deepEqual(second.structured, { summary: 'done' })
  assert.match(await readFile(join(runDir, '.autoresearch', 'subagent-tasks.json'), 'utf8'), /completed/)
})

test('adding contextual workDir reuses a completed worker without changing its fingerprint', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-workdir-resume-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bus = eventBus()
  let starts = 0
  const runtime = {
    async startContinuable(spec: { childId?: string }) {
      starts += 1
      bus.emit({ id: spec.childId!, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '{"summary":"preserved"}' }] })
      return { childId: spec.childId!, messageId: 'message-1' }
    },
  }
  const provider = new SubagentRoleAgentProvider(runtime as never, { context: bus as never })
  const first = await provider.run('research-worker', { runDir, taskId: 'worker-resume', plan: 'same-plan' }, context(runDir))
  const second = await provider.run('research-worker', {
    runDir,
    taskId: 'worker-resume',
    plan: 'same-plan',
    workDir: join(runDir, 'work', 'cycle-01'),
  }, context(runDir))

  assert.equal(starts, 1)
  assert.equal(second.childId, first.childId)
  assert.deepEqual(second.structured, { summary: 'preserved' })
})

test('continuable start preserves the native runtime receiver', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-native-receiver-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bus = eventBus()
  const runtime = {
    marker: 'native-runtime',
    async startContinuable(this: { marker: string }, spec: { childId?: string }) {
      assert.equal(this.marker, 'native-runtime')
      bus.emit({ id: spec.childId!, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '{"summary":"ok"}' }] })
      return { childId: spec.childId!, messageId: 'message-1' }
    },
  }
  const result = await new SubagentRoleAgentProvider(runtime as never, { context: bus as never }).run('research-worker', { runDir, taskId: 'receiver-task' }, context(runDir))
  assert.match(result.childId ?? '', /^ar-/)
})

test('continuable start reserves a child id and removes provisioning after native rejection', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-provisioning-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bus = eventBus()
  let reserved: string | undefined
  const runtime = {
    async startContinuable(spec: { childId?: string }) {
      reserved = spec.childId
      throw new Error('native start rejected')
    },
  }
  await assert.rejects(() => new SubagentRoleAgentProvider(runtime as never, { context: bus as never }).run('research-worker', { runDir, taskId: 'provisioning-task' }, context(runDir)), /native start rejected/)
  assert.match(reserved ?? '', /^ar-/)
  assert.equal(JSON.parse(await readFile(join(runDir, '.autoresearch', 'subagent-tasks.json'), 'utf8')).tasks['provisioning-task'], undefined)
})

test('changed task input cannot reuse a completed worker registry entry', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-task-fingerprint-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bus = eventBus()
  const runtime = {
    async startContinuable(spec: { childId?: string }) {
      bus.emit({ id: spec.childId!, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '{"summary":"done"}' }] })
      return { childId: spec.childId!, messageId: 'message' }
    },
  }
  const provider = new SubagentRoleAgentProvider(runtime as never, { context: bus as never })
  await provider.run('research-worker', { runDir, taskId: 'fingerprint-task', plan: 'v1' }, context(runDir))
  await assert.rejects(() => provider.run('research-worker', { runDir, taskId: 'fingerprint-task', plan: 'v2' }, context(runDir)), /task registry conflict/)
})

test('abort interrupts continuable waiter and rejects with AbortError', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-abort-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const controller = new AbortController()
  const bus = eventBus()
  let interrupted = ''
  const runtime = {
    async startContinuable(spec: { childId?: string }) { return { childId: spec.childId!, messageId: 'message-1' } },
    interrupt(id: string) { interrupted = id },
  }
  const provider = new SubagentRoleAgentProvider(runtime as never, { context: bus as never })
  const pending = provider.run('research-worker', { runDir, taskId: 'worker-abort' }, context(runDir, controller.signal))
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, (error: Error) => error.name === 'AbortError')
  assert.match(interrupted, /^ar-/)
})

test('continuable ownership is released when resume delivery rejects', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-release-send-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bus = eventBus()
  const ledger = await openRequestLedger({ runDir, runId: 'run-release-send', config: { maxInputTokens: 1000, maxOutputTokens: 1000, maxRunTokens: 10000, maxRoleCalls: 5, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 } })
  const controller = new AbortController()
  let resume = false
  const runtime = {
    async startContinuable(spec: { childId?: string }) { return { childId: spec.childId!, messageId: 'message' } },
    async sendMessage() { resume = true; throw new Error('delivery rejected') },
    interrupt() {},
  }
  const provider = new SubagentRoleAgentProvider(runtime as never, { context: bus as never })
  const first = provider.run('research-worker', { runDir, taskId: 'release-send' }, { ...context(runDir, controller.signal), requestLedger: ledger })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(first, (error: Error) => error.name === 'AbortError')
  assert.equal(ownedSessionCount(), 0)
  await assert.rejects(() => provider.run('research-worker', { runDir, taskId: 'release-send' }, { ...context(runDir), requestLedger: ledger }), /delivery rejected/)
  assert.equal(resume, true)
  assert.equal(ownedSessionCount(), 0)
})

test('corrupt task registry fails closed instead of rerunning a child', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-corrupt-registry-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  await writeFile(join(runDir, '.autoresearch', 'subagent-tasks.json'), '{not-json', 'utf8')
  let starts = 0
  const runtime = { async startContinuable() { starts += 1; return { childId: 'unexpected', messageId: 'message' } } }
  const bus = eventBus()
  await assert.rejects(
    () => new SubagentRoleAgentProvider(runtime as never, { context: bus as never }).run('research-worker', { runDir, taskId: 'worker-corrupt' }, context(runDir)),
    /invalid subagent task registry/,
  )
  assert.equal(starts, 0)
})

test('continuable JSON repair persists the original worker child identity only after repair succeeds', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-worker-repair-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bus = eventBus()
  let starts = 0
  const runtime = {
    async startContinuable(spec: { childId?: string }) {
      starts += 1
      bus.emit({ id: spec.childId!, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'invalid worker json' }] })
      return { childId: spec.childId!, messageId: 'message-1' }
    },
    async start(_provider: string, request: { label?: string }) {
      assert.match(request.label ?? '', /json-repair/)
      return { id: 'repair-child', result: Promise.resolve({ output: [{ type: 'text', text: '{"summary":"fixed"}' }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  const provider = new SubagentRoleAgentProvider(runtime as never, { context: bus as never })
  const result = await provider.run('research-worker', { runDir, taskId: 'worker-repair' }, context(runDir))
  assert.match(result.childId ?? '', /^ar-/)
  const registry = JSON.parse(await readFile(join(runDir, '.autoresearch', 'subagent-tasks.json'), 'utf8')) as { tasks: Record<string, { status: string; childId: string; structured?: unknown }> }
  assert.equal(registry.tasks['worker-repair']?.status, 'completed')
  assert.equal(registry.tasks['worker-repair']?.childId, result.childId)
  assert.deepEqual(registry.tasks['worker-repair']?.structured, { summary: 'fixed' })
  assert.equal(starts, 1)
})

test('provider records one completed role start in the run ledger', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-ledger-role-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({
    runDir,
    runId: 'run-ledger-role',
    config: { maxInputTokens: 1000, maxOutputTokens: 1000, maxRunTokens: 10000, maxRoleCalls: 5, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 },
  })
  const runtime = {
    async start(_provider: string, _value: Record<string, unknown>) {
      return { id: 'ledger-child', result: Promise.resolve({ output: [{ type: 'text', text: '{"plan":"ok"}' }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  await new SubagentRoleAgentProvider(runtime as never).run('planner', { runDir, taskId: 'ledger-task' }, { ...context(runDir), requestLedger: ledger })
  const snapshot = await ledger.snapshot()
  assert.equal(snapshot.totals.roleStarts, 1)
  assert.equal(Object.values(snapshot.roleStarts)[0]?.status, 'completed')
})

test('repeated one-shot input is rejected instead of bypassing maxRoleCalls', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-duplicate-role-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir, runId: 'run-duplicate-role', config: { maxInputTokens: 1000, maxOutputTokens: 1000, maxRunTokens: 10000, maxRoleCalls: 1, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 } })
  let starts = 0
  const runtime = {
    async start(_provider: string, _value: Record<string, unknown>) {
      starts += 1
      return { id: 'duplicate-child', result: Promise.resolve({ output: [{ type: 'text', text: '{"plan":"ok"}' }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  const provider = new SubagentRoleAgentProvider(runtime as never)
  const runContext = { ...context(runDir), requestLedger: ledger }
  await provider.run('planner', { runDir, taskId: 'duplicate-task' }, runContext)
  await assert.rejects(() => provider.run('planner', { runDir, taskId: 'duplicate-task' }, runContext), (error: Error & { code?: string }) => error.code === 'REQUEST_CONFLICT')
  assert.equal(starts, 1)
})

test('one-shot binds a synchronous initial llm stream before native start resolves', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-early-stream-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({
    runDir,
    runId: 'run-early-stream',
    config: { maxInputTokens: 1000, maxOutputTokens: 1000, maxRunTokens: 10000, maxRoleCalls: 5, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 },
  })
  let streamListener: ((options: never, next: (options?: never) => AsyncIterable<never>) => AsyncIterable<never>) | undefined
  const eventContext = {
    on(event: string, listener: typeof streamListener) {
      if (event === 'llm/stream') streamListener = listener
      return () => undefined
    },
  }
  installRequestAccounting(eventContext as never)
  const runtime = {
    async start(_provider: string, _value: Record<string, unknown>) {
      assert.ok(streamListener)
      const stream = streamListener!({ provider: 'standard-provider', model: 'standard-model', messages: [], sessionId: SessionId('early-child'), maxTokens: 3 }, async function* () {
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } as never
        yield { type: 'finish', reason: 'completed' } as never
      })
      for await (const _chunk of stream) { /* consume synchronous initial request */ }
      return { id: SessionId('early-child'), result: Promise.resolve({ output: [{ type: 'text', text: '{"plan":"ok"}' }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  const result = await new SubagentRoleAgentProvider(runtime as never, { context: eventContext as never }).run('planner', { runDir, taskId: 'early-stream' }, { ...context(runDir), requestLedger: ledger })
  assert.deepEqual(result.structured, { plan: 'ok' })
  assert.equal((await ledger.snapshot()).totals.committedTokens, 3)
})

test('unidentified initial streams retain role and repair provisional ownership ids', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-unidentified-stream-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({
    runDir,
    runId: 'run-unidentified-stream',
    config: { maxInputTokens: 1000, maxOutputTokens: 1000, maxRunTokens: 10000, maxRoleCalls: 5, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 },
  })
  let streamListener: ((options: never, next: (options?: never) => AsyncIterable<never>) => AsyncIterable<never>) | undefined
  const eventContext = {
    on(event: string, listener: typeof streamListener) {
      if (event === 'llm/stream') streamListener = listener
      return () => undefined
    },
  }
  installRequestAccounting(eventContext as never)
  let calls = 0
  const runtime = {
    async start(_provider: string, _value: Record<string, unknown>) {
      calls += 1
      const stream = streamListener!({ provider: 'standard-provider', model: 'standard-model', messages: [], maxTokens: 3 } as never, async function* () {
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } as never
        yield { type: 'finish', reason: 'completed' } as never
      })
      for await (const _chunk of stream) { /* consume the request without a native session id */ }
      const text = calls === 1 ? 'invalid' : '{"plan":"fixed"}'
      return { id: SessionId('unidentified-child-' + calls), result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  const result = await new SubagentRoleAgentProvider(runtime as never, { context: eventContext as never }).run(
    'planner',
    { runDir, taskId: 'unidentified-stream' },
    { ...context(runDir), runId: 'run-unidentified-stream', requestLedger: ledger },
  )
  assert.deepEqual(result.structured, { plan: 'fixed' })
  const requests = Object.values((await ledger.snapshot()).requests)
  assert.equal(requests.length, 2)
  const roleRequest = requests.find((entry) => entry.descriptor.kind === 'role')
  const repairRequest = requests.find((entry) => entry.descriptor.kind === 'repair')
  assert.match(roleRequest?.descriptor.childId ?? '', /^pending-[0-9a-f-]+$/)
  assert.match(repairRequest?.descriptor.childId ?? '', /^pending-repair-[0-9a-f-]+$/)
})

test('native error normalization retains a typed budget rejection', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-budget-normalized-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const ledger = await openRequestLedger({ runDir, runId: 'run-budget-normalized', config: { maxInputTokens: 1000, maxOutputTokens: 1000, maxRunTokens: 10000, maxRoleCalls: 5, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 } })
  let streamListener: ((options: never, next: (options?: never) => AsyncIterable<never>) => AsyncIterable<never>) | undefined
  const eventContext = {
    on(event: string, listener: typeof streamListener) {
      if (event === 'llm/stream') streamListener = listener
      return () => undefined
    },
  }
  installRequestAccounting(eventContext as never)
  const runtime = {
    async start() {
      try {
        for await (const _chunk of streamListener!({ provider: 'standard-provider', model: 'standard-model', messages: [], sessionId: SessionId('normalized-child'), maxTokens: 500 } as never, async function* () { yield undefined as never })) { /* native runtime consumes hook */ }
      } catch { /* native runtime converts hook failure to terminal error */ }
      return { id: SessionId('normalized-child'), result: Promise.resolve({ output: [], stopReason: 'error' }), async dispose() {} }
    },
  }
  await assert.rejects(
    () => new SubagentRoleAgentProvider(runtime as never, { context: eventContext as never }).run('planner', { runDir, taskId: 'budget-normalized' }, { ...context(runDir), requestLedger: ledger }),
    (error: Error & { code?: string }) => error.code === 'BUDGET_EXHAUSTED',
  )
})

test('provider refuses a required context section that cannot fit the route cap', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-context-cap-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  let starts = 0
  const runtime = {
    async start() {
      starts += 1
      return { id: 'should-not-start', result: Promise.resolve({ output: [{ type: 'text', text: '{"plan":"bad"}' }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  await assert.rejects(
    () => new SubagentRoleAgentProvider(runtime as never).run('planner', { runDir, taskId: 'context-cap', treeSummary: 'a'.repeat(1000) }, context(runDir, undefined, policy({ budget: { ...policy().budget, maxInputTokens: 12, context: { treeSummaryTokens: 1, evidenceTokens: 1, paperTokens: 1, failureTokens: 1 } } }))),
    (error: Error & { code?: string }) => error.code === 'CONTEXT_INSUFFICIENT',
  )
  assert.equal(starts, 0)
})

test('provider replaces unbounded legacy history with the selected context and persists its manifest', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-structured-context-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  let prompt = ''
  const runtime = {
    async start(_provider: string, value: { prompt: Array<{ text?: string }> }) {
      prompt = value.prompt[0]?.text ?? ''
      return { id: 'structured-child', result: Promise.resolve({ output: [{ type: 'text', text: '{"plan":"ok"}' }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  const scope = { projectId: runDir, branchId: 'branch-a', runId: 'run-1' }
  const visibility = { visibility: 'run' as const, ...scope }
  const constraint = sealContextRecord({ id: 'constraint', version: 1, layer: 0, kind: 'constraint', scope: visibility, required: true, payload: { rule: 'frozen protocol' }, source: { recordType: 'constraint' } })
  const opposing = sealContextRecord({ id: 'negative', version: 1, layer: 2, kind: 'evidence', scope: visibility, required: true, polarity: 'opposing', topicIds: ['claim-1'], payload: { observation: 'negative interval' }, source: { recordType: 'evidence' } })
  const foreign = sealContextRecord({ id: 'foreign', version: 1, layer: 2, kind: 'evidence', scope: { visibility: 'branch', projectId: runDir, branchId: 'branch-b' }, payload: { secret: 'OUT_OF_SCOPE_SECRET' }, source: { recordType: 'evidence' } })
  const wideContext = context(runDir, undefined, policy({ budget: { ...policy().budget, maxInputTokens: 10_000 } }))
  await new SubagentRoleAgentProvider(runtime as never).run('planner', {
    runDir,
    taskId: 'structured-context',
    treeSummary: 'UNBOUNDED_LEGACY_TREE',
    baselines: 'UNBOUNDED_LEGACY_EVIDENCE',
    researchContext: { stage: 'design', scope, requiredRecordIds: ['constraint', 'negative'], queryTerms: ['claim-1'], records: [foreign, opposing, constraint] },
  }, wideContext)
  assert.match(prompt, /Structured research context/)
  assert.match(prompt, /frozen protocol/)
  assert.match(prompt, /negative interval/)
  assert.doesNotMatch(prompt, /UNBOUNDED_LEGACY_TREE|UNBOUNDED_LEGACY_EVIDENCE|OUT_OF_SCOPE_SECRET/)
  const manifests = await import('node:fs/promises').then(({ readdir }) => readdir(join(runDir, 'context')))
  assert.equal(manifests.length, 1)
  const manifest = JSON.parse(await readFile(join(runDir, 'context', manifests[0]!), 'utf8')) as { selected: Array<{ id: string }>; renderedHash: string }
  assert.deepEqual(manifest.selected.map((entry) => entry.id), ['constraint', 'negative'])
  assert.match(manifest.renderedHash, /^[a-f0-9]{64}$/)
})

test('structured worker prompt retains complete current design inputs while dropping legacy history', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-worker-current-input-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bus = eventBus()
  let prompt = ''
  const runtime = {
    async startContinuable(spec: { childId?: string; request: { prompt: Array<{ text?: string }> } }) {
      prompt = spec.request.prompt[0]?.text ?? ''
      bus.emit({ id: spec.childId!, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '{"status":"completed","summary":"done","artifacts":[]}' }] })
      return { childId: spec.childId!, messageId: 'message' }
    },
  }
  const scope = { projectId: runDir, branchId: 'branch-a', runId: 'run-1' }
  const state = sealContextRecord({ id: 'worker-state', version: 1, layer: 1, kind: 'state', scope: { visibility: 'run', ...scope }, required: true, payload: { phase: 'execute' }, source: { recordType: 'snapshot' } })
  const wide = context(runDir, undefined, policy({ budget: { ...policy().budget, maxInputTokens: 20_000, context: { treeSummaryTokens: 10_000, evidenceTokens: 10_000, paperTokens: 10_000, failureTokens: 10_000 } } }))
  await new SubagentRoleAgentProvider(runtime as never, { context: bus as never }).run('research-worker', {
    runDir,
    taskId: 'worker-current-input',
    plan: 'CURRENT_PLAN_SENTINEL',
    treeSummary: 'STALE_TREE_SENTINEL',
    minimalVerification: 'CURRENT_VERIFICATION_SENTINEL',
    experimentDesign: 'CURRENT_DESIGN_SENTINEL',
    researchContext: { stage: 'execute', scope, records: [state] },
  }, wide)
  assert.match(prompt, /CURRENT_PLAN_SENTINEL/)
  assert.match(prompt, /CURRENT_VERIFICATION_SENTINEL/)
  assert.match(prompt, /CURRENT_DESIGN_SENTINEL/)
  assert.doesNotMatch(prompt, /STALE_TREE_SENTINEL/)
})

test('structured writer prompt retains complete current paper contract inputs', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-writer-current-input-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  let prompt = ''
  const runtime = {
    async start(_provider: string, value: { prompt: Array<{ text?: string }> }) {
      prompt = value.prompt[0]?.text ?? ''
      return { id: 'writer-current-input', result: Promise.resolve({ output: [{ type: 'text', text: '{"mainTex":"paper","failureReport":"none"}' }], stopReason: 'completed' }), async dispose() {} }
    },
  }
  const scope = { projectId: runDir, branchId: 'branch-a', runId: 'run-1' }
  const state = sealContextRecord({ id: 'writer-state', version: 1, layer: 1, kind: 'state', scope: { visibility: 'run', ...scope }, required: true, payload: { phase: 'paper' }, source: { recordType: 'snapshot' } })
  const wide = context(runDir, undefined, policy({ budget: { ...policy().budget, maxInputTokens: 20_000, context: { treeSummaryTokens: 10_000, evidenceTokens: 10_000, paperTokens: 10_000, failureTokens: 10_000 } } }))
  await new SubagentRoleAgentProvider(runtime as never).run('writer', {
    runDir,
    taskId: 'writer-current-input',
    plan: 'WRITER_PLAN_SENTINEL',
    minimalVerification: 'WRITER_VERIFICATION_SENTINEL',
    experimentDesign: 'WRITER_DESIGN_SENTINEL',
    reflexion: 'WRITER_REFLEXION_SENTINEL',
    paperPlan: 'PAPER_PLAN_SENTINEL',
    paperMatrix: 'PAPER_MATRIX_SENTINEL',
    paperContract: 'PAPER_CONTRACT_SENTINEL',
    paperFigures: 'PAPER_FIGURES_SENTINEL',
    modelScout: 'STALE_MODEL_SCOUT_SENTINEL',
    researchContext: { stage: 'paper', scope, records: [state] },
  }, wide)
  for (const sentinel of ['WRITER_PLAN_SENTINEL', 'WRITER_VERIFICATION_SENTINEL', 'WRITER_DESIGN_SENTINEL', 'WRITER_REFLEXION_SENTINEL', 'PAPER_PLAN_SENTINEL', 'PAPER_MATRIX_SENTINEL', 'PAPER_CONTRACT_SENTINEL', 'PAPER_FIGURES_SENTINEL']) {
    assert.match(prompt, new RegExp(sentinel))
  }
  assert.doesNotMatch(prompt, /STALE_MODEL_SCOUT_SENTINEL/)
})

test('structured provider fails before dispatch when a current workflow input cannot fit', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-current-input-cap-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  let starts = 0
  const runtime = { async startContinuable() { starts += 1; throw new Error('must not start') } }
  const scope = { projectId: runDir, branchId: 'branch-a', runId: 'run-1' }
  const state = sealContextRecord({ id: 'bounded-state', version: 1, layer: 1, kind: 'state', scope: { visibility: 'run', ...scope }, required: true, payload: { phase: 'execute' }, source: { recordType: 'snapshot' } })
  await assert.rejects(
    () => new SubagentRoleAgentProvider(runtime as never).run('research-worker', {
      runDir,
      taskId: 'bounded-current-input',
      experimentDesign: 'REQUIRED_DESIGN_SENTINEL'.repeat(100),
      researchContext: { stage: 'execute', scope, records: [state] },
    }, context(runDir, undefined, policy({ budget: { ...policy().budget, maxInputTokens: 20_000, context: { ...policy().budget.context, evidenceTokens: 1 } } }))),
    (error: Error & { code?: string }) => error.code === 'CONTEXT_INSUFFICIENT',
  )
  assert.equal(starts, 0)
})

test('provider includes selected context identity in a continuable task fingerprint', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-context-fingerprint-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bus = eventBus()
  let starts = 0
  const runtime = {
    async startContinuable(spec: { childId?: string }) {
      starts += 1
      bus.emit({ id: spec.childId!, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '{"summary":"done"}' }] })
      return { childId: spec.childId!, messageId: 'message' }
    },
  }
  const scope = { projectId: runDir, branchId: 'branch-a', runId: 'run-1' }
  const first = sealContextRecord({ id: 'state', version: 1, layer: 1, kind: 'state', scope: { visibility: 'run', ...scope }, required: true, payload: { revision: 1 }, source: { recordType: 'snapshot' } })
  const changed = sealContextRecord({ id: 'state', version: 2, layer: 1, kind: 'state', scope: { visibility: 'run', ...scope }, required: true, payload: { revision: 2 }, source: { recordType: 'snapshot' } })
  const provider = new SubagentRoleAgentProvider(runtime as never, { context: bus as never })
  const wideContext = context(runDir, undefined, policy({ budget: { ...policy().budget, maxInputTokens: 10_000 } }))
  await provider.run('research-worker', { runDir, taskId: 'context-fingerprint', researchContext: { stage: 'execute', scope, records: [first] } }, wideContext)
  await provider.run('research-worker', { runDir, taskId: 'context-fingerprint', researchContext: { stage: 'execute', scope, records: [first] } }, wideContext)
  assert.equal((await import('node:fs/promises').then(({ readdir }) => readdir(join(runDir, 'context')))).length, 1)
  await assert.rejects(
    () => provider.run('research-worker', { runDir, taskId: 'context-fingerprint', researchContext: { stage: 'execute', scope, records: [changed] } }, wideContext),
    /task registry conflict/,
  )
  assert.equal(starts, 1)
  assert.equal((await import('node:fs/promises').then(({ readdir }) => readdir(join(runDir, 'context')))).length, 2)
})

test('provider rejects stale required structured context before starting a child', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-context-stale-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  let starts = 0
  const runtime = { async start() { starts += 1; throw new Error('must not start') } }
  const scope = { projectId: runDir, branchId: 'branch-a', runId: 'run-1' }
  const source = sealContextRecord({ id: 'source', version: 2, layer: 2, kind: 'evidence', scope: { visibility: 'run', ...scope }, payload: { value: 2 }, source: { recordType: 'evidence' } })
  const stale = sealContextRecord({ id: 'summary', version: 1, layer: 1, kind: 'summary', scope: { visibility: 'run', ...scope }, required: true, payload: { value: 1 }, dependencies: [{ id: 'source', version: 1, contentHash: '0'.repeat(64) }], source: { recordType: 'summary' } })
  await assert.rejects(
    () => new SubagentRoleAgentProvider(runtime as never).run('planner', { runDir, taskId: 'stale-context', researchContext: { stage: 'design', scope, records: [source, stale] } }, context(runDir)),
    (error: Error & { code?: string }) => error.code === 'STALE_CONTEXT_DEPENDENCY',
  )
  assert.equal(starts, 0)
})

test('provider refuses required memory after its source invalidates the dependent summary', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-provider-memory-invalidated-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const store = new FileMemoryStore(runDir)
  const scope = { visibility: 'run' as const, projectId: runDir, branchId: 'branch-a', runId: 'run-1' }
  const source = (await store.append({
    id: 'source', version: 1, kind: 'observation', scope, content: { observation: 'measured value' },
    provenance: { sourceIds: ['evidence'], sourceHashes: { evidence: 'a'.repeat(64) }, createdAt: '2026-09-12T00:00:00.000Z' },
    applicability: { appliesWhen: ['same protocol'], doesNotApplyWhen: ['changed scorer'] },
    assessment: { status: 'validated_in_scope', method: 'formal validation', supportingSourceIds: ['evidence'], opposingSourceIds: [] }, dependencies: [], topicIds: ['claim-1'],
  })).record
  await store.append({
    id: 'summary', version: 1, kind: 'interpretation', summary: true, scope, content: { observation: 'measured value', interpretation: 'derived lesson' },
    provenance: { sourceIds: ['evidence'], sourceHashes: { evidence: 'a'.repeat(64) }, createdAt: '2026-09-12T00:00:00.000Z' },
    applicability: { appliesWhen: ['same protocol'], doesNotApplyWhen: ['changed scorer'] },
    assessment: { status: 'validated_in_scope', method: 'reviewed summary', supportingSourceIds: ['evidence'], opposingSourceIds: [] },
    dependencies: [{ id: source.id, version: source.version, contentHash: source.contentHash }], topicIds: ['claim-1'],
  })
  await store.transition('source', 'invalidated', { method: 'scorer audit failed', opposingSourceIds: ['audit'] })
  let starts = 0
  const runtime = { async start() { starts += 1; throw new Error('must not start') } }
  const requestScope = { projectId: runDir, branchId: 'branch-a', runId: 'run-1' }
  await assert.rejects(
    () => new SubagentRoleAgentProvider(runtime as never).run('planner', { runDir, taskId: 'invalidated-memory', researchContext: { stage: 'assess', scope: requestScope, requiredRecordIds: ['memory:summary'], records: [] } }, context(runDir)),
    (error: Error & { code?: string }) => error.code === 'CONTEXT_INSUFFICIENT',
  )
  assert.equal(starts, 0)
})
