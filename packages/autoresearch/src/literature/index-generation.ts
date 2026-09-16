import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  assertDocumentVersion,
  assertSourceSpan,
  assertWork,
  type Catalog,
  type DocumentVersion,
  type Hash,
  type SourceSpan,
  type Visibility,
  type Work,
} from './contracts.js'
import { readObject } from './objects.js'
import { MAX_QUERY_TOKENS, TOKENIZER_VERSION, tokenize } from './tokenize.js'

const MANIFEST_SCHEMA = 'autoresearch/literature-index-generation/v1' as const
const CHUNKER_FINGERPRINT = sha256('autoresearch:source-span-chunker:v2:2000-codepoints')

export interface IndexGeneration {
  id: string
  manifestHash: Hash
  corpusHash: Hash
  configHash: Hash
  partitionIds: string[]
  documentIds: string[]
  spanIds: string[]
  status: 'building' | 'validated' | 'active' | 'retired' | 'failed'
  tokenizerVersion: typeof TOKENIZER_VERSION
  createdAt: string
}

export interface BuildOptions {
  expectedActiveId: string | null
  maxSpans: number
}

export interface VisibilityScope {
  projectId: string
  runId: string | null
  split: string | null
  roles: string[]
  policyHash: Hash
}

interface ManifestDocument {
  id: string
  workId: string
  rawHash: Hash
  mediaType: string
  parserFingerprints: Hash[]
  spanIds: string[]
  fingerprint: Hash
}

interface ManifestSpan {
  id: string
  documentId: string
  workId: string
  partitionId: string
  parserFingerprint: Hash
  contentHash: Hash
  recordHash: Hash
  lexicalHash: Hash
}

interface IndexConfig {
  tokenizer: { version: typeof TOKENIZER_VERSION; normalization: 'NFKC-lower'; maxQueryTokens: number }
  chunkerFingerprint: Hash
  ranking: {
    algorithm: 'fts5-bm25'
    weights: { title: 3; section: 2; body: 1 }
    scoreOrder: 'ascending'
    tieBreak: 'span-id'
  }
}

export interface GenerationManifest {
  schema: typeof MANIFEST_SCHEMA
  generationId: string
  manifestHash: Hash
  configHash: Hash
  corpusHash: Hash
  config: IndexConfig
  corpus: {
    documents: ManifestDocument[]
    spans: ManifestSpan[]
    partitionScopes: { partitionId: string; scope: VisibilityScope }[]
  }
  partitionFiles: { partitionId: string; file: string }[]
}

interface CorpusRecords {
  documents: Map<string, DocumentVersion>
  works: Map<string, Work>
  spans: SourceSpan[]
}

const INDEX_CONFIG: IndexConfig = {
  tokenizer: { version: TOKENIZER_VERSION, normalization: 'NFKC-lower', maxQueryTokens: MAX_QUERY_TOKENS },
  chunkerFingerprint: CHUNKER_FINGERPRINT,
  ranking: {
    algorithm: 'fts5-bm25',
    weights: { title: 3, section: 2, body: 1 },
    scoreOrder: 'ascending',
    tieBreak: 'span-id',
  },
}

