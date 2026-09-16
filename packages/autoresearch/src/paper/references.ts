import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AutoResearchError, atomicWriteJson, nowIso } from '../core/utils.js'
import { acquire } from '../literature/acquisition.js'
import { putObject, readObject } from '../literature/objects.js'

export interface BibEntry {
  key: string
  type: string
  fields: Record<string, string>
  raw: string
}

export interface CitationPdfRecord {
  key: string
  title?: string
  year?: string
  sourceUrl?: string
  localFile: string
  status: 'downloaded' | 'skipped' | 'failed'
  bytes?: number
  sha256?: string
  error?: string
}

export interface DownloadReferencePdfsOptions {
  force?: boolean
  timeoutMs?: number
  strict?: boolean
  maxBytes?: number
  signal?: AbortSignal
  fetch?: typeof fetch
}

export function parseBibEntries(bib: string): BibEntry[] {
  const entries: BibEntry[] = []
  const startRe = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g
  let match: RegExpExecArray | null
  while ((match = startRe.exec(bib)) !== null) {
    const key = match[2]?.trim()
    if (!key) continue
    const bodyStart = match.index + match[0].length
    const end = findEntryEnd(bib, bodyStart)
    const raw = bib.slice(match.index, end)
    entries.push({
      key,
      type: match[1]?.toLowerCase() ?? '',
      fields: parseBibFields(raw),
      raw,
    })
  }
  return entries
}

