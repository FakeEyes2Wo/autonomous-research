import test from 'node:test'
import assert from 'node:assert/strict'
import { memorySources, providerFixture } from './discovery-test-utils.ts'
const api = await import('../../dist/literature/discovery/index.js').catch(() => ({})) as any
test('Crossref uses bibliographic relevance, captures raw and decoded observation separately', async () => {
  assert.equal(typeof api.createDiscoveryProviders, 'function')
  const urls: string[] = []; const sourceStore = memorySources()
  const providers = api.createDiscoveryProviders({ sourceStore, fetch: async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ message: { 'total-results': 3, items: [{ DOI: '10.14722/ndss.2014.23212', title: ['Macaroons'], author: [{ given: 'A', family: 'Researcher' }], abstract: '<jats:p>Delegated &amp; attenuated authority.</jats:p>', published: { 'date-parts': [[2014]] } }] } }), { status: 200 }) } })
  const result = await providers.find((p: any) => p.name === 'crossref').search({ query: { id: 'q', text: 'capability security', dimensions: ['mechanism'], round: 1, origin: 'model' }, page: 1, pageSize: 1, signal: new AbortController().signal, now: () => 0 })
  assert.match(urls[0]!, /query.bibliographic=capability/); assert.match(urls[0]!, /offset=1/)
  assert.equal(result.candidates[0].abstract, 'Delegated & attenuated authority.')
  assert.equal(result.receipt.outcome, 'ok'); assert.ok(result.receipt.responseSource.hash)
  assert.notEqual(result.candidates[0].observations[0].sourceRef.hash, result.receipt.responseSource.hash)
})
test('all three real adapters decode provider fixtures and keep missing metadata explicit', async () => {
  const providers = api.createDiscoveryProviders({ sourceStore: memorySources(), fetch: providerFixture })
  const results = await Promise.all(providers.map((p: any) => p.search({ query: { id: 'q', text: 'delegation', dimensions: ['mechanism'], round: 1, origin: 'model' }, page: 0, pageSize: 20, signal: new AbortController().signal, now: () => 0 })))
  assert.deepEqual(results.map((r: any) => r.receipt.outcome), ['ok', 'ok', 'ok'])
  assert.equal(results[0].candidates[0].aliases.find((a: any) => a.kind === 'arxiv').value, '2503.18813')
  assert.equal(results[1].candidates[0].authors, null)
  assert.equal(results[2].candidates[0].aliases.find((a: any) => a.kind === 'arxiv').value, '2311.08252')
})
test('oversized and malformed HTTP bodies are captured but never admitted as candidate observations', async () => {
  for (const [body, limit, outcome] of [['abcdef', 3, 'too_large'], ['<not-a-feed/>', 100, 'invalid_response']] as const) {
    const store = memorySources(); const p = api.createDiscoveryProviders({ sourceStore: store, fetch: async () => new Response(body) })[0]
    const r = await p.search({ query: { id: 'q', text: 'test', dimensions: ['problem'], round: 1, origin: 'model' }, page: 0, pageSize: 2, maxResponseBytes: limit, signal: new AbortController().signal, now: () => 0 })
    assert.equal(r.receipt.outcome, outcome); assert.deepEqual(r.candidates, []); assert.ok(r.receipt.responseBytes <= limit); assert.ok(r.receipt.responseSource.hash)
  }
})
test('rate-limit receipt preserves actual response and Retry-After', async () => {
  assert.equal(typeof api.createDiscoveryProviders, 'function')
  const providers = api.createDiscoveryProviders({ sourceStore: memorySources(), fetch: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '4' } }) })
  const result = await providers[0].search({ query: { id: 'q', text: 'retrieval', dimensions: ['problem'], round: 1, origin: 'model' }, page: 0, pageSize: 2, signal: new AbortController().signal, now: () => 0 })
  assert.equal(result.receipt.outcome, 'rate_limited'); assert.equal(result.receipt.retryAfterMs, 4000); assert.ok(result.receipt.responseSource.hash)
})
test('HTTP deadline also bounds a stalled response body and records timeout', async () => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const providers = api.createDiscoveryProviders({ sourceStore: memorySources(), fetch: async () => new Response(body) })
  const result = await Promise.race([providers[0].search({ query: { id: 'q', text: 'retrieval', dimensions: ['problem'], round: 1, origin: 'model' }, page: 0, pageSize: 2, timeoutMs: 10, signal: new AbortController().signal, now: Date.now }), new Promise(resolve => setTimeout(() => resolve({ receipt: { outcome: 'unbounded' } }), 150))]) as any
  assert.equal(result.receipt.outcome, 'timeout'); assert.equal(cancelled, true)
})
test('provider identifiers normalize DOI/arXiv prefixes, URL fragments and version case; malformed optional metadata stays null', async () => {
  const providers = api.createDiscoveryProviders({ sourceStore: memorySources(), fetch: async () => new Response(JSON.stringify({ data: [
    { paperId: 'one', title: 'One', authors: [null, {}, { name: 12 }], year: '2020', externalIds: { DOI: 'DOI:10.14722/NDSS.2014.23212', ArXiv: 'arXiv:2503.18813V2' } },
    { paperId: 'two', title: 'Two', authors: 'invalid', year: 0, externalIds: { ArXiv: 'https://arxiv.org/abs/2311.08252V3?context=cs#paper' } }
  ] })) })
  const result = await providers[2].search({ query: { id: 'q', text: 'test', dimensions: ['problem'], round: 1, origin: 'model' }, page: 0, pageSize: 20, signal: new AbortController().signal, now: () => 0 })
  assert.equal(result.receipt.outcome, 'ok')
  assert.equal(result.candidates[0].aliases.find((a: any) => a.kind === 'doi')?.value, '10.14722/ndss.2014.23212')
  assert.equal(result.candidates[0].aliases.find((a: any) => a.kind === 'arxiv')?.value, '2503.18813')
  assert.equal(result.candidates[1].aliases.find((a: any) => a.kind === 'arxiv')?.value, '2311.08252')
  assert.ok(result.candidates.every((c: any) => c.authors === null && c.year === null))
})
