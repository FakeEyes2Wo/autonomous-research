import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { openJobStore } from './job-store.js'
import { terminal, type JobReceipt } from './contracts.js'
import { localJobDirectory } from './executors/local.js'
import { collectArtifacts, writeArtifactManifest } from './artifacts.js'
import { JobLogs } from './job-logs.js'
import { WINDOWS_JOB_RUNNER, windowsCommandLine } from './windows-job.js'
import { assertLocalContainment } from './budget.js'

const [root, jobId, nonce] = process.argv.slice(2)
if (!root || !jobId || !nonce) throw new Error('supervisor requires root, jobId, nonce')
assertLocalContainment()
const store = await openJobStore(root)
let child: ChildProcess | undefined
let timer: NodeJS.Timeout | undefined
let finalizing = false
let cancellation = false
let artifactFailure: string | null = null
const directory = localJobDirectory(root, jobId)
const artifactDirectory = join(directory, 'artifacts')
const cancelPath = join(directory, 'cancel.request')
const resultPath = join(directory, 'tree-result.json')
let job = await store.get(jobId)
const identity = job.identity
if (!identity || identity.nonce !== nonce || identity.host !== hostname() || !(await store.claimExecution(jobId, nonce, process.pid))) {
  await store.close(); process.exit(0)
}
await mkdir(artifactDirectory, { recursive: true })
const logs = new JobLogs(directory, job.spec.budget.maxLogBytes)
const server = createServer(socket => {
  let input = ''
  socket.setTimeout(2000, () => socket.destroy())
  socket.on('error', () => {})
  socket.on('data', data => {
    input += data.toString()
    if (input.length > 65536) { socket.destroy(); return }
    if (!input.includes('\n')) return
    socket.pause()
    void (async () => {
      const request = JSON.parse(input.split('\n')[0]!)
      const current = await store.get(jobId)
      if (request.jobId !== jobId || request.nonce !== nonce || request.host !== identity.host || request.startupId !== identity.startupId || request.fence !== current.fence) throw new Error('stale fence or supervisor identity mismatch')
      if (request.command === 'cancel') {
        await store.requestCancel(jobId, current.fence, current.cancellationReason ?? 'user cancellation')
        await requestStop()
      } else if (request.command !== 'inspect') throw new Error('unknown control command')
      const latest = await store.get(jobId)
      socket.end(JSON.stringify({ nonce, jobId, host: identity.host, startupId: identity.startupId, receipt: latest.receipt }) + '\n')
    })().catch(() => socket.destroy())
  })
})
async function requestStop(): Promise<void> {
  cancellation = true
  if (process.platform === 'win32') await writeFile(cancelPath, nonce!)
  else if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
}
async function cleanup(): Promise<void> {
  if (timer) clearInterval(timer)
  logs.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (process.platform !== 'win32') await unlink(identity!.socket).catch(() => {})
  await store.close()
}
async function finish(exitCode: number | null): Promise<void> {
  if (finalizing) return
  finalizing = true
  if (timer) clearInterval(timer)
  let treeStopped = false
  if (process.platform === 'win32') {
    try {
      const proof = JSON.parse(await readFile(resultPath, 'utf8'))
      treeStopped = proof.nonce === nonce && proof.treeStopped === true
      if (treeStopped) { exitCode = proof.exitCode; cancellation ||= proof.cancelled === true }
    } catch { /* No certificate means unknown, never a released reservation. */ }
  } else if (child?.pid) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* Verify independently below. */ }
    for (let tries = 0; tries < 100; tries++) {
      try { process.kill(-child.pid, 0); await new Promise(resolve => setTimeout(resolve, 20)) }
      catch (error) { treeStopped = (error as NodeJS.ErrnoException).code === 'ESRCH'; break }
    }
  }
  job = await store.get(jobId!)
  let receipt: JobReceipt = { ...job.receipt, exitCode, heartbeatAt: new Date().toISOString(), status: treeStopped ? cancellation ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed' : 'unknown' }
  let reason = treeStopped ? job.cancellationReason : 'process tree termination unconfirmed'
  if (treeStopped) {
    try {
      const manifest = await collectArtifacts(artifactDirectory, job.spec.budget.maxArtifactBytes)
      await writeArtifactManifest(directory, manifest)
      receipt.artifactManifestHash = manifest.hash
      if (manifest.files.length) receipt.progressAt = new Date().toISOString()
    } catch (error) { artifactFailure = String(error) }
    if (artifactFailure) { receipt.status = 'failed'; reason = artifactFailure }
  }
  await store.supervisorUpdate(jobId!, nonce!, { receipt, logs: logs.snapshot(), ...(reason ? { reason } : {}) })
  await cleanup()
}

