import type {
  FalsifiabilityReport,
  GateDecision,
  IdeaPackage,
  RubricItemScore,
  SkepticReport,
  StructuralCheckReport,
  ValidationPlan,
} from './idea.js'

export const GATE_RUBRIC_VERSION = 'gate-rubric/v2'
export const MAX_TOLERATED_RISKS = 6

export interface GateInput {
  structural: StructuralCheckReport
  falsifiability: FalsifiabilityReport
  reviews?: SkepticReport[]
  validationPlan?: ValidationPlan
}

export type PreGateInput = Pick<GateInput, 'structural' | 'falsifiability'>

export interface LightHardGateInput extends GateInput {
  reviews: SkepticReport[]
  validationPlan: ValidationPlan
}

export function maxTotalRisks(perspectiveCount: number): number {
  if (perspectiveCount < 1) throw new Error('perspectiveCount must be at least 1')
  return MAX_TOLERATED_RISKS * perspectiveCount
}

export function structuralCheck(pkg: IdeaPackage): StructuralCheckReport {
  const violations: string[] = []
  const supportedPremises = Array.isArray(pkg.supported_premises) ? pkg.supported_premises : []
  const premiseEvidenceOk = supportedPremises.every((premise) =>
    premise.role === 'supported_premise' ? premise.supporting_refs.length > 0 : true,
  )
  if (!premiseEvidenceOk) violations.push('supported_premise_without_evidence')
  const predictedObservations = Array.isArray(pkg.predicted_observations) ? pkg.predicted_observations : []
  const disconfirmingObservations = Array.isArray(pkg.disconfirming_observations) ? pkg.disconfirming_observations : []
  const novelTestable = predictedObservations.length > 0 && disconfirmingObservations.length > 0
  if (!novelTestable) violations.push('novel_hypothesis_not_testable')
  return {
    idea_id: pkg.idea_id,
    premise_evidence_ok: premiseEvidenceOk,
    novel_hypothesis_testable: novelTestable,
    violations,
  }
}

export function structuralRubricScores(
  structural: StructuralCheckReport,
  falsifiability: FalsifiabilityReport,
): { ok: boolean; evidenceTraceable: RubricItemScore; falsifiable: RubricItemScore } {
  const ok = structural.premise_evidence_ok && structural.novel_hypothesis_testable
  return {
    ok,
    evidenceTraceable: {
      item: 'evidence_traceable',
      score: ok ? 1 : 0,
      evidence: ok
        ? 'all premises cite evidence and predictions/disconfirmers are present'
        : `structural violations: ${structural.violations.join(', ')}`,
    },
    falsifiable: {
      item: 'falsifiable',
      score: falsifiability.is_falsifiable ? 1 : 0,
      evidence: falsifiability.is_falsifiable
        ? falsifiability.testable_implication
        : `unobservable variables: ${falsifiability.unobservable_variables.join(', ')}`,
    },
  }
}

function createGateDecision(input: {
  ideaId: string
  gatePhase: GateDecision['gate_phase']
  verdict: GateDecision['verdict']
  itemScores: RubricItemScore[]
  blockingFactor: GateDecision['blocking_factor']
}): GateDecision {
  return {
    idea_id: input.ideaId,
    gate_phase: input.gatePhase,
    verdict: input.verdict,
    rubric_version: GATE_RUBRIC_VERSION,
    item_scores: input.itemScores,
    blocking_factor: input.blockingFactor,
  }
}

function preGateDecision(input: PreGateInput): GateDecision {
  const { structural, falsifiability } = input
  const { ok, evidenceTraceable, falsifiable } = structuralRubricScores(structural, falsifiability)
  let verdict: GateDecision['verdict'] = 'PASS'
  let blockingFactor: string | null = null
  if (!ok) {
    verdict = 'REVISE'
    blockingFactor = 'evidence_traceable'
  } else if (!falsifiability.is_falsifiable) {
    verdict = 'REVISE'
    blockingFactor = 'falsifiable'
  }
  return createGateDecision({
    ideaId: structural.idea_id,
    gatePhase: 'pre_gate',
    verdict,
    itemScores: [evidenceTraceable, falsifiable],
    blockingFactor,
  })
}

export function preGate(structural: StructuralCheckReport, falsifiability: FalsifiabilityReport): GateDecision
export function preGate(input: PreGateInput): GateDecision
export function preGate(
  structuralOrInput: PreGateInput | StructuralCheckReport,
  falsifiability?: FalsifiabilityReport,
): GateDecision {
  if ('structural' in structuralOrInput) return preGateDecision(structuralOrInput)
  return preGateDecision({ structural: structuralOrInput, falsifiability: falsifiability! })
}

