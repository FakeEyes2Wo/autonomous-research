import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquire } from '../../dist/literature/acquisition.js'
import { readObject } from '../../dist/literature/objects.js'
import { downloadReferencePdfs } from '../../dist/paper/references.js'
import { withLibrary } from '../fixtures/literature.ts'
import { sourceBytes, sourceHash } from '../fixtures/literature/sources.ts'

function response(body: BodyInit | null, init: ResponseInit, url: string): Response {
  const result = new Response(body, init)
  Object.defineProperty(result, 'url', { value: url })
  return result
}

test('acquire streams accepted source bytes into immutable storage and records the final URL', async () => {
  await withLibrary(async (root) => {
    const bytes = sourceBytes('%PDF-1.7\nfixture')
    const finalUrl = 'https://cdn.example/paper.pdf'
    const fetchImpl: typeof fetch = async () => response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/pdf; charset=binary' },
    }, finalUrl)

    const receipt = await acquire(root, 'https://example.test/paper', {
      fetch: fetchImpl,
      signal: new AbortController().signal,
      maxBytes: 1024,
    })

    assert.equal(receipt.finalUrl, finalUrl)
    assert.equal(receipt.contentType, 'application/pdf')
    assert.equal(receipt.rawHash, sourceHash(bytes))
    assert.deepEqual(await readObject(root, receipt.rawHash!), bytes)
  })
})

test('acquire enforces maxBytes against streamed bytes without storing a truncated object', async () => {
  await withLibrary(async (root) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sourceBytes('1234'))
        controller.enqueue(sourceBytes('5678'))
        controller.close()
      },
    })
    const receipt = await acquire(root, 'https://example.test/large.txt', {
      fetch: async () => response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }, 'https://example.test/large.txt'),
      signal: new AbortController().signal,
      maxBytes: 6,
    })

    assert.equal(receipt.error, 'too_large')
    assert.equal(receipt.rawHash, null)
  })
})

test('acquire reports its own deadline as timeout', async () => {
  await withLibrary(async (root) => {
    const fetchImpl: typeof fetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })

    const receipt = await acquire(root, 'https://example.test/slow.pdf', {
      fetch: fetchImpl,
      signal: new AbortController().signal,
      maxBytes: 1024,
      timeoutMs: 10,
    })

    assert.equal(receipt.error, 'timeout')
    assert.equal(receipt.rawHash, null)
  })
})

test('acquire propagates caller cancellation promptly', async () => {
  await withLibrary(async (root) => {
    const controller = new AbortController()
    const fetchImpl: typeof fetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const pending = acquire(root, 'https://example.test/cancel.pdf', {
      fetch: fetchImpl,
      signal: controller.signal,
      maxBytes: 1024,
      timeoutMs: 10_000,
    })

    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
  })
})

test('acquire rejects unsupported content types after redirects', async () => {
  await withLibrary(async (root) => {
    const receipt = await acquire(root, 'https://example.test/paper', {
      fetch: async () => response('{}', { status: 200, headers: { 'content-type': 'application/json' } }, 'https://login.example.test/'),
      signal: new AbortController().signal,
      maxBytes: 1024,
    })

    assert.equal(receipt.finalUrl, 'https://login.example.test/')
    assert.equal(receipt.error, 'invalid_type')
    assert.equal(receipt.rawHash, null)
  })
})

test('acquire rejects redirects to non-HTTP sources before storing bytes', async () => {
  await withLibrary(async (root) => {
    const receipt = await acquire(root, 'https://example.test/paper', {
      fetch: async () => response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }, 'file:///private/paper.pdf'),
      signal: new AbortController().signal,
      maxBytes: 1024,
    })

    assert.equal(receipt.error, 'invalid_type')
    assert.equal(receipt.rawHash, null)
  })
})

test('acquire cancels a stalled response stream when its deadline expires', async () => {
  await withLibrary(async (root) => {
    let cancelled = false
    const stalled = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true
      },
    })
    const receipt = await acquire(root, 'https://example.test/stalled.pdf', {
      fetch: async () => response(stalled, { status: 200, headers: { 'content-type': 'application/pdf' } }, 'https://example.test/stalled.pdf'),
      signal: new AbortController().signal,
      maxBytes: 1024,
      timeoutMs: 10,
    })

    assert.equal(receipt.error, 'timeout')
    assert.equal(cancelled, true)
  })
})

test('acquire cancels non-success response bodies', async () => {
  await withLibrary(async (root) => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true
      },
    })

    const receipt = await acquire(root, 'https://example.test/missing.pdf', {
      fetch: async () => response(body, { status: 404, headers: { 'content-type': 'application/pdf' } }, 'https://example.test/missing.pdf'),
      signal: new AbortController().signal,
      maxBytes: 1024,
    })

    assert.equal(receipt.error, 'unavailable')
    assert.equal(cancelled, true)
  })
})

test('acquire cannot report success when caller cancellation happens during persistence', async () => {
  await withLibrary(async (root) => {
    const controller = new AbortController()
    const bytes = sourceBytes('%PDF-1.7\npersist')

    const pending = acquire(root, 'https://example.test/persist.pdf', {
      fetch: async () => response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }, 'https://example.test/persist.pdf'),
      signal: controller.signal,
      maxBytes: 1024,
      storeObject: async () => {
        controller.abort()
        return sourceHash(bytes)
      },
    })

    await assert.rejects(pending, { name: 'AbortError' })
  })
})

test('acquire reports timeout when its deadline expires during persistence', async () => {
  await withLibrary(async (root) => {
    const bytes = sourceBytes('%PDF-1.7\npersist-timeout')
    const receipt = await acquire(root, 'https://example.test/persist-timeout.pdf', {
      fetch: async () => response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }, 'https://example.test/persist-timeout.pdf'),
      signal: new AbortController().signal,
      maxBytes: 1024,
      timeoutMs: 10,
      storeObject: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return sourceHash(bytes)
      },
    })

    assert.equal(receipt.error, 'timeout')
    assert.equal(receipt.rawHash, null)
  })
})

test('reference downloads preserve the legacy PDF output and persist the same bytes immutably', async () => {
  await withLibrary(async (root) => {
    const bytes = sourceBytes('%PDF-1.7\nreference fixture')
    const fetchImpl: typeof fetch = async () => response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }, 'https://cdn.example.test/reference.pdf')
    const records = await downloadReferencePdfs(
      root,
      '@article{bounded, title={Bounded}, url={https://example.test/reference.pdf}}',
      { strict: true, fetch: fetchImpl, maxBytes: 1024 },
    )

    assert.equal(records[0]?.status, 'downloaded')
    assert.equal(records[0]?.sourceUrl, 'https://example.test/reference.pdf')
    assert.deepEqual(new Uint8Array(await readFile(join(root, 'evidence', 'bounded.pdf'))), bytes)
    assert.deepEqual(await readObject(root, records[0]!.sha256!), bytes)
  })
})

test('reference downloads enforce the acquisition byte limit', async () => {
  await withLibrary(async (root) => {
    const bytes = sourceBytes(`%PDF-1.7\n${'x'.repeat(64)}`)
    const fetchImpl: typeof fetch = async () => response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }, 'https://example.test/large.pdf')
    const records = await downloadReferencePdfs(
      root,
      '@article{large, url={https://example.test/large.pdf}}',
      { strict: false, fetch: fetchImpl, maxBytes: 16 },
    )

    assert.equal(records[0]?.status, 'failed')
    assert.match(records[0]?.error ?? '', /too_large/)
  })
})