export function resolvePdfCandidates(entry: BibEntry): string[] {
  const f = entry.fields
  const candidates: string[] = []
  const push = (url: string | undefined) => {
    if (url) candidates.push(url)
  }

  const doi = cleanField(f.doi)
  if (doi) {
    const normalizedDoi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    push(`https://doi.org/${encodeURIComponent(normalizedDoi).replace(/%2F/gi, '/')}`)
  }

  const eprint = cleanField(f.eprint)
  if (eprint) {
    const id = eprint.replace(/^arXiv:/i, '').trim()
    push(`https://arxiv.org/pdf/${id}`)
  }

  const url = cleanField(f.url) || cleanField(f.howpublished) || cleanField(f.note)
  if (url) {
    if (/arxiv\.org\/(abs|pdf)\//i.test(url)) {
      push(url.replace(/arxiv\.org\/(abs|pdf)\//i, 'arxiv.org/pdf/'))
    } else {
      push(url)
    }
  }

  return [...new Set(candidates)]
}

export async function downloadReferencePdfs(
  runDir: string,
  bibText: string,
  options: DownloadReferencePdfsOptions = {},
): Promise<CitationPdfRecord[]> {
  const { force = false, timeoutMs = 30000, strict = true, maxBytes } = options
  const signal = options.signal ?? new AbortController().signal
  const fetchImpl = options.fetch ?? globalThis.fetch
  const entries = parseBibEntries(bibText)
  const evidenceDir = join(runDir, 'evidence')
  await mkdir(evidenceDir, { recursive: true })

  const records: CitationPdfRecord[] = []
  for (const entry of entries) {
    const localFile = join(evidenceDir, `${safeFileName(entry.key)}.pdf`)
    let existing: Buffer | null = null
    try {
      existing = await readFile(localFile)
    } catch {
      existing = null
    }
    if (!force && existing && isPdfBuffer(existing)) {
      const rawHash = await putObject(runDir, existing)
      records.push({
        key: entry.key,
        title: cleanField(entry.fields.title),
        year: cleanField(entry.fields.year),
        localFile,
        status: 'skipped',
        bytes: existing.length,
        sha256: rawHash,
      })
      continue
    }

    const candidates = resolvePdfCandidates(entry)
    let downloaded = false
    let lastError = ''
    for (const url of candidates) {
      try {
        const receipt = await acquire(runDir, url, { fetch: fetchImpl, signal, maxBytes, timeoutMs })
        if (receipt.error || !receipt.rawHash) {
          throw new Error(`source acquisition failed: ${receipt.error ?? 'missing object hash'}`)
        }
        if (receipt.contentType !== 'application/pdf') {
          throw new Error(`response is not a PDF (content-type: ${receipt.contentType || 'unknown'})`)
        }
        const bytes = await readObject(runDir, receipt.rawHash)
        if (!isPdfBuffer(bytes)) {
          throw new Error(`response is not a PDF (content-type: ${receipt.contentType}, bytes: ${bytes.byteLength})`)
        }
        await writeFile(localFile, bytes)
        records.push({
          key: entry.key,
          title: cleanField(entry.fields.title),
          year: cleanField(entry.fields.year),
          sourceUrl: url,
          localFile,
          status: 'downloaded',
          bytes: bytes.byteLength,
          sha256: receipt.rawHash,
        })
        downloaded = true
        break
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    if (!downloaded) {
      records.push({
        key: entry.key,
        title: cleanField(entry.fields.title),
        year: cleanField(entry.fields.year),
        localFile,
        status: 'failed',
        error: lastError || 'no candidate URL in BibTeX entry',
      })
    }
  }

  await atomicWriteJson(join(evidenceDir, 'citations.json'), {
    schema: 'autoresearch/citation-pdfs/v1',
    generated_at: nowIso(),
    entries: records,
  })

  // PDFs are supplementary reference material. A failed download does not mean
  // the citation is invalid; citation validity is handled by citation-audit.
  if (strict && records.some((record) => record.status === 'failed')) {
    const failed = records
      .filter((record) => record.status === 'failed')
      .map((record) => `${record.key} (${record.error ?? 'no URL'})`)
      .join('; ')
    throw new AutoResearchError(`failed to download PDFs for references: ${failed}`, 'AGENT_FAILED')
  }

  return records
}

export function safeFileName(key: string): string {
  const cleaned = key
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .replace(/\.{2,}/g, '.')
  return cleaned || 'ref'
}

function findEntryEnd(text: string, start: number): number {
  let depth = 1
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

function parseBibFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let i = 0
  while (i < raw.length) {
    while (i < raw.length && /\s|,/.test(raw[i] ?? '')) i += 1
    const keyStart = i
    while (i < raw.length && /[A-Za-z0-9_:\-]/.test(raw[i] ?? '')) i += 1
    if (keyStart === i) {
      i += 1
      continue
    }
    const key = raw.slice(keyStart, i).toLowerCase()
    while (i < raw.length && /\s/.test(raw[i] ?? '')) i += 1
    if (raw[i] !== '=') continue
    i += 1
    while (i < raw.length && /\s/.test(raw[i] ?? '')) i += 1

    const ch = raw[i]
    if (ch === '{') {
      const { value, next } = readBraceValue(raw, i)
      fields[key] = value
      i = next
    } else if (ch === '"') {
      const { value, next } = readQuoteValue(raw, i)
      fields[key] = value
      i = next
    } else {
      const start = i
      while (i < raw.length && raw[i] !== ',') i += 1
      fields[key] = raw.slice(start, i).trim()
    }
  }
  return fields
}

function readBraceValue(text: string, start: number): { value: string; next: number } {
  let depth = 0
  let i = start
  let out = ''
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '{') {
      depth += 1
      if (depth > 1) out += ch
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { value: out.trim(), next: i + 1 }
      out += ch
    } else {
      out += ch
    }
    i += 1
  }
  return { value: out.trim(), next: text.length }
}

function readQuoteValue(text: string, start: number): { value: string; next: number } {
  let i = start + 1
  let out = ''
  let escaped = false
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (escaped) {
      out += ch
      escaped = false
    } else if (ch === '\\') {
      out += ch
      escaped = true
    } else if (ch === '"') {
      return { value: out.trim(), next: i + 1 }
    } else {
      out += ch
    }
    i += 1
  }
  return { value: out.trim(), next: text.length }
}

function cleanField(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.replace(/[{}]/g, '').trim() || undefined
}

function isPdfBuffer(buffer: Uint8Array): boolean {
  const head = Buffer.from(buffer.subarray(0, Math.min(buffer.length, 1024))).toString('latin1')
  return head.includes('%PDF-')
}
