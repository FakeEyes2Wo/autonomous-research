import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, realpath, rename, unlink, link, open, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { ResearchSnapshot, SourceRef, VersionedRecord } from './contracts.js'
import { freezeRecord, hashBytes, sealRecord, verifyRecord } from './records.js'
import { assessEvidence } from './assessment.js'

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const contained = (root: string, target: string) => target === root || target.startsWith(root + sep)
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(id)) throw new Error('invalid research identity')
  return id
}

/** File-backed canonical history; CURRENT is the only commit point. One writer may advance a run at a time. */
export class ResearchStore {
  readonly runDir: string
  constructor(runDir: string) { this.runDir = resolve(runDir) }

  private async path(...parts: string[]): Promise<string> {
    const target = resolve(this.runDir, ...parts)
    if (!contained(this.runDir, target)) throw new Error('research path escapes run containment')
    await mkdir(this.runDir, { recursive: true })
    const root = await realpath(this.runDir)
    let existing = target
    while (true) {
      try {
        const actual = await realpath(existing)
        if (!contained(root, actual)) throw new Error('research realpath escapes run containment')
        break
      } catch (error) {
        if (!missing(error)) throw error
        const parent = dirname(existing)
        if (parent === existing) throw error
        existing = parent
      }
    }
    return target
  }

  private async immutable(relativePath: string, bytes: string | Uint8Array): Promise<void> {
    const file = await this.path(relativePath)
    await mkdir(dirname(file), { recursive: true })
    await this.path(relativePath)
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, bytes, { flag: 'wx' })
    try {
      try { await link(tmp, file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (hashBytes(await readFile(file)) !== hashBytes(bytes)) throw new Error(`immutable research artifact conflict: ${relativePath}`)
      }
    } finally { await unlink(tmp) }
  }

  async captureSource(relativePath: string, sourceId = relativePath): Promise<SourceRef> {
    const bytes = await readFile(await this.path(relativePath))
    return this.captureBytes(bytes, sourceId)
  }

  async captureBytes(bytes: Uint8Array | string, sourceId: string): Promise<SourceRef> {
    const hash = hashBytes(bytes)
    const path = `research/sources/${hash}`
    await this.immutable(path, bytes)
    return freezeRecord({ id: sourceId, path, hash })
  }

  private records(snapshot: ResearchSnapshot): VersionedRecord[] {
    return [snapshot, ...snapshot.claims, ...snapshot.hypotheses, snapshot.protocol, ...snapshot.evidence, ...(snapshot.candidate_batches ?? []), ...(snapshot.assessment ? [snapshot.assessment, ...snapshot.assessment.failures] : []), ...(snapshot.decision ? [snapshot.decision] : [])]
  }

  private async history(snapshot: ResearchSnapshot): Promise<ResearchSnapshot[]> {
    const snapshots = [snapshot]
    const visited = new Set([snapshot.id])
    let id = snapshot.parent_snapshot_id
    while (id) {
      if (visited.has(id)) throw new Error('cyclic research snapshot lineage')
      visited.add(id)
      const ancestor = JSON.parse(await readFile(await this.path('research', 'snapshots', safeId(id), 'manifest.json'), 'utf8')) as ResearchSnapshot
      if (ancestor.id !== id) throw new Error('ancestor snapshot identity mismatch')
      for (const record of this.records(ancestor)) verifyRecord(record)
      snapshots.push(ancestor)
      id = ancestor.parent_snapshot_id
    }
    return snapshots
  }

