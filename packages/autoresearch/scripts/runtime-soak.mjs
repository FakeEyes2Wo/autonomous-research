import { fork, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { localJobDirectory } from '../dist/runtime/executors/local.js'
import { openJobStore } from '../dist/runtime/job-store.js'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const terminal = status => ['succeeded', 'failed', 'cancelled'].includes(status)
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
const sha = content => createHash('sha256').update(content).digest('hex')

export function validateConfig(config, durationMs) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 24 * 3600000) throw new Error('duration must be positive and at most 24 hours')
  if (config.schema !== 'autoresearch/soak/v1' || !config.jobs?.length) throw new Error('invalid soak schema/jobs')
  if (!Number.isSafeInteger(config.limits?.maxReservedWallMs) || config.limits.maxReservedWallMs <= 0 || config.limits.maxReservedWallMs === Number.MAX_SAFE_INTEGER) throw new Error('explicit finite aggregate wall budget required')
  if (config.limits.maxConcurrentJobs !== 1) throw new Error('controlled soak requires maxConcurrentJobs=1')
  for (const key of ['maxDiskBytes', 'maxHarnessLogBytes']) if (!Number.isSafeInteger(config[key]) || config[key] < 1024) throw new Error(`finite ${key} required`)
  if (!Array.isArray(config.restartAfterMs) || config.restartAfterMs.some(ms => !Number.isSafeInteger(ms) || ms < 0)) throw new Error('invalid restart schedule')
  for (const job of config.jobs) {
    const delay = Number(job.env?.JOB_DELAY)
    if (!Number.isSafeInteger(delay) || delay < 60000 || delay > 300000) throw new Error('controlled jobs must last 1 to 5 minutes')
    if (!Number.isSafeInteger(job.budget?.wallMs) || job.budget.wallMs <= delay || job.budget.wallMs > 360000) throw new Error('finite per-job wall budget required')
    if (job.executable !== '$NODE' || job.args?.length !== 1 || job.args[0] !== '$WORKLOAD') throw new Error('soak only authorizes the trusted bounded fixture workload')
    for (const key of ['maxLogBytes', 'maxArtifactBytes']) if (!Number.isSafeInteger(job.budget[key]) || job.budget[key] < 1 || job.budget[key] > 1048576) throw new Error(`invalid ${key}`)
  }
  return config
}

export function auditEvidence({ jobs, executions, submissions, usages, artifacts }) {
  const countDuplicates = rows => {
    const counts = new Map()
    for (const row of rows) { const key = row.jobId ?? row.job_id; counts.set(key, (counts.get(key) ?? 0) + 1) }
    return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  }
  const succeeded = jobs.filter(job => job.receipt.status === 'succeeded')
  return {
    duplicateSubmissions: Math.max(countDuplicates(executions), countDuplicates(submissions)),
    lostResults: succeeded.filter(job => !artifacts.some(artifact => artifact.jobId === job.spec.id && artifact.valid)).length,
    unresolvedJobs: jobs.filter(job => !terminal(job.receipt.status)).length,
    settlementMismatches: jobs.filter(job => terminal(job.receipt.status) && usages.filter(row => row.job_id === job.spec.id).length !== 1).length,
  }
}

async function filesUnder(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else files.push({ path, bytes: (await stat(path)).size })
  }
  return files
}
async function jsonLines(path) {
  const content = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  return content.trim() ? content.trim().split('\n').map(line => JSON.parse(line)) : []
}

