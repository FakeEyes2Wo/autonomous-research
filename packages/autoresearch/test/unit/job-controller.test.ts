import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcile, JobController } from '../../dist/runtime/job-controller.js'
import { JobStore, openJobStore } from '../../dist/runtime/job-store.js'
import type { JobSpec, JobReceipt } from '../../dist/runtime/contracts.js'

export function spec(id = 'j1'): JobSpec {
  return { id, attemptId: `attempt-${id}`, taskId: 't1', protocolHash: 'protocol', inputHash: 'input', executable: process.execPath, args: [], cwd: process.cwd(), env: {}, budget: { wallMs: 10000, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 1024, maxArtifactBytes: 1024 }, checkpoint: null }
}
const receipt = (status: JobReceipt['status']): JobReceipt => ({ jobId: 'j1', backendId: 'b1', status, inputHash: 'input', protocolHash: 'protocol', heartbeatAt: null, progressAt: null, exitCode: null, artifactManifestHash: null })

test('unknown recovery waits without authorizing resubmission', () => {
  assert.equal(reconcile(receipt('unknown')), 'wait_unknown')
})

test('resume validates payload input protocol and application version before a new attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-resume-')); const store = await openJobStore(root)
  const checkpointPath = join(root, 'checkpoint.json'); const payload = join(root, 'state.bin')
  const original = { ...spec(), checkpoint: { path: checkpointPath, resumeArgs: ['--resume', payload] } }
  const terminal = { ...receipt('failed'), exitCode: 1 }
  let collected = 0
  const backend = { async submit() { return terminal }, async inspect() { return terminal }, async collect() { collected++; return terminal }, async cancel() { return receipt('cancel_requested') } }
  try {
    const controller = new JobController(store, backend); await controller.enqueue(original); await controller.advance('j1')
    await writeFile(payload, 'state')
    const manifest = { version: 1, applicationVersion: 'app-v1', inputHash: 'input', protocolHash: 'protocol', payloadPath: 'state.bin', payloadHash: createHash('sha256').update('state').digest('hex') }
    await writeFile(checkpointPath, JSON.stringify(manifest))
    const next = { ...spec('j2'), checkpoint: original.checkpoint }
    await assert.rejects(controller.resume('j1', next, 'app-v2'), /application version/i)
    await assert.rejects(controller.resume('j1', { ...next, inputHash: 'changed' }, 'app-v1'), /input|protocol/i)
    await writeFile(payload, 'corrupt'); await assert.rejects(controller.resume('j1', next, 'app-v1'), /payload.*hash/i)
    await writeFile(payload, 'state')
    const resumed = await controller.resume('j1', next, 'app-v1')
    assert.equal(resumed.jobId, 'j2'); assert.deepEqual((await store.get('j2')).spec.args, ['--resume', payload])
    assert.equal((await store.get('j1')).receipt.status, 'failed')
    assert.equal(collected, 0)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('succeeded job is collected directly instead of resumed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-complete-')); const store = await openJobStore(root)
  let collected = 0
  const backend = { async submit() { return receipt('succeeded') }, async inspect() { return receipt('succeeded') }, async collect() { collected++; return receipt('succeeded') }, async cancel() { return receipt('cancel_requested') } }
  try {
    const controller = new JobController(store, backend); await controller.enqueue(spec()); await controller.advance('j1')
    assert.equal((await controller.resume('j1', spec('j2'), 'v1')).status, 'succeeded')
    assert.equal(collected, 1); assert.equal((await store.list()).length, 1)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('accepted submission with lost response is inspected after restart exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-controller-'))
  let submits = 0
  const backend = { async submit() { submits++; throw new Error('connection lost after acceptance') }, async inspect() { return receipt('running') }, async collect() { return receipt('succeeded') }, async cancel() { return receipt('cancel_requested') } }
  let store = await openJobStore(root)
  try {
    let controller = new JobController(store, backend)
    await controller.enqueue(spec())
    assert.equal((await controller.advance('j1')).status, 'unknown')
    await store.close()
    store = await openJobStore(root)
    controller = new JobController(store, backend)
    assert.equal((await controller.advance('j1')).status, 'running')
    assert.equal(submits, 1)
    assert.equal((await store.budget()).reservedWallMs, 10000)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('job id and attempt identity prevent changed-input duplicate execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-identity-'))
  const store = await openJobStore(root)
  try {
    await store.enqueue(spec())
    await store.enqueue(spec())
    await assert.rejects(store.enqueue({ ...spec(), inputHash: 'changed' }), /conflict/i)
    await assert.rejects(store.enqueue({ ...spec('j2'), attemptId: 'attempt-j1' }), /UNIQUE|conflict/i)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('backend receipt cannot reset a persisted submission to queued or change backend identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-receipt-')); const store = await openJobStore(root)
  try {
    await store.enqueue(spec()); const job = await store.claim('j1', 'owner'); await store.beginSubmission('j1', job.fence)
    await store.acceptReceipt(receipt('running'), job.fence)
    await assert.rejects(store.acceptReceipt(receipt('queued'), job.fence), /queued|transition/i)
    await assert.rejects(store.acceptReceipt({ ...receipt('succeeded'), backendId: 'wrong-backend' }, job.fence), /backend.*identity/i)
    assert.equal((await store.get('j1')).receipt.status, 'running')
    assert.equal((await store.budget()).activeJobs, 1)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('durable cancellation survives uncertain observations and restart without releasing reservations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-cancel-intent-')); let store = await openJobStore(root)
  try {
    await store.enqueue(spec()); const old = await store.claim('j1', 'owner'); await store.beginSubmission('j1', old.fence)
    await store.acceptReceipt(receipt('running'), old.fence)
    await store.requestCancel('j1', old.fence, 'stop requested')
    const observation = { ...receipt('unknown'), heartbeatAt: '2026-09-16T12:00:00.000Z' }
    await store.acceptReceipt(observation, old.fence)
    assert.equal((await store.get('j1')).receipt.status, 'cancel_requested')
    await store.markUnknown('j1', old.fence, 'inspection failed')
    assert.equal((await store.get('j1')).receipt.status, 'cancel_requested')
    await store.release('j1', old.fence); await store.close(); store = await openJobStore(root)
    const fresh = await store.claim('j1', 'new owner')
    assert.ok(fresh.fence > old.fence)
    await assert.rejects(store.markUnknown('j1', old.fence, 'stale'), /fence/)
    await assert.rejects(store.acceptReceipt(receipt('cancelled'), old.fence), /fence/)
    for (const status of ['unknown', 'submitting', 'running'] as const) await store.acceptReceipt(receipt(status), fresh.fence)
    assert.equal((await store.get('j1')).receipt.status, 'cancel_requested')
    assert.equal((await store.get('j1')).cancellationReason, 'stop requested')
    assert.equal((await store.budget()).reservedWallMs, 10000)
    await store.acceptReceipt(receipt('cancelled'), fresh.fence)
    assert.equal((await store.budget()).reservedWallMs, 0)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('job store shares concurrent close and rejects late calls while draining admitted work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'job-close-'))
  const worker = new Worker(new URL('../../dist/runtime/job-store-worker.js', import.meta.url), { workerData: { root } })
  const store = new JobStore(root, worker)
  t.after(async () => { await worker.terminate(); await rm(root, { recursive: true, force: true }) })
  await store.ready
  await assert.rejects(store.enqueue({ ...spec(), env: { invalid: () => {} } } as unknown as JobSpec), /clone/i)
  const admitted = store.enqueue(spec())
  const first = store.close(), second = store.close(), late = store.get('j1')
  const outcomes = Promise.allSettled([admitted, first, second, late])
  assert.equal(first, second, 'all close callers must share the same completion promise')
  const results = await outcomes
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'fulfilled')
  assert.equal(results[2].status, 'fulfilled')
  assert.equal(results[3].status, 'rejected')
  if (results[3].status === 'rejected') assert.match(String(results[3].reason), /closing|closed/)
  await assert.rejects(store.budget(), /closed/)
  const reopened = await openJobStore(root)
  try { assert.equal((await reopened.get('j1')).spec.id, 'j1') } finally { await reopened.close() }
})

test('job worker exit rejects pending calls and close settles after worker failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'job-exit-'))
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true })
  const store = new JobStore(root, worker)
  t.after(async () => { await worker.terminate(); await rm(root, { recursive: true, force: true }) })
  const queued = store.get('missing')
  const outcome = Promise.allSettled([queued, store.ready])
  await worker.terminate()
  const results = await outcome
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'rejected')
  await store.close()
})

test('job worker exit during close rejects admitted RPC instead of hanging shutdown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'job-closing-exit-'))
  const worker = new Worker("require('node:worker_threads').parentPort.postMessage({ type: 'ready' }); setInterval(() => {}, 1000)", { eval: true })
  const store = new JobStore(root, worker)
  t.after(async () => { await worker.terminate(); await rm(root, { recursive: true, force: true }) })
  await store.ready
  const queued = store.get('missing'), closing = store.close()
  const outcome = Promise.allSettled([queued, closing])
  await worker.terminate()
  const results = await outcome
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled')
  if (results[0].status === 'rejected') assert.match(String(results[0].reason), /worker exited/)
})
