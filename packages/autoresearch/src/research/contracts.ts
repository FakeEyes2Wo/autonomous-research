/** Stable identity and provenance shared by research records and adapters. */
export interface VersionRef { id: string; version: number }
export interface SourceRef { id: string; path?: string; hash?: string; line_start?: number; line_end?: number }
export interface VersionedRecord extends VersionRef {
  created_at: string
  content_hash: string
  source_refs: SourceRef[]
}
export type ClaimStatus = 'proposed' | 'supported' | 'refuted' | 'inconclusive' | 'superseded'
export type EvidenceMode = 'formal' | 'exploratory' | 'unknown'
export interface Claim extends VersionedRecord {
  statement: string
  scope: string
  parents: VersionRef[]
  supporting_evidence_ids: string[]
  opposing_evidence_ids: string[]
  status: ClaimStatus
  reason: string
}
export interface Hypothesis extends VersionedRecord {
  statement: string
  claim: VersionRef
  parents: VersionRef[]
  mechanism: string
  alternatives: string[]
  prediction: string
  falsification: string
  measurement: string
  decision_rule: string
  scope: string
  mode: EvidenceMode
  status: ClaimStatus
  /** Registered evidence or captured SourceRef IDs used to select this hypothesis. */
  discovery_source_ids?: string[]
}
export interface Fingerprints { code: string; data: string; treatment: string; model: string }
export interface Protocol extends VersionedRecord {
  /** Explicit immutable allowlist for actor literature; absent means no literature. */
  allowed_literature_span_ids?: string[]
  hypothesis: VersionRef
  metric: string
  controls: string[]
  sample: string
  split: string
  seeds: number[]
  budget: { unit: string; limit: number; tolerance: number }
  stopping_rule: string
  failure_policy: 'exclude_from_mechanism' | 'include_as_outcome'
  missing_policy: string
  duplicate_policy: 'block_conflicts'
  fingerprints: Fingerprints
  provenance: 'known' | 'unknown'
  /** Domain rule identifier; prose alone is not executable validation. */
  decision_rule: string
}
export interface Evidence extends VersionedRecord {
  target_claim: VersionRef
  protocol_hash: string
  attempt_id: string
  unit_id?: string
  artifacts: SourceRef[]
  analysis?: SourceRef
  validity: 'valid' | 'invalid' | 'unknown'
  polarity: 'supports' | 'opposes' | 'inconclusive'
  execution: 'completed' | 'error' | 'unknown'
  observation: string
  interpretation?: string
  sample_size?: number
  effect?: number
  interval?: [number, number]
  split: string
  mode: EvidenceMode
  fingerprints: Fingerprints
  validation?: { method: string; passed: boolean; issues: string[] }
}
export type FailureCategory = 'execution_error' | 'invalid_measurement' | 'insufficient_evidence' | 'hypothesis_refuted' | 'mixed_evidence' | 'supported' | 'budget_exhausted' | 'external_block'
export type ResearchAction = 'repair' | 'revise' | 'replicate' | 'finish' | 'pause'
export interface FailureAnalysis extends VersionedRecord {
  category: FailureCategory
  attempt_ids: string[]
  protocol_hash: string
  target_claim: VersionRef
  observations: string[]
  interpretations: string[]
  unknowns: string[]
  affected_evidence_ids: string[]
  recommended_action: ResearchAction
  minimal_diagnostic: string
}
export interface ResearchAssessment extends VersionedRecord {
  claim: VersionRef
  protocol_hash: string
  claim_status: ClaimStatus
  category: FailureCategory
  next_action: ResearchAction
  admissible_evidence_ids: string[]
  excluded_evidence: { id: string; reasons: string[] }[]
  supporting_evidence_ids: string[]
  opposing_evidence_ids: string[]
  conflicts: string[]
  failure_signature: string
  failures: FailureAnalysis[]
  reason: string
}
export interface RevisionCandidate {
  statement: string
  scope: string
  mechanism: string
  alternatives: string[]
  prediction: string
  falsification: string
  measurement: string
  decision_rule: string
  evidence_ids: string[]
  rationale: string
  source_span_refs?: SourceRef[]
}
export interface RevisionDecision extends VersionedRecord {
  parent_snapshot_id: string
  parent_claim: VersionRef
  parent_hypothesis: VersionRef
  assessment_id: string
  evidence_ids: string[]
  action: ResearchAction
  reason: string
  candidate?: RevisionCandidate
  candidate_batch_id?: string
  next_protocol_hash?: string
  stop_conditions: string[]
}
export interface ResearchBudget { revisions: number; repairs: number; [key: string]: number }
export interface ResearchSnapshot extends VersionedRecord {
  schema: 'autoresearch/research-snapshot/v1'
  branch_id: string
  parent_snapshot_id?: string
  active_claim: VersionRef
  active_hypothesis: VersionRef
  claims: Claim[]
  hypotheses: Hypothesis[]
  protocol: Protocol
  evidence: Evidence[]
  assessment?: ResearchAssessment
  decision?: RevisionDecision
  /** Immutable proposal/selection history; tree nodes are only a projection. */
  candidate_batches?: import('./candidate-batch.js').CandidateBatch[]
  budget: ResearchBudget
}
export interface AssessmentInput {
  claim: Claim
  hypothesis: Hypothesis
  protocol: Protocol
  evidence: Evidence[]
  /** Retained discovery records; not additional observations to assess. */
  discoveryEvidence?: Evidence[]
  /** Captured literature provenance only; never counted as experimental observations. */
  discoverySourceRefs?: SourceRef[]
  budgetExhausted?: boolean
  externalBlock?: string
  repairAttempts?: number
  maxRepairAttempts?: number
  previousFailureSignature?: string
  repairChanged?: boolean
  createdAt?: string
}
export interface RevisionInput {
  decisionId: string
  parentSnapshot: ResearchSnapshot
  assessment: ResearchAssessment
  candidate?: RevisionCandidate
  nextProtocol?: Protocol
  reason: string
  maxRevisions?: number
  createdAt?: string
}
