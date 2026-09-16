import type { Work } from './contracts.js'

export interface IdentityInput { title: string; doi?: string; arxivId?: string; url?: string }
export interface IdentityResult { aliases: Work['aliases']; arxivVersion: number | null; titleKey: string }

function arxiv(value: string): { id: string; version: number | null } {
  const normalized = value.trim().replace(/^arxiv:\s*/i, '').replace(/\.pdf$/i, '')
  const match = /^(\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?\/\d{7})(?:v([1-9]\d*))?$/i.exec(normalized)
  if (!match) throw new Error('INVALID_IDENTITY: malformed arXiv identifier')
  return { id: match[1]!.toLowerCase(), version: match[2] ? Number(match[2]) : null }
}

export function normalizeIdentity(input: IdentityInput): IdentityResult {
  if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('INVALID_IDENTITY: title required')
  const aliases: Work['aliases'] = []
  let arxivVersion: number | null = null
  const add = (kind: Work['aliases'][number]['kind'], value: string) => {
    if (!aliases.some(a => a.kind === kind && a.value === value)) aliases.push({ kind, value })
  }
  const addArxiv = (value: string) => {
    const parsed = arxiv(value)
    const existing = aliases.find(a => a.kind === 'arxiv')
    if (existing && existing.value !== parsed.id) throw new Error('IDENTITY_CONFLICT: arXiv identifiers differ')
    if (arxivVersion !== null && parsed.version !== null && arxivVersion !== parsed.version) throw new Error('IDENTITY_CONFLICT: arXiv versions differ')
    add('arxiv', parsed.id)
    arxivVersion ??= parsed.version
  }
  const addDoi = (value: string) => {
    let doi = value.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
    try { doi = decodeURIComponent(doi) } catch { throw new Error('INVALID_IDENTITY: malformed DOI encoding') }
    if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new Error('INVALID_IDENTITY: malformed DOI')
    doi = doi.toLowerCase()
    const existing = aliases.find(a => a.kind === 'doi')
    if (existing && existing.value !== doi) throw new Error('IDENTITY_CONFLICT: DOI identifiers differ')
    add('doi', doi)
  }
  if (input.doi) addDoi(input.doi)
  if (input.arxivId) addArxiv(input.arxivId)
  if (input.url) {
    let url: URL
    try { url = new URL(input.url.trim()) } catch { throw new Error('INVALID_IDENTITY: malformed URL') }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('INVALID_IDENTITY: unsupported URL')
    url.hash = ''
    if (['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)) {
      const match = /^\/(?:abs|pdf|html)\/(.+)$/.exec(url.pathname)
      if (match) addArxiv(decodeURIComponent(match[1]!))
    }
    if (['doi.org', 'dx.doi.org'].includes(url.hostname)) addDoi(url.pathname.slice(1))
    add('url', url.href)
  }
  return { aliases, arxivVersion, titleKey: input.title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() }
}