export async function buildGeneration(
  catalog: Catalog,
  root: string,
  inputSpans: SourceSpan[],
  options: BuildOptions,
): Promise<IndexGeneration> {
  validateBuildOptions(inputSpans, options)
  const active = await getActiveGeneration(catalog)
  if ((active?.id ?? null) !== options.expectedActiveId) {
    throw codedError('active generation changed before build started', 'INDEX_ACTIVE_MISMATCH')
  }

  const records = await loadRegisteredCorpus(catalog, inputSpans)
  const manifest = makeManifest(records)
  const prior = await getGeneration(catalog, manifest.generationId)
  const generation: IndexGeneration = {
    id: manifest.generationId,
    manifestHash: manifest.manifestHash,
    corpusHash: manifest.corpusHash,
    configHash: manifest.configHash,
    partitionIds: manifest.partitionFiles.map(entry => entry.partitionId),
    documentIds: manifest.corpus.documents.map(document => document.id),
    spanIds: manifest.corpus.spans.map(span => span.id),
    status: 'building',
    tokenizerVersion: TOKENIZER_VERSION,
    createdAt: prior?.createdAt ?? new Date().toISOString(),
  }
  await registerBuilding(catalog, generation, prior)

  const finalDirectory = generationDirectory(root, generation.id)
  try {
    for (const document of records.documents.values()) await readObject(root, document.rawHash)
    if (await exists(finalDirectory)) {
      await validatePublishedDirectory(finalDirectory, manifest)
      const status: IndexGeneration['status'] =
        prior?.status === 'active' || prior?.status === 'retired' || prior?.status === 'validated'
          ? prior.status
          : 'validated'
      const recovered: IndexGeneration = { ...generation, status }
      if (status === 'validated') await saveBuilderResult(catalog, recovered)
      return await getGeneration(catalog, generation.id) ?? recovered
    }

    const stagingDirectory = stagingGenerationDirectory(root, generation.id)
    await mkdir(stagingDirectory, { recursive: true })
    await ensureBuildIdentity(stagingDirectory, manifest)
    await buildPartitionIndexes(stagingDirectory, manifest, records)
    await validateStaging(stagingDirectory, manifest, true)
    await writeFile(join(stagingDirectory, 'manifest.json'), `${canonicalJson(manifest)}\n`, 'utf8')
    await mkdir(join(root, 'indexes', 'generations'), { recursive: true })
    try {
      await rename(stagingDirectory, finalDirectory)
    } catch (error) {
      if (!await exists(finalDirectory)) throw error
      await validatePublishedDirectory(finalDirectory, manifest)
      await rm(stagingDirectory, { recursive: true, force: true })
    }

    const validated: IndexGeneration = { ...generation, status: 'validated' }
    await saveBuilderResult(catalog, validated)
    return await getGeneration(catalog, generation.id) ?? validated
  } catch (error) {
    await markBuilderFailed(catalog, generation.id).catch(() => undefined)
    throw error
  }
}

export async function publishGeneration(
  catalog: Catalog,
  root: string,
  id: string,
  expectedActiveId: string | null,
): Promise<void> {
  const generation = await getGeneration(catalog, id)
  if (generation === null) throw codedError(`index generation not found: ${id}`, 'INDEX_GENERATION_NOT_FOUND')
  if (generation.status !== 'validated') {
    throw codedError(`index generation is not publishable: ${generation.status}`, 'INDEX_GENERATION_NOT_VALIDATED')
  }
  const manifest = await loadGenerationManifest(root, id)
  if (manifest.manifestHash !== generation.manifestHash) {
    throw codedError('published manifest does not match catalog generation', 'INDEX_MANIFEST_MISMATCH')
  }
  await validatePublishedDirectory(generationDirectory(root, id), manifest)

  const [, , , pointerRows = []] = await catalog.transact([
    {
      sql: `UPDATE index_generations
        SET status='retired', body=json_set(body,'$.status','retired')
        WHERE id=(SELECT active_generation_id FROM index_state WHERE singleton=1 AND active_generation_id IS ?)`,
      params: [expectedActiveId],
    },
    {
      sql: 'UPDATE index_state SET active_generation_id=? WHERE singleton=1 AND active_generation_id IS ?',
      params: [id, expectedActiveId],
    },
    {
      sql: `UPDATE index_generations
        SET status='active', body=json_set(body,'$.status','active')
        WHERE id=? AND (SELECT active_generation_id FROM index_state WHERE singleton=1)=?`,
      params: [id, id],
    },
    { sql: 'SELECT active_generation_id FROM index_state WHERE singleton=1', params: [] },
  ])
  if (pointerRows[0]?.active_generation_id !== id) {
    throw codedError('active generation compare-and-swap failed', 'INDEX_CAS_FAILED')
  }
}

export async function getActiveGeneration(catalog: Catalog): Promise<IndexGeneration | null> {
  const [rows = []] = await catalog.transact([{
    sql: `SELECT g.body,g.status FROM index_state s
      JOIN index_generations g ON g.id=s.active_generation_id
      WHERE s.singleton=1 AND g.status='active'`,
    params: [],
  }])
  return rows[0] === undefined ? null : parseGenerationRow(rows[0])
}

