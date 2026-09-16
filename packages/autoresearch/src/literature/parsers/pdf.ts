import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentLoadingTask, PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { Locator, SourceSpan } from '../contracts.js'
import type { ParseInput, ParseIssue, ParseResult } from '../parsing.js'
import { makeParserFingerprint, makeSpan, makeSpanRelations, sourceMatches, splitTextByCodePoints } from '../spans.js'

const FINGERPRINT = makeParserFingerprint('pdf-parser', 2)
const MAX_CODE_POINTS = 2000
const pdfJsEntry = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')
const pdfJsRoot = dirname(dirname(dirname(pdfJsEntry))).replaceAll('\\', '/')
const standardFontDataUrl = `${pdfJsRoot}/standard_fonts/`

interface PositionedItem {
  index: number
  item: TextItem
  x: number
  y: number
}

interface PdfChunk {
  text: string
  items: PositionedItem[]
}

export async function parsePdf(input: ParseInput): Promise<ParseResult> {
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

  let loadingTask: PDFDocumentLoadingTask | undefined
  let aborted = false
  const spans: SourceSpan[] = []
  const parentLocators = new Map<string, Locator>()
  const issues: ParseIssue[] = []
  const onAbort = () => {
    aborted = true
    void loadingTask?.destroy()
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    loadingTask = getDocument({
      data: input.bytes.slice(),
      standardFontDataUrl,
      verbosity: VerbosityLevel.ERRORS,
    })
    const pdf = await loadingTask.promise
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      checkAbort(input.signal)
      let page: PDFPageProxy | undefined
      try {
        page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        checkAbort(input.signal)
        const items = content.items
          .map((item, index): PositionedItem | null => {
            if (!('str' in item) || !item.str.trim()) return null
            const x = numeric(item.transform[4])
            const y = numeric(item.transform[5])
            return { index, item, x, y }
          })
          .filter((item): item is PositionedItem => item !== null)
        const locator = pdfLocator(input, pageNumber, items)
        if (items.length === 0) {
          issues.push({ code: 'PDF_NO_TEXT', locator, message: `page ${pageNumber} has no extractable text` })
          continue
        }

        const text = items.map(({ item }) => item.str).join(' ').replace(/\s+/gu, ' ').trim()
        const uncertainColumns = hasTwoColumnLayout(items, page.getViewport({ scale: 1 }).width)
        const garbled = looksGarbled(text)
        const quality = uncertainColumns || garbled ? 'needs_review' : 'accepted'
        if (uncertainColumns) {
          issues.push({
            code: 'PDF_READING_ORDER_UNCERTAIN',
            locator,
            message: `page ${pageNumber} appears to contain multiple text columns`,
          })
        }
        if (garbled) {
          issues.push({ code: 'PDF_TEXT_GARBLED', locator, message: `page ${pageNumber} contains unreliable decoded text` })
        }
        for (const chunk of chunkPdfItems(items, MAX_CODE_POINTS)) {
          const span = makeSpan({
            document: input.document,
            parserFingerprint: FINGERPRINT,
            kind: 'paragraph',
            sectionPath: [`Page ${pageNumber}`],
            evidenceText: chunk.text,
            locator: pdfLocator(input, pageNumber, chunk.items),
            quality,
          })
          spans.push(span)
          parentLocators.set(span.id, locator)
        }
      } catch (error) {
        if (aborted || input.signal?.aborted) throw abortError()
        issues.push({
          code: 'PDF_PAGE_FAILED',
          locator: emptyPdfLocator(input, pageNumber),
          message: `page ${pageNumber} could not be parsed: ${safeErrorMessage(error)}`,
        })
      } finally {
        page?.cleanup()
      }
    }
    return {
      spans,
      parserFingerprint: FINGERPRINT,
      status: issues.length > 0 ? 'partial' : 'complete',
      issues,
      spanRelations: makeSpanRelations(spans, parentLocators),
    }
  } catch (error) {
    if (aborted || input.signal?.aborted) throw abortError()
    if (spans.length > 0) {
      issues.push({ code: 'PDF_PARTIAL_FAILURE', locator: null, message: safeErrorMessage(error) })
      return {
        spans,
        parserFingerprint: FINGERPRINT,
        status: 'partial',
        issues,
        spanRelations: makeSpanRelations(spans, parentLocators),
      }
    }
    return {
      spans: [],
      parserFingerprint: FINGERPRINT,
      status: 'failed',
      issues: [{ code: 'PDF_INVALID', locator: null, message: safeErrorMessage(error) }],
      spanRelations: [],
    }
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    await loadingTask?.destroy().catch(() => undefined)
  }
}

