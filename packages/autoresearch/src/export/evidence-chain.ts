import { EVIDENCE_CHAIN_FILE } from '../core/utils.js'
import type { ResearchTree } from '../core/research-tree.js'
import type { ResearchNode } from '../core/types.js'
import { atomicWriteJson, nowIso, readJson, safeResolve } from '../core/utils.js'

export interface EvidenceChain {
  schema: 'autoresearch/evidence-chain/v1'
  run_id: string
  generated_at: string
  hypotheses: ResearchNode[]
  actions: ResearchNode[]
  evidence: ResearchNode[]
}

export interface EvidenceChainResult {
  chain: EvidenceChain
  file: string
}

export interface ExportEvidenceChainInput {
  runDir: string
  runId: string
  tree: ResearchTree
}

async function writeEvidenceChain(runDir: string, runId: string, tree: ResearchTree): Promise<EvidenceChainResult> {
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
  return { chain, file }
}

/**
 * Object-oriented overload returning the written JSON object and its path.
 */
export async function exportEvidenceChain(input: ExportEvidenceChainInput): Promise<EvidenceChainResult>
/**
 * Legacy positional overload kept for callers of the original public API.
 */
export async function exportEvidenceChain(runDir: string, runId: string, tree: ResearchTree): Promise<string>
export async function exportEvidenceChain(inputOrRunDir: ExportEvidenceChainInput | string, runId?: string, tree?: ResearchTree): Promise<EvidenceChainResult | string> {
  if (typeof inputOrRunDir === 'string') {
    if (runId === undefined || tree === undefined) throw new TypeError('exportEvidenceChain requires runId and tree when called positionally')
    return (await writeEvidenceChain(inputOrRunDir, runId, tree)).file
  }
  return writeEvidenceChain(inputOrRunDir.runDir, inputOrRunDir.runId, inputOrRunDir.tree)
}

export async function loadEvidenceChain(runDir: string): Promise<EvidenceChain> {
  return readJson<EvidenceChain>(safeResolve(runDir, EVIDENCE_CHAIN_FILE))
}

export function evidenceIdsFromChain(chain: EvidenceChain): string[] {
  return chain.evidence.map((node) => `E-${node.id}`)
}

export function collectEvidenceIds(tree: ResearchTree): string[] {
  return tree.query({ kind: 'evidence' }).map((node) => `E-${node.id}`)
}
