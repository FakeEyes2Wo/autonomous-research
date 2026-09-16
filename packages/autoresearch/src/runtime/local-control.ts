import { createConnection } from 'node:net'
import type { JobRecord, JobReceipt } from './contracts.js'
export interface ControlReply { nonce: string; jobId: string; host: string; startupId: string; receipt: JobReceipt }
export async function sendControl(job: JobRecord, command: 'inspect' | 'cancel'): Promise<JobReceipt> {
  const identity = job.identity
  if (!identity) throw new Error('missing supervisor identity')
  return new Promise((resolve, reject) => {
    const socket = createConnection(identity.socket)
    let text = ''
    socket.setTimeout(1500, () => socket.destroy(new Error('supervisor control timed out')))
    socket.on('connect', () => socket.write(JSON.stringify({ command, jobId: job.spec.id, nonce: identity.nonce, host: identity.host, startupId: identity.startupId, fence: job.fence }) + '\n'))
    socket.on('error', reject)
    socket.on('end', () => { if (!text.includes('\n')) reject(new Error('supervisor reply incomplete')) })
    socket.on('data', data => {
      text += data.toString()
      if (text.length > 65536) { socket.destroy(new Error('supervisor reply too large')); return }
      if (!text.includes('\n')) return
      try {
        const reply = JSON.parse(text.split('\n')[0]!) as ControlReply
        if (reply.nonce !== identity.nonce || reply.jobId !== job.spec.id || reply.host !== identity.host || reply.startupId !== identity.startupId) throw new Error('supervisor identity mismatch')
        resolve(reply.receipt)
      } catch (error) { reject(error) }
      socket.destroy()
    })
  })
}
