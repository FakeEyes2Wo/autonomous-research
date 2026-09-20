import assert from 'node:assert/strict'
import { test } from 'node:test'

test('review protocol rejects model authority and contradictory PASS', async () => {
  const protocol = await import('../../dist/paper/review-protocol.js')
  const binding = { sourceHash: 'source', templateHash: 'template', assetHashes: {}, evidenceHash: 'evidence' }
  const result = protocol.normalizePaperReview({ verdict: 'PASS', capability: { visual: 'actual' }, binding: {}, issues: [{ severity: 'major', code: 'OVERCLAIM', detail: 'Unsupported claim', repair: 'Remove it', location: { source: '../../escape' } }] }, {
    role: 'paper-reviewer', binding, capability: { visual: 'machine-only' }, budget: { used: 1, limit: 3, progress: true }, sources: ['main.tex'], pages: [],
  })
  assert.equal(result.verdict, 'REVISE')
  assert.deepEqual(result.binding, binding)
  assert.equal(result.capability.visual, 'machine-only')
  assert.equal(result.issues[0].location?.source, 'main.tex')
  assert.match(result.issues[0].id, /^paper-reviewer:/)
})

test('all artifact mutations invalidate prior reviews', async () => {
  const { samePaperBinding } = await import('../../dist/paper/review-protocol.js')
  const binding = { sourceHash: 's', templateHash: 't', assetHashes: { figure: 'a' }, evidenceHash: 'e', pdfHash: 'p', inspectionHash: 'i' }
  assert.equal(samePaperBinding(binding, structuredClone(binding)), true)
  for (const field of ['sourceHash', 'templateHash', 'evidenceHash', 'pdfHash', 'inspectionHash']) assert.equal(samePaperBinding(binding, { ...binding, [field]: 'changed' }), false)
  assert.equal(samePaperBinding(binding, { ...binding, assetHashes: { figure: 'changed' } }), false)
})

test('visual PASS requires actual coverage and legacy score-only output is blocked', async () => {
  const { normalizePaperReview } = await import('../../dist/paper/review-protocol.js')
  const host = { role: 'layout-reviewer', binding: { sourceHash: 's', templateHash: 't', assetHashes: {}, evidenceHash: 'e' }, capability: { visual: 'machine-only' }, budget: { used: 1, limit: 3, progress: true }, sources: ['main.tex'], pages: [1], visualRequired: true }
  assert.equal(normalizePaperReview({ verdict: 'PASS', issues: [] }, host as never).verdict, 'BLOCKED')
  assert.equal(normalizePaperReview({ score: 10, critical: [], major: [], minor: [] }, { ...host, role: 'paper-reviewer', visualRequired: false } as never).verdict, 'BLOCKED')
})

test('draft and missing numeric or citation audits cannot become submission ready', async () => {
  const { evaluatePaperGate } = await import('../../dist/paper/review-protocol.js')
  const audits = { proof: { verdict: 'PASS' }, claim: { verdict: 'PASS' }, citation: { verdict: 'PASS' }, kill: { verdict: 'PASS' }, basic: { numeric: { ok: true }, citation: { ok: true } } }
  assert.equal(evaluatePaperGate({ assurance: 'draft', deterministic: [], audits, reviews: [], requiredRoles: [], binding: {} } as never).submissionReady, false)
  assert.equal(evaluatePaperGate({ assurance: 'submission', deterministic: [], audits: { ...audits, basic: { numeric: { ok: true } } }, reviews: [], requiredRoles: [], binding: {} } as never).submissionReady, false)
})
