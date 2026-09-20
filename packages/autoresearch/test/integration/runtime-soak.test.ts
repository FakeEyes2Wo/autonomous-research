import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

test('soak audit derives duplicate, lost and unresolved counts from observed rows', async () => {
  const { auditEvidence } = await import('../../scripts/runtime-soak.mjs')
  const result = auditEvidence({
    jobs: [
      { spec: { id: 'a' }, receipt: { status: 'succeeded', artifactManifestHash: 'h' } },
      { spec: { id: 'b' }, receipt: { status: 'unknown', artifactManifestHash: null } },
      { spec: { id: 'c' }, receipt: { status: 'succeeded', artifactManifestHash: 'missing' } },
    ],
    executions: [{ jobId: 'a' }, { jobId: 'a' }, { jobId: 'c' }],
    submissions: [{ job_id: 'a' }, { job_id: 'b' }, { job_id: 'c' }],
    usages: [{ job_id: 'a', wall_ms: 123 }],
    artifacts: [{ jobId: 'a', valid: true }, { jobId: 'c', valid: false }],
  })
  assert.equal(result.duplicateSubmissions, 1)
  assert.equal(result.lostResults, 1)
  assert.equal(result.unresolvedJobs, 1)
  assert.equal(result.settlementMismatches, 1)
})

test('soak rejects unbounded configuration and leaves 24 hours explicit', async () => {
  const { validateConfig } = await import('../../scripts/runtime-soak.mjs')
  const config = JSON.parse(await readFile(resolve('test/fixtures/jobs/soak-config.json'), 'utf8'))
  assert.equal(validateConfig(config, 24 * 3600000).limits.maxConcurrentJobs, 1)
  assert.throws(() => validateConfig({ ...config, limits: { maxConcurrentJobs: 1 } }, 7200000), /finite|budget/i)
  assert.throws(() => validateConfig(config, 0), /duration/i)
})

test('harness log exhaustion still confirms cancellation and writes a failure report', { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoresearch-soak-log-limit-'))
  const config = JSON.parse(await readFile(resolve('test/fixtures/jobs/soak-config.json'), 'utf8'))
  config.maxHarnessLogBytes = 1024
  const configPath = join(directory, 'config.json'), output = join(directory, 'output')
  await writeFile(configPath, JSON.stringify(config))
  const child = spawn(process.execPath, [resolve('scripts/runtime-soak.mjs'), '--duration-seconds', '3', '--config', configPath, '--output', output], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
  const [code] = await once(child, 'exit')
  assert.equal(code, 1)
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  assert.match(report.failure, /log budget/)
  assert.equal(report.passed, false)
  assert.equal(report.unresolvedJobs, 0)
  assert.equal(report.finalBudget.reservedWallMs, 0)
  assert.ok((await readFile(join(output, 'events.jsonl'))).byteLength <= 1024)
})

test('unexpected controller exit cancels its live job and preserves a failure report', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const output = await mkdtemp(join(tmpdir(), 'autoresearch-soak-controller-exit-'))
  const child = spawn(process.execPath, [resolve('scripts/runtime-soak.mjs'), '--duration-seconds', '80', '--config', resolve('test/fixtures/jobs/soak-config.json'), '--output', output], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''; child.stderr.on('data', data => { stderr += data })
  const exited = once(child, 'exit')
  const pause = (ms: number) => new Promise(resolvePause => setTimeout(resolvePause, ms))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    const { openJobStore } = await import('../../dist/runtime/job-store.js')
    const { JobController } = await import('../../dist/runtime/job-controller.js')
    const { LocalJobBackend } = await import('../../dist/runtime/executors/local.js')
    const store = await openJobStore(join(output, 'runtime'))
    try {
      const controller = new JobController(store, new LocalJobBackend(store))
      for (const job of await store.list()) if (!['succeeded', 'failed', 'cancelled'].includes(job.receipt.status)) {
        await pause(Math.max(0, job.leaseUntil - Date.now() + 50))
        await controller.cancel(job.spec.id, 'fault regression cleanup')
      }
      const deadline = Date.now() + 20000
      while ((await store.budget()).activeJobs && Date.now() < deadline) await pause(100)
      assert.equal((await store.budget()).activeJobs, 0, 'test cleanup must confirm termination')
    } finally { await store.close() }
  })
  const deadline = Date.now() + 15000
  let killed = false
  while (Date.now() < deadline) {
    const executions = await readFile(join(output, 'executions.jsonl'), 'utf8').catch(() => '')
    const events = (await readFile(join(output, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (executions && events.some(event => event.type === 'after-restart' && event.boundary === 'after-spawn')) {
      process.kill(events.filter(event => event.type === 'controller-start').at(-1).pid, 'SIGKILL')
      killed = true; break
    }
    await pause(20)
  }
  assert.equal(killed, true, 'must kill an actual controller while its workload is alive')
  const [code] = await exited
  assert.equal(code, 1, stderr)
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  assert.equal(report.passed, false)
  // Windows may surface the killed controller's broken pipe as EPIPE before the IPC error is named.
  assert.match(report.failure, /controller|IPC|EPIPE/i)
  assert.equal(report.unresolvedJobs, 0)
  assert.equal(report.finalBudget.reservedWallMs, 0)
  assert.equal(report.finalBudget.activeJobs, 0)
  assert.doesNotMatch(stderr, /Unhandled 'error' event|ERR_IPC_CHANNEL_CLOSED/)
})

test('three minute Windows subprocess recovery keeps submissions results and budgets durable', { skip: process.platform !== 'win32', timeout: 270000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), 'autoresearch-soak-recovery-'))
  const child = spawn(process.execPath, [resolve('scripts/runtime-soak.mjs'), '--duration-seconds', '180', '--config', resolve('test/fixtures/jobs/soak-config.json'), '--output', output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', data => { stderr += data }); child.stdout.resume()
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, stderr + `\nEvidence: ${output}`)
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  assert.ok(report.elapsedMs >= 180000)
  assert.ok(report.controllerRestarts >= 3)
  assert.equal(report.duplicateSubmissions, 0)
  assert.equal(report.lostResults, 0)
  assert.equal(report.unresolvedJobs, 0)
  assert.equal(report.settlementMismatches, 0)
  assert.equal(report.budgetMonotonic, true)
  assert.ok(report.budgetAfterRestart.spent > 0)
  assert.equal(report.probes.unknownPaused, true)
  assert.equal(report.probes.cancellationUnconfirmedPaused, true)
  assert.equal(report.probes.diskWriteRejected, true)
})
