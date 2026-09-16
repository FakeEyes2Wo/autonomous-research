export type Hash = string

export type Locator =
  | { kind: 'text'; start: number; end: number; unit: 'utf16'; sourceHash: Hash }
  | { kind: 'html'; anchor: string; start: number; end: number; sourceHash: Hash }
  | { kind: 'pdf'; page: number; itemStart: number; itemEnd: number; sourceHash: Hash }

export interface Visibility {
  projectId: string
  partitionId: string
  runId?: string
  split?: string
  roles: string[]
  policyHash: Hash
}

export interface Work {
  id: string
  title: string
  authors: string[] | null
  aliases: { kind: 'doi' | 'arxiv' | 'url'; value: string }[]
  metadataSources: Hash[]
  status: 'candidate' | 'verified_metadata'
}

export interface DocumentVersion {
  id: string
  workId: string
  versionLabel: string | null
  sourceUrl: string | null
  rawHash: Hash
  mediaType: string
  fetchedAt: string
  visibility: Visibility
  publicationDate: string | null
  updatedAt: string | null
  sourceKind: 'abstract' | 'full_text'
  license: string | null
}

export interface SourceSpan {
  id: string
  workId: string
  documentId: string
  parserFingerprint: Hash
  kind: 'paragraph' | 'table'
  sectionPath: string[]
  evidenceText: string
  retrievalText: string
  locator: Locator
  contentHash: Hash
  visibility: Visibility
  quality: 'accepted' | 'needs_review'
  sourceKind: 'abstract' | 'full_text'
  table?: { headers: string[][]; rows: string[][]; caption: string; notes: string[] }
}

export interface AnalysisCard {
  id: string
  workId: string
  revision: number
  origin: 'author_reported' | 'agent_analysis'
  text: string
  spanIds: string[]
  verification: 'legacy_unverified' | 'located' | 'reviewed'
  coverage: 'metadata' | 'abstract' | 'sections' | 'full_text'
  generator: { model: string; promptHash: Hash } | null
}

export interface SqlStatement {
  sql: string
  params: (string | number | null)[]
}

export interface Catalog {
  transact(statements: SqlStatement[]): Promise<Record<string, unknown>[][]>
  close(): Promise<void>
}

const HASH_PATTERN = /^[0-9a-f]{64}$/

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : string(value, name)
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new TypeError(`${name} must be a string array`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${name} is invalid`)
  }
  return value as T
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return value as number
}

export function assertHash(value: unknown, name = 'hash'): Hash {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a 64-character lowercase hexadecimal hash`)
  }
  return value
}

export function assertLocator(value: unknown): Locator {
  const locator = record(value, 'locator')
  const kind = oneOf(locator.kind, ['text', 'html', 'pdf'] as const, 'locator.kind')
  assertHash(locator.sourceHash, 'locator.sourceHash')
  if (kind === 'pdf') {
    const page = nonNegativeInteger(locator.page, 'locator.page')
    const itemStart = nonNegativeInteger(locator.itemStart, 'locator.itemStart')
    const itemEnd = nonNegativeInteger(locator.itemEnd, 'locator.itemEnd')
    if (page < 1 || itemEnd < itemStart) throw new TypeError('locator has an invalid PDF range')
  } else {
    const start = nonNegativeInteger(locator.start, 'locator.start')
    const end = nonNegativeInteger(locator.end, 'locator.end')
    if (end < start) throw new TypeError('locator has an invalid range')
    if (kind === 'text' && locator.unit !== 'utf16') throw new TypeError('locator.unit must be utf16')
    if (kind === 'html') string(locator.anchor, 'locator.anchor')
  }
  return value as Locator
}

export function assertVisibility(value: unknown): Visibility {
  const visibility = record(value, 'visibility')
  string(visibility.projectId, 'visibility.projectId')
  string(visibility.partitionId, 'visibility.partitionId')
  if (visibility.runId !== undefined) string(visibility.runId, 'visibility.runId')
  if (visibility.split !== undefined) string(visibility.split, 'visibility.split')
  stringArray(visibility.roles, 'visibility.roles')
  assertHash(visibility.policyHash, 'visibility.policyHash')
  return value as Visibility
}

