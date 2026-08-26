import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAPER_AUDITS } from '../../dist/paper/phases.js'

test('paper audit registry is the single source of proof/claim/citation/kill audits', () => {
  assert.deepEqual(PAPER_AUDITS, [
    { name: 'proof', role: 'proof-checker', file: 'PROOF_AUDIT.json' },
    { name: 'claim', role: 'claim-auditor', file: 'PAPER_CLAIM_AUDIT.json' },
    { name: 'citation', role: 'citation-auditor', file: 'CITATION_AUDIT.json' },
    { name: 'kill', role: 'kill-argument-reviewer', file: 'KILL_ARGUMENT.json' },
  ])
})
