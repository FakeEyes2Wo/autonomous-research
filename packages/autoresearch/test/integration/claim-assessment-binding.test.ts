import assert from 'node:assert/strict'
import { test } from 'node:test'
import { literatureFixture } from '../helpers/literature-context.ts'
import { captureResearchPlan, freezeResearchCycle } from '../../dist/service/research-cycle.js'
import { researchContextForInput } from '../../dist/service/research-context.js'
import { createClaimAssessment, saveClaimAssessment, loadClaimAssessments } from '../../dist/literature/claim-assessment.js'
import { ResearchStore, sealRecord } from '../../dist/research/index.js'
import { SubagentRoleAgentProvider } from '../../dist/providers/subagent-provider.js'
import { DEFAULT_PROJECT_SETTINGS } from '../../dist/settings/schema.js'

async function scenario(f: any, options: { bound: boolean; revise?: boolean; relation?: 'supports' | 'refutes'; sameMeaning?: boolean; wrongHash?: boolean }) {
  const ctx = { runDir: f.runDir, state: { cycle: 1, runId: 'run' } }
  await captureResearchPlan(ctx as never, {})
  const frozen = await freezeResearchCycle(ctx as never, 'alpha improves the result', '')
  const claim = frozen.claims[0], span = f.document.spans[options.relation === 'refutes' ? 1 : 0]
  const assessment = createClaimAssessment({ claimId: claim.id,
    ...(options.bound ? { claimBinding: { version: claim.version, contentHash: options.wrongHash ? '0'.repeat(64) : claim.content_hash } } : {}),
    spanIds: [span.id], relation: options.relation ?? 'supports', conditions: [], assessor: 'human', assessorVersion: 'human-v1' }, f.document.spans)
  await saveClaimAssessment(f.runDir, assessment, f.document.spans)
  if (options.revise) {
    const revised = sealRecord({ ...claim, version: claim.version + 1, statement: options.sameMeaning ? claim.statement : 'alpha harms the result', parents: [frozen.active_claim] })
    await new ResearchStore(f.runDir).commit(sealRecord({ ...frozen, id: 'revised-snapshot', version: frozen.version + 1,
      parent_snapshot_id: frozen.id, claims: [...frozen.claims, revised], active_claim: { id: revised.id, version: revised.version } }), frozen.content_hash)
  }
  const context = { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal,
    projectDir: f.project, runId: 'run', policySnapshot: { ...structuredClone(DEFAULT_PROJECT_SETTINGS), literature: f.input.settings } }
  const request = await researchContextForInput('planner', { runDir: f.runDir }, context)
  const record: any = request!.records.find(r => r.id === span.id)
  let prompt = ''
  const provider = new SubagentRoleAgentProvider({ async start(_name: string, input: any) {
    prompt = input.prompt[0].text
    return { id: 'binding-fixture', result: Promise.resolve({ stopReason: 'completed', structured: { plan: 'review evidence' }, output: [] }), async dispose() {} }
  } } as never)
  await provider.run('planner', { runDir: f.runDir, researchContext: request }, context)
  assert.ok(prompt.includes(span.evidenceText), 'the actual provider prompt must retain the source bytes')
  assert.deepEqual(await loadClaimAssessments(f.runDir), [assessment], 'context cannot rewrite immutable review history')
  return { assessment, claim, span, request, record, semantic: record.payload.claimAssessments[0], prompt }
}

test('exact committed claim binding preserves a reviewed relation through the real provider', async () => literatureFixture(async f => {
  const result = await scenario(f, { bound: true })
  assert.deepEqual(result.assessment.claimBinding, { version: result.claim.version, contentHash: result.claim.content_hash })
  assert.equal(result.semantic.relation, 'supports')
  assert.notEqual(result.semantic.reviewStatus, 're_review_required')
}))

test('changed claim meaning cannot inherit historical human support in the final provider prompt', async () => literatureFixture(async f => {
  const result = await scenario(f, { bound: true, revise: true })
  assert.equal(result.semantic.relation, 'unknown')
  assert.equal(result.semantic.originalRelation, 'supports')
  assert.equal(result.semantic.reviewStatus, 're_review_required')
  assert.match(result.prompt, /"reviewStatus"\s*:\s*"re_review_required"/)
  assert.match(result.prompt, /"relation"\s*:\s*"unknown"/)
}))

test('legacy unbound assessments require review even when the claim ID is unchanged', async () => literatureFixture(async f => {
  const result = await scenario(f, { bound: false })
  assert.equal(result.semantic.relation, 'unknown')
  assert.equal(result.semantic.originalRelation, 'supports')
  assert.equal(result.semantic.reviewStatus, 're_review_required')
}))

test('stale refutation remains a required source while its relation awaits review', async () => literatureFixture(async f => {
  const result = await scenario(f, { bound: true, revise: true, relation: 'refutes' })
  assert.equal(result.semantic.relation, 'unknown')
  assert.equal(result.semantic.originalRelation, 'refutes')
  assert.equal(result.record.required, true)
  assert.ok(result.request!.requiredRecordIds!.includes(result.span.id))
  assert.match(result.prompt, /"originalRelation"\s*:\s*"refutes"/)
}))

test('strict version binding requires re-review even for a same-meaning successor', async () => literatureFixture(async f => {
  const result = await scenario(f, { bound: true, revise: true, sameMeaning: true })
  assert.equal(result.semantic.relation, 'unknown')
  assert.equal(result.semantic.reviewStatus, 're_review_required')
}))

test('matching claim ID and version cannot substitute for the exact committed content hash', async () => literatureFixture(async f => {
  const result = await scenario(f, { bound: true, wrongHash: true })
  assert.equal(result.semantic.relation, 'unknown')
  assert.equal(result.semantic.originalRelation, 'supports')
  assert.equal(result.semantic.reviewStatus, 're_review_required')
}))
