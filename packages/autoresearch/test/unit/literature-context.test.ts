import assert from 'node:assert/strict'
import { test } from 'node:test'
import { literatureFixture } from '../helpers/literature-context.ts'
import { createHash } from 'node:crypto'
import { buildGeneration, publishGeneration } from '../../dist/literature/index-generation.js'
import { retrieveLiteratureContext, toLiteratureRecords, updateLiteratureKnowledge } from '../../dist/literature/context-adapter.js'
import { researchContextForInput } from '../../dist/service/research-context.js'
import { createClaimAssessment, saveClaimAssessment } from '../../dist/literature/claim-assessment.js'
import { ResearchStore, sealRecord } from '../../dist/research/index.js'
import { recordSourceEvent } from '../../dist/literature/source-events.js'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

test('failed catalog opening releases the explicit knowledge update lock', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'literature-update-lock-'))
  const runDir = join(projectDir, 'run')
  try {
    await mkdir(join(projectDir, '.autoresearch', 'literature', 'catalog.sqlite'), { recursive: true })
    const input = { projectDir, runDir, runId: 'run', role: 'planner', query: 'alpha', stage: 'plan', nextGenerationId: 'missing', reason: 'refresh', sourceEventIds: [] }
    await assert.rejects(updateLiteratureKnowledge(input))
    await assert.rejects(access(join(runDir, 'literature', 'update.lock')), { code: 'ENOENT' })
    await assert.rejects(updateLiteratureKnowledge(input), error => error.code !== 'KNOWLEDGE_UPDATE_IN_PROGRESS')
  } finally { await rm(projectDir, { recursive: true, force: true }) }
})

test('first survey retrieves before snapshot and pins access policy independently of changing budget', async () => literatureFixture(async f => {
  const request = await retrieveLiteratureContext(f.input)
  assert.equal(request.records.length, 1)
  assert.equal(request.records[0].layer, 3)
  assert.equal(request.records[0].kind, 'artifact')
  assert.equal(request.records[0].payload.origin, 'author_reported')
  assert.equal(request.records[0].polarity, 'neutral')
  assert.equal(request.records[0].lifecycle, 'candidate')
  const second = await buildGeneration(f.catalog, f.root, f.document.spans.slice(0, 1), { expectedActiveId: f.generation.id, maxSpans: 100 })
  await publishGeneration(f.catalog, f.root, second.id, f.generation.id)
  const resumed = await retrieveLiteratureContext({ ...f.input, settings: { ...f.input.settings, maxResults: 1 } })
  assert.equal(resumed.literature.receipt.request.generationId, f.generation.id)
  assert.equal(resumed.literature.receipt.request.policyHash, hash('access-policy'))
  await updateLiteratureKnowledge({ ...f.input, nextGenerationId: second.id, reason: 'explicit library refresh', sourceEventIds: [] })
  assert.equal((await retrieveLiteratureContext(f.input)).literature.receipt.request.generationId, second.id)
}))

test('forced counterevidence loads outside query ranking and absent required sources pause', async () => literatureFixture(async f => {
  const required = f.document.spans[1].id
  const request = await retrieveLiteratureContext({ ...f.input, requiredSpanIds: [required], settings: { ...f.input.settings, maxResults: 1 } })
  assert.equal(request.records[0].id, required)
  assert.equal(request.records[0].required, true)
  await assert.rejects(retrieveLiteratureContext({ ...f.input, requiredSpanIds: ['invented'] }), /REQUIRED_SOURCE_UNAVAILABLE/)
  assert.throws(() => toLiteratureRecords([{ ...f.document.spans[0], evidenceText: 'tampered' }], request.literature.receipt), /SPAN|HASH|RECEIPT/)
}))

test('legacy off and workers without protocol allowlist never retrieve literature', async () => literatureFixture(async f => {
  assert.equal(await retrieveLiteratureContext({ ...f.input, settings: undefined }), undefined)
  assert.equal(await retrieveLiteratureContext({ ...f.input, role: 'research-worker' }), undefined)
  const actor = await retrieveLiteratureContext({ ...f.input, role: 'research-worker', allowedSpanIds: [f.document.spans[1].id] })
  assert.deepEqual(actor.records.map((r: any) => r.id), [f.document.spans[1].id])
}))

