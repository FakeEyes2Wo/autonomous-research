import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { BudgetSnapshot, JobRecord, JobReceipt, JobSpec, LogRecord, RuntimeLimits, SupervisorIdentity } from './contracts.js'

export class JobStore {
  private serial = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private stopped = false
  readonly ready: Promise<void>
  constructor(readonly root: string, private worker: Worker) {
    this.ready = new Promise((resolveReady, rejectReady) => {
      worker.on('message', message => {
        if (message.type === 'ready') { message.error ? rejectReady(new Error(message.error)) : resolveReady(); return }
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result)
      })
      const fail = (error: Error) => { this.stopped = true; rejectReady(error); for (const p of this.pending.values()) p.reject(error); this.pending.clear() }
      worker.on('error', fail)
      worker.on('exit', code => { if (!this.stopped) fail(new Error(`job worker exited (${code})`)) })
    })
  }
  private async call<T>(action: string, data: unknown = {}): Promise<T> {
    await this.ready
    if (this.stopped) throw new Error('job store is closed')
    return new Promise<T>((resolveCall, reject) => {
      const id = ++this.serial
      this.pending.set(id, { resolve: resolveCall, reject })
      this.worker.postMessage({ id, action, data })
    })
  }
  enqueue(spec: JobSpec): Promise<JobRecord> { return this.call('enqueue', { spec }) }
  get(jobId: string): Promise<JobRecord> { return this.call('get', { jobId }) }
  list(): Promise<JobRecord[]> { return this.call('list') }
  claim(jobId: string, owner: string, now = Date.now(), leaseMs = 15000): Promise<JobRecord> { return this.call('claim', { jobId, owner, now, leaseMs }) }
  release(jobId: string, fence: number): Promise<void> { return this.call('release', { jobId, fence }) }
  beginSubmission(jobId: string, fence: number, now = Date.now()): Promise<JobRecord> { return this.call('beginSubmission', { jobId, fence, now }) }
  markUnknown(jobId: string, fence: number, reason: string): Promise<JobRecord> { return this.call('markUnknown', { jobId, fence, reason }) }
  acceptReceipt(receipt: JobReceipt, fence: number, now = Date.now()): Promise<JobRecord> { return this.call('acceptReceipt', { jobId: receipt.jobId, receipt, fence, now }) }
  requestCancel(jobId: string, fence: number, reason: string): Promise<JobRecord> { return this.call('requestCancel', { jobId, fence, reason }) }
  prepareSpawn(jobId: string, fence: number, identity: SupervisorIdentity): Promise<boolean> { return this.call('prepareSpawn', { jobId, fence, identity }) }
  claimExecution(jobId: string, nonce: string, pid: number): Promise<boolean> { return this.call('claimExecution', { jobId, nonce, pid }) }
  supervisorUpdate(jobId: string, nonce: string, update: { receipt?: JobReceipt; reason?: string; logs?: LogRecord[]; now?: number }): Promise<JobRecord> { return this.call('supervisorUpdate', { jobId, nonce, ...update, now: update.now ?? Date.now() }) }
  budget(): Promise<BudgetSnapshot> { return this.call('budget') }
  linkRequest(jobId: string, requestId: string): Promise<void> { return this.call('linkRequest', { jobId, requestId }) }
  async close(): Promise<void> { if (this.stopped) return; await this.call('close'); this.stopped = true; await this.worker.terminate() }
}
export async function openJobStore(root: string, limits?: Partial<RuntimeLimits>): Promise<JobStore> {
  root = resolve(root)
  await mkdir(root, { recursive: true })
  const store = new JobStore(root, new Worker(new URL('./job-store-worker.js', import.meta.url), { workerData: { root, limits } }))
  await store.ready
  return store
}
