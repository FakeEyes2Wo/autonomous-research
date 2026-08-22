import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lightHardGate, preGate, structuralCheck, maxTotalRisks } from '../../dist/domain/idea-gate.js'
import type { FalsifiabilityReport, IdeaPackage, SkepticReport, StructuralCheckReport, ValidationPlan } from '../../dist/domain/idea.js'

const pkg: IdeaPackage = {
  idea_id: 'idea-1',
  generation_strategy: 'test',
  lineage_op: 'generate',
  statement: 'hypothesis',
  intervention: 'intervention',
  expected_effect: 'effect',
  supported_premises: [],
  inference_chain: [],
  predicted_observations: ['p'],
  disconfirming_observations: ['d'],
  sources: ['s'],
}

const falsifiable: FalsifiabilityReport = {
  idea_id: 'idea-1',
  testable_implication: 'run experiment',
  unobservable_variables: [],
  is_falsifiable: true,
}

const structural: StructuralCheckReport = {
  idea_id: 'idea-1',
  premise_evidence_ok: true,
  novel_hypothesis_testable: true,
  violations: [],
}

const validation: ValidationPlan = {
  idea_id: 'idea-1',
  minimal_test: 'test',
  verifier: 'ablation_replication',
  decision_rule: 'compare',
}

test('maxTotalRisks follows 6N-1', () => {
  assert.equal(maxTotalRisks(2), 11)
})

test('structuralCheck rejects non-testable idea', () => {
  const report = structuralCheck({ ...pkg, predicted_observations: [] })
  assert.equal(report.novel_hypothesis_testable, false)
})

test('preGate passes valid idea', () => {
  const decision = preGate(structural, falsifiable)
  assert.equal(decision.verdict, 'PASS')
})

test('lightHardGate passes clean reviews', () => {
  const reviews: SkepticReport[] = [
    { idea_id: 'idea-1', perspective: 'methodology', critique: 'ok', unaddressed_risks: [], fatal_flaw_found: false, failed: false },
    { idea_id: 'idea-1', perspective: 'statistics', critique: 'ok', unaddressed_risks: [], fatal_flaw_found: false, failed: false },
  ]
  const decision = lightHardGate(structural, falsifiable, reviews, validation)
  assert.equal(decision.verdict, 'PASS')
})

test('lightHardGate rejects fatal flaw', () => {
  const reviews: SkepticReport[] = [
    { idea_id: 'idea-1', perspective: 'methodology', critique: 'bad', unaddressed_risks: [], fatal_flaw_found: true, failed: false },
    { idea_id: 'idea-1', perspective: 'statistics', critique: 'ok', unaddressed_risks: [], fatal_flaw_found: false, failed: false },
  ]
  const decision = lightHardGate(structural, falsifiable, reviews, validation)
  assert.equal(decision.verdict, 'REJECT')
})
