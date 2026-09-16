import { createHash } from 'node:crypto'
import type { DocumentVersion, Hash, Locator, SourceSpan } from './contracts.js'

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
