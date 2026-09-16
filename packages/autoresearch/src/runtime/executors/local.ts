import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { terminal, type JobBackend, type JobReceipt, type JobSpec } from '../contracts.js'
import { assertLocalContainment, validateLocalBudget } from '../budget.js'
import type { JobStore } from '../job-store.js'
import { sendControl } from '../local-control.js'
import { validateCheckpoint } from '../checkpoint.js'

export function localJobDirectory(root: string, jobId: string): string { return join(root, 'jobs', createHash('sha256').update(jobId).digest('hex')) }
export class LocalJobBackend implements JobBackend {
  constructor(readonly store: JobStore, private fence?: number) {}
  atFence(fence: number): LocalJobBackend { return new LocalJobBackend(this.store, fence) }
  async submit(spec: JobSpec, fence: number): Promise<JobReceipt> {
    assertLocalContainment()
    validateLocalBudget(spec.budget)
    if (spec.env.AUTORESEARCH_CHECKPOINT_APPLICATION_VERSION) {
      const manifest = await validateCheckpoint(spec, spec.env.AUTORESEARCH_CHECKPOINT_APPLICATION_VERSION)
      if (manifest.payloadHash !== spec.env.AUTORESEARCH_CHECKPOINT_PAYLOAD_HASH) throw new Error('checkpoint payload changed after resume validation')
    }
    const nonce = randomUUID(), startupId = randomUUID()
    const socketId = createHash('sha256').update(this.store.root + spec.id + nonce).digest('hex').slice(0, 36)
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\autoresearch-${socketId}` : join(tmpdir(), `ar-${socketId}.sock`)
    const fresh = await this.store.prepareSpawn(spec.id, fence, { nonce, startupId, host: hostname(), socket, pid: null })
    if (!fresh) return this.inspect(spec.id)
    const directory = localJobDirectory(this.store.root, spec.id)
    await mkdir(directory, { recursive: true })
    const log = await open(join(directory, 'supervisor.log'), 'a')
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../local-supervisor.js', import.meta.url)), this.store.root, spec.id, nonce], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
    } finally { await log.close() }
    return (await this.store.get(spec.id)).receipt
  }
  async inspect(jobId: string): Promise<JobReceipt> {
    const job = await this.store.get(jobId)
    if (this.fence !== undefined && this.fence !== job.fence) throw new Error('stale backend fence')
    if (terminal(job.receipt.status)) return job.receipt
    try { return await sendControl(job, 'inspect') }
    catch { const latest = await this.store.get(jobId); return terminal(latest.receipt.status) ? latest.receipt : { ...latest.receipt, status: 'unknown' } }
  }
  async collect(jobId: string): Promise<JobReceipt> { return this.inspect(jobId) }
  async cancel(jobId: string): Promise<JobReceipt> {
    const job = await this.store.get(jobId)
    if (this.fence !== undefined && this.fence !== job.fence) throw new Error('stale backend fence')
    if (terminal(job.receipt.status)) return job.receipt
    try { return await sendControl(job, 'cancel') }
    catch { return { ...job.receipt, status: 'unknown' } }
  }
}
