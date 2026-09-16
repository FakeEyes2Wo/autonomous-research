import { parse } from 'parse5'
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

const FINGERPRINT = makeParserFingerprint('html-parser', 3)
const IGNORED = new Set(['script', 'style', 'nav'])
const PARAGRAPH_TAGS = new Set(['p', 'li', 'blockquote', 'pre'])
const MAX_CODE_POINTS = 2000

interface Location {
  startOffset: number
  endOffset: number
}

interface HtmlNode {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: HtmlNode[]
  parentNode?: HtmlNode
  sourceCodeLocation?: Location
}

interface TableCell {
  text: string
  colspan: number
  rowspan: number
}

export async function parseHtml(input: ParseInput): Promise<ParseResult> {
  if (input.signal?.aborted) throw abortError()
  if (!sourceMatches(input.document, input.bytes)) {
    return {
      spans: [],
      parserFingerprint: FINGERPRINT,
      status: 'failed',
      issues: [{ code: 'SOURCE_HASH_MISMATCH', locator: null, message: 'source bytes do not match document.rawHash' }],
      spanRelations: [],
    }
  }

  const html = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes)
  const document = parse(html, { sourceCodeLocationInfo: true }) as unknown as HtmlNode
  const spans: SourceSpan[] = []
  const relationSources: SpanRelationSource[] = []
  const sections: string[] = []

  walk(document, (node) => {
    if (input.signal?.aborted) throw abortError()
    const tag = node.tagName?.toLowerCase()
    if (tag && /^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1))
      sections.splice(level - 1)
      sections[level - 1] = normalizedTextContent(node)
      return false
    }
    if (tag && PARAGRAPH_TAGS.has(tag) && node.sourceCodeLocation) {
      const evidenceText = rawTextContent(node).trim()
      if (evidenceText) {
        const locator: Locator = {
          kind: 'html',
          anchor: domAnchor(node),
          start: node.sourceCodeLocation.startOffset,
          end: node.sourceCodeLocation.endOffset,
          sourceHash: input.document.rawHash,
        }
        const parentId = makeParentSpanId({
          document: input.document,
          parserFingerprint: FINGERPRINT,
          kind: 'paragraph',
          locator,
        })
        for (const [ordinal, chunk] of splitTextByCodePoints(evidenceText, MAX_CODE_POINTS).entries()) {
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
          relationSources.push({ span, parentId, parentLocator: locator })
        }
      }
      return false
    }
    if (tag !== 'table' || !node.sourceCodeLocation) return true

    const locator: Locator = {
      kind: 'html',
      anchor: domAnchor(node),
      start: node.sourceCodeLocation.startOffset,
      end: node.sourceCodeLocation.endOffset,
      sourceHash: input.document.rawHash,
    }
    const parentId = makeParentSpanId({
      document: input.document,
      parserFingerprint: FINGERPRINT,
      kind: 'table',
      locator,
    })
    for (const [ordinal, table] of splitTable(extractTable(node), MAX_CODE_POINTS).entries()) {
      const evidenceText = tableText(table)
      if (!evidenceText) continue
      const span = makeSpan({
        document: input.document,
        parserFingerprint: FINGERPRINT,
        kind: 'table',
        sectionPath: sections.filter(Boolean),
        evidenceText,
        locator,
        table,
        identity: { parentId, ordinal },
      })
      spans.push(span)
      relationSources.push({ span, parentId, parentLocator: locator })
    }
    return false
  })

  return {
    spans,
    parserFingerprint: FINGERPRINT,
    status: 'complete',
    issues: [],
    spanRelations: makeSpanRelations(relationSources),
  }
}

function walk(node: HtmlNode, visit: (node: HtmlNode) => boolean): void {
  if (node.tagName && IGNORED.has(node.tagName.toLowerCase())) return
  if (!visit(node)) return
  for (const child of node.childNodes ?? []) walk(child, visit)
}