function emptyPdfLocator(input: ParseInput, page: number): Locator {
  return { kind: 'pdf', page, itemStart: 0, itemEnd: 0, sourceHash: input.document.rawHash }
}

function chunkPdfItems(items: PositionedItem[], maxCodePoints: number): PdfChunk[] {
  const chunks: PdfChunk[] = []
  let currentItems: PositionedItem[] = []
  let currentText = ''
  const flush = () => {
    if (currentText) chunks.push({ text: currentText, items: currentItems })
    currentItems = []
    currentText = ''
  }
  for (const positioned of items) {
    const itemText = positioned.item.str.trim()
    if (!itemText) continue
    const itemChunks = splitTextByCodePoints(itemText, maxCodePoints)
    if (itemChunks.length > 1) {
      flush()
      for (const chunk of itemChunks) chunks.push({ text: chunk.text, items: [positioned] })
      continue
    }
    const candidate = currentText ? `${currentText} ${itemText}` : itemText
    if (currentText && [...candidate].length > maxCodePoints) flush()
    currentItems.push(positioned)
    currentText = currentText ? `${currentText} ${itemText}` : itemText
  }
  flush()
  return chunks
}

function pdfLocator(input: ParseInput, page: number, items: PositionedItem[]): Locator {
  return {
    kind: 'pdf',
    page,
    itemStart: items[0]?.index ?? 0,
    itemEnd: (items.at(-1)?.index ?? -1) + 1,
    sourceHash: input.document.rawHash,
  }
}

function hasTwoColumnLayout(items: PositionedItem[], pageWidth: number): boolean {
  if (items.length < 4 || !Number.isFinite(pageWidth) || pageWidth <= 0) return false
  const sorted = [...items].sort((a, b) => a.x - b.x)
  let largestGap = 0
  let splitAt = 0
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = (sorted[index]?.x ?? 0) - (sorted[index - 1]?.x ?? 0)
    if (gap > largestGap) {
      largestGap = gap
      splitAt = index
    }
  }
  if (largestGap < pageWidth * 0.25 || splitAt < 2 || sorted.length - splitAt < 2) return false
  const leftY = sorted.slice(0, splitAt).map((item) => item.y)
  const rightY = sorted.slice(splitAt).map((item) => item.y)
  return rangesOverlap(leftY, rightY)
}

function rangesOverlap(first: number[], second: number[]): boolean {
  const firstMin = Math.min(...first)
  const firstMax = Math.max(...first)
  const secondMin = Math.min(...second)
  const secondMax = Math.max(...second)
  return Math.min(firstMax, secondMax) >= Math.max(firstMin, secondMin)
}

function looksGarbled(text: string): boolean {
  if (!text) return true
  const characters = [...text]
  const suspicious = characters.filter((character) => {
    const code = character.codePointAt(0) ?? 0
    return character === '\uFFFD' || (code < 32 && character !== '\n' && character !== '\r' && character !== '\t')
  }).length
  return suspicious / characters.length > 0.02
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'PDF parsing failed'
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): DOMException {
  return new DOMException('The parsing operation was aborted', 'AbortError')
}