export function assertWork(value: unknown): Work {
  const work = record(value, 'work')
  string(work.id, 'work.id')
  string(work.title, 'work.title')
  if (work.authors !== null) stringArray(work.authors, 'work.authors')
  if (!Array.isArray(work.aliases)) throw new TypeError('work.aliases must be an array')
  for (const aliasValue of work.aliases) {
    const alias = record(aliasValue, 'work.alias')
    oneOf(alias.kind, ['doi', 'arxiv', 'url'] as const, 'work.alias.kind')
    string(alias.value, 'work.alias.value')
  }
  if (!Array.isArray(work.metadataSources)) throw new TypeError('work.metadataSources must be an array')
  work.metadataSources.forEach((item, index) => assertHash(item, `work.metadataSources[${index}]`))
  oneOf(work.status, ['candidate', 'verified_metadata'] as const, 'work.status')
  return value as Work
}

export function assertDocumentVersion(value: unknown): DocumentVersion {
  const document = record(value, 'document')
  string(document.id, 'document.id')
  string(document.workId, 'document.workId')
  nullableString(document.versionLabel, 'document.versionLabel')
  nullableString(document.sourceUrl, 'document.sourceUrl')
  assertHash(document.rawHash, 'document.rawHash')
  string(document.mediaType, 'document.mediaType')
  string(document.fetchedAt, 'document.fetchedAt')
  assertVisibility(document.visibility)
  nullableString(document.publicationDate, 'document.publicationDate')
  nullableString(document.updatedAt, 'document.updatedAt')
  oneOf(document.sourceKind, ['abstract', 'full_text'] as const, 'document.sourceKind')
  nullableString(document.license, 'document.license')
  return value as DocumentVersion
}

function stringMatrix(value: unknown, name: string): string[][] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`)
  return value.map((row, index) => stringArray(row, `${name}[${index}]`))
}

export function assertSourceSpan(value: unknown): SourceSpan {
  const span = record(value, 'span')
  string(span.id, 'span.id')
  string(span.workId, 'span.workId')
  string(span.documentId, 'span.documentId')
  assertHash(span.parserFingerprint, 'span.parserFingerprint')
  oneOf(span.kind, ['paragraph', 'table'] as const, 'span.kind')
  stringArray(span.sectionPath, 'span.sectionPath')
  string(span.evidenceText, 'span.evidenceText')
  string(span.retrievalText, 'span.retrievalText')
  assertLocator(span.locator)
  assertHash(span.contentHash, 'span.contentHash')
  assertVisibility(span.visibility)
  oneOf(span.quality, ['accepted', 'needs_review'] as const, 'span.quality')
  oneOf(span.sourceKind, ['abstract', 'full_text'] as const, 'span.sourceKind')
  if (span.table !== undefined) {
    const table = record(span.table, 'span.table')
    stringMatrix(table.headers, 'span.table.headers')
    stringMatrix(table.rows, 'span.table.rows')
    if (typeof table.caption !== 'string') throw new TypeError('span.table.caption must be a string')
    stringArray(table.notes, 'span.table.notes')
  }
  return value as SourceSpan
}

export function assertAnalysisCard(value: unknown): AnalysisCard {
  const card = record(value, 'card')
  string(card.id, 'card.id')
  string(card.workId, 'card.workId')
  nonNegativeInteger(card.revision, 'card.revision')
  oneOf(card.origin, ['author_reported', 'agent_analysis'] as const, 'card.origin')
  string(card.text, 'card.text')
  stringArray(card.spanIds, 'card.spanIds')
  oneOf(card.verification, ['legacy_unverified', 'located', 'reviewed'] as const, 'card.verification')
  oneOf(card.coverage, ['metadata', 'abstract', 'sections', 'full_text'] as const, 'card.coverage')
  if (card.generator !== null) {
    const generator = record(card.generator, 'card.generator')
    string(generator.model, 'card.generator.model')
    assertHash(generator.promptHash, 'card.generator.promptHash')
  }
  return value as AnalysisCard
}