function extractTable(table: HtmlNode): NonNullable<SourceSpan['table']> {
  const caption = findDescendants(table, 'caption').map(normalizedTextContent).join(' ').trim()
  const allRows = findDescendants(table, 'tr')
  const noteRows = allRows.filter((row) => hasAncestorTag(row, 'tfoot'))
  const headerRows = allRows.filter((row) => {
    return !noteRows.includes(row)
      && (hasAncestorTag(row, 'thead') || (directCells(row, 'th').length > 0 && directCells(row, 'td').length === 0))
  })
  const dataRows = allRows.filter((row) => {
    return !headerRows.includes(row) && !noteRows.includes(row) && directCells(row, 'td').length > 0
  })
  return {
    headers: expandRows(headerRows.map((row) => cells(row))),
    rows: expandRows(dataRows.map((row) => cells(row))),
    caption,
    notes: noteRows.map(normalizedTextContent).map((text) => text.trim()).filter(Boolean),
  }
}

function splitTable(
  table: NonNullable<SourceSpan['table']>,
  maxCodePoints: number,
): NonNullable<SourceSpan['table']>[] {
  if ([...tableText(table)].length <= maxCodePoints || table.rows.length < 2) return [table]
  const chunks: NonNullable<SourceSpan['table']>[] = []
  let rows: string[][] = []
  for (const row of table.rows) {
    const candidate = { ...table, rows: [...rows, row] }
    if (rows.length > 0 && [...tableText(candidate)].length > maxCodePoints) {
      chunks.push({ ...table, rows })
      rows = [row]
    } else {
      rows.push(row)
    }
  }
  if (rows.length > 0) chunks.push({ ...table, rows })
  return chunks
}

function tableText(table: NonNullable<SourceSpan['table']>): string {
  return [
    table.caption,
    ...table.headers.map((row) => row.join('\t')),
    ...table.rows.map((row) => row.join('\t')),
    ...table.notes,
  ].filter(Boolean).join('\n')
}

function cells(row: HtmlNode): TableCell[] {
  return (row.childNodes ?? [])
    .filter((child) => child.tagName === 'th' || child.tagName === 'td')
    .map((cell) => ({
      text: normalizedTextContent(cell),
      colspan: positiveInt(attribute(cell, 'colspan')),
      rowspan: positiveInt(attribute(cell, 'rowspan')),
    }))
}

function expandRows(rows: TableCell[][]): string[][] {
  const grid: string[][] = []
  rows.forEach((cellsInRow, rowIndex) => {
    const row = grid[rowIndex] ?? []
    grid[rowIndex] = row
    let column = 0
    for (const cell of cellsInRow) {
      while (row[column] !== undefined) column += 1
      for (let rowOffset = 0; rowOffset < cell.rowspan; rowOffset += 1) {
        const target = grid[rowIndex + rowOffset] ?? []
        grid[rowIndex + rowOffset] = target
        for (let columnOffset = 0; columnOffset < cell.colspan; columnOffset += 1) {
          target[column + columnOffset] = cell.text
        }
      }
      column += cell.colspan
    }
  })
  return grid.map((row) => row.map((cell) => cell ?? ''))
}

function directCells(row: HtmlNode, tagName: string): HtmlNode[] {
  return (row.childNodes ?? []).filter((child) => child.tagName === tagName)
}

function findDescendants(node: HtmlNode, tagName: string): HtmlNode[] {
  const found: HtmlNode[] = []
  for (const child of node.childNodes ?? []) {
    if (child.tagName === tagName) found.push(child)
    found.push(...findDescendants(child, tagName))
  }
  return found
}

function hasAncestorTag(node: HtmlNode, tagName: string): boolean {
  let parent = node.parentNode
  while (parent) {
    if (parent.tagName === tagName) return true
    parent = parent.parentNode
  }
  return false
}

function rawTextContent(node: HtmlNode): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName && IGNORED.has(node.tagName)) return ''
  return (node.childNodes ?? []).map(rawTextContent).join('')
}

function normalizedTextContent(node: HtmlNode): string {
  return rawTextContent(node).replace(/\s+/gu, ' ').trim()
}

function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((attr) => attr.name === name)?.value
}

function positiveInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '1', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

function domAnchor(node: HtmlNode): string {
  const path: string[] = []
  let current: HtmlNode | undefined = node
  while (current?.tagName) {
    const siblings = current.parentNode?.childNodes?.filter((item) => item.tagName === current?.tagName) ?? []
    path.unshift(`${current.tagName}[${Math.max(1, siblings.indexOf(current) + 1)}]`)
    current = current.parentNode
  }
  const id = attribute(node, 'id')
  return `${path.join('/')}${id ? `#${id}` : ''}`
}

function abortError(): Error {
  return new DOMException('The parsing operation was aborted', 'AbortError')
}
