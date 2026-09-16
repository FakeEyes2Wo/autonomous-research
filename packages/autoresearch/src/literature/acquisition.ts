import type { Hash } from './contracts.js'
import { putObject } from './objects.js'

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const ACCEPTED_TYPES = new Set(['application/pdf', 'application/xhtml+xml', 'text/html', 'text/plain'])

export interface FetchReceipt {
  requestedUrl: string
  finalUrl: string
  fetchedAt: string
  status: number
  contentType: string
  rawHash: Hash | null
  error: 'timeout' | 'unavailable' | 'too_large' | 'invalid_type' | null
}

export interface AcquireOptions {
  fetch: typeof fetch
  signal: AbortSignal
  maxBytes?: number
  timeoutMs?: number
  storeObject?: (root: string, bytes: Uint8Array) => Promise<Hash>
}

export async function acquire(root: string, url: string, options: AcquireOptions): Promise<FetchReceipt> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be positive')
  if (options.signal.aborted) throw abortError()

  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort(options.signal.reason)
  options.signal.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Source acquisition timed out', 'TimeoutError'))
  }, timeoutMs)

  const receipt: FetchReceipt = {
    requestedUrl: url,
    finalUrl: url,
    fetchedAt: new Date().toISOString(),
    status: 0,
    contentType: '',
    rawHash: null,
    error: null,
  }

  try {
    if (!isHttpUrl(url)) return { ...receipt, error: 'invalid_type' }
    const response = await options.fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'application/pdf, text/html, application/xhtml+xml, text/plain' },
    })
    receipt.finalUrl = response.url || url
    receipt.status = response.status
    receipt.contentType = normalizeContentType(response.headers.get('content-type'))
    if (!response.ok) {
      await response.body?.cancel()
      return { ...receipt, error: 'unavailable' }
    }
    if (!isHttpUrl(receipt.finalUrl) || !ACCEPTED_TYPES.has(receipt.contentType)) {
      await response.body?.cancel()
      return { ...receipt, error: 'invalid_type' }
    }

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel()
      return { ...receipt, error: 'too_large' }
    }
    if (!response.body) return { ...receipt, error: 'unavailable' }

    const bytes = await readBounded(response.body, maxBytes, controller.signal)
    if (bytes === null) return { ...receipt, error: 'too_large' }
    checkOperationSignal(options.signal, controller.signal)
    const rawHash = await (options.storeObject ?? putObject)(root, bytes)
    checkOperationSignal(options.signal, controller.signal)
    return { ...receipt, rawHash }
  } catch (error) {
    if (options.signal.aborted) throw abortError()
    if (timedOut || isAbortError(error)) return { ...receipt, error: 'timeout' }
    return { ...receipt, error: 'unavailable' }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onCallerAbort)
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal)
      if (done) break
      if (!value) continue
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel('source exceeds maxBytes')
        return null
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel(signal.reason ?? error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function normalizeContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function checkOperationSignal(callerSignal: AbortSignal, operationSignal: AbortSignal): void {
  if (callerSignal.aborted) throw abortError()
  if (operationSignal.aborted) throw operationSignal.reason ?? abortError()
}

function abortError(): DOMException {
  return new DOMException('Source acquisition was aborted', 'AbortError')
}
