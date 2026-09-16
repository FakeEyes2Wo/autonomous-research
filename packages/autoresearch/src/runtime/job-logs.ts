import { createHash, type Hash } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { LogRecord } from './contracts.js'

// Two fixed-size files per stream form a bounded rotation ring. Every segment
// keeps sequence/byte/hash metadata even after its file slot is overwritten.
export class JobLogs {
  private records: LogRecord[] = []
  private streams = new Map<string, { record: LogRecord; hash: Hash; fd: number | null }>()
  private segmentBytes = 65536
  private retainedPerSlot: number
  constructor(private directory: string, limit: number) { this.retainedPerSlot = Math.floor(limit / 4) }
  write(stream: string, data: Buffer): void {
    let offset = 0
    while (offset < data.length) {
      let current = this.streams.get(stream)
      if (!current || (this.segmentBytes > 0 && current.record.bytes === this.segmentBytes)) {
        if (current?.fd !== null && current?.fd !== undefined) closeSync(current.fd)
        const sequence = (current?.record.sequence ?? -1) + 1
        const record: LogRecord = { stream, sequence, bytes: 0, hash: '', retainedBytes: 0 }
        for (const previous of this.records) if (previous.stream === stream && previous.sequence % 2 === sequence % 2) previous.retainedBytes = 0
        current = { record, hash: createHash('sha256'), fd: this.retainedPerSlot ? openSync(join(this.directory, `${stream}.${sequence % 2}.log`), 'w') : null }
        this.records.push(record); this.streams.set(stream, current)
      }
      const part = data.subarray(offset, this.segmentBytes ? offset + Math.min(data.length - offset, this.segmentBytes - current.record.bytes) : data.length)
      current.hash.update(part); current.record.bytes += part.length; current.record.hash = current.hash.copy().digest('hex')
      if (current.fd !== null) {
        const retained = part.subarray(0, Math.max(0, this.retainedPerSlot - current.record.retainedBytes))
        writeSync(current.fd, retained); current.record.retainedBytes += retained.length
      }
      offset += part.length
    }
  }
  snapshot(): LogRecord[] { return this.records.map(record => ({ ...record })) }
  close(): void { for (const current of this.streams.values()) if (current.fd !== null) { closeSync(current.fd); current.fd = null } }
}
