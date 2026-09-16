import type { Evidence, Protocol, ResearchSnapshot } from '../research/contracts.js'
import { hashContent } from '../research/records.js'

export interface DomainValidation {
  validity: Evidence['validity']; polarity: Evidence['polarity']; observation: string
  sample_size?: number; effect?: number
  validation: NonNullable<Evidence['validation']>
}
export interface EvidenceValidator { rule: string; validate(raw: unknown, protocol: Protocol, history: ResearchSnapshot): DomainValidation }

/** Exact conditional paired sign test. Each row is one independent task, never another seed of the same task. */
const pairedSignTest: EvidenceValidator = {
  rule: 'paired_sign_test_v1',
  validate(raw, protocol, history) {
    const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const issues: string[] = []
    if (data.schema !== 'autoresearch/paired-outcomes/v1') issues.push('unsupported raw observation schema')
    if (data.protocol_hash !== protocol.content_hash) issues.push('wrong frozen protocol')
    if (data.split !== protocol.split || hashContent(data.fingerprints ?? {}) !== hashContent(protocol.fingerprints)) issues.push('split or fingerprints mismatch')
    if (data.unit !== protocol.budget.unit || typeof data.cost !== 'number' || !Number.isFinite(data.cost) || data.cost < 0 || data.cost > protocol.budget.limit * (1 + protocol.budget.tolerance)) issues.push('budget or unit mismatch')
    const units = Array.isArray(data.units) ? data.units as Array<Record<string, unknown>> : []
    if (!units.length || units.length !== protocol.budget.limit || protocol.budget.unit !== 'task-pair') issues.push('incomplete independent task-pair batch')
    const ids = new Set<string>()
    let positive = 0, negative = 0
    for (const unit of units) {
      if (!unit || typeof unit !== 'object') { issues.push('malformed unit'); continue }
      if (typeof unit.id !== 'string' || !unit.id || ids.has(unit.id)) issues.push('duplicate or missing independent task identifier')
      ids.add(String(unit.id))
      if (unit.seed !== undefined || unit.task_id !== undefined) issues.push('seed repeats must be aggregated into independent task units before testing')
      if ((unit.control !== 0 && unit.control !== 1) || (unit.treatment !== 0 && unit.treatment !== 1)) { issues.push('nonbinary or nonfinite outcome'); continue }
      if (unit.treatment > unit.control) positive++
      if (unit.treatment < unit.control) negative++
    }
    const hypothesis = history.hypotheses.find(h => h.id === history.active_hypothesis.id && h.version === history.active_hypothesis.version)
    for (const id of hypothesis?.discovery_source_ids ?? []) {
      const old = history.evidence.find(e => e.id === id)
      if (old && (old.fingerprints.data === protocol.fingerprints.data || old.split === protocol.split)) issues.push('discovery data reused for formal validation')
    }
    // Stable binomial probabilities avoid 2**n overflow for large batches.
    const n = positive + negative, k = Math.min(positive, negative)
    let logProbability = -n * Math.log(2), tail = Math.exp(logProbability)
    for (let i = 1; i <= k; i++) { logProbability += Math.log(n - i + 1) - Math.log(i); tail += Math.exp(logProbability) }
    const p = n === 0 ? 1 : Math.min(1, 2 * tail)
    const polarity = p <= 0.05 ? (positive > negative ? 'supports' : 'opposes') : 'inconclusive'
    return { validity: issues.length ? 'invalid' : 'valid', polarity: issues.length ? 'inconclusive' : polarity,
      observation: `Independent task pairs=${units.length}; treatment wins=${positive}; control wins=${negative}; exact two-sided p=${p}; alpha=0.05; null results are inconclusive.`,
      sample_size: units.length, effect: units.length ? (positive - negative) / units.length : 0,
      validation: { method: 'paired_sign_test_v1', passed: issues.length === 0, issues: [...new Set(issues)] } }
  },
}

/** Registry is a trusted-code adapter boundary, never a model-supplied validation receipt. */
const validators = new Map<string, EvidenceValidator>([[pairedSignTest.rule, pairedSignTest]])
export function validateScientificEvidence(raw: unknown, protocol: Protocol, history: ResearchSnapshot): DomainValidation {
  const adapter = validators.get(protocol.decision_rule)
  if (protocol.provenance !== 'known' || !adapter) return { validity: 'unknown', polarity: 'inconclusive', observation: 'No supported frozen domain validator; historical content remains unverified.', validation: { method: protocol.decision_rule, passed: false, issues: ['unsupported or unknown protocol'] } }
  return adapter.validate(raw, protocol, history)
}
