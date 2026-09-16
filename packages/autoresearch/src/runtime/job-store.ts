import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { BudgetSnapshot, JobRecord, JobReceipt, JobSpec, LogRecord, RuntimeLimits, SupervisorIdentity } from './contracts.js'

export class JobStore {
  private serial = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private state: 'open' | 'closing' | 'closed' = 'open'
  private closePromise: Promise<void> | undefined
  private failure: Error | undefined
  private readonly exited: Promise<number>
  readonly ready: Promise<void>
  constructor(readonly root: string, private worker: Worker) {
    let settleReady: ((error?: Error) => void) | undefined
    this.ready = new Promise((resolveReady, rejectReady) => {
      settleReady = error => error ? rejectReady(error) : resolveReady()
    })
    this.exited = new Promise(resolveExit => {
      worker.once('exit', code => {
        resolveExit(code)
        const error = new Error(`job worker exited (${code})`)
        settleReady?.(error); settleReady = undefined
        if (this.state === 'open' || this.pending.size > 0) this.fail(error)
      })
    })
    worker.on('message', message => {
      if (message.type === 'ready') {
        settleReady?.(message.error ? new Error(message.error) : undefined); settleReady = undefined
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result)
    })
    worker.once('error', error => { settleReady?.(error); settleReady = undefined; this.fail(error) })
  }
  private fail(error: Error): void {
    this.failure ??= error
    for (const pending of this.pending.values()) pending.reject(this.failure)
    this.pending.clear()
  }
  private call<T>(action: string, data: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.state !== 'open') return Promise.reject(new Error(`job store is ${this.state}`))
    return this.post<T>(action, data)
  }
  private post<T>(action: string, data: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise<T>((resolveCall, reject) => {
      const id = ++this.serial
      this.pending.set(id, { resolve: resolveCall, reject })
      try { this.worker.postMessage({ id, action, data }) }
      catch (error) { this.pending.delete(id); reject(error) }
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
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.state === 'closed') return Promise.resolve()
    this.state = 'closing'
    this.closePromise = this.finishClose()
    return this.closePromise
  }
  private async finishClose(): Promise<void> {
    try {
      if (!this.failure) { await this.ready; await this.post('close') }
      await this.exited
    } catch (error) {
      if (!this.failure) throw error
      await this.exited
    } finally { this.state = 'closed' }
  }
}
export async function openJobStore(root: string, limits?: Partial<RuntimeLimits>): Promise<JobStore> {
  root = resolve(root)
  await mkdir(root, { recursive: true })
  const store = new JobStore(root, new Worker(new URL('./job-store-worker.js', import.meta.url), { workerData: { root, limits } }))
  try { await store.ready; return store }
  catch (error) { await store.close().catch(() => {}); throw error }
}
