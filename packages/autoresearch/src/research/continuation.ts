import { hashContent } from './records.js'
import type { SourceRef } from './contracts.js'

export interface AcceptanceCriterion {
  id: string
  required: boolean
  text: string
  evidenceKind: 'artifact' | 'review' | 'scientific'
  origin: 'explicit' | 'derived'
  applicability?: 'when-scientific-claims'
}
export interface AcceptanceInput { criteria: Omit<AcceptanceCriterion, 'origin' | 'applicability'>[] }
export interface FrozenAcceptanceContract {
  schema: 'autoresearch/acceptance/v1'
  origin: 'explicit' | 'derived'
  goalProfileRubric: { goal: string; profile: string; rubric: string }
  criteria: AcceptanceCriterion[]
  maxCycles: number
  hash: string
}
export interface RecoveryInput { changedCondition: string; newEvidencePaths?: string[]; criterionIds?: string[] }
export interface ControlRevision { revision: number; maxCycles: number; changedCondition?: string; sourceRefs?: SourceRef[]; criterionIds?: string[] }
export interface FollowupProposal {
  mechanismKey?: string
  retryOf?: string
  kind: 'investigate' | 'repair' | 'replicate'
  criterionIds: string[]
  task: string
  changedCondition: string
  sourceRefs: SourceRef[]
}
export interface FollowupItem extends FollowupProposal {
  fingerprint: string
  generation: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  failureReason?: string
  previousAttempts?: { generation: number; cycle?: number; sourceRefs: SourceRef[]; resultRefs?: SourceRef[]; failureReason?: string }[]
  cycle?: number
  execution?: { cycle: number; planVersion: number; graphId: string }
  resultRefs?: SourceRef[]
}
export interface CoverageDecision {
  action: 'complete' | 'followup' | 'pause' | 'budget_exhausted'
  reason: string
  criteria: { id: string; status: 'met' | 'unmet' | 'unknown' | 'not_applicable'; rationale?: string; sourceRefs: SourceRef[] }[]
  blockers: string[]
  unsupportedClaims: string[]
  followups: FollowupProposal[]
}
export interface ContinuationStop {
  stopReason: 'pause' | 'no_feasible_followup' | 'budget_exhausted' | 'evidence_unresolved'
  reason: string
  inputHash?: string
  resumeCondition: { changedConditionRequired: true; relevantSourceIds: string[]; mayIncreaseMaxCycles: boolean }
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value) }
  return value
}
export function parseAcceptance(value: unknown): AcceptanceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'criteria')) throw new TypeError('acceptance must contain only criteria')
  const criteria = (value as AcceptanceInput).criteria
  if (!Array.isArray(criteria) || !criteria.length) throw new TypeError('acceptance requires nonempty criteria')
  const ids = new Set<string>()
  for (const c of criteria) {
    if (!c || typeof c !== 'object' || Object.keys(c).some(key => !['id', 'required', 'text', 'evidenceKind'].includes(key)) ||
      typeof c.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(c.id) || ids.has(c.id) ||
      typeof c.text !== 'string' || !c.text.trim() || typeof c.required !== 'boolean' || !['artifact', 'review', 'scientific'].includes(c.evidenceKind)) throw new TypeError('invalid or duplicate acceptance criterion')
    ids.add(c.id)
  }
  if (!criteria.some(c => c.required)) throw new TypeError('acceptance requires at least one required criterion')
  return structuredClone({ criteria })
}
export function parseRecovery(value: unknown): RecoveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['changedCondition', 'newEvidencePaths', 'criterionIds'].includes(key))) throw new TypeError('recovery has invalid fields')
  const r = value as RecoveryInput
  if (typeof r.changedCondition !== 'string' || !r.changedCondition.trim()) throw new TypeError('recovery requires changedCondition')
  if (r.newEvidencePaths !== undefined && (!Array.isArray(r.newEvidencePaths) || r.newEvidencePaths.some(path => typeof path !== 'string' || !path.trim() || /(^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$))/.test(path)) || new Set(r.newEvidencePaths).size !== r.newEvidencePaths.length)) throw new TypeError('recovery paths must be unique run-relative paths')
  if (r.criterionIds !== undefined && (!Array.isArray(r.criterionIds) || !r.criterionIds.length || r.criterionIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(r.criterionIds).size !== r.criterionIds.length)) throw new TypeError('recovery criterionIds must be unique nonempty IDs')
  return structuredClone(r)
}
export function freezeAcceptance(input: AcceptanceInput | undefined, basis: { goal: string; profile: string; rubric: string; maxCycles: number }): FrozenAcceptanceContract {
  if (!Number.isSafeInteger(basis.maxCycles) || basis.maxCycles < 1) throw new TypeError('acceptance maxCycles must be positive')
  const origin: 'explicit' | 'derived' = input === undefined ? 'derived' : 'explicit'
  const criteria: AcceptanceCriterion[] = input === undefined ? [
    { id: 'goal-coverage', required: true, text: `Cover the full goal and its constraints:\n${basis.goal}\n\nPROFILE:\n${basis.profile}\n\nRUBRIC:\n${basis.rubric}`, evidenceKind: 'review', origin },
    { id: 'scientific-claims', required: true, text: 'Any scientific claims in the goal or resulting work require formal, admissible evidence under the frozen protocol. If no scientific claim is made, independently justify non-applicability from the complete frozen goal and captured work; never infer support from a paper or tests.', evidenceKind: 'scientific', origin, applicability: 'when-scientific-claims' },
  ] : parseAcceptance(input).criteria.map(c => ({ ...c, origin }))
  const contract = { schema: 'autoresearch/acceptance/v1' as const, origin, goalProfileRubric: { goal: basis.goal, profile: basis.profile, rubric: basis.rubric }, criteria, maxCycles: basis.maxCycles }
  return deepFreeze({ ...contract, hash: hashContent(contract) })
}
export function continuationInputHash(input: { acceptance: FrozenAcceptanceContract; assessmentAndEvidence: unknown; queue: unknown; controlRevision: ControlRevision }): string {
  return hashContent({ acceptance: input.acceptance, assessmentAndEvidence: input.assessmentAndEvidence, queue: input.queue, controlRevision: input.controlRevision })
}
const refKey = (ref: SourceRef) => `${ref.id}\0${ref.path}\0${ref.hash}`
export function admittedRefs(refs: SourceRef[], available: SourceRef[]): boolean {
  const known = new Set(available.map(refKey))
  return Array.isArray(refs) && refs.length > 0 && refs.every(ref => ref && typeof ref.path === 'string' && typeof ref.hash === 'string' && known.has(refKey(ref)))
}
export function validateCoverage(contract: FrozenAcceptanceContract, decision: CoverageDecision, available: SourceRef[], scientificSupported: boolean, scientificRefs: SourceRef[] = available, scientificObligation = scientificSupported): string[] {
  const issues: string[] = []
  if (!decision || !['complete', 'followup', 'pause', 'budget_exhausted'].includes(decision.action) || typeof decision.reason !== 'string' || !Array.isArray(decision.criteria) || !Array.isArray(decision.blockers) || !Array.isArray(decision.unsupportedClaims) || !Array.isArray(decision.followups)) return ['malformed coverage decision']
  const seen = new Set<string>()
  for (const row of decision.criteria) {
    const c = contract.criteria.find(c => c.id === row.id)
    if (!c || seen.has(row.id)) { issues.push(`unknown or duplicate criterion: ${row.id}`); continue }
    seen.add(row.id)
    if (!['met', 'unmet', 'unknown', 'not_applicable'].includes(row.status)) issues.push(`invalid criterion status: ${row.id}`)
    if (row.status === 'not_applicable' && (contract.origin !== 'derived' || c.origin !== 'derived' || c.applicability !== 'when-scientific-claims' || scientificObligation || typeof row.rationale !== 'string' || !row.rationale.trim() || !admittedRefs(row.sourceRefs, available))) issues.push(`scientific applicability waiver rejected: ${row.id}`)
    if (row.status === 'met' && !admittedRefs(row.sourceRefs, c.evidenceKind === 'scientific' ? scientificRefs : available)) issues.push(`unverified criterion sources: ${row.id}`)
    if (row.status === 'met' && c.evidenceKind === 'scientific' && !scientificSupported) issues.push(`formal scientific admission missing: ${row.id}`)
  }
  if (decision.action === 'complete') {
    for (const c of contract.criteria.filter(c => c.required)) if (!decision.criteria.some(row => row.id === c.id && (row.status === 'met' || row.status === 'not_applicable'))) issues.push(`required criterion unmet: ${c.id}`)
    if (decision.blockers.length || decision.unsupportedClaims.length) issues.push('unresolved blockers or unsupported claims')
    if (decision.followups.length) issues.push('complete decision still proposes unfinished work')
  }
  return issues
}
export function mergeFollowups(queue: FollowupItem[], proposals: FollowupProposal[], contract: FrozenAcceptanceContract, available: SourceRef[]): FollowupItem[] {
  const result = structuredClone(queue)
  for (const p of proposals) {
    if (!p || (p.mechanismKey !== undefined && !/^[a-f0-9]{64}$/.test(p.mechanismKey)) || (p.retryOf !== undefined && !/^[a-f0-9]{64}$/.test(p.retryOf)) || !['investigate', 'repair', 'replicate'].includes(p.kind) || typeof p.task !== 'string' || !p.task.trim() || typeof p.changedCondition !== 'string' || !Array.isArray(p.criterionIds) || !p.criterionIds.length || new Set(p.criterionIds).size !== p.criterionIds.length || p.criterionIds.some(id => !contract.criteria.some(c => c.id === id)) || !admittedRefs(p.sourceRefs, available)) continue
    if (p.retryOf && !result.some(item => item.fingerprint === p.retryOf && item.status === 'failed' && p.kind === 'repair' && hashContent([...item.criterionIds].sort()) === hashContent([...p.criterionIds].sort()) && (!item.mechanismKey || p.mechanismKey === item.mechanismKey))) continue
    // Wording and byte hashes cannot create a new mechanism. IDs link to a
    // criterion's existing sources; new unrelated references cannot reopen it.
    const fingerprint = hashContent({ kind: p.kind, criterionIds: [...p.criterionIds].sort(), ...(p.mechanismKey ? { mechanismKey: p.mechanismKey } : { sourceIds: [...new Set(p.sourceRefs.map(r => r.id))].sort() }) })
    // An explicit, validated retry target is exclusive; earlier generic matches
    // must never steal its repair or become a fallback for an invalid target.
    const old = p.retryOf ? result.find(item => item.fingerprint === p.retryOf) : result.find(item => item.fingerprint === fingerprint || (hashContent([...item.criterionIds].sort()) === hashContent([...p.criterionIds].sort()) && ((p.mechanismKey && item.mechanismKey === p.mechanismKey) || ((item.status === 'failed' || item.status === 'running' || item.kind === p.kind) && p.sourceRefs.every(ref => item.sourceRefs.some(prior => prior.hash === ref.hash || prior.id === ref.id))))))
    if (!old) { result.push({ ...structuredClone(p), fingerprint, generation: 0, status: 'pending' }); continue }
    const previousRefs = [...old.sourceRefs, ...(old.resultRefs ?? []), ...(old.previousAttempts ?? []).flatMap(attempt => [...attempt.sourceRefs, ...(attempt.resultRefs ?? [])])]
    if ((old.status === 'completed' || old.status === 'failed') && p.changedCondition.trim() && p.sourceRefs.some(ref => (p.retryOf === old.fingerprint || p.mechanismKey === old.mechanismKey && !!p.mechanismKey || old.sourceRefs.some(prior => prior.id === ref.id)) && !previousRefs.some(prior => prior.hash === ref.hash))) {
      const previousAttempts = [...(old.previousAttempts ?? []), { generation: old.generation, cycle: old.cycle, sourceRefs: old.sourceRefs, resultRefs: old.resultRefs, failureReason: old.failureReason }]
      Object.assign(old, structuredClone(p), { status: 'pending', generation: old.generation + 1, cycle: undefined, execution: undefined, resultRefs: undefined, failureReason: undefined, previousAttempts })
    }
  }
  return result
}