try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(identity.socket, resolve) })
  job = await store.get(jobId)
  if (job.receipt.status === 'cancel_requested' || (job.deadlineAt !== null && Date.now() >= job.deadlineAt)) {
    await store.supervisorUpdate(jobId, nonce, { receipt: { ...job.receipt, status: 'cancelled' }, reason: job.cancellationReason ?? 'wall deadline exceeded before execution' })
    await cleanup()
  } else {
    const env = { ...process.env, ...job.spec.env, AUTORESEARCH_ARTIFACT_DIR: artifactDirectory }
    if (process.platform === 'win32') {
      const script = join(directory, 'run-job.ps1'), config = join(directory, 'runner.json')
      await writeFile(script, WINDOWS_JOB_RUNNER, 'utf8')
      await writeFile(config, JSON.stringify({ executable: job.spec.executable, commandLine: windowsCommandLine(job.spec.executable, job.spec.args), cwd: job.spec.cwd, cancelPath, resultPath, nonce }), 'utf8')
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, config], { cwd: job.spec.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } else child = spawn(job.spec.executable, job.spec.args, { cwd: job.spec.cwd, env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', data => logs.write('stdout', data))
    child.stderr?.on('data', data => logs.write('stderr', data))
    child.once('error', error => { artifactFailure = `launch failed: ${String(error)}` })
    child.once('close', code => { void finish(code).catch(async error => { console.error(error); await cleanup().catch(() => {}) }) })
    await store.supervisorUpdate(jobId, nonce, { receipt: { ...job.receipt, status: 'running', heartbeatAt: new Date().toISOString() } })
    let busy = false, heartbeat = Date.now(), previousArtifacts = ''
    timer = setInterval(() => {
      if (busy || finalizing) return
      busy = true
      void (async () => {
        job = await store.get(jobId)
        if (!terminal(job.receipt.status) && job.deadlineAt !== null && Date.now() >= job.deadlineAt) {
          await store.supervisorUpdate(jobId, nonce, { receipt: { ...job.receipt, status: 'cancel_requested' }, reason: 'wall deadline exceeded' })
          await requestStop()
        } else if (job.receipt.status === 'cancel_requested') await requestStop()
        if (Date.now() - heartbeat >= 5000) {
          heartbeat = Date.now()
          const current = await store.get(jobId)
          const receipt = { ...current.receipt, heartbeatAt: new Date().toISOString() }
          try {
            const artifacts = await collectArtifacts(artifactDirectory, job.spec.budget.maxArtifactBytes)
            if (artifacts.files.length && artifacts.hash !== previousArtifacts) { receipt.progressAt = new Date().toISOString(); previousArtifacts = artifacts.hash }
          } catch (error) { artifactFailure = String(error); await requestStop() }
          await store.supervisorUpdate(jobId, nonce, { receipt, logs: logs.snapshot() })
        }
      })().catch(error => console.error(error)).finally(() => { busy = false })
    }, 100)
  }
} catch (error) {
  console.error(error)
  await store.supervisorUpdate(jobId, nonce, { receipt: { ...job.receipt, status: 'unknown' }, reason: String(error) }).catch(() => {})
  await cleanup().catch(() => {})
}
