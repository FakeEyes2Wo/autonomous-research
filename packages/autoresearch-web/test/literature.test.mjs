import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { createLiterature } from '../src/literature.js'
import { apply } from '../src/index.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLiteratureService } from '../src/core-bridge.js'

test('installed core bridge imports, indexes and reads authorized immutable evidence through HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'literature-core-web-'))
  const core = await resolveLiteratureService({})
  assert.ok(core, 'built core ./literature export is available')
  const handler = createLiterature({ ...core, getProject: async id => id === 'registered' ? { id, root } : null })
  const call = async (path, body) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    Object.assign(req, { url: '/api/autoresearch/literature' + path, method: body ? 'POST' : 'GET', headers: { host: 'localhost', 'content-type': 'application/json' } })
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(body) { this.body = body } }
    await handler.handle(req, res)
    assert.ok(res.statusCode < 300, `${res.statusCode}: ${res.body}`)
    return res.headers['content-type'].startsWith('application/json') ? JSON.parse(res.body) : String(res.body)
  }
  const settle = async operation => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const result = await call(`/operations?projectId=registered&operationId=${operation.operationId}`)
      if (!['queued', 'running'].includes(result.status)) { assert.equal(result.status, 'completed', JSON.stringify(result)); return result }
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.fail('core operation timed out')
  }
  assert.deepEqual(await call('/papers?projectId=registered'), { rows: [], generationId: null, nextId: null })
  await settle(await call('/import', { projectId: 'registered', manifest: {
    works: [{ id: 'web-paper', title: 'HTTP evidence', authors: null, aliases: [], metadataSources: [], status: 'candidate' }],
    documents: [{ workId: 'web-paper', source: { kind: 'text', text: '<h1>结果</h1><p>反证 alpha effect</p><script>unsafe()</script>', mediaType: 'text/html' }, sourceKind: 'full_text' }],
  } }))
  await settle(await call('/index', { projectId: 'registered' }))
  const listing = await call('/papers?projectId=registered')
  assert.equal(listing.rows[0].header.readingCoverage.status, 'unread')
  const result = await call(`/search?projectId=registered&q=alpha&generationId=${listing.generationId}`)
  assert.equal(result.hits.length, 1)
  const span = await call(`/span?projectId=registered&spanId=${result.hits[0].span.id}&generationId=${listing.generationId}`)
  assert.match(span.evidenceText, /反证/)
  const source = await call(`/source?projectId=registered&documentId=${span.documentId}`)
  assert.match(source, /alpha/)
  assert.doesNotMatch(source, /unsafe|<script>/)
})

test('host wires registered literature behind same-origin and CSRF protections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'literature-host-'))
  const routes = [], scopes = []
  const { hooks } = fixture()
  hooks.listPapers = async request => { scopes.push(request); return { rows: [], generationId: 'g1', nextId: null } }
  const dispose = await apply({ webServer: { register: route => { routes.push(route); return () => {} } }, autoresearchLiterature: hooks },
    { standaloneProjects: true, projects: [{ id: 'p1', root }] })
  const call = async (method, path, body, headers = {}) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    Object.assign(req, { method, url: '/api/autoresearch' + path, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } })
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(body) { this.body = body } }
    await routes[0].handler(req, res)
    return { status: res.statusCode, data: JSON.parse(res.body) }
  }
  try {
    const listing = await call('GET', '/literature/papers?projectId=p1&root=ignored')
    assert.equal(listing.status, 200)
    assert.equal(listing.data.generationId, 'g1')
    assert.deepEqual(scopes, [{ projectId: 'p1', root, limit: 25 }])
    assert.equal((await call('GET', '/literature/papers?projectId=p1', null, { origin: 'http://evil.test' })).status, 403)
    assert.equal((await call('POST', '/literature/index', { projectId: 'p1' })).status, 403)
    const token = (await call('GET', '/projects')).data.csrfToken
    assert.equal((await call('POST', '/literature/index', { projectId: 'p1' }, { origin: 'http://localhost', 'content-type': 'application/json', 'x-autoresearch-csrf': token })).status, 202)
  } finally { dispose() }
})

