import type { Locator, SourceSpan } from '../contracts.js'
import type { ParseInput, ParseResult } from '../parsing.js'
import { makeParserFingerprint, makeSpan, sourceMatches } from '../spans.js'

const FINGERPRINT = makeParserFingerprint('text-parser', 1)
const MAX_CODE_POINTS = 2000

export async function parseText(input: ParseInput): Promise<ParseResult> {
  checkAbort(input.signal)
  if (!sourceMatches(input.document, input.bytes)) {
    return {
      spans: [],
      parserFingerprint: FINGERPRINT,
      status: 'failed',
      issues: [{ code: 'SOURCE_HASH_MISMATCH', locator: null, message: 'source bytes do not match document.rawHash' }],
    }
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes)
  const spans: SourceSpan[] = []
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
    for (const chunk of splitAtCodePointBudget(paragraph, range.start, MAX_CODE_POINTS)) {
      const locator: Locator = {
        kind: 'text',
        start: chunk.start,
        end: chunk.end,
        unit: 'utf16',
        sourceHash: input.document.rawHash,
      }
      spans.push(makeSpan({
        document: input.document,
        parserFingerprint: FINGERPRINT,
        kind: 'paragraph',
        sectionPath: sections.filter(Boolean),
        evidenceText: text.slice(chunk.start, chunk.end),
        locator,
      }))
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

function splitAtCodePointBudget(
  paragraph: string,
  sourceStart: number,
  maxCodePoints: number,
): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = []
  let remaining = paragraph
  let offset = sourceStart
  while ([...remaining].length > maxCodePoints) {
    const prefix = [...remaining].slice(0, maxCodePoints).join('')
    const preferred = findPreferredBoundary(prefix)
    const split = preferred > 0 ? preferred : prefix.length
    const chunkText = remaining.slice(0, split).trimEnd()
    if (chunkText.length > 0) result.push({ start: offset, end: offset + chunkText.length })
    let consumed = split
    while (/\s/u.test(remaining[consumed] ?? '')) consumed += 1
    offset += consumed
    remaining = remaining.slice(consumed)
  }
  if (remaining.length > 0) result.push({ start: offset, end: offset + remaining.length })
  return result
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

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The parsing operation was aborted', 'AbortError')
}