export async function getGeneration(catalog: Catalog, id: string): Promise<IndexGeneration | null> {
  const [rows = []] = await catalog.transact([{
    sql: 'SELECT body,status FROM index_generations WHERE id=?',
    params: [id],
  }])
  return rows[0] === undefined ? null : parseGenerationRow(rows[0])
}

/** Pin an active or retired generation to a run. Repeated calls are idempotent. */
export async function pinGeneration(catalog: Catalog, runId: string, generationId: string): Promise<void> {
  if (typeof runId !== 'string' || runId.trim() === '') throw new TypeError('runId must be a non-empty string')
  if (typeof generationId !== 'string' || generationId.trim() === '') {
    throw new TypeError('generationId must be a non-empty string')
  }
  const [, rows = []] = await catalog.transact([
    {
      sql: `INSERT OR IGNORE INTO generation_pins(run_id,generation_id,created_at)
        SELECT ?,id,? FROM index_generations WHERE id=? AND status IN ('active','retired')`,
      params: [runId, new Date().toISOString(), generationId],
    },
    {
      sql: `SELECT p.run_id FROM generation_pins p
        JOIN index_generations g ON g.id=p.generation_id
        WHERE p.run_id=? AND p.generation_id=? AND g.status IN ('active','retired')`,
      params: [runId, generationId],
    },
  ])
  if (rows.length === 0) {
    throw codedError('generation cannot be pinned until it is active or retired', 'INDEX_GENERATION_NOT_PINNABLE')
  }
}

export async function loadGenerationManifest(root: string, id: string): Promise<GenerationManifest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(generationDirectory(root, id), 'manifest.json'), 'utf8'))
  } catch (error) {
    throw codedError(`index manifest is unavailable: ${errorMessage(error)}`, 'INDEX_MANIFEST_UNAVAILABLE')
  }
  const manifest = parsed as GenerationManifest
  assertManifest(manifest, id)
  return manifest
}

export function generationDirectory(root: string, id: string): string {
  return join(root, 'indexes', 'generations', id)
}

function stagingGenerationDirectory(root: string, id: string): string {
  return join(root, 'indexes', 'staging', id)
}

function makeManifest(records: CorpusRecords): GenerationManifest {
  const spans = [...records.spans].sort((left, right) => left.id.localeCompare(right.id))
  const configHash = hashJson(INDEX_CONFIG)
  const partitionScopes = validatePartitionScopes(spans)
  const documents = [...records.documents.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((document): ManifestDocument => {
      const documentSpans = spans.filter(span => span.documentId === document.id)
      const processing = {
        rawHash: document.rawHash,
        configHash,
        chunkerFingerprint: CHUNKER_FINGERPRINT,
        spans: documentSpans.map(span => ({
          id: span.id,
          parserFingerprint: span.parserFingerprint,
          contentHash: span.contentHash,
          recordHash: hashJson(span),
        })),
      }
      return {
        id: document.id,
        workId: document.workId,
        rawHash: document.rawHash,
        mediaType: document.mediaType,
        parserFingerprints: [...new Set(documentSpans.map(span => span.parserFingerprint))].sort(),
        spanIds: documentSpans.map(span => span.id),
        fingerprint: hashJson(processing),
      }
    })
  const manifestSpans: ManifestSpan[] = spans.map(span => ({
    id: span.id,
    documentId: span.documentId,
    workId: span.workId,
    partitionId: span.visibility.partitionId,
    parserFingerprint: span.parserFingerprint,
    contentHash: span.contentHash,
    recordHash: hashJson(span),
    lexicalHash: hashJson(lexicalRecord(span, records.works.get(span.workId)!)),
  }))
  const corpus = {
    documents,
    spans: manifestSpans,
    partitionScopes: [...partitionScopes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([partitionId, scope]) => ({ partitionId, scope })),
  }
  const corpusHash = hashJson(corpus)
  const partitionFiles = corpus.partitionScopes.map(({ partitionId }) => ({
    partitionId,
    file: `${sha256(`partition:${partitionId}`)}.sqlite`,
  }))
  const manifestHash = hashJson({ schema: MANIFEST_SCHEMA, config: INDEX_CONFIG, corpus, partitionFiles })
  const generationId = `gen_${manifestHash}`
  return {
    schema: MANIFEST_SCHEMA,
    generationId,
    manifestHash,
    configHash,
    corpusHash,
    config: INDEX_CONFIG,
    corpus,
    partitionFiles,
  }
}

function validatePartitionScopes(spans: SourceSpan[]): Map<string, VisibilityScope> {
  const scopes = new Map<string, VisibilityScope>()
  for (const span of spans) {
    const scope = visibilityScope(span.visibility)
    const prior = scopes.get(span.visibility.partitionId)
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(scope)) {
      throw codedError(
        `partition ${span.visibility.partitionId} contains inconsistent visibility scopes`,
        'INDEX_PARTITION_SCOPE_CONFLICT',
      )
    }
    scopes.set(span.visibility.partitionId, scope)
  }
  return scopes
}