export function perspectiveOk(review: SkepticReport): boolean {
  return !review.failed && !review.fatal_flaw_found && review.unaddressed_risks.length <= MAX_TOLERATED_RISKS
}

function lightHardGateDecision(input: LightHardGateInput): GateDecision {
  const { structural, falsifiability, reviews, validationPlan } = input
  const perspectiveIds = reviews.map((r) => r.perspective)
  if (new Set(perspectiveIds).size !== perspectiveIds.length) {
    throw new Error(`light_hard_gate requires distinct perspectives, got ${perspectiveIds.join(', ')}`)
  }
  const ideaIds = new Set([structural.idea_id, falsifiability.idea_id, validationPlan.idea_id, ...reviews.map((r) => r.idea_id)])
  if (ideaIds.size !== 1) {
    throw new Error(`reports refer to different ideas: ${[...ideaIds].sort().join(', ')}`)
  }

  const { ok, evidenceTraceable, falsifiable } = structuralRubricScores(structural, falsifiability)
  const ordered = [...reviews].sort((a, b) => a.perspective.localeCompare(b.perspective))
  const totalRisks = ordered.reduce((sum, r) => sum + r.unaddressed_risks.length, 0)
  const failedCount = ordered.filter((r) => r.failed).length
  const totalNote = `cross-perspective total unaddressed risks: ${totalRisks}`

  const riskScores: RubricItemScore[] = ordered.map((review) => ({
    item: `risk_ok_${review.perspective}`,
    score: perspectiveOk(review) ? 1 : 0,
    evidence: `failed=${review.failed}; fatal_flaw_found=${review.fatal_flaw_found}; unaddressed_risks=${review.unaddressed_risks.length} (tolerance ${MAX_TOLERATED_RISKS}): ${review.unaddressed_risks.join('; ')}; ${totalNote}`,
  }))
  const ceiling = maxTotalRisks(ordered.length)
  const totalOk = totalRisks <= ceiling
  const riskTotalScore: RubricItemScore = {
    item: 'risk_total',
    score: totalOk ? 1 : 0,
    evidence: `${totalNote} (ceiling ${ceiling})${failedCount ? ` (incomplete: ${failedCount} perspective(s) failed)` : ''}`,
  }
  const verifierOk = validationPlan.verifier !== null
  const verifierScore: RubricItemScore = {
    item: 'verifier_ok',
    score: verifierOk ? 1 : 0,
    evidence: verifierOk ? `verifier=${validationPlan.verifier}` : 'no verifier matched; validation plan is EXPLORATORY',
  }

  const fatal = ordered.find((r) => r.fatal_flaw_found)
  const blocked = ordered.find((r) => !perspectiveOk(r))

  let verdict: GateDecision['verdict'] = 'PASS'
  let blockingFactor: string | null = null
  if (!ok || !falsifiability.is_falsifiable) {
    verdict = 'REVISE'
    blockingFactor = !ok ? 'evidence_traceable' : 'falsifiable'
  } else if (fatal) {
    verdict = 'REJECT'
    blockingFactor = `risk_ok_${fatal.perspective}`
  } else if (blocked) {
    verdict = 'REVISE'
    blockingFactor = `risk_ok_${blocked.perspective}`
  } else if (!totalOk) {
    verdict = 'REVISE'
    blockingFactor = 'risk_total'
  } else if (!verifierOk) {
    verdict = 'EXPLORATORY'
    blockingFactor = 'verifier_ok'
  }

  return createGateDecision({
    ideaId: structural.idea_id,
    gatePhase: 'full',
    verdict,
    itemScores: [evidenceTraceable, falsifiable, riskTotalScore, verifierScore, ...riskScores],
    blockingFactor,
  })
}

export function lightHardGate(
  structural: StructuralCheckReport,
  falsifiability: FalsifiabilityReport,
  reviews: SkepticReport[],
  validationPlan: ValidationPlan,
): GateDecision
export function lightHardGate(input: LightHardGateInput): GateDecision
export function lightHardGate(
  structuralOrInput: LightHardGateInput | StructuralCheckReport,
  falsifiability?: FalsifiabilityReport,
  reviews?: SkepticReport[],
  validationPlan?: ValidationPlan,
): GateDecision {
  if ('structural' in structuralOrInput) return lightHardGateDecision(structuralOrInput)
  return lightHardGateDecision({
    structural: structuralOrInput,
    falsifiability: falsifiability!,
    reviews: reviews!,
    validationPlan: validationPlan!,
  })
}

export function blockingEvidence(decision: GateDecision): string {
  if (!decision.blocking_factor) return 'no blocking factor'
  const item = decision.item_scores.find((i) => i.item === decision.blocking_factor)
  return item?.evidence ?? 'no itemized evidence recorded'
}
