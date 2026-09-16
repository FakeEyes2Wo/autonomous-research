import type { AssessmentInput, Evidence, FailureCategory, ResearchAction, ResearchAssessment } from './contracts.js'
import { hashContent, sealRecord, verifyRecord } from './records.js'

/** Pure admission of domain-validated observations. Callers must run the domain validator and verify raw source bytes. */
export function assessEvidence(input: AssessmentInput): ResearchAssessment {
  const { claim, hypothesis, protocol, evidence } = input
  for (const record of [claim, hypothesis, protocol, ...evidence]) verifyRecord(record)
  const discovery = (hypothesis.discovery_source_ids ?? []).map((id) => (input.discoveryEvidence ?? evidence).find((row) => row.id === id))
  const captured = (input.discoverySourceRefs ?? []).filter(ref => ref.path && ref.hash)
  const missingDiscovery = (hypothesis.discovery_source_ids ?? []).filter(id => !(input.discoveryEvidence ?? evidence).some(row => row.id === id) && !captured.some(ref => ref.id === id))
  for (const row of discovery) if (row) verifyRecord(row)
  const excluded: ResearchAssessment['excluded_evidence'] = []
  const admitted: Evidence[] = []
  for (const row of evidence) {
    const reasons: string[] = []
    if (row.target_claim.id !== claim.id || row.target_claim.version !== claim.version) reasons.push('target_claim_mismatch')
    if (protocol.hypothesis.id !== hypothesis.id || protocol.hypothesis.version !== hypothesis.version) reasons.push('hypothesis_version_mismatch')
    if (row.protocol_hash !== protocol.content_hash) reasons.push('protocol_mismatch')
    if (protocol.provenance !== 'known' || row.mode !== 'formal') reasons.push('unknown_or_exploratory_provenance')
    if (!row.artifacts.length || row.artifacts.some((ref) => !ref.path || !ref.hash) || !row.analysis?.path || !row.analysis.hash) reasons.push('missing_source_provenance')
    if (row.validity !== 'valid') reasons.push(`${row.validity}_measurement`)
    if (!row.validation?.passed || row.validation.method !== protocol.decision_rule || row.validation.issues.length || protocol.decision_rule !== 'paired_sign_test_v1') reasons.push('domain_validation_missing_or_failed')
    if (row.split !== protocol.split || hashContent(row.fingerprints) !== hashContent(protocol.fingerprints) || Object.values(protocol.fingerprints).some((v) => !v || v === 'unknown')) reasons.push('fingerprint_or_split_mismatch')
    if (row.execution === 'unknown') reasons.push('execution_unknown')
    if (row.execution === 'error' && protocol.failure_policy !== 'include_as_outcome') reasons.push('execution_error')
    if (missingDiscovery.length) reasons.push('discovery_provenance_unresolved')
    if (discovery.some((source) => source && (source.id === row.id || source.fingerprints.data === row.fingerprints.data || source.split === row.split || source.artifacts.some((ref) => row.artifacts.some((current) => current.id === ref.id || (!!current.hash && current.hash === ref.hash)))))) reasons.push('discovery_data_reused')
    if (captured.some(ref => (hypothesis.discovery_source_ids ?? []).includes(ref.id) && row.artifacts.some(current => current.id === ref.id || current.hash === ref.hash))) reasons.push('discovery_data_reused')
    if (reasons.length) excluded.push({ id: row.id, reasons })
    else admitted.push(row)
  }
  const supporting = admitted.filter((row) => row.polarity === 'supports').map((row) => row.id).sort()
  const opposing = admitted.filter((row) => row.polarity === 'opposes').map((row) => row.id).sort()
  const conflicts: string[] = []
  if (supporting.length && opposing.length) conflicts.push('supporting_and_opposing_evidence')
  const units = new Map<string, Evidence>()
  for (const row of admitted) {
    if (!row.unit_id) continue
    const previous = units.get(row.unit_id)
    if (previous && hashContent([previous.effect, previous.interval, previous.polarity]) !== hashContent([row.effect, row.interval, row.polarity])) conflicts.push(`duplicate_unit:${row.unit_id}`)
    units.set(row.unit_id, row)
  }
  let category: FailureCategory
  let next_action: ResearchAction
  let claim_status: ResearchAssessment['claim_status'] = 'inconclusive'
  const invalid = excluded.some((entry) => entry.reasons.some((reason) => ['invalid_measurement', 'fingerprint_or_split_mismatch', 'protocol_mismatch', 'discovery_data_reused'].includes(reason)))
  const executionError = excluded.some((entry) => entry.reasons.includes('execution_error'))
  if (conflicts.length) { category = 'mixed_evidence'; next_action = 'revise' }
  else if (invalid) { category = 'invalid_measurement'; next_action = 'repair' }
  else if (executionError) { category = 'execution_error'; next_action = 'repair' }
  else if (opposing.length) { category = 'hypothesis_refuted'; next_action = 'revise'; claim_status = 'refuted' }
  else if (supporting.length) { category = 'supported'; next_action = 'replicate'; claim_status = 'supported' }
  else { category = 'insufficient_evidence'; next_action = 'replicate' }
  // Failure signatures exclude attempt IDs/timestamps so unchanged retries are detectable.
  const failure_signature = hashContent({ protocol: protocol.content_hash, category, reasons: excluded.flatMap((e) => e.reasons).sort(), observations: evidence.map((e) => e.observation).sort() })
  if (evidence.some((row) => row.execution === 'unknown')) next_action = 'pause'
  if (next_action === 'repair' && ((input.repairAttempts ?? 0) >= (input.maxRepairAttempts ?? 2) || (input.previousFailureSignature === failure_signature && !input.repairChanged))) next_action = 'pause'
  if (input.budgetExhausted) { category = 'budget_exhausted'; next_action = 'pause' }
  if (input.externalBlock) { category = 'external_block'; next_action = 'pause' }
  const created_at = input.createdAt ?? new Date().toISOString()
  const source_refs = evidence.map((row) => ({ id: row.id, hash: row.content_hash }))
  const reason = `${category}; admitted ${admitted.length}/${evidence.length}; ${next_action}`
  const failureBody = { version: 1, created_at, source_refs, category, attempt_ids: evidence.map((row) => row.attempt_id), protocol_hash: protocol.content_hash, target_claim: { id: claim.id, version: claim.version }, observations: evidence.map((row) => row.observation), interpretations: evidence.flatMap((row) => row.interpretation ? [row.interpretation] : []), unknowns: excluded.flatMap((row) => row.reasons), affected_evidence_ids: evidence.map((row) => row.id), recommended_action: next_action, minimal_diagnostic: next_action === 'repair' ? 'Verify the failed measurement or execution with a bounded smoke check before a new attempt.' : 'Resolve source/coverage gaps or test the next hypothesis on independent data.' }
  const failure = sealRecord({ id: `failure-${hashContent(failureBody).slice(0, 24)}`, ...failureBody })
  const assessmentBody = { version: 1, created_at, source_refs, claim: { id: claim.id, version: claim.version }, protocol_hash: protocol.content_hash, claim_status, category, next_action, admissible_evidence_ids: admitted.map((row) => row.id).sort(), excluded_evidence: excluded, supporting_evidence_ids: supporting, opposing_evidence_ids: opposing, conflicts: [...new Set(conflicts)].sort(), failure_signature, failures: category === 'supported' ? [] : [failure], reason }
  return sealRecord({ id: `assessment-${hashContent(assessmentBody).slice(0, 24)}`, ...assessmentBody })
}