function visibilityScope(visibility: Visibility): VisibilityScope {
  return {
    projectId: visibility.projectId,
    runId: visibility.runId ?? null,
    split: visibility.split ?? null,
    roles: [...visibility.roles].sort(),
    policyHash: visibility.policyHash,
  }
}

async function loadRegisteredCorpus(catalog: Catalog, inputSpans: SourceSpan[]): Promise<CorpusRecords> {
  const spans = inputSpans.map(span => assertSourceSpan(span))
  const spanRows = await catalog.transact(spans.map(span => ({
    sql: 'SELECT body FROM spans WHERE id=?',
    params: [span.id],
  })))
  spans.forEach((span, index) => {
    const body = spanRows[index]?.[0]?.body
    if (typeof body !== 'string') throw codedError(`span is not registered: ${span.id}`, 'INDEX_SPAN_NOT_REGISTERED')
    const stored = assertSourceSpan(JSON.parse(body))
    if (canonicalJson(stored) !== canonicalJson(span)) {
      throw codedError(`registered span differs from build input: ${span.id}`, 'INDEX_SPAN_MISMATCH')
    }
  })

  const documentIds = [...new Set(spans.map(span => span.documentId))].sort()
  const documentRows = await catalog.transact(documentIds.map(id => ({
    sql: 'SELECT raw_hash,body FROM documents WHERE id=?',
    params: [id],
  })))
  const documents = new Map<string, DocumentVersion>()
  documentIds.forEach((id, index) => {
    const row = documentRows[index]?.[0]
    if (typeof row?.body !== 'string') throw codedError(`document is not registered: ${id}`, 'INDEX_DOCUMENT_NOT_REGISTERED')
    const document = assertDocumentVersion(JSON.parse(row.body))
    if (row.raw_hash !== document.rawHash) throw codedError(`document raw hash mismatch: ${id}`, 'INDEX_DOCUMENT_MISMATCH')
    documents.set(id, document)
  })

  for (const span of spans) {
    const document = documents.get(span.documentId)!
    if (span.workId !== document.workId || canonicalJson(span.visibility) !== canonicalJson(document.visibility)) {
      throw codedError(`span provenance differs from its document: ${span.id}`, 'INDEX_SPAN_PROVENANCE_MISMATCH')
    }
    if (span.locator.sourceHash !== document.rawHash) {
      throw codedError(`span locator source differs from its document: ${span.id}`, 'INDEX_SPAN_SOURCE_MISMATCH')
    }
    if (span.contentHash !== sha256(span.evidenceText)) {
      throw codedError(`span content hash differs from its evidence text: ${span.id}`, 'INDEX_SPAN_CONTENT_MISMATCH')
    }
    if (span.sourceKind !== document.sourceKind) {
      throw codedError(`span source kind differs from its document: ${span.id}`, 'INDEX_SPAN_PROVENANCE_MISMATCH')
    }
  }

  const workIds = [...new Set([...documents.values()].map(document => document.workId))].sort()
  const workRows = await catalog.transact(workIds.map(id => ({
    sql: 'SELECT body FROM works WHERE id=?',
    params: [id],
  })))
  const works = new Map<string, Work>()
  workIds.forEach((id, index) => {
    const body = workRows[index]?.[0]?.body
    if (typeof body !== 'string') throw codedError(`work is not registered: ${id}`, 'INDEX_WORK_NOT_REGISTERED')
    works.set(id, assertWork(JSON.parse(body)))
  })
  return { documents, works, spans }
}

