import { createHash } from 'node:crypto'
import { assertWork, type AnalysisCard, type Catalog, type SqlStatement, type Work } from './contracts.js'
import { normalizeIdentity } from './identity.js'
import { putObject } from './objects.js'
import { openCatalog } from './catalog.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

function normalizedAuthors(authors: string[]): string[] {
  return authors.map(author => author.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US'))
}

function sameAuthors(left: string[], right: string[]): boolean {
  const a = normalizedAuthors(left)
  const b = normalizedAuthors(right)
  return a.length === b.length && a.every((author, index) => author === b[index])
}

interface AuthorConflictObservation {
  authors: string[]
  metadataSources: string[]
}

interface StoredWork extends Work {
  unresolvedConflicts?: { kind: 'authors'; observations: AuthorConflictObservation[] }[]
}

function addAuthorObservation(observations: AuthorConflictObservation[], authors: string[], metadataSources: string[]): void {
  const existing = observations.find(observation => sameAuthors(observation.authors, authors))
  if (existing === undefined) {
    observations.push({ authors: [...authors], metadataSources: [...new Set(metadataSources)] })
  } else {
    existing.metadataSources = [...new Set([...existing.metadataSources, ...metadataSources])]
  }
}

/** Only verified metadata participates in cross-record alias resolution. */
export async function registerWork(catalog: Catalog, value: Work): Promise<Work> {
  const work = assertWork(value)
  if (work.status === 'verified_metadata' && work.metadataSources.length === 0) throw new Error('METADATA_SOURCE_REQUIRED')
  for (let attempt = 0; attempt < 3; attempt++) {
    const lookups: SqlStatement[] = [{ sql: 'SELECT body FROM works WHERE id = ?', params: [work.id] }]
    if (work.status === 'verified_metadata') for (const alias of work.aliases) lookups.push({
      sql: 'SELECT works.body FROM aliases JOIN works ON works.id = aliases.work_id WHERE aliases.kind = ? AND aliases.value = ?',
      params: [alias.kind, alias.value],
    })
    const found = (await catalog.transact(lookups)).flat().map(row => assertWork(JSON.parse(String(row.body))) as StoredWork)
    const ids = [...new Set(found.map(item => item.id))]
    if (ids.length > 1) throw new Error('IDENTITY_CONFLICT: aliases refer to multiple works')
    const previous = found[0]
    if (previous && normalizeIdentity({ title: previous.title }).titleKey !== normalizeIdentity({ title: work.title }).titleKey) {
      throw new Error('IDENTITY_CONFLICT: matching identifier has different title; review version relationship')
    }
    const priorAuthorConflict = previous?.unresolvedConflicts?.find(conflict => conflict.kind === 'authors')
    const newAuthorConflict = previous?.status === 'verified_metadata' && work.status === 'verified_metadata' &&
      previous.authors !== null && work.authors !== null &&
      !sameAuthors(previous.authors, work.authors)
    const authorConflict = priorAuthorConflict !== undefined || newAuthorConflict
    const unresolvedConflicts = previous?.unresolvedConflicts?.map(conflict => ({
      kind: conflict.kind,
      observations: conflict.observations.map(observation => ({
        authors: [...observation.authors], metadataSources: [...observation.metadataSources],
      })),
    })) ?? []
    if (newAuthorConflict) {
      const observations: AuthorConflictObservation[] = []
      addAuthorObservation(observations, previous!.authors!, previous!.metadataSources)
      addAuthorObservation(observations, work.authors!, work.metadataSources)
      unresolvedConflicts.push({ kind: 'authors', observations })
    } else if (priorAuthorConflict !== undefined && work.status === 'verified_metadata' && work.authors !== null) {
      const conflict = unresolvedConflicts.find(item => item.kind === 'authors')!
      addAuthorObservation(conflict.observations, work.authors, work.metadataSources)
    }
    const merged: StoredWork = previous ? {
      ...previous,
      authors: authorConflict ? previous.authors
        : work.status === 'verified_metadata' && previous.status === 'candidate'
        ? work.authors
        : previous.authors ?? work.authors,
      status: authorConflict ? 'candidate' : previous.status === 'verified_metadata' ? previous.status : work.status,
      // Candidate aliases have no cross-record trust and must not be promoted with later verified metadata.
      aliases: authorConflict ? previous.aliases
        : previous.status === 'verified_metadata' && work.status === 'verified_metadata'
        ? [...new Map([...previous.aliases, ...work.aliases].map(a => [a.kind + ':' + a.value, a])).values()]
        : work.status === 'verified_metadata' ? work.aliases : previous.aliases,
      metadataSources: [...new Set([...previous.metadataSources, ...work.metadataSources])],
      ...(authorConflict ? { unresolvedConflicts } : {}),
    } : work
    const statements: SqlStatement[] = [{
      sql: 'INSERT INTO works(id, body) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET body = CASE WHEN works.body = ? THEN excluded.body ELSE NULL END',
      params: [merged.id, JSON.stringify(merged), previous ? JSON.stringify(previous) : null],
    }]
    if (work.status === 'verified_metadata' && !authorConflict) for (const alias of work.aliases) statements.push({
      sql: 'INSERT INTO aliases(kind, value, work_id) VALUES(?, ?, ?) ON CONFLICT(kind, value) DO UPDATE SET work_id = CASE WHEN aliases.work_id = excluded.work_id THEN aliases.work_id ELSE NULL END',
      params: [alias.kind, alias.value, merged.id],
    })
    try {
      await catalog.transact(statements)
      if (authorConflict && work.status === 'verified_metadata') {
        throw new Error('METADATA_CONFLICT: authors remain unresolved after NFKC, whitespace, and case normalization')
      }
      return merged
    } catch (error) {
      if (attempt === 2 || !/constraint|unique/i.test(String(error))) throw error
    }
  }
  throw new Error('IDENTITY_CONFLICT: concurrent alias registration')
}

export interface LegacyImportResult {
  imported: number; skipped: number; conflicts: string[]
  mappings: { originalId: string | null; workId: string }[]
}

interface SavedImport {
  rawHash: string
  runIds?: string[]
  runId?: string
  mappings: { originalId: string | null; workId: string }[]
  conflicts: string[]
}

async function associateImportRun(catalog: Catalog, inputHash: string, runId: string): Promise<SavedImport | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [rows = []] = await catalog.transact([{
      sql: 'SELECT body FROM imports WHERE input_hash = ?', params: [inputHash],
    }])
    if (rows.length === 0) return null
    const priorBody = String(rows[0]!.body)
    const saved = JSON.parse(priorBody) as SavedImport
    const runIds = [...new Set([...(saved.runIds ?? (saved.runId === undefined ? [] : [saved.runId])), runId])]
    if (saved.runIds !== undefined && runIds.length === saved.runIds.length) return saved
    const next: SavedImport = { rawHash: saved.rawHash, runIds, mappings: saved.mappings, conflicts: saved.conflicts }
    const [updated = []] = await catalog.transact([{
      sql: 'UPDATE imports SET body = ? WHERE input_hash = ? AND body = ? RETURNING body',
      params: [JSON.stringify(next), inputHash, priorBody],
    }])
    if (updated.length > 0) return next
  }
  throw new Error('IMPORT_CONFLICT: concurrent run provenance update')
}

