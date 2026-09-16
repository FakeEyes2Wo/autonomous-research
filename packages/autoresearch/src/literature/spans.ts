import { createHash } from 'node:crypto'
import type { DocumentVersion, Hash, Locator, SourceSpan } from './contracts.js'
import type { SpanRelation } from './parsing.js'

export interface TextChunk {
  text: string
  start: number
  end: number
}

export function sha256(bytes: Uint8Array | string): Hash {
  return createHash('sha256').update(bytes).digest('hex')
}

export function normalizeRetrievalText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

export function makeParserFingerprint(name: string, version: number): Hash {
  return sha256(`autoresearch:${name}:v${version}`)
}

export function sourceMatches(document: DocumentVersion, bytes: Uint8Array): boolean {
  return sha256(bytes) === document.rawHash
}

export function splitTextByCodePoints(text: string, maxCodePoints = 2000): TextChunk[] {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
    throw new RangeError('maxCodePoints must be a positive integer')
  }
  const chunks: TextChunk[] = []
  let remaining = text
  let sourceOffset = 0
  while ([...remaining].length > maxCodePoints) {
    const prefix = [...remaining].slice(0, maxCodePoints).join('')
    const boundary = findPreferredBoundary(prefix)
    const chunkText = remaining.slice(0, boundary).trimEnd()
    if (chunkText) chunks.push({ text: chunkText, start: sourceOffset, end: sourceOffset + chunkText.length })
    let consumed = boundary
    while (/\s/u.test(remaining[consumed] ?? '')) consumed += 1
    sourceOffset += consumed
    remaining = remaining.slice(consumed)
  }
  if (remaining) chunks.push({ text: remaining, start: sourceOffset, end: sourceOffset + remaining.length })
  return chunks
}

export function makeSpanRelations(
  spans: SourceSpan[],
  parentLocators: ReadonlyMap<string, Locator> = new Map(),
): SpanRelation[] {
  return spans.map((span, index) => ({
    spanId: span.id,
    previousId: spans[index - 1]?.id ?? null,
    nextId: spans[index + 1]?.id ?? null,
    parentLocator: parentLocators.get(span.id) ?? null,
  }))
}

export function makeSpan(input: {
  document: DocumentVersion
  parserFingerprint: Hash
  kind: 'paragraph' | 'table'
  sectionPath: string[]
  evidenceText: string
  locator: Locator
  quality?: 'accepted' | 'needs_review'
  table?: SourceSpan['table']
}): SourceSpan {
  const retrievalText = normalizeRetrievalText(input.evidenceText)
  const contentHash = sha256(input.evidenceText)
  const id = sha256(JSON.stringify({
    documentId: input.document.id,
    parserFingerprint: input.parserFingerprint,
    kind: input.kind,
    locator: input.locator,
    contentHash,
  }))
  return {
    id,
    workId: input.document.workId,
    documentId: input.document.id,
    parserFingerprint: input.parserFingerprint,
    kind: input.kind,
    sectionPath: [...input.sectionPath],
    evidenceText: input.evidenceText,
    retrievalText,
    locator: input.locator,
    contentHash,
    visibility: input.document.visibility,
    quality: input.quality ?? 'accepted',
    sourceKind: input.document.sourceKind,
    ...(input.table === undefined ? {} : { table: input.table }),
  }
}

function findPreferredBoundary(prefix: string): number {
  const minimum = Math.floor(prefix.length * 0.6)
  for (let index = prefix.length; index > minimum; index -= 1) {
    if (/[.!?。！？；;]\s/u.test(prefix.slice(index - 1, index + 1))) return index
  }
  for (let index = prefix.length; index > minimum; index -= 1) {
    if (/\s/u.test(prefix[index - 1] ?? '')) return index
  }
  return prefix.length
}