test('service builds literature context from the first survey input before a snapshot exists', async () => literatureFixture(async f => {
  const request = await researchContextForInput('paper-survey', { runDir: f.runDir, plan: 'alpha' }, { projectDir: f.project, runId: 'run', policySnapshot: { literature: f.input.settings } })
  assert.ok(request.records.some((record: any) => record.source.recordType === 'literature-span'))
  assert.ok(request.records.some((record: any) => record.id === 'constraints'))
}))

test('registered opposing assessments require both conflict sides outside top-k and live correction notices survive pins', async () => literatureFixture(async f => {
  const base = { version: 1, created_at: new Date().toISOString(), source_refs: [] }
  const claim = sealRecord({ ...base, id: 'claim', statement: 'alpha', scope: 'task', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: 'intake' })
  const hypothesis = sealRecord({ ...base, id: 'hypothesis', statement: 'alpha', claim: { id: 'claim', version: 1 }, parents: [], mechanism: '', alternatives: [], prediction: '', falsification: '', measurement: '', decision_rule: '', scope: 'task', mode: 'unknown', status: 'proposed' })
  const protocol = sealRecord({ ...base, id: 'protocol', hypothesis: { id: 'hypothesis', version: 1 }, metric: '', controls: [], sample: '', split: 'unknown', seeds: [], budget: { unit: 'unknown', limit: 0, tolerance: 0 }, stopping_rule: 'bounded', failure_policy: 'exclude_from_mechanism', missing_policy: 'unknown', duplicate_policy: 'block_conflicts', fingerprints: { code: 'unknown', data: 'unknown', treatment: 'unknown', model: 'unknown' }, provenance: 'unknown', decision_rule: '' })
  await new ResearchStore(f.runDir).commit(sealRecord({ ...base, id: 'initial', schema: 'autoresearch/research-snapshot/v1', branch_id: 'main', claims: [claim], hypotheses: [hypothesis], protocol, evidence: [], active_claim: { id: 'claim', version: 1 }, active_hypothesis: { id: 'hypothesis', version: 1 }, budget: { revisions: 0, repairs: 0, tokens: 0 } }))
  for (const [i, relation] of ['supports', 'refutes'].entries()) {
    const assessment = createClaimAssessment({ claimId: 'claim', spanIds: [f.document.spans[1 - i].id], relation, conditions: [], assessor: 'human', assessorVersion: 'review-v1' }, f.document.spans)
    await saveClaimAssessment(f.runDir, assessment, f.document.spans)
    if (i === 0) {
      await recordSourceEvent(f.catalog, { id: 'early-correction', documentId: f.document.document.id, sourceHash: f.document.document.rawHash, kind: 'correction', createdAt: new Date().toISOString(), reason: 'supporting claim corrected' })
      const correctedSupport = await researchContextForInput('supervisor', { runDir: f.runDir, idea: 'alpha' }, { projectDir: f.project, runId: 'run', policySnapshot: { literature: f.input.settings } })
      assert.ok(correctedSupport.requiredRecordIds.includes(f.document.spans[1].id), 'correction to registered support outside top-k must require re-review')
    }
  }
  const ctx = { projectDir: f.project, runId: 'run', policySnapshot: { literature: f.input.settings } }
  const grounded = await researchContextForInput('supervisor', { runDir: f.runDir, idea: 'alpha' }, ctx)
  assert.deepEqual(new Set(grounded.requiredRecordIds), new Set(f.document.spans.map((s: any) => s.id)))
  await assert.rejects(researchContextForInput('supervisor', { runDir: f.runDir, idea: 'alpha' }, { ...ctx, policySnapshot: { literature: { ...f.input.settings, maxResults: 1 } } }), { code: 'CONTEXT_INSUFFICIENT' })
  await recordSourceEvent(f.catalog, { id: 'correct', documentId: f.document.document.id, sourceHash: f.document.document.rawHash, kind: 'correction', createdAt: new Date().toISOString(), reason: 'amended measurements' })
  const corrected = await researchContextForInput('supervisor', { runDir: f.runDir, idea: 'alpha' }, ctx)
  assert.ok(corrected.records.filter((r: any) => r.source.recordType === 'literature-span').every((r: any) => r.required && r.payload.reviewStatus === 're_review_required'))
}))
