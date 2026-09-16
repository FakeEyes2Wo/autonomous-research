import { createHash } from 'node:crypto'

import type { Catalog, DocumentVersion, SourceSpan, Work } from '../../dist/literature/contracts.js'
import { putObject } from '../../dist/literature/objects.js'
import { makeSpan } from '../../dist/literature/spans.js'

const PARSER_FINGERPRINT = createHash('sha256').update('index-fixture-parser-v1').digest('hex')
const POLICY_HASH = createHash('sha256').update('index-fixture-policy-v1').digest('hex')

export interface IndexedDocumentFixture {
  document: DocumentVersion
  spans: SourceSpan[]
  work: Work
}

export async function persistIndexedDocument(
  catalog: Catalog,
  root: string,
  input: {
    id: string
    partitionId: string
    title: string
    texts: string[]
    projectId?: string
    sectionPath?: string[]
  },
): Promise<IndexedDocumentFixture> {
  const bytes = new TextEncoder().encode(input.texts.join('\n\n'))
  const rawHash = await putObject(root, bytes)
  const work: Work = {
    id: `work-${input.id}`,
    title: input.title,
    authors: ['Fixture Author'],
    aliases: [],
    metadataSources: [],
    status: 'verified_metadata',
  }
  const document: DocumentVersion = {
    id: `doc-${input.id}`,
    workId: work.id,
    versionLabel: 'v1',
    sourceUrl: `https://example.test/${input.id}`,
    rawHash,
    mediaType: 'text/plain',
    fetchedAt: '2026-09-16T00:00:00.000Z',
    visibility: {
      projectId: input.projectId ?? 'fixture-project',
      partitionId: input.partitionId,
      roles: ['researcher'],
      policyHash: POLICY_HASH,
    },
    publicationDate: '2026-09-01',
    updatedAt: null,
    sourceKind: 'full_text',
    license: 'CC-BY-4.0',
  }
  let offset = 0
  const spans = input.texts.map((text) => {
    const start = offset
    const end = start + text.length
    offset = end + 2
    return makeSpan({
      document,
      parserFingerprint: PARSER_FINGERPRINT,
      kind: 'paragraph',
      sectionPath: input.sectionPath ?? ['Results'],
      evidenceText: text,
      locator: { kind: 'text', start, end, unit: 'utf16', sourceHash: rawHash },
    })
  })

  await catalog.transact([
    { sql: 'INSERT INTO works(id,body) VALUES(?,?)', params: [work.id, JSON.stringify(work)] },
    {
      sql: 'INSERT INTO documents(id,work_id,raw_hash,body) VALUES(?,?,?,?)',
      params: [document.id, document.workId, document.rawHash, JSON.stringify(document)],
    },
    ...spans.map((span) => ({
      sql: 'INSERT INTO spans(id,document_id,body) VALUES(?,?,?)',
      params: [span.id, span.documentId, JSON.stringify(span)],
    })),
  ])
  return { document, spans, work }
}