  private async validate(snapshot: ResearchSnapshot): Promise<void> {
    if (snapshot.schema !== 'autoresearch/research-snapshot/v1' || !Array.isArray(snapshot.claims) || !Array.isArray(snapshot.hypotheses) || !Array.isArray(snapshot.evidence) || !snapshot.budget) throw new Error('malformed research snapshot')
    for (const record of this.records(snapshot)) verifyRecord(record)
    const history = await this.history(snapshot)
    const records = history.flatMap((state) => this.records(state))
    for (const batch of snapshot.candidate_batches ?? []) {
      if (batch.snapshotHash !== batch.selection.snapshotHash || batch.snapshotHash !== batch.selectionInput.snapshotHash ||
        !history.some(state => state.content_hash === batch.snapshotHash)) throw new Error('candidate selection snapshot mismatch')
      if (batch.entries.length !== batch.selection.candidateIds.length || batch.entries.some(entry => !batch.selection.candidateIds.includes(entry.candidate.id))) throw new Error('candidate selection set mismatch')
    }
    const historicalHashes = new Map<string, string>()
    for (const record of records) {
      const key = `${record.id}:${record.version}`
      const previous = historicalHashes.get(key)
      if (previous && previous !== record.content_hash) throw new Error(`immutable historical record identity conflict: ${key}`)
      historicalHashes.set(key, record.content_hash)
    }
    const identities = new Set<string>()
    for (const record of this.records(snapshot)) {
      const key = `${record.id}:${record.version}`
      if (identities.has(key)) throw new Error(`duplicate research record lineage: ${key}`)
      identities.add(key)
    }
    if (!snapshot.claims.some((r) => r.id === snapshot.active_claim.id && r.version === snapshot.active_claim.version) || !snapshot.hypotheses.some((r) => r.id === snapshot.active_hypothesis.id && r.version === snapshot.active_hypothesis.version)) throw new Error('missing active research lineage')
    const sources = [...this.records(snapshot).flatMap((r) => r.source_refs), ...snapshot.evidence.flatMap((r) => [...r.artifacts, ...(r.analysis ? [r.analysis] : [])])]
    for (const source of sources) {
      if (!source.path) {
        if (!source.hash) continue // Legacy references are explicitly unknown.
        const matches = records.filter((record) => record.id === source.id)
        if (!matches.some((record) => record.content_hash === source.hash)) throw new Error(`record reference source hash mismatch: ${source.id}`)
        continue
      }
      if (!source.hash) continue // Unknown provenance cannot be admitted by assessEvidence.
      const bytes = await readFile(await this.path(source.path))
      if (hashBytes(bytes) !== source.hash) throw new Error(`source hash mismatch: ${source.id}`)
    }
    for (const row of snapshot.evidence) {
      if (snapshot.assessment?.admissible_evidence_ids.includes(row.id) && (!row.artifacts.length || row.artifacts.some((ref) => !ref.path || !ref.hash) || !row.analysis?.path || !row.analysis.hash)) throw new Error(`admissible evidence lacks verifiable provenance: ${row.id}`)
    }
    for (const claim of snapshot.claims) {
      if (claim.status !== 'supported' && claim.status !== 'refuted') continue
      const ids = claim.status === 'supported' ? claim.supporting_evidence_ids : claim.opposing_evidence_ids
      const ancestors = new Set<string>()
      const pending = [{ id: claim.id, version: claim.version }]
      while (pending.length) {
        const ref = pending.pop()!
        const key = `${ref.id}:${ref.version}`
        if (ancestors.has(key)) continue
        ancestors.add(key)
        const parent = snapshot.claims.find((row) => row.id === ref.id && row.version === ref.version)
        if (parent) pending.push(...parent.parents)
      }
      const justified = history.some((state) => {
        const assessment = state.assessment
        if (!assessment || assessment.claim_status !== claim.status || !ancestors.has(`${assessment.claim.id}:${assessment.claim.version}`)) return false
        const target = snapshot.claims.find((row) => row.id === assessment.claim.id && row.version === assessment.claim.version)
        const protocol = history.find((entry) => entry.protocol.content_hash === assessment.protocol_hash)?.protocol
        const hypothesis = protocol && snapshot.hypotheses.find((row) => row.id === protocol.hypothesis.id && row.version === protocol.hypothesis.version)
        if (!target || target.statement !== claim.statement || target.scope !== claim.scope || !protocol || !hypothesis) return false
        const rows = assessment.source_refs.map((ref) => snapshot.evidence.find((row) => row.id === ref.id && row.content_hash === ref.hash))
        if (rows.some((row) => !row)) return false
        const verified = assessEvidence({ claim: target, hypothesis, protocol, evidence: rows.filter((row) => !!row), discoveryEvidence: snapshot.evidence, discoverySourceRefs: hypothesis.source_refs, createdAt: assessment.created_at })
        const allowed = claim.status === 'supported' ? verified.supporting_evidence_ids : verified.opposing_evidence_ids
        const declared = claim.status === 'supported' ? assessment.supporting_evidence_ids : assessment.opposing_evidence_ids
        return verified.claim_status === claim.status && ids.length > 0 && ids.every((id) => allowed.includes(id) && declared.includes(id) && assessment.admissible_evidence_ids.includes(id))
      })
      if (!justified) throw new Error(`scientific claim lacks matching assessment, protocol and evidence: ${claim.id}`)
    }
  }

  async loadSnapshot(id: string): Promise<ResearchSnapshot> {
    const file = await this.path('research', 'snapshots', safeId(id), 'manifest.json')
    const snapshot = JSON.parse(await readFile(file, 'utf8')) as ResearchSnapshot
    if (snapshot.id !== id) throw new Error('snapshot identity mismatch')
    await this.validate(snapshot)
    return freezeRecord(snapshot)
  }

  async loadCurrent(): Promise<ResearchSnapshot | undefined> {
    let text: string
    try { text = await readFile(await this.path('CURRENT.json'), 'utf8') }
    catch (error) { if (missing(error)) return undefined; throw error }
    const pointer = JSON.parse(text) as { snapshot_id: string; content_hash: string }
    if (!pointer.snapshot_id || !pointer.content_hash) throw new Error('corrupt research CURRENT pointer')
    const snapshot = await this.loadSnapshot(pointer.snapshot_id)
    if (snapshot.content_hash !== pointer.content_hash) throw new Error('CURRENT snapshot hash mismatch')
    return snapshot
  }

