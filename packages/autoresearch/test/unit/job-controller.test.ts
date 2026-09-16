import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcile, JobController } from '../../dist/runtime/job-controller.js'
import { openJobStore } from '../../dist/runtime/job-store.js'
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
