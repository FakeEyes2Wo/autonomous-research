import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { Catalog, SqlStatement } from './contracts.js'

interface ErrorPayload {
  name: string
  message: string
  code?: string
}

interface ResponseMessage {
  type: 'ready' | 'response'
  requestId?: number
  result?: Record<string, unknown>[][] | null
  error?: ErrorPayload
}

interface PendingRequest {
  resolve(value: Record<string, unknown>[][] | null): void
  reject(error: Error): void
}

function reviveError(payload: ErrorPayload): Error {
  const error = new Error(payload.message)
  error.name = payload.name
  if (payload.code !== undefined) Object.assign(error, { code: payload.code })
  return error
}

class WorkerCatalog implements Catalog {
  readonly worker: Worker
  readonly #pending = new Map<number, PendingRequest>()
  #nextRequestId = 1
  #closed = false
  #failure: Error | undefined
  readonly #ready: Promise<void>
  readonly #exited: Promise<number>

  constructor(root: string) {
    this.worker = new Worker(new URL('./catalog-worker.js', import.meta.url), {
      workerData: { root, databasePath: join(root, 'catalog.sqlite') },
    })
    let settleReady: ((error?: Error) => void) | undefined
    this.#ready = new Promise<void>((resolve, reject) => {
      settleReady = error => error === undefined ? resolve() : reject(error)
    })
    this.#exited = new Promise(resolve => {
      this.worker.once('exit', code => {
        resolve(code)
        if (!this.#closed) {
          const error = new Error(`catalog worker exited with code ${code}`)
          settleReady?.(error)
          settleReady = undefined
          this.#fail(error)
        }
      })
    })
    this.worker.on('message', (message: ResponseMessage) => {
      if (message.type === 'ready') {
        settleReady?.(message.error === undefined ? undefined : reviveError(message.error))
        settleReady = undefined
        return
      }
      if (message.requestId === undefined) return
      const pending = this.#pending.get(message.requestId)
      if (pending === undefined) return
      this.#pending.delete(message.requestId)
      if (message.error !== undefined) pending.reject(reviveError(message.error))
      else pending.resolve(message.result ?? [])
    })
    this.worker.once('error', error => {
      settleReady?.(error)
      settleReady = undefined
      this.#fail(error)
    })
  }

  async ready(): Promise<void> {
    return this.#ready
  }

  async transact(statements: SqlStatement[]): Promise<Record<string, unknown>[][]> {
    await this.#ready
    return await this.#request('transact', statements) as Record<string, unknown>[][]
  }

  async close(): Promise<void> {
    if (this.#closed) return
    if (this.#failure !== undefined) {
      this.#closed = true
      return
    }
    try {
      await this.#ready
      await this.#request('close')
      this.#closed = true
      await this.#exited
    } catch (error) {
      this.#closed = true
      if (this.#failure === undefined) throw error
    }
  }

  #request(type: 'transact' | 'close', statements?: SqlStatement[]): Promise<Record<string, unknown>[][] | null> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (this.#closed) return Promise.reject(new Error('catalog is closed'))
    const requestId = this.#nextRequestId++
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject })
      try {
        this.worker.postMessage({ requestId, type, ...(statements === undefined ? {} : { statements }) })
      } catch (error) {
        this.#pending.delete(requestId)
        reject(error)
      }
    })
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return
    this.#failure = error
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

export async function openCatalog(root: string): Promise<Catalog> {
  await mkdir(root, { recursive: true })
  const catalog = new WorkerCatalog(root)
  try {
    await catalog.ready()
    return catalog
  } catch (error) {
    await catalog.close().catch(() => undefined)
    throw error
  }
}