export async function importLegacy(catalog: Catalog, root: string,
  input: { bytes: Uint8Array; runId: string }): Promise<LegacyImportResult> {
  let data: unknown
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)) } catch { throw new Error('INVALID_LEGACY: expected UTF-8 JSON array') }
  if (!Array.isArray(data) || data.length > 10000 || !input.runId?.trim()) throw new Error('INVALID_LEGACY: expected bounded paper array and run ID')
  if (data.some(item => !item || typeof item !== 'object' || typeof item.title !== 'string' || !item.title.trim())) throw new Error('INVALID_LEGACY: every paper needs a title')
  const rawHash = await putObject(root, input.bytes)
  const importHash = rawHash
  const saved = await associateImportRun(catalog, importHash, input.runId)
  if (saved !== null) {
    return { imported: 0, skipped: data.length, conflicts: saved.conflicts, mappings: saved.mappings }
  }
  const conflicts: string[] = []
  const statements: SqlStatement[] = []
  const mappings: { originalId: string | null; workId: string }[] = []
  for (const [index, item] of data.entries()) {
    const id = `legacy_${digest(`${importHash}:${index}`).slice(0, 24)}`
    let aliases: Work['aliases'] = []
    try { aliases = normalizeIdentity({ title: item.title,
      ...(typeof item.doi === 'string' ? { doi: item.doi } : {}),
      ...(typeof item.arxivId === 'string' ? { arxivId: item.arxivId } : {}),
      ...(typeof item.url === 'string' ? { url: item.url } : {}),
    }).aliases } catch (error) { conflicts.push(`${index}: ${String(error)}`) }
    const work: Work = { id, title: item.title.trim(), authors: null, aliases, metadataSources: [rawHash], status: 'candidate' }
    const card: AnalysisCard = { id: `card_${id}`, workId: id, revision: 1, origin: 'agent_analysis',
      text: JSON.stringify(item), spanIds: [], verification: 'legacy_unverified', coverage: 'metadata', generator: null }
    statements.push({ sql: 'INSERT INTO works(id,body) VALUES(?,?)', params: [id, JSON.stringify(work)] },
      { sql: 'INSERT INTO cards(id,work_id,revision,body) VALUES(?,?,?,?)', params: [card.id, id, 1, JSON.stringify(card)] })
    mappings.push({ originalId: typeof item.id === 'string' ? item.id : null, workId: id })
  }
  statements.push({ sql: 'INSERT INTO imports(input_hash,body) VALUES(?,?)', params: [importHash, JSON.stringify({ runIds: [input.runId], rawHash, mappings, conflicts })] })
  try { await catalog.transact(statements) } catch (error) {
    const concurrent = await associateImportRun(catalog, importHash, input.runId)
    if (concurrent !== null) {
      return { imported: 0, skipped: data.length, conflicts: concurrent.conflicts, mappings: concurrent.mappings }
    }
    throw error
  }
  return { imported: data.length, skipped: 0, conflicts, mappings }
}

export async function importPaperRecords<T extends { id: string; title: string }>(root: string, runId: string, records: T[]): Promise<{
  records: (T & { workId: string; sourceStatus: 'legacy_unverified' })[]
  result: LegacyImportResult
}> {
  const catalog = await openCatalog(root)
  try {
    const result = await importLegacy(catalog, root, { bytes: new TextEncoder().encode(JSON.stringify(records)), runId })
    return { records: records.map((record, index) => ({ ...record, workId: result.mappings[index]!.workId, sourceStatus: 'legacy_unverified' })), result }
  } finally { await catalog.close() }
}
