import { createHash } from 'node:crypto'

export const TEST_VISIBILITY = {
  projectId: 'fixture-project',
  partitionId: 'public-literature',
  roles: ['researcher', 'reviewer'],
  policyHash: createHash('sha256').update('fixture-policy').digest('hex'),
}

export function sourceBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function sourceHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function documentFixture(
  id: string,
  mediaType: string,
  bytes: Uint8Array,
  sourceKind: 'abstract' | 'full_text' = 'full_text',
) {
  return {
    id,
    workId: id.replace(/^doc-/, 'work-'),
    versionLabel: null,
    sourceUrl: null,
    rawHash: sourceHash(bytes),
    mediaType,
    fetchedAt: '2026-09-16T00:00:00.000Z',
    visibility: TEST_VISIBILITY,
    publicationDate: null,
    updatedAt: null,
    sourceKind,
    license: null,
  }
}

export const TABLE_HTML = [
  '<!doctype html><html><body><main>',
  '<h1>Results</h1>',
  '<p>The measurements are reported below.</p>',
  '<table id="latency"><caption>Latency (ms)</caption>',
  '<tr><th>Method</th><th>p95</th></tr>',
  '<tr><td>A</td><td>12.5</td></tr>',
  '<tfoot><tr><td colspan="2">Lower is better.</td></tr></tfoot>',
  '</table></main></body></html>',
].join('')

export const MERGED_HEADER_HTML = [
  '<!doctype html><html><body><article>',
  '<table><caption>Accuracy</caption>',
  '<thead><tr><th rowspan="2">Method</th><th colspan="2">Score</th></tr>',
  '<tr><th>Mean</th><th>SD</th></tr></thead>',
  '<tbody><tr><td>A</td><td>0.91</td><td>0.02</td></tr></tbody>',
  '</table></article></body></html>',
].join('')

export const ABSTRACT_TEXT = 'Background\r\n\r\nWe evaluate α and report 0.42.\r\n'

export const CORRUPT_PDF = sourceBytes('%PDF-1.7\nthis is not a valid PDF')

export function pdfFixture(lines: { x: number; y: number; text: string }[]): Uint8Array {
  const operations = lines
    .map(({ x, y, text }) => `BT /F1 12 Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`)
    .join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(operations, 'latin1')} >>\nstream\n${operations}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

function escapePdfText(text: string): string {
  return text.replace(/([\\()])/g, '\\$1')
}
