import { HYPOTHESIS_POOL_FILE } from './utils.js'
import type { ResearchTree } from './research-tree.js'
import { atomicWriteJson, nowIso, readJson, safeResolve } from './utils.js'

export type PoolStatus = 'QUEUED' | 'TESTING' | 'SUPPORTED' | 'REFUTED' | 'INCONCLUSIVE' | 'REJECTED'

export interface PoolEntry {
  id: string
  statement: string
  status: PoolStatus
  origin_candidate_id?: string
  evidence_ids: string[]
  created_at: string
  updated_at: string
}

export class HypothesisPool {
  entries: PoolEntry[]

  constructor(public readonly file: string, entries: PoolEntry[] = []) {
    this.entries = entries
  }

  static async load(runDir: string): Promise<HypothesisPool> {
    const file = safeResolve(runDir, HYPOTHESIS_POOL_FILE)
    try {
      const data = await readJson<{ entries: PoolEntry[] }>(file)
      return new HypothesisPool(file, Array.isArray(data.entries) ? data.entries : [])
    } catch {
      return new HypothesisPool(file)
    }
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
        existing.statement = node.content
        existing.updated_at = nowIso()
      } else {
        this.upsert({
          id: node.id,
          statement: node.content,
          status: node.status === 'proposed' ? 'QUEUED' : 'TESTING',
          origin_candidate_id: originCandidateId,
          evidence_ids: [],
        })
      }
    }
    const actions = tree.query({ kind: 'action' })
    const evidence = tree.query({ kind: 'evidence' })
    for (const ev of evidence) {
      const action = actions.find((a) => a.id === ev.parent)
      const hypId = action?.parent ?? ev.parent
      const entry = hypId ? this.get(hypId) : undefined
      if (!entry) continue
      if (!entry.evidence_ids.includes(ev.id)) entry.evidence_ids.push(ev.id)
      if (ev.status === 'supports') entry.status = 'SUPPORTED'
      else if (ev.status === 'refutes') entry.status = 'REFUTED'
      else if (ev.status === 'inconclusive' && entry.status === 'QUEUED') entry.status = 'INCONCLUSIVE'
      entry.updated_at = nowIso()
    }
    for (const action of actions) {
      const entry = action.parent ? this.get(action.parent) : undefined
      if (entry && action.status === 'running' && entry.status === 'QUEUED') {
        entry.status = 'TESTING'
        entry.updated_at = nowIso()
      }
    }
  }
}
