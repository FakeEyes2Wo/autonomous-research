import type { Claim, Hypothesis, ResearchSnapshot, RevisionDecision, RevisionInput } from './contracts.js'
import { sealRecord, verifyRecord } from './records.js'

export function createRevision(input: RevisionInput): ResearchSnapshot {
  const { parentSnapshot: parent, assessment, candidate, nextProtocol } = input
  verifyRecord(parent)
  verifyRecord(assessment)
  const oldClaim = parent.claims.find((c) => c.id === parent.active_claim.id && c.version === parent.active_claim.version)
  const oldHypothesis = parent.hypotheses.find((h) => h.id === parent.active_hypothesis.id && h.version === parent.active_hypothesis.version)
  if (!oldClaim || !oldHypothesis) throw new Error('missing active research lineage')
  if (assessment.claim.id !== oldClaim.id || !parent.claims.some((claim) => claim.id === assessment.claim.id && claim.version === assessment.claim.version) || assessment.protocol_hash !== parent.protocol.content_hash) throw new Error('assessment does not match parent protocol/claim')
  const created_at = input.createdAt ?? new Date().toISOString()
  let action = assessment.next_action
  if (action === 'revise' && !candidate) action = 'pause'
  if (parent.budget.revisions >= (input.maxRevisions ?? 3) && candidate) action = 'pause'
  const claims = [...parent.claims]
  const hypotheses = [...parent.hypotheses]
  let active_claim = parent.active_claim
  let active_hypothesis = parent.active_hypothesis
  let protocol = parent.protocol
  if (candidate && action !== 'pause') {
    if (assessment.category === 'invalid_measurement' || assessment.category === 'execution_error') throw new Error('repair invalid evidence before scientific revision')
    if (!candidate.statement.trim() || candidate.statement.trim() === oldHypothesis.statement.trim()) throw new Error('unchanged revision candidate')
    if (!candidate.evidence_ids.length || candidate.evidence_ids.some((id) => !parent.evidence.some((row) => row.id === id))) throw new Error('revision candidate must cite existing evidence')
    if (!candidate.prediction.trim() || !candidate.falsification.trim() || !candidate.rationale.trim()) throw new Error('candidate must be falsifiable and justified')
    if (!nextProtocol || nextProtocol.content_hash === protocol.content_hash) throw new Error('revision requires a new protocol')
    verifyRecord(nextProtocol)
    const claimVersion = Math.max(...claims.filter((c) => c.id === oldClaim.id).map((c) => c.version)) + 1
    const hypothesisVersion = Math.max(...hypotheses.filter((h) => h.id === oldHypothesis.id).map((h) => h.version)) + 1
    const source_refs = candidate.evidence_ids.map((id) => ({ id, hash: parent.evidence.find((row) => row.id === id)!.content_hash }))
    const claim: Claim = sealRecord({ ...oldClaim, version: claimVersion, created_at, source_refs, statement: candidate.statement, scope: candidate.scope, parents: [parent.active_claim], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: candidate.rationale })
    const hypothesis: Hypothesis = sealRecord({ ...oldHypothesis, version: hypothesisVersion, created_at, source_refs, statement: candidate.statement, claim: { id: claim.id, version: claim.version }, parents: [parent.active_hypothesis], mechanism: candidate.mechanism, alternatives: candidate.alternatives, prediction: candidate.prediction, falsification: candidate.falsification, measurement: candidate.measurement, decision_rule: candidate.decision_rule, scope: candidate.scope, mode: 'exploratory', status: 'proposed', discovery_source_ids: candidate.evidence_ids })
    if (nextProtocol.hypothesis.id !== hypothesis.id || nextProtocol.hypothesis.version !== hypothesis.version) throw new Error('next protocol must target the revised hypothesis version')
    claims.push(claim)
    hypotheses.push(hypothesis)
    active_claim = { id: claim.id, version: claim.version }
    active_hypothesis = { id: hypothesis.id, version: hypothesis.version }
    protocol = nextProtocol
    action = 'revise'
  }
  const decision: RevisionDecision = sealRecord({ id: input.decisionId, version: 1, created_at, source_refs: [{ id: assessment.id, hash: assessment.content_hash }], parent_snapshot_id: parent.id, parent_claim: parent.active_claim, parent_hypothesis: parent.active_hypothesis, assessment_id: assessment.id, evidence_ids: candidate?.evidence_ids ?? assessment.admissible_evidence_ids, action, reason: input.reason, candidate, next_protocol_hash: protocol.content_hash, stop_conditions: ['global budget', `scientific revision limit ${input.maxRevisions ?? 3}`, 'no distinguishable feasible candidate'] })
  return sealRecord({ ...parent, id: `snapshot-${input.decisionId}`, version: parent.version + 1, created_at, source_refs: [{ id: parent.id, hash: parent.content_hash }], parent_snapshot_id: parent.id, active_claim, active_hypothesis, claims, hypotheses, protocol, assessment, decision, budget: { ...parent.budget, revisions: parent.budget.revisions + (action === 'revise' ? 1 : 0), repairs: parent.budget.repairs + (action === 'repair' ? 1 : 0) } })
}
