import type { Locator, SourceSpan } from '../contracts.js'
import type { ParseInput, ParseResult } from '../parsing.js'
import {
  makeParentSpanId,
  makeParserFingerprint,
  makeSpan,
  makeSpanRelations,
  sourceMatches,
  splitTextByCodePoints,
  type SpanRelationSource,
} from '../spans.js'

const FINGERPRINT = makeParserFingerprint('text-parser', 3)
const MAX_CODE_POINTS = 2000

export async function parseText(input: ParseInput): Promise<ParseResult> {
  checkAbort(input.signal)
  if (!sourceMatches(input.document, input.bytes)) {
    return {
      spans: [],
      parserFingerprint: FINGERPRINT,
      status: 'failed',
      issues: [{ code: 'SOURCE_HASH_MISMATCH', locator: null, message: 'source bytes do not match document.rawHash' }],
      spanRelations: [],
    }
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes)
  const spans: SourceSpan[] = []
  const relationSources: SpanRelationSource[] = []
  const sections: string[] = []
  const paragraphPattern = /(?:^|(?:\r?\n){2,})([\s\S]*?)(?=(?:\r?\n){2,}|$)/gu
  let match: RegExpExecArray | null
  while ((match = paragraphPattern.exec(text)) !== null) {
    checkAbort(input.signal)
    const raw = match[1] ?? ''
    const rawStart = match.index + match[0].indexOf(raw)
    const range = trimRange(raw, rawStart)
    if (range.start === range.end) continue
    const paragraph = text.slice(range.start, range.end)
    const heading = /^(#{1,6})\s+(.+)$/u.exec(paragraph)
    if (heading) {
      const level = heading[1]?.length ?? 1
      sections.splice(level - 1)
      sections[level - 1] = heading[2]?.trim() ?? ''
    }
    const parentLocator: Locator = {
      kind: 'text',
      start: range.start,
      end: range.end,
      unit: 'utf16',
      sourceHash: input.document.rawHash,
    }
    const parentId = makeParentSpanId({
      document: input.document,
      parserFingerprint: FINGERPRINT,
      kind: 'paragraph',
      locator: parentLocator,
    })
    for (const [ordinal, chunk] of splitTextByCodePoints(paragraph, MAX_CODE_POINTS).entries()) {
      const locator: Locator = {
        kind: 'text',
        start: range.start + chunk.start,
        end: range.start + chunk.end,
        unit: 'utf16',
        sourceHash: input.document.rawHash,
      }
      const span = makeSpan({
        document: input.document,
        parserFingerprint: FINGERPRINT,
        kind: 'paragraph',
        sectionPath: sections.filter(Boolean),
        evidenceText: chunk.text,
        locator,
        identity: {
          parentId,
          ordinal,
          withinSourceStart: chunk.start,
          withinSourceEnd: chunk.end,
        },
      })
      spans.push(span)
      relationSources.push({ span, parentId, parentLocator })
    }
  }

  const hasReplacement = text.includes('\uFFFD')
  return {
    spans,
    parserFingerprint: FINGERPRINT,
    status: hasReplacement ? 'partial' : 'complete',
    issues: hasReplacement
      ? [{ code: 'TEXT_DECODE_REPLACEMENT', locator: null, message: 'invalid UTF-8 bytes were replaced during decoding' }]
      : [],
    spanRelations: makeSpanRelations(relationSources),
  }
}

function trimRange(value: string, sourceStart: number): { start: number; end: number } {
  const leading = /^\s*/u.exec(value)?.[0].length ?? 0
  const trailing = /\s*$/u.exec(value)?.[0].length ?? 0
  return {
    start: sourceStart + leading,
    end: sourceStart + value.length - trailing,
  }
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The parsing operation was aborted', 'AbortError')
}