async function registerBuilding(
  catalog: Catalog,
  generation: IndexGeneration,
  prior: IndexGeneration | null,
): Promise<void> {
  if (prior !== null &&
    (prior.manifestHash !== generation.manifestHash || prior.corpusHash !== generation.corpusHash || prior.configHash !== generation.configHash)) {
    throw codedError('generation ID collides with different manifest data', 'INDEX_GENERATION_CONFLICT')
  }
  if (prior === null) {
    await catalog.transact([{
      sql: `INSERT INTO index_generations(id,manifest_hash,corpus_hash,config_hash,status,body)
        VALUES(?,?,?,?,?,?)`,
      params: [generation.id, generation.manifestHash, generation.corpusHash, generation.configHash, generation.status, JSON.stringify(generation)],
    }])
  } else if (prior.status === 'failed') {
    await catalog.transact([{
      sql: `UPDATE index_generations
        SET status='building',body=json_set(body,'$.status','building')
        WHERE id=? AND status='failed'`,
      params: [generation.id],
    }])
  }
}

async function saveBuilderResult(catalog: Catalog, generation: IndexGeneration): Promise<void> {
  await catalog.transact([{
    sql: `UPDATE index_generations SET manifest_hash=?,corpus_hash=?,config_hash=?,status=?,body=?
      WHERE id=? AND status IN ('building','failed')`,
    params: [
      generation.manifestHash,
      generation.corpusHash,
      generation.configHash,
      generation.status,
      JSON.stringify(generation),
      generation.id,
    ],
  }])
}

async function markBuilderFailed(catalog: Catalog, generationId: string): Promise<void> {
  await catalog.transact([{
    sql: `UPDATE index_generations
      SET status='failed',body=json_set(body,'$.status','failed')
      WHERE id=? AND status='building'`,
    params: [generationId],
  }])
}

async function ensureBuildIdentity(directory: string, manifest: GenerationManifest): Promise<void> {
  const path = join(directory, 'build.json')
  const identity = canonicalJson({
    generationId: manifest.generationId,
    manifestHash: manifest.manifestHash,
    configHash: manifest.configHash,
    corpusHash: manifest.corpusHash,
  })
  try {
    if ((await readFile(path, 'utf8')).trim() !== identity) {
      throw codedError('staging directory belongs to a different build', 'INDEX_STAGING_CONFLICT')
    }
  } catch (error) {
    if (!isMissing(error)) throw error
    await writeFile(path, `${identity}\n`, { encoding: 'utf8', flag: 'wx' })
  }
}

async function buildPartitionIndexes(
  directory: string,
  manifest: GenerationManifest,
  records: CorpusRecords,
): Promise<void> {
  const databases = new Map<string, DatabaseSync>()
  try {
    for (const partition of manifest.partitionFiles) {
      const database = new DatabaseSync(join(directory, partition.file), { timeout: 1000 })
      database.exec(`
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS indexed_documents (
          document_id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          span_count INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS span_records (
          span_id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          partition_id TEXT NOT NULL,
          body TEXT NOT NULL CHECK (json_valid(body)),
          body_hash TEXT NOT NULL
        ) STRICT;
        CREATE VIRTUAL TABLE IF NOT EXISTS spans_fts USING fts5(
          span_id UNINDEXED,
          document_id UNINDEXED,
          work_id UNINDEXED,
          title,
          section,
          body,
          tokenize='unicode61'
        );
      `)
      databases.set(partition.partitionId, database)
    }

    const completed = new Set<string>()
    for (const manifestDocument of manifest.corpus.documents) {
      const documentSpans = records.spans.filter(span => span.documentId === manifestDocument.id)
      const byPartition = groupBy(documentSpans, span => span.visibility.partitionId)
      let reusable = true
      for (const [partitionId, partitionSpans] of byPartition) {
        const row = databases.get(partitionId)!
          .prepare('SELECT fingerprint,span_count FROM indexed_documents WHERE document_id=?')
          .get(manifestDocument.id) as { fingerprint?: unknown; span_count?: unknown } | undefined
        if (row?.fingerprint !== manifestDocument.fingerprint || row.span_count !== partitionSpans.length) {
          reusable = false
          break
        }
      }
      if (!reusable) {
        for (const [partitionId, partitionSpans] of byPartition) {
          writeDocumentPartition(
            databases.get(partitionId)!,
            records.works.get(manifestDocument.workId)!,
            manifestDocument,
            partitionSpans,
          )
        }
      }
      completed.add(manifestDocument.id)
      await writeCheckpoint(directory, manifest, completed)
    }
  } finally {
    for (const database of databases.values()) database.close()
  }
}

