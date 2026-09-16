import type { ResearchSnapshot, RevisionCandidate, SourceRef, VersionedRecord, VersionRef } from './contracts.js'
import { assessCandidate, knownCost, mechanismKey, type ResearchCandidate } from './candidates.js'
import { hashContent, sealRecord } from './records.js'
import { selectCandidate, type SelectionDecision, type SelectionInput } from './selection.js'

export interface CandidateEntry {
  raw: unknown
  candidate: ResearchCandidate
  revision?: RevisionCandidate
  admissionReasons: string[]
  reasons: string[]
  reconsideredFrom?: string
}
export interface CandidateBatch extends VersionedRecord {
  snapshotHash: string
  proposalSnapshotHash: string
  selection: SelectionDecision
  selectionInput: SelectionInput
  entries: CandidateEntry[]
  basis: string[]
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown) => typeof v === 'string' ? v : ''
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim())
const list = (v: unknown): string[] => strings(v) ? v : []

/** Raw payload is retained separately; admission never registers model-supplied IDs. */
export function buildCandidateBatch(input: {
  id: string; parent: ResearchSnapshot; proposalParent: VersionRef; proposalSnapshotHash: string
  rawCandidates: unknown[]; rawSource: SourceRef; registeredSpans?: SourceRef[]; selectionInput: SelectionInput
}): CandidateBatch {
  const { parent } = input
  const spans = (input.registeredSpans ?? []).filter(s => s.path && s.hash)
  const old = parent.hypotheses.find(h => h.id === parent.active_hypothesis.id && h.version === parent.active_hypothesis.version)!
  // Development observations may motivate discovery while remaining excluded from formal claims.
  // The trusted assessment must have found no issue other than their exploratory status.
  const discoveryIds = parent.protocol?.provenance === 'known'
    ? (parent.assessment?.excluded_evidence ?? []).filter(entry => entry.reasons.length === 1 && entry.reasons[0] === 'unknown_or_exploratory_provenance'
      && parent.evidence.some(row => row.id === entry.id && row.mode === 'exploratory' && row.validity === 'valid')).map(entry => entry.id)
    : []
  const proposals = input.rawCandidates.map(raw => ({ raw, parent: input.proposalParent, from: undefined as string | undefined }))
  // Only the latest disposition of each proposal can reopen; selected/rejected proposals never re-enter implicitly.
  const latest = new Map<string, { entry: CandidateEntry; batch: CandidateBatch }>()
  for (const batch of parent.candidate_batches ?? []) for (const entry of batch.entries) latest.set(entry.candidate.id, { entry, batch })
  for (const { entry, batch } of latest.values()) if (entry.candidate.status === 'deferred' && batch.snapshotHash !== parent.content_hash &&
    entry.candidate.parent.id === parent.active_hypothesis.id && entry.candidate.parent.version === parent.active_hypothesis.version &&
    !input.rawCandidates.some(raw => hashContent(raw) === hashContent(entry.raw))) {
    proposals.push({ raw: entry.raw, parent: entry.candidate.parent, from: batch.id })
  }
  const occurrences = new Map<string, number>()
  const entries: CandidateEntry[] = proposals.map(proposal => {
    const raw = object(proposal.raw)
    const digest = hashContent(proposal.raw)
    const occurrence = (occurrences.get(digest) ?? 0) + 1
    occurrences.set(digest, occurrence)
    const id = `candidate-${digest}${occurrence > 1 ? `-${occurrence}` : ''}`
    const evidence = raw.sourceEvidenceIds ?? raw.evidence_ids
    const spanIds = raw.sourceSpanIds ?? []
    const candidate: ResearchCandidate = {
      id, parent: proposal.parent,
      mechanismKey: mechanismKey({ mechanism: text(raw.mechanism), intervention: text(raw.intervention ?? raw.measurement), outcome: text(raw.outcomeVariable ?? raw.measurement), conditions: [text(raw.scope), text(raw.decision_rule)] }),
      changedAssumption: text(raw.changedAssumption ?? raw.rationale), prediction: text(raw.prediction), disconfirmingObservation: text(raw.disconfirmingObservation ?? raw.falsification),
      sourceEvidenceIds: list(evidence), sourceSpanIds: list(spanIds), distinguishes: list(raw.distinguishes ?? raw.alternatives), unresolvedConstraints: list(raw.unresolvedConstraints ?? []),
      estimatedCost: knownCost(raw.estimatedCost) ? raw.estimatedCost : null,
      feasible: raw.feasible === undefined ? true : raw.feasible === true, status: 'proposed',
    }
    const reasons = assessCandidate(candidate, { parent: parent.active_hypothesis, evidenceIds: [...(parent.assessment?.admissible_evidence_ids ?? []), ...discoveryIds], spanIds: spans.map(s => s.id) })
    if (raw.parent !== undefined && (object(raw.parent).id !== proposal.parent.id || object(raw.parent).version !== proposal.parent.version)) reasons.push('proposal_parent_mismatch')
    for (const field of ['statement', 'scope', 'mechanism', 'measurement', 'decision_rule', 'rationale']) if (!text(raw[field]).trim()) reasons.push(`missing_${field}`)
    if (!strings(raw.alternatives)) reasons.push('alternatives')
    if (!strings(evidence)) reasons.push('unregistered_evidence')
    if (!strings(spanIds)) reasons.push('unregistered_span')
    if (raw.distinguishes !== undefined && !strings(raw.distinguishes)) reasons.push('distinguishes')
    if (raw.unresolvedConstraints !== undefined && !strings(raw.unresolvedConstraints)) reasons.push('unresolvedConstraints')
    if (raw.estimatedCost !== undefined && raw.estimatedCost !== null && !knownCost(raw.estimatedCost)) reasons.push('invalid_cost')
    if (raw.feasible !== undefined && typeof raw.feasible !== 'boolean') reasons.push('feasible')
    if (text(raw.statement).trim() === old.statement.trim() || candidate.prediction.trim() === old.prediction.trim()) reasons.push('unchanged_revision')
    if (['invalid_measurement', 'execution_error'].includes(parent.assessment?.category ?? '')) reasons.push('repair_before_revision')
    candidate.status = reasons.length ? 'rejected' : 'eligible'
    const revision: RevisionCandidate = { statement: text(raw.statement), scope: text(raw.scope), mechanism: text(raw.mechanism), alternatives: list(raw.alternatives),
      prediction: candidate.prediction, falsification: candidate.disconfirmingObservation, measurement: text(raw.measurement), decision_rule: text(raw.decision_rule),
      evidence_ids: candidate.sourceEvidenceIds, rationale: text(raw.rationale), source_span_refs: spans.filter(s => candidate.sourceSpanIds.includes(s.id)) }
    return { raw: proposal.raw, candidate, ...(reasons.length ? {} : { revision }), admissionReasons: [...new Set(reasons)], reasons: [], ...(proposal.from ? { reconsideredFrom: proposal.from } : {}) }
  })
  const selection = selectCandidate(entries.map(entry => entry.candidate), input.selectionInput)
  for (const entry of entries) {
    entry.reasons = [...entry.admissionReasons, ...(selection.reasons[entry.candidate.id] ?? [])]
    if (entry.candidate.status !== 'rejected') entry.candidate.status = selection.selectedId === entry.candidate.id ? 'selected' : 'deferred'
  }
  return sealRecord({ id: input.id, version: 1, created_at: new Date().toISOString(), source_refs: [input.rawSource, ...spans],
    snapshotHash: parent.content_hash, proposalSnapshotHash: input.proposalSnapshotHash, selection, selectionInput: input.selectionInput, entries,
    basis: [`assessment:${parent.assessment?.content_hash ?? 'none'}`, `snapshot:${parent.content_hash}`,
      ...(input.proposalSnapshotHash !== parent.content_hash ? ['rebuilt_after_snapshot_change'] : []),
      ...entries.filter(e => e.reconsideredFrom).map(e => `reopened:${e.candidate.id}:from:${e.reconsideredFrom}:new_snapshot:${parent.content_hash}`)] })
}
