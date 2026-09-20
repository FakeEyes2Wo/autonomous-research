import { isEvidenceVerdict, type EvidenceVerdict, type ResearchNodeStatus } from '../core/types.js'

export interface ActionFinishEvidence {
  content: string
  verdict: EvidenceVerdict
  artifacts?: string[]
}

export interface ActionFinishInput {
  actionId: string
  status: 'completed' | 'failed'
  summary: string
  artifacts?: string[]
  evidence?: ActionFinishEvidence[]
}

export interface ActionFinishWritePlan {
  action: { id: string; status: ResearchNodeStatus; content: string; artifacts?: string[] }
  evidence: ActionFinishEvidence[]
}

/**
 * Validate the complete fused request before a caller mutates or saves a tree.
 * Adapted from the action-boundary discussion in SoL-Pi §2.4
 * (arXiv:2609.20519v1); this project records deterministic local writes.
 * See packages/autoresearch/docs/sol-pi-harness-efficiency.md for the project boundary.
 */
export function fuseActionFinish(input: ActionFinishInput): ActionFinishWritePlan {
  if (!input.actionId.trim()) throw new TypeError('actionId is required')
  if (!['completed', 'failed'].includes(input.status)) throw new TypeError('invalid action status')
  if (!input.summary.trim()) throw new TypeError('summary is required')
  if (input.artifacts !== undefined && (!Array.isArray(input.artifacts) || input.artifacts.some((artifact) => typeof artifact !== 'string' || artifact.length === 0))) {
    throw new TypeError('action artifacts must be non-empty strings')
  }
  const evidence = input.evidence ?? []
  for (const item of evidence) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) throw new TypeError('evidence content is required')
    if (!isEvidenceVerdict(item.verdict)) throw new TypeError(`invalid evidence verdict: ${String(item.verdict)}`)
    if (item.artifacts !== undefined && item.artifacts.some((artifact) => typeof artifact !== 'string' || artifact.length === 0)) {
      throw new TypeError('evidence artifacts must be non-empty strings')
    }
  }
  return {
    action: { id: input.actionId, status: input.status, content: input.summary, ...(input.artifacts ? { artifacts: [...input.artifacts] } : {}) },
    evidence: evidence.map((item) => ({ content: item.content, verdict: item.verdict, ...(item.artifacts ? { artifacts: [...item.artifacts] } : {}) })),
  }
}