export async function runSoak(config, durationMs, output) {
  validateConfig(config, durationMs)
  if (process.platform !== 'win32') throw new Error('controlled local soak requires Windows containment')
  output = resolve(output)
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('output directory must be empty; evidence is never overwritten')
  const runId = randomUUID(), startedMs = Date.now(), deadline = startedMs + durationMs
  const root = join(output, 'runtime'), eventsPath = join(output, 'events.jsonl'), executionsPath = join(output, 'executions.jsonl')
  const limits = config.limits
  const runtimeFiles = (await filesUnder(join(packageRoot, 'dist/runtime'))).filter(file => file.path.endsWith('.js')).map(file => relative(packageRoot, file.path).replaceAll('\\', '/')).sort()
  const fingerprints = await Promise.all(['scripts/runtime-soak.mjs', 'test/fixtures/jobs/soak-controller.mjs', 'test/fixtures/jobs/soak-workload.mjs', ...runtimeFiles].map(async path => ({ path, sha256: sha(await readFile(join(packageRoot, path))) })))
  await writeFile(join(output, 'run.json'), JSON.stringify({ runId, pid: process.pid, startedAt: new Date(startedMs).toISOString(), durationMs, config, fingerprints, node: process.version, platform: process.platform, authority: 'trusted local controlled programs; not a security sandbox' }, null, 2))
  let child, serial = 0, harnessBytes = 0, crashBoundaries = new Set(), schedule = [...config.restartAfterMs].sort((a, b) => a - b), initialBudget, failure
  const pending = new Map()
  async function event(type, data = {}) {
    const line = JSON.stringify({ type, at: new Date().toISOString(), elapsedMs: Date.now() - startedMs, ...data }) + '\n'
    if (harnessBytes + Buffer.byteLength(line) > config.maxHarnessLogBytes) throw new Error('harness log budget exceeded')
    harnessBytes += Buffer.byteLength(line)
    await appendFile(eventsPath, line)
  }
  async function start(tolerateLogFailure = false) {
    child = fork(join(packageRoot, 'test/fixtures/jobs/soak-controller.mjs'), [root, JSON.stringify(limits)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] })
    const controllerProcess = child
    const rejectPending = error => {
      for (const [id, entry] of pending) if (entry.child === controllerProcess) { pending.delete(id); entry.reject(error) }
    }
    child.stdout.resume(); child.stderr.resume()
    child.on('message', message => {
      const entry = pending.get(message.id)
      if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.value) }
    })
    child.on('error', rejectPending)
    child.on('disconnect', () => rejectPending(new Error('controller IPC disconnected')))
    child.on('exit', (code, signal) => rejectPending(new Error(`controller exited ${code}/${signal}`)))
    const ready = await Promise.race([once(child, 'message').then(([message]) => message), once(child, 'exit').then(() => { throw new Error('controller exited before ready') })])
    if (ready.type !== 'ready') throw new Error('controller handshake failed')
    try { await event('controller-start', { pid: child.pid }) }
    catch (error) { if (!tolerateLogFailure) throw error; failure ??= String(error) }
  }
  async function rpc(op, data = {}) {
    const controllerProcess = child
    if (!controllerProcess?.connected || controllerProcess.exitCode !== null || controllerProcess.signalCode !== null) throw new Error(`controller unavailable for ${op}`)
    const id = ++serial
    let timeout
    try {
      return await Promise.race([new Promise((resolveCall, reject) => {
        pending.set(id, { child: controllerProcess, resolve: resolveCall, reject })
        // The callback handles the race where IPC closes after the connected
        // check. Omitting it emits an unhandled ChildProcess error instead.
        controllerProcess.send({ id, op, ...data }, error => { if (error) reject(error) })
      }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`controller timeout: ${op}`)), 20000) })])
    } finally { clearTimeout(timeout); pending.delete(id) }
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); const pid = child.pid; child.kill('SIGKILL'); await exited
      await event('controller-stop', { pid }).catch(error => { failure ??= String(error) })
    }
  }
  async function restart(boundary, before) {
    before ??= (await rpc('snapshot')).budget
    await event('before-restart', { boundary, pid: child.pid, budget: before })
    await stop(); await start()
    const after = (await rpc('snapshot')).budget
    await event('after-restart', { boundary, pid: child.pid, budget: after, before })
    if (after.settledWallMs < before.settledWallMs) throw new Error('persistent budget reset after restart')
  }
  function spec(index, id = `soak-${index}`) {
    const template = structuredClone(config.jobs[index % config.jobs.length])
    return { ...template, id, attemptId: `${id}-attempt`, executable: process.execPath, args: [join(packageRoot, 'test/fixtures/jobs/soak-workload.mjs')], cwd: output, env: { ...template.env, SOAK_JOB_ID: id, SOAK_EXECUTIONS: executionsPath } }
  }
  async function awaitTerminal(id, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) { const job = await rpc('get', { jobId: id }); if (terminal(job.receipt.status)) return job; await pause(100) }
    throw new Error(`job did not reach terminal: ${id}`)
  }
  try {
    await start(); initialBudget = (await rpc('snapshot')).budget
    // No supervisor is launched yet: both observations must hold the real reservation.
    const probe = spec(0, 'probe-delayed'), blocked = spec(0, 'probe-blocked')
    await rpc('enqueue', { spec: probe }); await rpc('enqueue', { spec: blocked })
    await rpc('prepare-unknown', { jobId: probe.id })
    for (const phase of ['unknown', 'cancel_requested']) {
      if (phase === 'cancel_requested') await rpc('cancel', { jobId: probe.id })
      const job = await rpc('get', { jobId: probe.id }), snapshot = await rpc('snapshot')
      let capacityRejected = false
      try { await rpc('advance', { jobId: blocked.id }) } catch (error) { if (!/budget\/capacity/.test(String(error))) throw error; capacityRejected = true }
      await event('pause-probe', { phase, status: job.receipt.status, budget: snapshot.budget, capacityRejected })
      if (job.receipt.status !== phase || snapshot.budget.reservedWallMs !== probe.budget.wallMs || !capacityRejected) throw new Error(`pause probe failed: ${phase}`)
    }
    await restart('cancel-unconfirmed')
    const delayed = await rpc('get', { jobId: probe.id })
    const supervisor = spawn(process.execPath, [join(packageRoot, 'dist/runtime/local-supervisor.js'), root, probe.id, delayed.identity.nonce], { windowsHide: true, stdio: 'ignore' })
    const [supervisorCode] = await once(supervisor, 'exit')
    if (supervisorCode !== 0) throw new Error(`delayed supervisor exit ${supervisorCode}`)
    await awaitTerminal(probe.id); await rpc('cancel', { jobId: blocked.id })
    const obstruction = join(output, 'disk-write-obstruction')
    await writeFile(obstruction, 'controlled directory obstruction')
    let diskWriteRejected = false
    try { const badStore = await openJobStore(join(obstruction, 'child')); await badStore.close() } catch (error) { diskWriteRejected = /ENOTDIR|EEXIST/.test(String(error)) }
    await event('disk-write-probe', { rejected: diskWriteRejected })
    if (!diskWriteRejected) throw new Error('disk obstruction did not reject store initialization')
    let index = 0, active = null, nextSample = 0
    while (Date.now() < deadline) {
      if (schedule.length && Date.now() - startedMs >= schedule[0]) { schedule.shift(); await restart('scheduled') }
      if (Date.now() >= nextSample) {
        const snapshot = await rpc('snapshot'), files = await filesUnder(output)
        const diskBytes = files.reduce((sum, file) => sum + file.bytes, 0)
        const statusCounts = {}
        for (const job of snapshot.jobs) statusCounts[job.receipt.status] = (statusCounts[job.receipt.status] ?? 0) + 1
        await event('sample', { budget: snapshot.budget, controllerRss: snapshot.rss, harnessRss: process.memoryUsage().rss, diskBytes, statusCounts })
        if (diskBytes > config.maxDiskBytes) throw new Error('soak disk budget exceeded')
        nextSample = Date.now() + 5000
      }
      if (!active) {
        const input = spec(index++)
        if (deadline - Date.now() < Number(input.env.JOB_DELAY) + 3000) { await pause(Math.min(500, deadline - Date.now())); continue }
        await rpc('enqueue', { spec: input }); active = input.id
        if (!crashBoundaries.has('before-submit')) { await restart('before-submit'); crashBoundaries.add('before-submit') }
        if (!crashBoundaries.has('after-spawn')) {
          const response = await rpc('crash-after-spawn', { jobId: active })
          await restart('after-spawn', response.budget); crashBoundaries.add('after-spawn')
        } else await rpc('advance', { jobId: active })
      }
      const job = await rpc('get', { jobId: active })
      if (terminal(job.receipt.status)) {
        if (!crashBoundaries.has('before-collect')) { await restart('before-collect'); crashBoundaries.add('before-collect') }
        await rpc('advance', { jobId: active }); await event('collected', { jobId: active, receipt: job.receipt })
        if (job.receipt.status !== 'succeeded') throw new Error(`controlled job failed: ${active}`)
        active = null
      } else if (job.leaseUntil <= Date.now()) await rpc('advance', { jobId: active })
      await pause(250)
    }
  } catch (error) { failure = String(error); await event('failure', { error: failure }).catch(() => {}) }
  finally {
    // Cancellation is persisted and tree confirmation is required even on harness errors.
    try {
        if (!child?.connected || child.exitCode !== null || child.signalCode !== null) {
          await stop()
          await start(true)
        }
        for (const job of (await rpc('snapshot')).jobs) if (!terminal(job.receipt.status)) {
          // A crashed owner retains its lease. Recovery cannot borrow its
          // fence or bypass the lease; wait, then authenticate a fresh cancel.
          await pause(Math.max(0, job.leaseUntil - Date.now() + 25))
          await rpc('cancel', { jobId: job.spec.id })
          if (job.spec.id === 'probe-delayed' && job.identity && !job.executionClaimed) {
            // A failure can interrupt the probe before its intentionally delayed
            // supervisor starts. Only the original nonce may certify this stop.
            const supervisor = spawn(process.execPath, [join(packageRoot, 'dist/runtime/local-supervisor.js'), root, job.spec.id, job.identity.nonce], { windowsHide: true, stdio: 'ignore' })
            await once(supervisor, 'exit')
          }
          await awaitTerminal(job.spec.id)
        }
        const afterCleanup = (await rpc('snapshot')).budget
        if (afterCleanup.activeJobs !== 0 || afterCleanup.reservedWallMs !== 0) throw new Error('cleanup did not settle all reservations')
      } catch (error) { failure = [failure, `cleanup: ${String(error)}`].filter(Boolean).join('; ') }
    await stop()
  }
  const events = await jsonLines(eventsPath), executions = await jsonLines(executionsPath)
  const db = new DatabaseSync(join(root, 'jobs.sqlite'), { readOnly: true })
  const rows = table => db.prepare(`SELECT * FROM ${table}`).all()
  const jobs = rows('jobs').map(row => JSON.parse(row.body)), usages = rows('usage'), submissions = rows('outbox'), reservations = rows('reservations')
  const persistedLimits = JSON.parse(rows('settings')[0].body)
  db.close()
  const artifacts = []
  for (const job of jobs.filter(job => job.receipt.status === 'succeeded')) {
    try {
      const manifest = JSON.parse(await readFile(join(localJobDirectory(root, job.spec.id), 'artifact-manifest.json'), 'utf8'))
      const entries = manifest.files
      const valid = sha(JSON.stringify(entries)) === job.receipt.artifactManifestHash && (await Promise.all(entries.map(async entry => sha(await readFile(join(localJobDirectory(root, job.spec.id), 'artifacts', entry.path))) === entry.hash))).every(Boolean)
      artifacts.push({ jobId: job.spec.id, valid, manifest })
    } catch (error) { artifacts.push({ jobId: job.spec.id, valid: false, error: String(error) }) }
  }
  const allFiles = await filesUnder(output), restarts = events.filter(event => event.type === 'after-restart')
  const report = {
    runId, mode: 'local-controlled-jobs', startedAt: new Date(startedMs).toISOString(), endedAt: new Date().toISOString(), elapsedMs: Date.now() - startedMs, requestedDurationMs: durationMs,
    controllerRestarts: restarts.length, ...auditEvidence({ jobs, executions: executions.filter(event => event.type === 'execution'), submissions, usages, artifacts }),
    completedExecutions: executions.filter(event => event.type === 'completion').length,
    peakRssBytes: Math.max(...events.filter(event => event.type === 'sample').map(event => event.controllerRss + event.harnessRss), process.memoryUsage().rss),
    rssScope: 'sampled controller plus harness; workload/supervisor excluded',
    logBytes: allFiles.filter(file => /\.log$|\.jsonl$/.test(file.path)).reduce((sum, file) => sum + file.bytes, 0),
    diskBytes: allFiles.reduce((sum, file) => sum + file.bytes, 0),
    budgetAfterRestart: { spent: restarts.at(-1)?.budget.settledWallMs ?? null, snapshots: restarts },
    budgetMonotonic: restarts.length > 0 && restarts.every(event => event.budget.settledWallMs >= event.before.settledWallMs),
    initialBudget, finalBudget: { settledWallMs: usages.reduce((sum, row) => sum + row.wall_ms, 0), reservedWallMs: reservations.reduce((sum, row) => sum + row.wall_ms, 0), activeJobs: reservations.length }, persistedLimits,
    probes: {
      unknownPaused: events.some(event => event.type === 'pause-probe' && event.status === 'unknown' && event.capacityRejected && event.budget.activeJobs === 1),
      cancellationUnconfirmedPaused: events.some(event => event.type === 'pause-probe' && event.status === 'cancel_requested' && event.capacityRejected && event.budget.activeJobs === 1),
      diskWriteRejected: events.some(event => event.type === 'disk-write-probe' && event.rejected),
    },
    recoveryBoundaries: [...new Set(restarts.map(event => event.boundary))], failure: failure ?? null,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    fingerprints,
  }
  report.passed = !failure && report.elapsedMs >= durationMs && report.controllerRestarts >= 3 && report.completedExecutions > 0 && report.duplicateSubmissions === 0 && report.lostResults === 0 && report.unresolvedJobs === 0 && report.settlementMismatches === 0 && report.budgetMonotonic && Object.values(report.probes).every(Boolean) && report.finalBudget.reservedWallMs === 0
  await writeFile(join(output, 'database-evidence.json'), JSON.stringify({ jobs, usages, submissions, reservations, artifacts, executions }, null, 2))
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ output, report }, null, 2))
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {}
  for (let i = 0; i < args.length; i += 2) { if (!['--duration-hours', '--duration-seconds', '--config', '--output'].includes(args[i]) || !args[i + 1]) throw new Error('usage: --duration-hours 2|24 --config <json> --output <empty-directory>'); options[args[i]] = args[i + 1] }
  if (options['--duration-hours'] && options['--duration-seconds']) throw new Error('choose one duration unit')
  const durationMs = options['--duration-seconds'] ? Number(options['--duration-seconds']) * 1000 : Number(options['--duration-hours'] ?? 2) * 3600000
  const config = JSON.parse(await readFile(resolve(options['--config'] ?? join(packageRoot, 'test/fixtures/jobs/soak-config.json')), 'utf8'))
  try { const report = await runSoak(config, durationMs, options['--output'] ?? config.outputDir); process.exitCode = report.passed ? 0 : 1 }
  catch (error) { console.error(error); process.exitCode = 1 }
}
