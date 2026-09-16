import { createHash } from 'node:crypto'

export interface ResearchCandidate {
  id: string
  parent: { id: string; version: number }
  mechanismKey: string
  changedAssumption: string
  prediction: string
  disconfirmingObservation: string
  sourceEvidenceIds: string[]
  sourceSpanIds: string[]
  distinguishes: string[]
  unresolvedConstraints: string[]
  /** Integer microcurrency, or null when no reliable estimate exists. */
  estimatedCost: number | null
  feasible: boolean
  status: 'proposed' | 'eligible' | 'selected' | 'deferred' | 'rejected'
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty)
export const knownCost = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function assessCandidate(candidate: ResearchCandidate, scope: {
  parent: { id: string; version: number }; evidenceIds: string[]; spanIds: string[]
}): string[] {
  const reasons: string[] = []
  for (const field of ['id', 'mechanismKey', 'changedAssumption', 'prediction', 'disconfirmingObservation'] as const) {
    if (!nonempty(candidate[field])) reasons.push(field)
  }
  if (candidate.parent?.id !== scope.parent.id || candidate.parent?.version !== scope.parent.version) reasons.push('parent_version')
  if (!strings(candidate.sourceEvidenceIds) || candidate.sourceEvidenceIds.some(id => !scope.evidenceIds.includes(id))) reasons.push('unregistered_evidence')
  if (!strings(candidate.sourceSpanIds) || candidate.sourceSpanIds.some(id => !scope.spanIds.includes(id))) reasons.push('unregistered_span')
  if (!(candidate.sourceEvidenceIds?.length || candidate.sourceSpanIds?.length)) reasons.push('missing_sources')
  if (!strings(candidate.distinguishes)) reasons.push('distinguishes')
  if (!strings(candidate.unresolvedConstraints)) reasons.push('unresolvedConstraints')
  if (candidate.estimatedCost !== null && !knownCost(candidate.estimatedCost)) reasons.push('invalid_cost')
  if (typeof candidate.feasible !== 'boolean') reasons.push('feasible')
  return reasons
}

/** Exact normalized identity only; semantic duplicates require separate review. */
export function mechanismKey(input: { mechanism: string; intervention: string; outcome: string; conditions: string[] }): string {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  return createHash('sha256').update(JSON.stringify({ mechanism: normalize(input.mechanism), intervention: normalize(input.intervention),
    outcome: normalize(input.outcome), conditions: [...new Set(input.conditions.map(normalize))].sort() })).digest('hex')
}
