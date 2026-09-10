import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAPER_AUDITS, paperAuditStatus } from '../../dist/paper/phases.js'

test('paper audit registry is the single source of proof/claim/citation/kill audits', () => {
  assert.deepEqual(PAPER_AUDITS, [
    { name: 'proof', role: 'proof-checker', file: 'PROOF_AUDIT.json' },
    { name: 'claim', role: 'claim-auditor', file: 'PAPER_CLAIM_AUDIT.json' },
    { name: 'citation', role: 'citation-auditor', file: 'CITATION_AUDIT.json' },
    { name: 'kill', role: 'kill-argument-reviewer', file: 'KILL_ARGUMENT.json' },
  ])
})

test('paper audit gate fails closed and accepts only explicit passing verdicts', () => {
  const passing = {
    proof: { verdict: 'NOT_APPLICABLE' },
    claim: { verdict: 'PASS' },
    citation: { verdict: 'PASS' },
    kill: { verdict: 'NOT_APPLICABLE' },
    basic: { numeric: { ok: true }, citation: { ok: true } },
  }
  assert.equal(paperAuditStatus(passing), 'passed')
  assert.equal(paperAuditStatus({ ...passing, claim: { verdict: 'ERROR' } }), 'failed')
  assert.equal(paperAuditStatus({}), 'failed')
})
