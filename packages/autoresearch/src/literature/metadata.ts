import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { parse } from 'parse5'
import type { Work } from './contracts.js'
import { normalizeIdentity, type IdentityInput } from './identity.js'

interface XmlNode { nodeName: string; value?: string; childNodes?: XmlNode[] }
function descendants(node: XmlNode, name: string): XmlNode[] {
  return [...(node.nodeName === name ? [node] : []), ...(node.childNodes ?? []).flatMap(c => descendants(c, name))]
}
function text(node: XmlNode | undefined): string {
  if (!node) return ''
  return node.value ?? (node.childNodes ?? []).map(text).join('')
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const titleKey = (title: string) => normalizeIdentity({ title }).titleKey

async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1024 * 1024) throw new Error('METADATA_TOO_LARGE')
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function resolveMetadata(input: IdentityInput, options: { fetch: typeof fetch; signal: AbortSignal }): Promise<{
  work: Work; rawResponses: Uint8Array[]; conflicts: string[]
  receipts: { url: string; fetchedAt: string; status: number; rawHash: string }[]
}> {
  const identity = normalizeIdentity(input)
  const doi = identity.aliases.find(a => a.kind === 'doi')
  const arxiv = identity.aliases.find(a => a.kind === 'arxiv')
  const primary = doi ?? arxiv
  const work: Work = { id: `work_${hash(primary ? `${primary.kind}:${primary.value}` : JSON.stringify(identity)).slice(0, 24)}`,
    title: input.title.trim(), authors: null, aliases: identity.aliases, metadataSources: [], status: 'candidate' }
  const result = { work, rawResponses: [] as Uint8Array[], conflicts: [] as string[], receipts: [] as { url: string; fetchedAt: string; status: number; rawHash: string }[] }
  if (!primary) { result.conflicts.push('No authoritative DOI/arXiv resolver available for this candidate'); return result }
  const url = doi ? `https://api.crossref.org/works/${encodeURIComponent(doi.value)}`
    : `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxiv!.value + (identity.arxivVersion ? `v${identity.arxivVersion}` : ''))}`
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
  try {
    let response: Response | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      response = await options.fetch(url, { signal, headers: { Accept: doi ? 'application/json' : 'application/atom+xml' } })
      const bytes = await readBounded(response)
      result.rawResponses.push(bytes)
      result.receipts.push({ url, fetchedAt: new Date().toISOString(), status: response.status, rawHash: hash(bytes) })
      if (response.status === 429 && attempt < 2) {
        const retry = response.headers.get('retry-after')
        const seconds = retry === null ? 1 : Number(retry)
        const waitMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry!) - Date.now()
        if (!Number.isFinite(waitMs) || waitMs > 5000) throw new Error('METADATA_RATE_LIMITED')
        await delay(Math.max(0, waitMs), undefined, { signal })
        continue
      }
      if (!response.ok) throw new Error(`METADATA_HTTP_${response.status}`)
      let verifiedTitle: string
      let authors: string[]
      let verifiedAliases: Work['aliases']
      if (doi) {
        const message = (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { message?: Record<string, unknown> }).message
        if (!message || typeof message.DOI !== 'string' || !Array.isArray(message.title) || typeof message.title[0] !== 'string') throw new Error('METADATA_INVALID_RESPONSE')
        verifiedTitle = message.title[0]
        const responseIdentity = normalizeIdentity({ title: verifiedTitle, doi: message.DOI })
        if (responseIdentity.aliases[0]?.value !== doi.value) throw new Error('METADATA_IDENTIFIER_MISMATCH')
        authors = Array.isArray(message.author) ? message.author.flatMap((author: unknown) => {
          if (!author || typeof author !== 'object') return []
          const a = author as Record<string, unknown>
          const name = [a.given, a.family].filter(v => typeof v === 'string').join(' ').trim()
          return name ? [name] : typeof a.name === 'string' ? [a.name] : []
        }) : []
        verifiedAliases = [...responseIdentity.aliases, { kind: 'url', value: `https://doi.org/${doi.value}` }]
      } else {
        const doc = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown as XmlNode
        const entries = descendants(doc, 'entry')
        if (entries.length !== 1) throw new Error('METADATA_INVALID_RESPONSE')
        const entry = entries[0]!
        verifiedTitle = text(descendants(entry, 'title')[0]).trim()
        const responseId = text(descendants(entry, 'id')[0]).trim()
        const responseIdentity = normalizeIdentity({ title: verifiedTitle, url: responseId })
        if (responseIdentity.aliases.find(a => a.kind === 'arxiv')?.value !== arxiv!.value ||
          (identity.arxivVersion !== null && responseIdentity.arxivVersion !== identity.arxivVersion)) throw new Error('METADATA_IDENTIFIER_MISMATCH')
        authors = descendants(entry, 'author').map(a => text(descendants(a, 'name')[0]).trim()).filter(Boolean)
        verifiedAliases = responseIdentity.aliases
      }
      if (titleKey(verifiedTitle) !== identity.titleKey) throw new Error('METADATA_TITLE_MISMATCH')
      work.title = verifiedTitle.trim()
      work.authors = authors.length ? authors : null
      work.aliases = verifiedAliases
      work.metadataSources = [hash(bytes)]
      work.status = 'verified_metadata'
      for (const alias of identity.aliases) if (!verifiedAliases.some(a => a.kind === alias.kind && a.value === alias.value)) result.conflicts.push(`Unverified additional alias: ${alias.kind}:${alias.value}`)
      return result
    }
    throw new Error('METADATA_RATE_LIMITED')
  } catch (error) {
    if (options.signal.aborted) throw error
    result.conflicts.push(String(error))
    return result
  }
}
