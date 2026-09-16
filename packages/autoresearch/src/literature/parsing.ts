import type { DocumentVersion, Hash, Locator, SourceSpan } from './contracts.js'

export interface ParseInput {
  document: DocumentVersion
  bytes: Uint8Array
  signal?: AbortSignal
}

export interface ParseIssue {
  code: string
  locator: Locator | null
  message: string
}

export interface ParseResult {
  spans: SourceSpan[]
  parserFingerprint: Hash
  status: 'complete' | 'partial' | 'failed'
  issues: ParseIssue[]
}

export interface Parser {
  fingerprint: Hash
  parse(input: ParseInput): Promise<ParseResult>
}
