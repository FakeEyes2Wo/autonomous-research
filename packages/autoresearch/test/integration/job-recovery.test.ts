import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { openJobStore } from '../../dist/runtime/job-store.js'
import { JobController } from '../../dist/runtime/job-controller.js'
import { LocalJobBackend, localJobDirectory } from '../../dist/runtime/executors/local.js'
import type { JobSpec } from '../../dist/runtime/contracts.js'
import { sendControl } from '../../dist/runtime/local-control.js'
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const localOnly = { skip: process.platform !== 'win32' }
function spec(root: string, env: Record<string,string> = {}): JobSpec {
  return { id: 'job', attemptId: 'a1', taskId: 't1', inputHash: 'input', protocolHash: 'protocol', executable: process.execPath, args: [resolve('test/fixtures/jobs/controlled-job.mjs')], cwd: root, env: { EXECUTION_COUNTER: join(root, 'counter'), ...env }, checkpoint: null, budget: { wallMs: 30000, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 100, maxArtifactBytes: 100 } }
}
async function finish(store: Awaited<ReturnType<typeof openJobStore>>, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const job = await store.get('job')
    if (['succeeded', 'failed', 'cancelled'].includes(job.receipt.status)) return job
    await pause(50)
  }
  assert.fail(`job did not finish: ${JSON.stringify(await store.get('job'))}`)
}

for (const boundary of ['before-submit', 'after-spawn', 'before-collect']) {
  test(`real controller kill at ${boundary} recovers one execution and original budget`, { ...localOnly, timeout: 60000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'job-recovery-'))
    const input = spec(root); input.budget.maxLogBytes = 10000
    const specPath = join(root, 'spec.json'); await writeFile(specPath, JSON.stringify(input))
    const child = fork(resolve('test/fixtures/jobs/controller-process.mjs'), [root, specPath, boundary], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    let errors = ''; child.stderr?.on('data', data => { errors += data })
    const stage = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(errors) })])
    assert.equal(stage[0].stage, boundary)
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    const store = await openJobStore(root)
    try {
      const before = await store.get('job')
      if (boundary === 'after-spawn') await pause(Math.max(0, before.leaseUntil - Date.now() + 50))
      const controller = new JobController(store, new LocalJobBackend(store))
      await controller.advance('job')
      const done = await finish(store)
      assert.equal(done.receipt.status, 'succeeded', JSON.stringify(done) + '\n' + await readFile(join(localJobDirectory(root, 'job'), 'stderr.0.log'), 'utf8').catch(() => ''))
      assert.equal((await readFile(join(root, 'counter'), 'utf8')).trim().split('\n').length, 1)
      if (before.deadlineAt !== null) assert.equal(done.deadlineAt, before.deadlineAt)
      await controller.advance('job'); await controller.advance('job')
      const budget = await store.budget()
      assert.equal(budget.activeJobs, 0)
      assert.ok(budget.settledWallMs > 0)
    } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
  })
}

test('racing controllers cannot submit twice and PID identity alone cannot authenticate', localOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-race-')); const a = await openJobStore(root); const b = await openJobStore(root)
  try {
    await a.enqueue(spec(root))
    await Promise.allSettled([new JobController(a, new LocalJobBackend(a)).advance('job'), new JobController(b, new LocalJobBackend(b)).advance('job')])
    await finish(a)
    assert.equal((await readFile(join(root, 'counter'), 'utf8')).trim().split('\n').length, 1)
    const old = await a.claim('job', 'old', 0, 10); const next = await b.claim('job', 'new', 11, 10)
    assert.ok(next.fence > old.fence)
    await assert.rejects(a.requestCancel('job', old.fence, 'stale'), /fence/)
  } finally { await a.close(); await b.close(); await rm(root, { recursive: true, force: true }) }
})

