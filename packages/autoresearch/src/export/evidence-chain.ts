import { EVIDENCE_CHAIN_FILE } from '../core/utils.js'
import type { ResearchTree } from '../core/research-tree.js'
import { atomicWriteJson, nowIso, safeResolve } from '../core/utils.js'

export interface EvidenceChain {
  schema: 'autoresearch/evidence-chain/v1'
  run_id: string
  generated_at: string
  hypotheses: unknown[]
  actions: unknown[]
  evidence: unknown[]
}

export async function exportEvidenceChain(runDir: string, runId: string, tree: ResearchTree): Promise<string> {
  const file = safeResolve(runDir, EVIDENCE_CHAIN_FILE)
  const chain: EvidenceChain = {
    schema: 'autoresearch/evidence-chain/v1',
    run_id: runId,
    generated_at: nowIso(),
    hypotheses: tree.query({ kind: 'hypothesis' }),
    actions: tree.query({ kind: 'action' }),
    evidence: tree.query({ kind: 'evidence' }),
  }
  await atomicWriteJson(file, chain)
  return file
}
