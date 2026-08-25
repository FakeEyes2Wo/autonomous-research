export type GateVerdict = 'PASS' | 'REVISE' | 'REJECT' | 'EXPLORATORY'

export interface ClaimEvidence {
  claim: string
  role: 'supported_premise' | 'derived_inference' | 'novel_hypothesis' | 'prediction' | 'disconfirming_observation'
  supporting_refs: string[]
}

export interface InferenceStep {
  step_id: string
  from_premises: string[]
  operator: string
  to_claim: string
  uncertainty: number
}

export interface IdeaDraft {
  statement: string
  intervention: string
  expected_effect: string
  supported_premises: ClaimEvidence[]
  inference_chain: InferenceStep[]
  predicted_observations: string[]
  disconfirming_observations: string[]
  sources: string[]
}

export interface IdeaPackage extends IdeaDraft {
  idea_id: string
  generation_strategy: string
  lineage_op: string
}

export interface StructuralCheckReport {
  idea_id: string
  premise_evidence_ok: boolean
  novel_hypothesis_testable: boolean
  violations: string[]
}

export interface FalsifiabilityReport {
  idea_id: string
  testable_implication: string
  unobservable_variables: string[]
  is_falsifiable: boolean
}

export interface RubricItemScore {
  item: string
  score: number
  evidence: string
  evidence_refs?: string[]
}

export interface GateDecision {
  idea_id: string
  gate_phase: 'pre_gate' | 'full'
  verdict: GateVerdict
  rubric_version: string
  item_scores: RubricItemScore[]
  blocking_factor: string | null
}

export interface SkepticReport {
  idea_id: string
  perspective: string
  critique: string
  unaddressed_risks: string[]
  fatal_flaw_found: boolean
  failed: boolean
}

export interface ValidationPlan {
  idea_id: string
  minimal_test: string
  verifier: string | null
  decision_rule: string
}

export interface ResearchIdea {
  direction: string
  aPrioriIdeas: string[]
  raw: string
}