  private async lock(): Promise<() => Promise<void>> {
    const file = await this.path('research', 'commit.lock')
    await mkdir(dirname(file), { recursive: true })
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(String(process.pid))
      await handle.close()
      return () => unlink(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = Number(await readFile(file, 'utf8'))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('research writer lock malformed; explicit recovery required')
      try { process.kill(pid, 0) }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
          await unlink(file)
          return this.lock()
        }
      }
      throw new Error('research concurrent writer is active')
    }
  }

  async commit(snapshot: ResearchSnapshot, expectedHash?: string): Promise<ResearchSnapshot> {
    safeId(snapshot.id)
    const release = await this.lock()
    try {
      await this.validate(snapshot)
      const current = await this.loadCurrent()
      if (expectedHash !== undefined && current?.content_hash !== expectedHash) throw new Error('stale snapshot hash; rebuild selection inputs')
      let existing: ResearchSnapshot | undefined
      try { existing = await this.loadSnapshot(snapshot.id) }
      catch (error) { if (!missing(error)) throw error }
      if (existing && existing.content_hash !== snapshot.content_hash) throw new Error('immutable snapshot conflict')
      if (existing && current) {
        let ancestor: ResearchSnapshot | undefined = current
        while (ancestor) {
          if (ancestor.id === snapshot.id) return existing
          ancestor = ancestor.parent_snapshot_id ? await this.loadSnapshot(ancestor.parent_snapshot_id) : undefined
        }
      }
      if (snapshot.parent_snapshot_id !== current?.id) throw new Error('stale snapshot parent; refusing to overwrite lineage')
      if (current) {
        if (snapshot.version !== current.version + 1) throw new Error('snapshot version must advance once')
        for (const key of Object.keys(current.budget)) if (!Number.isFinite(snapshot.budget[key]) || snapshot.budget[key]! < current.budget[key]!) throw new Error('cumulative research budget cannot reset')
        for (const key of ['claims', 'hypotheses', 'evidence'] as const) {
          for (const old of current[key]) {
            const retained = snapshot[key].find((r) => r.id === old.id && r.version === old.version)
            if (!retained || retained.content_hash !== old.content_hash) throw new Error('historical research lineage cannot be overwritten or dropped')
          }
        }
        for (const old of current.candidate_batches ?? []) {
          if (!snapshot.candidate_batches?.some(batch => batch.id === old.id && batch.content_hash === old.content_hash)) throw new Error('historical candidate batches cannot be dropped')
        }
      }
      // A decision ID is globally stable within a run, even if callers change the snapshot ID.
      if (snapshot.decision) {
        const dir = await this.path('research', 'snapshots')
        let entries: string[] = []
        try { entries = await readdir(dir) } catch (error) { if (!missing(error)) throw error }
        for (const id of entries) {
          if (id === snapshot.id) continue
          let previous: ResearchSnapshot
          try { previous = await this.loadSnapshot(id) } catch (error) { if (missing(error)) continue; throw error }
          if (previous.decision?.id === snapshot.decision.id) throw new Error('decision id already committed to another immutable snapshot')
        }
      }
      if (!existing) await this.immutable(`research/snapshots/${snapshot.id}/manifest.json`, `${JSON.stringify(snapshot, null, 2)}\n`)
      const committed = await this.loadSnapshot(snapshot.id)
      const pointer = await this.path('CURRENT.json')
      const tmp = `${pointer}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify({ snapshot_id: committed.id, content_hash: committed.content_hash }))
      await rename(tmp, pointer)
      return committed
    } finally { await release() }
  }
}

export interface ImportedFailureReport extends VersionedRecord {
  source_run_id: string
  branch_id: string
  provenance: 'unknown'
  observation: string
  recommended_action: 'recover_and_validate_sources'
}

export async function importFailureReport(input: { sourceRunId: string; sourcePath: string; targetRunDir: string; branchId: string }): Promise<ImportedFailureReport> {
  const source = await realpath(input.sourcePath)
  const intended = resolve(input.targetRunDir)
  let existing = intended
  let target: string
  while (true) {
    try { target = resolve(await realpath(existing), relative(existing, intended)); break }
    catch (error) {
      if (!missing(error)) throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }
  if (contained(dirname(source), target) || contained(target, source)) throw new Error('report import requires a distinct target run outside source history')
  await mkdir(target, { recursive: true })
  const store = new ResearchStore(target)
  const bytes = await readFile(source)
  const ref = await store.captureBytes(bytes, `failure-report:${input.sourceRunId}`)
  const record: ImportedFailureReport = sealRecord({ id: `import-${ref.hash!.slice(0, 24)}`, version: 1, created_at: new Date().toISOString(), source_refs: [ref], source_run_id: input.sourceRunId, branch_id: input.branchId, provenance: 'unknown', observation: bytes.toString('utf8'), recommended_action: 'recover_and_validate_sources' })
  const metadata = JSON.stringify(record, null, 2)
  // Imports are artifacts, independent of terminal run state and the target's active research pointer.
  await store.captureBytes(metadata, record.id)
  return record
}