test('artifact cap fails collection and bounded logs retain byte/hash metadata', localOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-limits-')); const store = await openJobStore(root)
  try {
    const controller = new JobController(store, new LocalJobBackend(store)); await controller.enqueue(spec(root, { ARTIFACT_BYTES: '101', LOG_BYTES: '10000' })); await controller.advance('job')
    const done = await finish(store)
    assert.equal(done.receipt.status, 'failed'); assert.match(done.cancellationReason!, /artifact/i)
    assert.equal(done.logs.filter(log => log.stream === 'stdout').reduce((sum, log) => sum + log.bytes, 0), 10000)
    assert.ok(done.logs.reduce((sum, log) => sum + log.retainedBytes, 0) <= 100)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('local job cancellation confirms the owned process tree before releasing budget', localOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-cancel-')); const store = await openJobStore(root)
  try {
    const controller = new JobController(store, new LocalJobBackend(store))
    await controller.enqueue(spec(root, { JOB_DELAY: '15000', SPAWN_DESCENDANT: '1' })); await controller.advance('job')
    const end = Date.now() + 10000
    while (Date.now() < end && !(await readFile(join(root, 'counter'), 'utf8').catch(() => ''))) await pause(50)
    assert.ok(await readFile(join(root, 'counter'), 'utf8'))
    await controller.cancel('job')
    const done = await finish(store)
    assert.equal(done.receipt.status, 'cancelled')
    assert.equal((await store.budget()).activeJobs, 0)
    assert.equal(done.cancellationReason, 'user cancellation')
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('successful root exit terminates its lingering descendant before terminal settlement', localOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-descendant-')); const store = await openJobStore(root)
  try {
    const controller = new JobController(store, new LocalJobBackend(store))
    await controller.enqueue(spec(root, { SPAWN_DESCENDANT: '1' })); await controller.advance('job')
    const done = await finish(store)
    assert.equal(done.receipt.status, 'succeeded')
    assert.equal((await store.budget()).activeJobs, 0)
    const proof = JSON.parse(await readFile(join(localJobDirectory(root, 'job'), 'tree-result.json'), 'utf8'))
    assert.equal(proof.treeStopped, true)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('unreachable supervisor never treats a reused PID as cancellation proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-pid-')); const store = await openJobStore(root)
  try {
    await store.enqueue(spec(root)); const job = await store.claim('job', 'owner'); await store.beginSubmission('job', job.fence)
    await store.prepareSpawn('job', job.fence, { nonce: 'wrong', startupId: 'old-start', host: 'old-host', socket: join(root, 'absent.sock'), pid: process.pid })
    const backend = new LocalJobBackend(store)
    assert.equal((await backend.inspect('job')).status, 'unknown')
    assert.ok(['unknown', 'cancel_requested'].includes((await backend.cancel('job')).status))
    assert.equal((await store.budget()).activeJobs, 1)
    assert.doesNotThrow(() => process.kill(process.pid, 0))
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('authenticated control rejects expired fence and a stale backend cannot cancel with a newer fence', localOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-fence-')); const store = await openJobStore(root)
  try {
    await store.enqueue(spec(root, { JOB_DELAY: '15000' }))
    let old = await store.claim('job', 'old', 0, 1); old = await store.beginSubmission('job', old.fence)
    const backend = new LocalJobBackend(store)
    await backend.submit(old.spec, old.fence)
    const end = Date.now() + 10000
    while (Date.now() < end && !(await readFile(join(root, 'counter'), 'utf8').catch(() => ''))) await pause(50)
    old = await store.get('job')
    const stale = backend.atFence(old.fence)
    const fresh = await store.claim('job', 'new', Date.now())
    await assert.rejects(sendControl(old, 'cancel'))
    await assert.rejects(stale.cancel('job'), /fence/i)
    assert.equal((await store.get('job')).receipt.status, 'running')
    await store.requestCancel('job', fresh.fence, 'test cleanup')
    await backend.atFence(fresh.fence).cancel('job'); await finish(store)
  } finally {
    const current = await store.get('job'); await store.requestCancel('job', current.fence, 'test cleanup')
    await new LocalJobBackend(store).cancel('job'); await finish(store)
    await store.close(); await rm(root, { recursive: true, force: true })
  }
})

test('supervisor enforces original wall deadline after controller goes away', localOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'job-deadline-')); const store = await openJobStore(root)
  try {
    const input = spec(root, { JOB_DELAY: '15000' }); input.budget.wallMs = 1200
    const controller = new JobController(store, new LocalJobBackend(store))
    await controller.enqueue(input); await controller.advance('job')
    const done = await finish(store)
    assert.equal(done.receipt.status, 'cancelled')
    assert.match(done.cancellationReason!, /wall deadline/)
    assert.equal(done.deadlineAt! - done.startedAt!, 1200)
    assert.ok((await store.budget()).settledWallMs < 10000)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
