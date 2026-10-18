import { randomUUID } from 'node:crypto'
import { parseFragment } from 'parse5'
import { hashBytes, hashContent } from '../../research/records.js'
import type { DiscoveryCandidate, DiscoveryProvider, DiscoveryProviderName, DiscoverySourceStore, HttpReceipt } from './contracts.js'

export const DISCOVERY_PARSER_VERSION = 'provider-metadata/v1'
type Node = { nodeName?: string; value?: string; childNodes?: Node[] }
function nodes(root: Node, name: string): Node[] { return (root.childNodes ?? []).flatMap(n => n.nodeName === name ? [n] : nodes(n, name)) }
function content(root: Node): string { return root.value ?? (root.childNodes ?? []).map(content).join(' ') }
function plain(value: unknown): string { return typeof value === 'string' ? content(parseFragment(value) as Node).replace(/\s+/g, ' ').trim() : '' }
function field(root: Node, name: string): string { return content(nodes(root, name)[0] ?? {}).replace(/\s+/g, ' ').trim() }
function doi(value: unknown): string | undefined { if (typeof value !== 'string') return; const normalized = value.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase(); return /^10\.\d{4,9}\/\S+$/.test(normalized) ? normalized : undefined }
function arxiv(value: unknown): string | undefined { if (typeof value !== 'string') return; const normalized = value.trim().replace(/^arxiv:\s*/i, '').replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/[?#].*$/, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase(); return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})$/i.test(normalized) ? normalized : undefined }
type Parsed = { key: string; title: string; authors: string[] | null; year: number | null; abstract: string | null; aliases: DiscoveryCandidate['aliases'] }
const year = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 3000 ? value : null
function authorNames(values: unknown, parse: (item: any) => string): string[] | null { if (!Array.isArray(values)) return null; const authors = values.map(parse).map(plain).filter(Boolean); return authors.length ? authors : null }
function aliases(provider: DiscoveryProviderName, key: string, doiValue?: unknown, arxivValue?: unknown, urlValue?: unknown): DiscoveryCandidate['aliases'] {
  const result: DiscoveryCandidate['aliases'] = [{ kind: 'provider', value: `${provider}:${key}` }]
  const d = doi(doiValue), a = arxiv(arxivValue)
  if (d) result.push({ kind: 'doi', value: d }); if (a) result.push({ kind: 'arxiv', value: a })
  if (typeof urlValue === 'string') { try { const url = new URL(urlValue); if (url.protocol === 'https:' || url.protocol === 'http:') result.push({ kind: 'url', value: url.href }) } catch {} }
  return result
}
function parseResponse(provider: DiscoveryProviderName, text: string, page: number, size: number): { rows: Parsed[]; hasMore: boolean } {
  if (provider === 'arxiv') {
    if (!/<(?:\w+:)?feed[\s>]/i.test(text) || !/<\/(?:\w+:)?feed\s*>/i.test(text)) throw new Error('Invalid Atom feed')
    const root = parseFragment(text) as Node
    const rows = nodes(root, 'entry').map(entry => {
      const id = field(entry, 'id'); const key = arxiv(id)
      if (!key || !field(entry, 'title')) throw new Error('Invalid arXiv entry')
      return { key, title: field(entry, 'title'), authors: authorNames(nodes(entry, 'author'), n => field(n, 'name')), year: year(Number(field(entry, 'published').slice(0, 4))), abstract: field(entry, 'summary') || null, aliases: aliases(provider, key, field(entry, 'arxiv:doi'), key, id) }
    })
    const total = Number(field(root, 'opensearch:totalresults'))
    return { rows, hasMore: rows.length === size && (!Number.isFinite(total) || total > (page + 1) * size) }
  }
  const data = JSON.parse(text)
  if (provider === 'crossref') {
    if (!Array.isArray(data?.message?.items)) throw new Error('Invalid Crossref response')
    const rows = data.message.items.map((item: any): Parsed => {
      const key = doi(item.DOI)
      if (!key || !Array.isArray(item.title) || !plain(item.title[0])) throw new Error('Invalid Crossref item')
      return { key, title: plain(item.title[0]), authors: authorNames(item.author, a => [a?.given, a?.family].filter(v => typeof v === 'string').join(' ')), year: year((item.published ?? item.issued)?.['date-parts']?.[0]?.[0]), abstract: plain(item.abstract) || null, aliases: aliases(provider, key, key, undefined, item.URL) }
    })
    return { rows, hasMore: rows.length === size && Number(data.message['total-results']) > (page + 1) * size }
  }
  if (!Array.isArray(data?.data)) throw new Error('Invalid Semantic Scholar response')
  const rows = data.data.map((item: any): Parsed => {
    if (typeof item.paperId !== 'string' || !plain(item.title)) throw new Error('Invalid Semantic Scholar item')
    return { key: item.paperId, title: plain(item.title), authors: authorNames(item.authors, a => typeof a?.name === 'string' ? a.name : ''), year: year(item.year), abstract: plain(item.abstract) || null, aliases: aliases(provider, item.paperId, item.externalIds?.DOI, item.externalIds?.ArXiv, item.url) }
  })
  return { rows, hasMore: typeof data.next === 'number' && data.next > page * size }
}
export function discoveryRequestUrl(provider: DiscoveryProviderName, query: string, page: number, pageSize: number): string {
  const url = new URL(provider === 'arxiv' ? 'https://export.arxiv.org/api/query' : provider === 'crossref' ? 'https://api.crossref.org/works' : 'https://api.semanticscholar.org/graph/v1/paper/search')
  const values = provider === 'arxiv' ? { search_query: query, start: String(page * pageSize), max_results: String(pageSize), sortBy: 'relevance', sortOrder: 'descending' } : provider === 'crossref' ? { 'query.bibliographic': query, rows: String(pageSize), offset: String(page * pageSize) } : { query, limit: String(pageSize), offset: String(page * pageSize), fields: 'paperId,title,authors,year,abstract,externalIds,url' }
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  return url.href
}
export async function verifyDiscoverySource(store: Pick<DiscoverySourceStore, 'readSource'>, ref: import('../../research/contracts.js').SourceRef): Promise<Uint8Array> {
  if (!ref.id || !ref.hash || !ref.path) throw new Error('Discovery source must have actual captured id, path and hash')
  const bytes = await store.readSource(ref)
  if (!(bytes instanceof Uint8Array) || hashBytes(bytes) !== ref.hash) throw new Error('Discovery source bytes do not match captured hash')
  return bytes
}
async function capture(store: DiscoverySourceStore, bytes: Uint8Array | string, id: string) {
  const ref = await store.captureBytes(bytes, id)
  const stored = await verifyDiscoverySource(store, ref)
  if (hashBytes(typeof bytes === 'string' ? Buffer.from(bytes) : bytes) !== hashBytes(stored)) throw new Error('Source store captured different bytes')
  return ref
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw signal.reason }
  let listener: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true }) })
  try { return await Promise.race([promise, interrupted]) } finally { signal.removeEventListener('abort', listener) }
}
export function createDiscoveryProviders(options: { sourceStore: DiscoverySourceStore; fetch?: typeof globalThis.fetch; semanticScholarApiKey?: string; userAgent?: string }): DiscoveryProvider[] {
  const fetcher = options.fetch ?? globalThis.fetch
  return (['arxiv', 'crossref', 'semantic-scholar'] as const).map(name => ({ name, async search(input) {
    const { query, page, pageSize, now } = input
    const id = input.attemptId ?? `http-${randomUUID()}`
    const requestUrl = discoveryRequestUrl(name, query.text, page, pageSize)
    const started = now(); const receipt: HttpReceipt = { id, provider: name, requestUrl, queryId: query.id, page, startedAt: new Date(started).toISOString(), finishedAt: new Date(started).toISOString(), status: null, responseSource: null, responseBytes: 0, retryAfterMs: null, parserVersion: DISCOVERY_PARSER_VERSION, outcome: 'unavailable' }
    const abort = new AbortController(); let timedOut = false
    const onAbort = () => abort.abort(input.signal.reason)
    if (input.signal.aborted) onAbort(); else input.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; abort.abort(new Error('Discovery HTTP timeout')) }, input.timeoutMs ?? 20_000)
    const chunks: Uint8Array[] = []; let tooLarge = false
    const limit = input.maxResponseBytes ?? 2_000_000
    try {
      const headers: Record<string, string> = { 'User-Agent': options.userAgent ?? 'Autoresearch-IdeaDiscovery/1.0', Accept: name === 'arxiv' ? 'application/atom+xml' : 'application/json' }
      if (name === 'semantic-scholar' && options.semanticScholarApiKey) headers['x-api-key'] = options.semanticScholarApiKey
      if (abort.signal.aborted) throw abort.signal.reason
      const response = await abortable(fetcher(requestUrl, { headers, signal: abort.signal, redirect: 'error' }), abort.signal)
      receipt.status = response.status
      const retry = response.headers.get('retry-after')
      if (retry) receipt.retryAfterMs = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now()) || null
      const reader = response.body?.getReader()
      if (reader) {
        try { while (true) { const part = await abortable(reader.read(), abort.signal); if (part.done) break; const remaining = limit - receipt.responseBytes; const bytes = part.value.subarray(0, remaining); chunks.push(bytes); receipt.responseBytes += bytes.length; if (part.value.length > remaining) { tooLarge = true; void reader.cancel().catch(() => {}); break } } } finally { if (abort.signal.aborted) void reader.cancel().catch(() => {}); reader.releaseLock() }
      }
      const bytes = Buffer.concat(chunks)
      receipt.responseSource = await capture(options.sourceStore, bytes, `${id}:raw-http`)
      if (tooLarge) receipt.outcome = 'too_large'
      else if (response.status === 429) receipt.outcome = 'rate_limited'
      else if (!response.ok) receipt.outcome = 'http_error'
      else {
        const parsed = parseResponse(name, bytes.toString('utf8'), page, pageSize)
        if (parsed.rows.length > pageSize) throw new Error('Provider exceeded requested page size')
        const candidates: DiscoveryCandidate[] = []
        for (const [offset, row] of parsed.rows.entries()) {
          const observationBytes = JSON.stringify({ parserVersion: DISCOVERY_PARSER_VERSION, provider: name, resultKey: row.key, rawSource: receipt.responseSource, title: row.title, authors: row.authors, year: row.year, abstract: row.abstract })
          const sourceRef = await capture(options.sourceStore, observationBytes, `${id}:parsed:${offset}`)
          const anchor = row.aliases.find(a => a.kind === 'doi') ?? row.aliases.find(a => a.kind === 'arxiv') ?? row.aliases[0]!
          candidates.push({ id: `paper-${hashContent(anchor).slice(0, 24)}`, title: row.title, authors: row.authors, year: row.year, abstract: row.abstract, aliases: row.aliases, providerHits: [{ provider: name, receiptId: id, resultKey: row.key, queryId: query.id, rank: page * pageSize + offset + 1, dimensions: query.dimensions }], observations: [{ receiptId: id, title: row.title, authors: row.authors, year: row.year, abstract: row.abstract, sourceRef, parserVersion: DISCOVERY_PARSER_VERSION, resultKey: row.key, rawSource: receipt.responseSource }], conflicts: [] })
        }
        receipt.outcome = 'ok'; receipt.finishedAt = new Date(now()).toISOString()
        return { receipt, candidates, hasMore: parsed.hasMore }
      }
    } catch (error) {
      receipt.outcome = timedOut ? 'timeout' : input.signal.aborted ? 'aborted' : receipt.status !== null ? 'invalid_response' : 'unavailable'
      receipt.note = error instanceof Error ? error.message.slice(0, 300) : 'HTTP attempt failed'
      if (!receipt.responseSource && chunks.length) receipt.responseSource = await capture(options.sourceStore, Buffer.concat(chunks), `${id}:partial-http`)
    } finally { clearTimeout(timer); input.signal.removeEventListener('abort', onAbort) }
    receipt.finishedAt = new Date(now()).toISOString()
    return { receipt, candidates: [], hasMore: false }
  } }))
}