function writeDocumentPartition(
  database: DatabaseSync,
  work: Work,
  document: ManifestDocument,
  spans: SourceSpan[],
): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare('DELETE FROM spans_fts WHERE document_id=?').run(document.id)
    database.prepare('DELETE FROM span_records WHERE document_id=?').run(document.id)
    database.prepare('DELETE FROM indexed_documents WHERE document_id=?').run(document.id)
    const insertRecord = database.prepare(`INSERT INTO span_records
      (span_id,document_id,work_id,partition_id,body,body_hash) VALUES(?,?,?,?,?,?)`)
    const insertFts = database.prepare(`INSERT INTO spans_fts
      (span_id,document_id,work_id,title,section,body) VALUES(?,?,?,?,?,?)`)
    for (const span of spans) {
      const recordJson = canonicalJson(span)
      const lexical = lexicalRecord(span, work)
      insertRecord.run(span.id, span.documentId, span.workId, span.visibility.partitionId, recordJson, sha256(recordJson))
      insertFts.run(
        lexical.spanId,
        lexical.documentId,
        lexical.workId,
        lexical.title,
        lexical.section,
        lexical.body,
      )
    }
    database.prepare('INSERT INTO indexed_documents(document_id,fingerprint,span_count) VALUES(?,?,?)')
      .run(document.id, document.fingerprint, spans.length)
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the write failure.
    }
    throw error
  }
}

