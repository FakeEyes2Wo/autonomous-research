import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHtml } from '../../dist/literature/parsers/html.js'
import { parsePdf } from '../../dist/literature/parsers/pdf.js'
import { parseText } from '../../dist/literature/parsers/text.js'
import {
  ABSTRACT_TEXT,
  CORRUPT_PDF,
  MERGED_HEADER_HTML,
  TABLE_HTML,
  documentFixture,
  pdfFixture,
  sourceBytes,
} from '../fixtures/literature/sources.ts'

test('HTML tables retain structured rows, captions, and their raw source locator', async () => {
  const bytes = sourceBytes(TABLE_HTML)
  const document = documentFixture('doc-html', 'text/html', bytes)

  const parsed = await parseHtml({ document, bytes })
  const table = parsed.spans.find((span) => span.kind === 'table')

  assert.deepEqual(table?.table?.headers, [['Method', 'p95']])
  assert.deepEqual(table?.table?.rows, [['A', '12.5']])
  assert.equal(table?.table?.caption, 'Latency (ms)')
  assert.deepEqual(table?.table?.notes, ['Lower is better.'])
  assert.equal(table?.locator.sourceHash, document.rawHash)
  assert.equal(table?.sourceKind, 'full_text')
  assert.match(table?.locator.kind === 'html' ? table.locator.anchor : '', /#latency$/)
})

test('merged HTML headers are expanded while scripts and navigation are excluded', async () => {
  const html = MERGED_HEADER_HTML.replace('<article>', '<nav>Hidden navigation</nav><script>Hidden script</script><article>')
  const bytes = sourceBytes(html)
  const document = documentFixture('doc-merged', 'text/html', bytes)

  const parsed = await parseHtml({ document, bytes })
  const table = parsed.spans.find((span) => span.kind === 'table')

  assert.deepEqual(table?.table?.headers, [
    ['Method', 'Score', 'Score'],
    ['Method', 'Mean', 'SD'],
  ])
  assert.doesNotMatch(parsed.spans.map((span) => span.evidenceText).join(' '), /Hidden/)
})

test('HTML paragraphs follow DOM sections while preserving raw UTF-16 element offsets', async () => {
  const html = '<main><h1>Methods</h1><nav><p>Hidden</p></nav><p id="method">中文\r\n  result</p></main>'
  const bytes = sourceBytes(html)
  const document = documentFixture('doc-paragraph', 'text/html', bytes)

  const parsed = await parseHtml({ document, bytes })
  const paragraph = parsed.spans.find((span) => span.kind === 'paragraph')

  assert.equal(paragraph?.evidenceText, '中文\n  result')
  assert.equal(paragraph?.retrievalText, '中文 result')
  assert.deepEqual(paragraph?.sectionPath, ['Methods'])
  assert.equal(paragraph?.locator.kind, 'html')
  if (paragraph?.locator.kind === 'html') {
    assert.equal(html.slice(paragraph.locator.start, paragraph.locator.end), '<p id="method">中文\r\n  result</p>')
    assert.match(paragraph.locator.anchor, /#method$/)
  }
  assert.doesNotMatch(parsed.spans.map((span) => span.evidenceText).join(' '), /Hidden/)
})

test('large HTML tables split only between rows and repeat their headers', async () => {
  const rows = Array.from({ length: 24 }, (_, index) => `<tr><td>row-${index}</td><td>${'x'.repeat(100)}</td></tr>`).join('')
  const html = `<table><tr><th>Key</th><th>Value</th></tr>${rows}</table>`
  const bytes = sourceBytes(html)
  const document = documentFixture('doc-large-table', 'text/html', bytes)

  const parsed = await parseHtml({ document, bytes })
  const tables = parsed.spans.filter((span) => span.kind === 'table')

  assert.ok(tables.length >= 2)
  assert.ok(tables.every((span) => [...span.evidenceText].length <= 2000))
  assert.ok(tables.every((span) => JSON.stringify(span.table?.headers) === JSON.stringify([['Key', 'Value']])))
  assert.deepEqual(tables.flatMap((span) => span.table?.rows ?? []).map((row) => row[0]), Array.from({ length: 24 }, (_, index) => `row-${index}`))
})

test('plain text preserves CRLF UTF-16 offsets and marks an abstract as abstract', async () => {
  const bytes = sourceBytes(ABSTRACT_TEXT)
  const document = documentFixture('doc-abstract', 'text/plain', bytes, 'abstract')

  const parsed = await parseText({ document, bytes })
  const evidence = parsed.spans.find((span) => span.evidenceText.includes('0.42'))

  assert.equal(parsed.status, 'complete')
  assert.equal(evidence?.sourceKind, 'abstract')
  assert.equal(evidence?.retrievalText, 'We evaluate α and report 0.42.')
  assert.equal(evidence?.locator.kind, 'text')
  if (evidence?.locator.kind === 'text') {
    assert.equal(ABSTRACT_TEXT.slice(evidence.locator.start, evidence.locator.end), evidence.evidenceText)
    assert.equal(evidence.locator.unit, 'utf16')
  }
})

test('plain text splits long paragraphs at Unicode code-point boundaries', async () => {
  const text = `${'🧪'.repeat(1999)}. ${'🧬'.repeat(100)}.`
  const bytes = sourceBytes(text)
  const document = documentFixture('doc-long', 'text/plain', bytes)

  const parsed = await parseText({ document, bytes })

  assert.ok(parsed.spans.length >= 2)
  for (const span of parsed.spans) {
    assert.ok([...span.evidenceText].length <= 2000)
    assert.doesNotMatch(span.evidenceText, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
  }
})

test('source hash mismatch fails without producing locatable text', async () => {
  const original = sourceBytes('registered source')
  const document = documentFixture('doc-mismatch', 'text/plain', original)

  const parsed = await parseText({ document, bytes: sourceBytes('different bytes') })

  assert.equal(parsed.status, 'failed')
  assert.deepEqual(parsed.spans, [])
  assert.equal(parsed.issues[0]?.code, 'SOURCE_HASH_MISMATCH')
})

test('corrupt PDFs return a failed quality report rather than throwing', async () => {
  const document = documentFixture('doc-corrupt', 'application/pdf', CORRUPT_PDF)

  const parsed = await parsePdf({ document, bytes: CORRUPT_PDF })

  assert.equal(parsed.status, 'failed')
  assert.deepEqual(parsed.spans, [])
  assert.equal(parsed.issues[0]?.code, 'PDF_INVALID')
})

test('PDF pages without extractable text are partial and require review', async () => {
  const bytes = pdfFixture([])
  const document = documentFixture('doc-scan', 'application/pdf', bytes)

  const parsed = await parsePdf({ document, bytes })

  assert.equal(parsed.status, 'partial')
  assert.equal(parsed.issues[0]?.code, 'PDF_NO_TEXT')
  assert.equal(parsed.issues[0]?.locator?.kind, 'pdf')
  assert.equal(parsed.issues[0]?.locator?.kind === 'pdf' ? parsed.issues[0].locator.page : null, 1)
})

test('two-column PDF extraction remains locatable but is conservatively marked needs_review', async () => {
  const bytes = pdfFixture([
    { x: 40, y: 740, text: 'Left one' },
    { x: 320, y: 740, text: 'Right one' },
    { x: 40, y: 720, text: 'Left two' },
    { x: 320, y: 720, text: 'Right two' },
  ])
  const document = documentFixture('doc-columns', 'application/pdf', bytes)

  const parsed = await parsePdf({ document, bytes })

  assert.equal(parsed.status, 'partial')
  assert.ok(parsed.spans.length > 0)
  assert.ok(parsed.spans.every((span) => span.quality === 'needs_review'))
  assert.equal(parsed.spans[0]?.locator.kind, 'pdf')
  assert.equal(parsed.spans[0]?.locator.kind === 'pdf' ? parsed.spans[0].locator.page : null, 1)
  assert.equal(parsed.issues[0]?.code, 'PDF_READING_ORDER_UNCERTAIN')
})
