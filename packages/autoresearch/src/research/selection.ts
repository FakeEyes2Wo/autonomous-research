import { knownCost, type ResearchCandidate } from './candidates.js'

export interface SelectionInput {
  snapshotHash: string
  remainingCost: number | null
  testedMechanismKeys: string[]
  registeredAlternatives: string[]
  /** Project-level compact direction memory. Matching mechanisms are never eligible. */
  avoidedMechanismKeys?: string[]
  /** IDs are retained only for an auditable selection reason; their text is not copied into snapshots. */
  directionMemoryIds?: string[]
  /** Preferred per-mechanism attribution for the selection reason. */
  directionMemoryMatches?: Record<string, string[]>
  /** Controller-owned caps. No conversion from tokens or cycles into currency. */
  exploratoryBudget?: { policy: 'controller-caps-v1'; remainingCycles: number; remainingRoleCalls: number | null; remainingTokens: number | null }
}

export interface SelectionDecision {
  policyVersion: 'rules-v1'
  candidateIds: string[]
  selectedId: string | null
  reasons: Record<string, string[]>
  snapshotHash: string
  stopReason: 'budget' | 'no_feasible_candidate' | null
}

export function selectCandidate(candidates: ResearchCandidate[], input: SelectionInput): SelectionDecision {
  if ((input.remainingCost !== null && !knownCost(input.remainingCost)) || !input.snapshotHash) throw new Error('INVALID_SELECTION_BUDGET_OR_SNAPSHOT')
  const fallback = input.exploratoryBudget
  const cap = (value: number | null) => value === null || (Number.isSafeInteger(value) && value > 0)
  const exploratory = fallback?.policy === 'controller-caps-v1' && Number.isSafeInteger(fallback.remainingCycles) && fallback.remainingCycles > 0 && cap(fallback.remainingRoleCalls) && cap(fallback.remainingTokens)
  const ordered = [...candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (new Set(ordered.map(candidate => candidate.id)).size !== ordered.length) throw new Error('DUPLICATE_CANDIDATE')
  const reasons: Record<string, string[]> = Object.create(null)
  const eligible: ResearchCandidate[] = []
  let budgetBlocked = false
  const avoidedMechanisms = new Set(input.avoidedMechanismKeys ?? [])
  const directionMemoryReason = (candidate: ResearchCandidate): string[] => {
    if (!avoidedMechanisms.has(candidate.mechanismKey)) return []
    const ids = [...new Set(input.directionMemoryMatches?.[candidate.mechanismKey] ?? input.directionMemoryIds ?? [])].sort()
    return ids.length ? ids.map((id) => `project_direction_memory:${id}`) : ['project_direction_memory']
  }
  for (const candidate of ordered) {
    const list: string[] = reasons[candidate.id] = []
    list.push(...directionMemoryReason(candidate))
    if (candidate.status === 'rejected') list.push('rejected')
    if (candidate.feasible !== true) list.push('infeasible')
    if (candidate.estimatedCost !== null && !knownCost(candidate.estimatedCost)) list.push('invalid_cost')
    if (!Array.isArray(candidate.unresolvedConstraints) || candidate.unresolvedConstraints.length) list.push('unresolved_constraints')
    if (!Array.isArray(candidate.distinguishes) || candidate.distinguishes.some(id => typeof id !== 'string')) list.push('invalid_alternatives')
    const viable = list.length === 0
    let budgetOK = true
    if (input.remainingCost !== null) {
      if (!knownCost(candidate.estimatedCost)) { list.push('unknown_cost_under_monetary_limit'); budgetOK = false }
      else if (candidate.estimatedCost > input.remainingCost) { list.push('over_budget'); budgetOK = false }
    } else if (!exploratory) { list.push('exploratory_budget_exhausted'); budgetOK = false }
    else list.push('controller_caps_exploratory_no_monetary_guarantee')
    if (fallback && !exploratory) { list.push('controller_cap_exhausted'); budgetOK = false }
    budgetBlocked ||= viable && !budgetOK
    if (viable && budgetOK) eligible.push(candidate)
    if (Array.isArray(candidate.distinguishes) && candidate.distinguishes.some(id => !input.registeredAlternatives.includes(id))) list.push('unregistered_alternatives')
  }
  const count = (candidate: ResearchCandidate) => new Set(candidate.distinguishes.filter(id => input.registeredAlternatives.includes(id))).size
  const tested = (candidate: ResearchCandidate) => Number(input.testedMechanismKeys.includes(candidate.mechanismKey))
  const costOrder = (a: ResearchCandidate, b: ResearchCandidate) => a.estimatedCost === null ? (b.estimatedCost === null ? 0 : 1) : b.estimatedCost === null ? -1 : a.estimatedCost - b.estimatedCost
  eligible.sort((a, b) => count(b) - count(a) || tested(a) - tested(b) || costOrder(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const selectedId = eligible[0]?.id ?? null
  for (const candidate of eligible) reasons[candidate.id]!.push(candidate.id === selectedId ? 'selected' : 'deferred_by_rules',
    `registered_alternatives:${count(candidate)}`, tested(candidate) ? 'tested_mechanism' : 'untested_mechanism', `estimated_cost_micros:${candidate.estimatedCost === null ? 'unknown' : candidate.estimatedCost}`)
  return { policyVersion: 'rules-v1', candidateIds: ordered.map(candidate => candidate.id), selectedId, reasons,
    snapshotHash: input.snapshotHash, stopReason: selectedId ? null : budgetBlocked ? 'budget' : 'no_feasible_candidate' }
}
