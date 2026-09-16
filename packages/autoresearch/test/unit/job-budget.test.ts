import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openJobStore } from '../../dist/runtime/job-store.js'
import { validateLocalBudget, assertLocalContainment } from '../../dist/runtime/budget.js'

test('local executor refuses unmeterable hard CPU GPU and cost limits', () => {
  const budget = { wallMs: 10, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 10, maxArtifactBytes: 10 }
  for (const key of ['cpuSeconds', 'gpuSeconds', 'costMicros']) assert.throws(() => validateLocalBudget({ ...budget, [key]: 1 }), /meter/i)
  assert.throws(() => validateLocalBudget({ ...budget, wallMs: -1 }), /wallMs/)
})

test('local profiles without certified descendant containment are refused', () => {
  assert.doesNotThrow(() => assertLocalContainment('win32'))
  assert.throws(() => assertLocalContainment('linux'), /containment/i)
  assert.throws(() => assertLocalContainment('darwin'), /containment/i)
})

test('persistent reservation survives unknown and duplicate settlement cannot refund twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-budget-'))
  let store = await openJobStore(root, { maxReservedWallMs: 100, maxConcurrentJobs: 1 })
  const spec = (id: string) => ({ id, attemptId: id, taskId: 't', inputHash: 'i', protocolHash: 'p', executable: process.execPath, args: [], cwd: root, env: {}, checkpoint: null, budget: { wallMs: 100, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 10, maxArtifactBytes: 10 } })
  try {
    await store.enqueue(spec('one')); await store.enqueue(spec('two'))
    const first = await store.claim('one', 'owner', 0, 10)
    await store.beginSubmission('one', first.fence, 0)
    await store.markUnknown('one', first.fence, 'lost')
    await store.close(); store = await openJobStore(root)
    const second = await store.claim('two', 'other', 20, 10)
    await assert.rejects(store.beginSubmission('two', second.fence, 20), /budget|capacity/i)
    const terminal = { jobId: 'one', backendId: 'b', status: 'succeeded' as const, inputHash: 'i', protocolHash: 'p', heartbeatAt: null, progressAt: null, exitCode: 0, artifactManifestHash: null }
    await store.acceptReceipt(terminal, first.fence, 30)
    await store.acceptReceipt(terminal, first.fence, 30)
    assert.deepEqual(await store.budget(), { reservedWallMs: 0, activeJobs: 0, settledWallMs: 30, cpuSeconds: null, gpuSeconds: null, costMicros: null })
    await store.linkRequest('one', 'llm-request-1'); await store.linkRequest('one', 'llm-request-1')
    assert.equal((await store.get('one')).requestIds.length, 1)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