async function writeCheckpoint(
  directory: string,
  manifest: GenerationManifest,
  completed: Set<string>,
): Promise<void> {
  const target = join(directory, 'checkpoint.json')
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const body = {
    generationId: manifest.generationId,
    manifestHash: manifest.manifestHash,
    configHash: manifest.configHash,
    completedDocumentIds: [...completed].sort(),
  }
  try {
    await writeFile(temporary, `${canonicalJson(body)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function validateStaging(
  directory: string,
  manifest: GenerationManifest,
  performFtsIntegrityCheck: boolean,
): Promise<void> {
  const expectedByPartition = groupBy(manifest.corpus.spans, span => span.partitionId)
  let total = 0
  for (const partition of manifest.partitionFiles) {
    const database = new DatabaseSync(join(directory, partition.file), { readOnly: !performFtsIntegrityCheck })
    try {
      const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined
      if (integrity?.integrity_check !== 'ok') throw codedError('partition index failed SQLite integrity check', 'INDEX_INTEGRITY_FAILED')
      if (performFtsIntegrityCheck) database.exec("INSERT INTO spans_fts(spans_fts) VALUES('integrity-check')")
      const rows = database.prepare('SELECT span_id,body_hash FROM span_records ORDER BY span_id').all() as {
        span_id: string; body_hash: string
      }[]
      const ftsRows = database.prepare(`SELECT span_id,document_id,work_id,title,section,body
        FROM spans_fts ORDER BY span_id`).all() as {
          span_id: string; document_id: string; work_id: string; title: string; section: string; body: string
        }[]
      const expected = expectedByPartition.get(partition.partitionId) ?? []
      if (rows.length !== expected.length || ftsRows.length !== expected.length) {
        throw codedError('partition index span count mismatch', 'INDEX_INTEGRITY_FAILED')
      }
      rows.forEach((row, index) => {
        const wanted = expected[index]
        const fts = ftsRows[index]
        const indexedLexical = fts === undefined ? null : {
          spanId: fts.span_id,
          documentId: fts.document_id,
          workId: fts.work_id,
          title: fts.title,
          section: fts.section,
          body: fts.body,
        }
        if (wanted === undefined || row.span_id !== wanted.id || row.body_hash !== wanted.recordHash ||
          fts?.span_id !== wanted.id || hashJson(indexedLexical) !== wanted.lexicalHash) {
          throw codedError('partition index span fingerprint mismatch', 'INDEX_INTEGRITY_FAILED')
        }
      })
      total += rows.length
    } finally {
      database.close()
    }
  }
  if (total !== manifest.corpus.spans.length) {
    throw codedError('generation span count mismatch', 'INDEX_INTEGRITY_FAILED')
  }
}

async function validatePublishedDirectory(directory: string, expected: GenerationManifest): Promise<void> {
  const parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as GenerationManifest
  assertManifest(parsed, expected.generationId)
  if (canonicalJson(parsed) !== canonicalJson(expected)) {
    throw codedError('published generation manifest differs from requested build', 'INDEX_MANIFEST_MISMATCH')
  }
  await validateStaging(directory, expected, false)
}

function assertManifest(manifest: GenerationManifest, id: string): void {
  if (manifest?.schema !== MANIFEST_SCHEMA || manifest.generationId !== id) {
    throw codedError('index manifest has an invalid schema or generation ID', 'INDEX_MANIFEST_INVALID')
  }
  const descriptor = {
    schema: manifest.schema,
    config: manifest.config,
    corpus: manifest.corpus,
    partitionFiles: manifest.partitionFiles,
  }
  if (hashJson(manifest.config) !== manifest.configHash ||
    hashJson(manifest.corpus) !== manifest.corpusHash ||
    hashJson(descriptor) !== manifest.manifestHash ||
    `gen_${manifest.manifestHash}` !== manifest.generationId) {
    throw codedError('index manifest fingerprint is invalid', 'INDEX_MANIFEST_INVALID')
  }
}

function parseGenerationRow(row: Record<string, unknown>): IndexGeneration {
  if (typeof row.body !== 'string') throw codedError('generation catalog row has no body', 'INDEX_GENERATION_INVALID')
  const generation = JSON.parse(row.body) as IndexGeneration
  generation.status = row.status as IndexGeneration['status']
  return generation
}

function validateBuildOptions(spans: SourceSpan[], options: BuildOptions): void {
  if (!Array.isArray(spans)) throw new TypeError('spans must be an array')
  if (!Number.isSafeInteger(options.maxSpans) || options.maxSpans < 1) {
    throw new RangeError('maxSpans must be a positive integer')
  }
  if (spans.length > options.maxSpans) throw codedError('generation exceeds maxSpans', 'INDEX_MAX_SPANS_EXCEEDED')
  if (spans.length === 0) throw codedError('generation requires at least one span', 'INDEX_EMPTY_CORPUS')
  if (options.expectedActiveId !== null &&
    (typeof options.expectedActiveId !== 'string' || options.expectedActiveId.trim() === '')) {
    throw new TypeError('expectedActiveId must be a non-empty string or null')
  }
  if (new Set(spans.map(span => span.id)).size !== spans.length) {
    throw codedError('generation contains duplicate span IDs', 'INDEX_DUPLICATE_SPAN')
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const groupKey = key(value)
    const group = groups.get(groupKey) ?? []
    group.push(value)
    groups.set(groupKey, group)
  }
  return groups
}

function lexicalRecord(span: SourceSpan, work: Work): {
  spanId: string; documentId: string; workId: string; title: string; section: string; body: string
} {
  return {
    spanId: span.id,
    documentId: span.documentId,
    workId: span.workId,
    title: tokenize(work.title).join(' '),
    section: tokenize(span.sectionPath.join(' ')).join(' '),
    body: tokenize(span.retrievalText).join(' '),
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

function hashJson(value: unknown): Hash {
  return sha256(canonicalJson(value))
}

function sha256(value: string | Uint8Array): Hash {
  return createHash('sha256').update(value).digest('hex')
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'ENOENT'
}
