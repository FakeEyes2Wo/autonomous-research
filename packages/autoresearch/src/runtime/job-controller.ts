import { randomUUID } from 'node:crypto'
import { terminal, type JobBackend, type JobReceipt, type JobSpec } from './contracts.js'
import type { JobStore } from './job-store.js'
import { validateCheckpoint } from './checkpoint.js'

export function reconcile(receipt: JobReceipt): 'watch' | 'collect' | 'diagnose' | 'wait_unknown' | 'finished' {
  switch (receipt.status) {
    case 'unknown': case 'submitting': return 'wait_unknown'
    case 'queued': case 'running': case 'cancel_requested': return 'watch'
    case 'succeeded': return 'collect'
    case 'failed': return 'diagnose'
    case 'cancelled': return 'finished'
  }
}
export class JobController {
  readonly owner = randomUUID()
  constructor(readonly store: JobStore, readonly backend: JobBackend, private clock = Date.now) {}
  enqueue(spec: JobSpec) { return this.store.enqueue(spec) }
  private fencedBackend(fence: number): JobBackend {
    const backend = this.backend as JobBackend & { atFence?: (fence: number) => JobBackend }
    return backend.atFence?.(fence) ?? backend
  }
  async resume(previousJobId: string, next: JobSpec, applicationVersion: string): Promise<JobReceipt> {
    const previous = await this.store.get(previousJobId)
    if (previous.receipt.status === 'succeeded') return this.backend.collect(previousJobId)
    if (!terminal(previous.receipt.status)) throw new Error('cannot resume until prior process termination is confirmed')
    if (next.id === previous.spec.id || next.attemptId === previous.spec.attemptId) throw new Error('resume requires a new job and attempt ID')
    if (next.inputHash !== previous.spec.inputHash || next.protocolHash !== previous.spec.protocolHash || next.executable !== previous.spec.executable) throw new Error('resume input/protocol/application conflict')
    const validated = await validateCheckpoint(previous.spec, applicationVersion)
    const checkpoint = previous.spec.checkpoint!
    return (await this.store.enqueue({ ...next, checkpoint, args: [...previous.spec.args, ...checkpoint.resumeArgs], env: { ...next.env, AUTORESEARCH_CHECKPOINT_APPLICATION_VERSION: applicationVersion, AUTORESEARCH_CHECKPOINT_PAYLOAD_HASH: validated.payloadHash } })).receipt
  }
  async advance(jobId: string): Promise<JobReceipt> {
    let job = await this.store.claim(jobId, this.owner, this.clock())
    const backend = this.fencedBackend(job.fence)
    try {
      let receipt: JobReceipt
      if (job.receipt.status === 'queued') {
        job = await this.store.beginSubmission(jobId, job.fence, this.clock())
        try { receipt = await backend.submit(job.spec, job.fence) }
        catch (error) { return (await this.store.markUnknown(jobId, job.fence, `submission uncertain: ${String(error)}`)).receipt }
      } else if (terminal(job.receipt.status)) receipt = await backend.collect(jobId)
      else {
        // An expired lease never authorizes another submit of a persisted intent.
        try { receipt = await backend.inspect(jobId) }
        catch (error) { return (await this.store.markUnknown(jobId, job.fence, `inspection uncertain: ${String(error)}`)).receipt }
      }
      job = await this.store.acceptReceipt(receipt, job.fence, this.clock())
      if (!terminal(job.receipt.status) && job.deadlineAt !== null && this.clock() >= job.deadlineAt) {
        await this.store.requestCancel(jobId, job.fence, 'wall deadline exceeded')
        try { return (await this.store.acceptReceipt(await backend.cancel(jobId), job.fence, this.clock())).receipt }
        catch { return (await this.store.get(jobId)).receipt }
      }
      return job.receipt
    } finally { await this.store.release(jobId, job.fence).catch(() => {}) }
  }
  async cancel(jobId: string, reason = 'user cancellation'): Promise<JobReceipt> {
    const job = await this.store.claim(jobId, this.owner, this.clock())
    const backend = this.fencedBackend(job.fence)
    try {
      const pending = await this.store.requestCancel(jobId, job.fence, reason)
      if (terminal(pending.receipt.status)) return pending.receipt
      try { return (await this.store.acceptReceipt(await backend.cancel(jobId), job.fence, this.clock())).receipt }
      catch { return (await this.store.get(jobId)).receipt }
    } finally { await this.store.release(jobId, job.fence).catch(() => {}) }
  }
}