function fixture() {
  const calls = { acquire: 0, index: 0, source: 0 }
  const hooks = {
    getProject: async id => id === 'p1' ? { id, root: '/registered-project' } : null,
    listPapers: async () => ({ rows: [], nextId: null }),
    search: async () => ({ hits: [], generationId: 'g1' }),
    getSource: async ({ documentId }) => { calls.source++; return documentId === 'd1' ? { mediaType: 'application/pdf', bytes: Buffer.from('0123456789') } : null },
    getSpan: async () => ({ id: 's1', evidenceText: '反证' }),
    importSources: async () => { calls.acquire++; return { operationId: 'o1', status: 'queued' } },
    buildIndex: async () => { calls.index++; return { operationId: 'o2', status: 'queued' } },
    getOperation: async () => ({ operationId: 'o1', status: 'completed' }),
  }
  const reader = createLiterature(hooks)
  const request = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { url: '/api/autoresearch/literature' + url, method, headers: { host: 'localhost', ...headers } })
    const res = { statusCode: 200, headers: {}, body: null, setHeader(name, value) { this.headers[name] = value }, end(value) { this.body = value } }
    assert.equal(await reader.handle(req, res), true)
    return res
  }
  return { calls, hooks, request }
}

test('registered PDF reads support ranges without acquiring or indexing', async () => {
  const { request, calls } = fixture()
  const response = await request('/source?projectId=p1&documentId=d1', { headers: { range: 'bytes=2-5' } })
  assert.equal(response.statusCode, 206)
  assert.equal(response.headers['content-type'], 'application/pdf')
  assert.equal(response.headers['content-range'], 'bytes 2-5/10')
  assert.equal(String(response.body), '2345')
  assert.deepEqual(calls, { acquire: 0, index: 0, source: 1 })
  assert.equal((await request('/source?projectId=p2&documentId=d1')).statusCode, 404)
  assert.equal(calls.source, 1)
})

test('PDF suffix/open ranges work; unsatisfiable or multiple ranges return 416', async () => {
  const { request } = fixture()
  const url = '/source?projectId=p1&documentId=d1'
  assert.equal(String((await request(url, { headers: { range: 'bytes=-3' } })).body), '789')
  assert.equal(String((await request(url, { headers: { range: 'bytes=8-' } })).body), '89')
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=0-1,3-4', 'bytes=-0']) {
    const response = await request(url, { headers: { range } })
    assert.equal(response.statusCode, 416)
    assert.equal(response.headers['content-range'], 'bytes */10')
  }
})

test('GET routes validate bounded queries and never initiate work', async () => {
  const { request, calls } = fixture()
  assert.equal((await request('/papers?projectId=p1&limit=101')).statusCode, 400)
  assert.equal((await request('/search?projectId=p1&q=' + 'a'.repeat(2001))).statusCode, 400)
  const noIndex = await request('/search?projectId=p1&q=反证')
  assert.equal(JSON.parse(noIndex.body).status, 'not_indexed')
  assert.equal((await request('/index?projectId=p1')).statusCode, 405)
  assert.deepEqual(calls, { acquire: 0, index: 0, source: 0 })
})

test('only explicit JSON POST can acquire/index and browser cannot provide local paths', async () => {
  const { request, calls } = fixture()
  const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body })
  assert.equal((await request('/import', post({ projectId: 'p1', manifest: { entries: [{ path: 'C:/private' }] } }))).statusCode, 400)
  assert.equal((await request('/import', { method: 'POST', body: { projectId: 'p1' } })).statusCode, 415)
  const response = await request('/index', post({ projectId: 'p1' }))
  assert.equal(response.statusCode, 202)
  assert.deepEqual(JSON.parse(response.body), { operationId: 'o2', status: 'queued' })
  assert.equal(calls.index, 1)
  assert.equal(calls.acquire, 0)
})

test('source HTML is never served as active content and internal errors do not leak paths', async () => {
  const f = fixture()
  f.hooks.getSource = async () => ({ mediaType: 'text/html', bytes: Buffer.from('<script>danger()</script>') })
  const response = await f.request('/source?projectId=p1&documentId=d1')
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
  f.hooks.getSource = async () => { throw new Error('C:/private/secret') }
  const failure = await f.request('/source?projectId=p1&documentId=d1')
  assert.equal(failure.statusCode, 500)
  assert.doesNotMatch(String(failure.body), /private|secret/)
})
