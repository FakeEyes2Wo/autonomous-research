import { HYPOTHESIS_POOL_FILE } from './utils.js'
import type { ResearchTree } from './research-tree.js'
import type { ResearchSnapshot, VersionRef } from '../research/contracts.js'
import { atomicWriteJson, nowIso, readOptionalText, safeResolve } from './utils.js'

export const POOL_STATUSES = ['QUEUED', 'TESTING', 'SUPPORTED', 'REFUTED', 'INCONCLUSIVE', 'REJECTED'] as const
export type PoolStatus = typeof POOL_STATUSES[number]

export interface PoolEntry {
  id: string
  statement: string
  status: PoolStatus
  origin_candidate_id?: string
  evidence_ids: string[]
  created_at: string
  updated_at: string
  provenance?: 'unknown' | 'canonical'
  version?: number
  content_hash?: string
  snapshot_id?: string
  snapshot_hash?: string
  parents?: VersionRef[]
  opposing_evidence_ids?: string[]
}

export class HypothesisPool {
  entries: PoolEntry[]

  constructor(public readonly file: string, entries: PoolEntry[] = []) {
    this.entries = entries
  }

  static async load(runDir: string): Promise<HypothesisPool> {
    const file = safeResolve(runDir, HYPOTHESIS_POOL_FILE)
    const text = await readOptionalText(file)
    if (text === undefined) return new HypothesisPool(file)
    const data = JSON.parse(text) as { entries: PoolEntry[] }
    if (!Array.isArray(data.entries)) throw new Error('malformed hypothesis pool entries')
    return new HypothesisPool(file, data.entries.map((entry) => ({ ...entry, provenance: entry.provenance ?? 'unknown' })))
  }

  async save(): Promise<void> {
    await atomicWriteJson(this.file, { schema: 'autoresearch/hypothesis-pool/v1', entries: this.entries })
  }

  upsert(entry: Omit<PoolEntry, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string }): PoolEntry {
    const existing = this.entries.find((e) => e.id === entry.id)
    const now = nowIso()
    if (existing) {
      Object.assign(existing, entry, { updated_at: now })
      return existing
    }
    const created: PoolEntry = { ...entry, created_at: entry.created_at ?? now, updated_at: now }
    this.entries.push(created)
    return created
  }

  get(id: string): PoolEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  query(status?: PoolStatus): PoolEntry[] {
    return status ? this.entries.filter((e) => e.status === status) : this.entries
  }

  syncFromTree(tree: ResearchTree, originCandidateId?: string): void {
    for (const node of tree.query({ kind: 'hypothesis' })) {
      const existing = this.get(node.id)
      if (existing) {
        if (existing.provenance === 'canonical') continue
        existing.statement = node.content
        existing.provenance = 'unknown'
        existing.updated_at = nowIso()
      } else {
        this.upsert({
          id: node.id,
          statement: node.content,
          status: node.status === 'proposed' ? 'QUEUED' : 'TESTING',
          origin_candidate_id: originCandidateId,
          evidence_ids: [],
          provenance: 'unknown',
        })
      }
    }
    const actions = tree.query({ kind: 'action' })
    const evidence = tree.query({ kind: 'evidence' })
    for (const ev of evidence) {
      const action = actions.find((a) => a.id === ev.parent)
      const hypId = action?.parent ?? ev.parent
      const entry = hypId ? this.get(hypId) : undefined
      if (!entry || entry.provenance === 'canonical') continue
      if (!entry.evidence_ids.includes(ev.id)) entry.evidence_ids.push(ev.id)
      const statuses = evidence.filter((row) => entry.evidence_ids.includes(row.id)).map((row) => row.status)
      if (statuses.includes('supports') && statuses.includes('refutes')) entry.status = 'INCONCLUSIVE'
      else if (statuses.includes('supports')) entry.status = 'SUPPORTED'
      else if (statuses.includes('refutes')) entry.status = 'REFUTED'
      else if (statuses.includes('inconclusive')) entry.status = 'INCONCLUSIVE'
      entry.updated_at = nowIso()
    }
    for (const action of actions) {
      const entry = action.parent ? this.get(action.parent) : undefined
      if (entry && entry.provenance !== 'canonical' && action.status === 'running' && entry.status === 'QUEUED') {
        entry.status = 'TESTING'
        entry.updated_at = nowIso()
      }
    }
  }

  /** Project the committed active lineage; legacy tree nodes cannot overwrite this view. */
  syncFromSnapshot(snapshot: ResearchSnapshot): void {
    for (const hypothesis of snapshot.hypotheses) {
      const existing = this.get(hypothesis.id)
      if (existing?.provenance === 'canonical' && (existing.version ?? 0) > hypothesis.version) continue
      const active = hypothesis.id === snapshot.active_hypothesis.id && hypothesis.version === snapshot.active_hypothesis.version
      const assessed = active && snapshot.assessment && snapshot.assessment.protocol_hash === snapshot.protocol.content_hash && snapshot.protocol.hypothesis.id === hypothesis.id && snapshot.protocol.hypothesis.version === hypothesis.version
      const status = assessed ? snapshot.assessment!.claim_status : hypothesis.status
      this.upsert({
        id: hypothesis.id,
        statement: hypothesis.statement,
        status: status === 'supported' ? 'SUPPORTED' : status === 'refuted' ? 'REFUTED' : status === 'inconclusive' ? 'INCONCLUSIVE' : status === 'superseded' ? 'REJECTED' : 'QUEUED',
        evidence_ids: assessed ? [...new Set([...snapshot.assessment!.supporting_evidence_ids, ...snapshot.assessment!.opposing_evidence_ids])] : hypothesis.source_refs.map((ref) => ref.id),
        opposing_evidence_ids: assessed ? [...snapshot.assessment!.opposing_evidence_ids] : [],
        provenance: 'canonical',
        version: hypothesis.version,
        content_hash: hypothesis.content_hash,
        snapshot_id: snapshot.id,
        snapshot_hash: snapshot.content_hash,
        parents: hypothesis.parents,
        created_at: hypothesis.created_at,
      })
    }
  }
}
