import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { literatureFixture } from '../helpers/literature-context.ts'
import { SubagentRoleAgentProvider } from '../../dist/providers/subagent-provider.js'
import { DEFAULT_PROJECT_SETTINGS } from '../../dist/settings/schema.js'
import { researchContextForInput } from '../../dist/service/research-context.js'
import { sealContextRecord } from '../../dist/research-context/index.js'
import { recordSourceEvent } from '../../dist/literature/source-events.js'
import { buildGeneration, publishGeneration } from '../../dist/literature/index-generation.js'
import { updateLiteratureKnowledge } from '../../dist/literature/context-adapter.js'
import { ResearchStore, sealRecord, assessEvidence } from '../../dist/research/index.js'
import { createInitialState } from '../../dist/core/state.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createRunContext } from '../../dist/service/context.js'
import { runSupervisor } from '../../dist/experiment/steps.js'
import { writeResearchReport } from '../../dist/service/research-cycle.js'
import { runIdeaGeneration } from '../../dist/service/steps/idea.js'
import { createClaimAssessment, saveClaimAssessment } from '../../dist/literature/claim-assessment.js'
import { buildPrompt } from '../../dist/agents/factory.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
function context(f: any, maxInputTokens = 24000) {
  return { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal, projectDir: f.project, runId: 'run',
    policySnapshot: { ...structuredClone(DEFAULT_PROJECT_SETTINGS), literature: f.input.settings, budget: { ...DEFAULT_PROJECT_SETTINGS.budget, maxInputTokens } } }
}
async function exposures(f: any) {
  const [rows] = await f.catalog.transact([{ sql: 'SELECT body FROM exposures ORDER BY rowid', params: [] }])
  return rows.map((row: any) => JSON.parse(row.body))
}

test('real final provider prompt, selected sources and captured manifest agree; retrieval alone is not exposure', async () => literatureFixture(async f => {
  const ctx = context(f)
  const request = await researchContextForInput('planner', { runDir: f.runDir, idea: 'alpha' }, ctx)
  assert.equal((await exposures(f)).length, 0)
  let actualPrompt = ''
  const provider = new SubagentRoleAgentProvider({ async start(_name: string, input: any) {
    actualPrompt = input.prompt[0].text
    assert.equal((await exposures(f))[0].status, 'prepared')
    return { id: 'child', result: Promise.resolve({ stopReason: 'completed', structured: { plan: 'done' }, output: [] }), async dispose() {} }
  } } as never)
  const result = await provider.run('planner', { runDir: f.runDir, idea: 'alpha', researchContext: request }, ctx)
  const events = await exposures(f)
  assert.deepEqual(events.map((e: any) => e.status), ['prepared', 'sent'])
  assert.equal(events[0].renderedHash, hash(actualPrompt))
  assert.deepEqual(events[0].spanIds, [f.document.spans[0].id])
  assert.ok(actualPrompt.includes(f.document.spans[0].evidenceText))
  assert.equal(result.literatureSources[0].sourceRef.id, f.document.spans[0].id)
  assert.equal(await readFile(join(f.runDir, result.literatureSources[0].sourceRef.path), 'utf8'), f.document.spans[0].evidenceText)
  const calls = await readdir(join(f.runDir, 'literature', 'calls'))
  const saved = JSON.parse(await readFile(join(f.runDir, 'literature', 'calls', calls[0]), 'utf8'))
  assert.equal(await readFile(join(f.runDir, saved.promptSource.path), 'utf8'), actualPrompt)
}))

test('transport uncertainty records unknown and never claims sent', async () => literatureFixture(async f => {
  const provider = new SubagentRoleAgentProvider({ async start() { throw new Error('connection lost after submission') } } as never)
  await assert.rejects(provider.run('planner', { runDir: f.runDir, idea: 'alpha' }, context(f)), /connection lost/)
  assert.deepEqual((await exposures(f)).map((e: any) => e.status), ['prepared', 'unknown'])
}))

test('optional retrieved spans omitted by the selector are absent from exposure and captured sources', async () => literatureFixture(async f => {
  const ctx = context(f, 24000)
  const request = await researchContextForInput('planner', { runDir: f.runDir, idea: 'mechanism' }, ctx)
  assert.equal(request.literature.receipt.selectedSpanIds.length, 2)
  // Fix the available record space independently of future changes to the system prompt.
  // It fits constraints plus one source, but cannot fit both complete source records.
  ctx.policySnapshot.budget.maxInputTokens = Math.ceil((await buildPrompt('planner', { runDir: f.runDir })).length / 4) + 650
  let prompt = ''
  const provider = new SubagentRoleAgentProvider({ async start(_name: string, input: any) {
    prompt = input.prompt[0].text
    return { id: 'child', result: Promise.resolve({ stopReason: 'completed', structured: { plan: 'done' }, output: [] }), async dispose() {} }
  } } as never)
  const output = await provider.run('planner', { runDir: f.runDir, researchContext: request }, ctx)
  const event = (await exposures(f))[0]
  assert.equal(event.spanIds.length, 1)
  assert.deepEqual(output.literatureSources.map((s: any) => s.spanId), event.spanIds)
  for (const span of f.document.spans) assert.equal(prompt.includes(span.evidenceText), event.spanIds.includes(span.id))
}))

test('a committed knowledge update prevents dispatch of a previously assembled generation', async () => literatureFixture(async f => {
  const ctx = context(f)
  const request = await researchContextForInput('planner', { runDir: f.runDir, idea: 'alpha' }, ctx)
  const next = await buildGeneration(f.catalog, f.root, f.document.spans.slice(0, 1), { expectedActiveId: f.generation.id, maxSpans: 100 })
  await publishGeneration(f.catalog, f.root, next.id, f.generation.id)
  await updateLiteratureKnowledge({ ...f.input, nextGenerationId: next.id, reason: 'accepted update', sourceEventIds: [] })
  let calls = 0
  const provider = new SubagentRoleAgentProvider({ async start() { calls++; throw new Error('stale generation dispatched') } } as never)
  await assert.rejects(provider.run('planner', { runDir: f.runDir, researchContext: request }, ctx), /LITERATURE_BINDING_CHANGED/)
  assert.equal(calls, 0)
}))

test('a real span ID with substituted rendered source text is rejected before transport', async () => literatureFixture(async f => {
  const ctx = context(f)
  const request = await researchContextForInput('planner', { runDir: f.runDir, idea: 'alpha' }, ctx)
  request.records = request.records.map((record: any) => {
    if (record.source.recordType !== 'literature-span') return record
    const { contentHash, ...body } = record
    return sealContextRecord({ ...body, payload: { ...body.payload, evidenceText: 'substituted claim' } })
  })
  let calls = 0
  const provider = new SubagentRoleAgentProvider({ async start() { calls++; throw new Error('should never dispatch') } } as never)
  await assert.rejects(provider.run('planner', { runDir: f.runDir, researchContext: request }, ctx), /LITERATURE_RENDERED_SOURCE_MISMATCH/)
  assert.equal(calls, 0)
}))

test('JSON repair records only complete source spans actually repeated in the repair prompt', async () => literatureFixture(async f => {
  let calls = 0
  const prompts: string[] = []
  const provider = new SubagentRoleAgentProvider({ async start(_name: string, input: any) {
    calls++; prompts.push(input.prompt[0].text)
    return { id: `child-${calls}`, result: Promise.resolve(calls === 1
      ? { stopReason: 'completed', output: [{ type: 'text', text: f.document.spans[0].evidenceText + ' BROKEN JSON' }] }
      : { stopReason: 'completed', structured: { plan: 'repaired' }, output: [] }), async dispose() {} }
  } } as never)
  await provider.run('planner', { runDir: f.runDir, idea: 'alpha' }, context(f))
  const events = await exposures(f)
  assert.equal(events.length, 4)
  assert.deepEqual(events[2].spanIds, [f.document.spans[0].id])
  assert.equal(events[2].renderedHash, hash(prompts[1]))
}))

test('fresh retrieval receipts do not restart a completed continuable worker with unchanged authorized source bytes', async () => literatureFixture(async f => {
  const { retrieveLiteratureContext } = await import('../../dist/literature/context-adapter.js')
  let listener: any, starts = 0
  const events = { on(_name: string, fn: any) { listener = fn } }
  const provider = new SubagentRoleAgentProvider({ async startContinuable(options: any) {
    starts++
    queueMicrotask(() => listener({ id: options.childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '{"result":"done"}' }] }))
    return { childId: options.childId }
  } } as never, { context: events } as never)
  for (let i = 0; i < 2; i++) {
    const request = await retrieveLiteratureContext({ ...f.input, role: 'research-worker', allowedSpanIds: [f.document.spans[0].id] })
    const result = await provider.run('research-worker', { runDir: f.runDir, taskId: 'frozen-task', researchContext: request }, context(f))
    assert.equal(result.literatureSources[0].spanId, f.document.spans[0].id)
  }
  assert.equal(starts, 1)
  assert.equal((await exposures(f)).length, 2)
}))

test('mandatory internal negative, OOM diagnosis and external counterevidence survive selector or fail before transport', async () => literatureFixture(async f => {
  const ctx = context(f)
  const request = await researchContextForInput('supervisor', { runDir: f.runDir, idea: 'alpha' }, ctx)
  const scope = { ...request.scope, visibility: 'run' }
  const counter = f.document.spans[1]
  const { retrieveLiteratureContext } = await import('../../dist/literature/context-adapter.js')
  const forced = await retrieveLiteratureContext({ ...f.input, role: 'supervisor', requiredSpanIds: [counter.id] })
  const records = [
    ...request.records.filter((r: any) => r.source.recordType !== 'literature-span'), ...forced.records,
    sealContextRecord({ id: 'valid-negative', version: 1, layer: 2, kind: 'evidence', scope, required: true, polarity: 'opposing', payload: { validity: 'valid', observation: 'Measured alpha decline', scientificUse: 'revision' }, source: { recordType: 'evidence' } }),
    sealContextRecord({ id: 'oom', version: 1, layer: 2, kind: 'evidence', scope, required: true, polarity: 'neutral', payload: { validity: 'invalid', observation: 'OOM', scientificUse: 'diagnosis_only' }, source: { recordType: 'evidence' } }),
  ]
  let prompt = '', calls = 0
  const provider = new SubagentRoleAgentProvider({ async start(_name: string, input: any) { calls++; prompt = input.prompt[0].text; return { id: 'child', result: Promise.resolve({ stopReason: 'completed', structured: { action: 'revise' }, output: [] }), async dispose() {} } } } as never)
  const grounded = { ...request, records, literature: forced.literature, requiredRecordIds: [counter.id] }
  await provider.run('supervisor', { runDir: f.runDir, researchContext: grounded }, ctx)
  assert.ok(prompt.includes('Measured alpha decline') && prompt.includes('diagnosis_only') && prompt.includes(counter.evidenceText))
  await assert.rejects(provider.run('supervisor', { runDir: f.runDir, researchContext: grounded }, context(f, 100)), { code: 'CONTEXT_INSUFFICIENT' })
  assert.equal(calls, 1)
  await recordSourceEvent(f.catalog, { id: 'revoked', documentId: f.document.document.id, createdAt: new Date().toISOString(), kind: 'access_revoked', sourceHash: f.document.document.rawHash, reason: 'access withdrawn' })
  await assert.rejects(provider.run('supervisor', { runDir: f.runDir, researchContext: grounded }, ctx), /SOURCE_UNAVAILABLE/)
  assert.equal(calls, 1)
}))

test('the real supervisor admits exposed literature refs, rejects invented span IDs, and commits an immutable successor', async () => literatureFixture(async f => {
  const store = new ResearchStore(f.runDir)
  const raw = await store.captureBytes('negative measurements', 'raw'), analysis = await store.captureBytes('paired sign test', 'analysis')
  const base = { version: 1, created_at: new Date().toISOString(), source_refs: [] }
  const claim = sealRecord({ ...base, id: 'claim', statement: 'alpha benefit', scope: 'tasks', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: 'intake' })
  const hypothesis = sealRecord({ ...base, id: 'hypothesis', statement: 'alpha benefit', claim: { id: 'claim', version: 1 }, parents: [], mechanism: 'alpha', alternatives: ['volume'], prediction: 'benefit', falsification: 'decline', measurement: 'accuracy', decision_rule: 'paired_sign_test_v1', scope: 'tasks', mode: 'formal', status: 'proposed' })
  const fingerprints = { code: 'code', data: 'data', treatment: 'treatment', model: 'model' }
  const protocol = sealRecord({ ...base, id: 'protocol', hypothesis: { id: 'hypothesis', version: 1 }, metric: 'accuracy', controls: ['baseline'], sample: '100 tasks', split: 'held-out', seeds: [1], budget: { unit: 'tokens', limit: 100, tolerance: 0 }, stopping_rule: '100 tasks', failure_policy: 'exclude_from_mechanism', missing_policy: 'unknown', duplicate_policy: 'block_conflicts', fingerprints, provenance: 'known', decision_rule: 'paired_sign_test_v1' })
  const negative = sealRecord({ ...base, id: 'negative', target_claim: { id: 'claim', version: 1 }, protocol_hash: protocol.content_hash, attempt_id: 'attempt', unit_id: 'unit', artifacts: [raw], analysis, validity: 'valid', polarity: 'opposes', execution: 'completed', observation: 'negative measured accuracy', sample_size: 100, effect: -0.2, interval: [-0.3, -0.1], split: 'held-out', mode: 'formal', fingerprints, validation: { method: 'paired_sign_test_v1', passed: true, issues: [] } })
  const oom = sealRecord({ ...negative, id: 'oom', protocol_hash: 'earlier-protocol', validity: 'invalid', polarity: 'inconclusive', execution: 'error', observation: 'OOM diagnosis only' })
  const assessment = assessEvidence({ claim, hypothesis, protocol, evidence: [negative] })
  const initial = sealRecord({ ...base, id: 'initial', schema: 'autoresearch/research-snapshot/v1', branch_id: 'main', claims: [claim], hypotheses: [hypothesis], protocol, evidence: [negative, oom], assessment, active_claim: { id: 'claim', version: 1 }, active_hypothesis: { id: 'hypothesis', version: 1 }, budget: { revisions: 0, repairs: 0, tokens: 0 } })
  await store.commit(initial)
  const span = f.document.spans[1]
  await saveClaimAssessment(f.runDir, createClaimAssessment({ claimId: 'claim', spanIds: [span.id], relation: 'refutes', conditions: [], assessor: 'human', assessorVersion: 'v1' }, f.document.spans), f.document.spans)
  const candidate = { statement: 'Only relevant alpha helps', scope: 'fresh tasks', mechanism: 'relevance', intervention: 'gate', prediction: 'gating improves', falsification: 'gating harms', measurement: 'accuracy', decision_rule: 'paired_sign_test_v1', evidence_ids: ['negative'], sourceSpanIds: [span.id], alternatives: ['volume'], distinguishes: ['volume'], unresolvedConstraints: [], rationale: 'negative result and counterexample require gating', parent: { id: 'hypothesis', version: 1 }, changedAssumption: 'relevance matters', feasible: true, estimatedCost: null }
  let prompt = ''
  const provider = new SubagentRoleAgentProvider({ async start(_name: string, input: any) {
    prompt = input.prompt[0].text
    return { id: 'child', result: Promise.resolve({ stopReason: 'completed', structured: { action: 'revise', reason: 'gating', candidates: [candidate, { ...candidate, sourceSpanIds: ['invented-span'] }] }, output: [] }), async dispose() {} }
  } } as never)
  const state = await createInitialState(f.runDir, 'run'), tree = await ResearchTree.load(f.runDir)
  const ctx = createRunContext({ provider, maxCycles: 3 }, f.runDir, state, tree, context(f))
  await writeResearchReport(ctx, initial)
  const decision = await runSupervisor(ctx, { planText: 'revise alpha based on valid negative and counterevidence' })
  assert.equal(decision.action, 'revise')
  assert.ok(prompt.includes('negative measured accuracy') && prompt.includes('OOM diagnosis only') && prompt.includes(span.evidenceText))
  const successor = await store.loadCurrent()
  assert.equal((await store.loadSnapshot(initial.id)).content_hash, initial.content_hash)
  const batch = successor.candidate_batches[0]
  assert.ok(batch.entries.some((e: any) => e.reasons.includes('unregistered_span') && e.candidate.status === 'rejected'))
  assert.ok(batch.entries.some((e: any) => e.candidate.status === 'selected'))
  assert.ok(successor.hypotheses.at(-1).discovery_source_ids.includes(span.id))
  assert.ok(successor.hypotheses.at(-1).source_refs.some((ref: any) => ref.id === span.id && ref.path && ref.hash))
}))

test('initial idea admission rejects an invented literature ID before reflexion and keeps captured discovery sources', async () => literatureFixture(async f => {
  let calls = 0
  const provider = new SubagentRoleAgentProvider({ async start() {
    calls++
    if (calls > 1) throw new Error('invented source reached reflexion')
    return { id: 'child', result: Promise.resolve({ stopReason: 'completed', structured: { hypotheses: [{ statement: 'alpha', sources: ['invented-span'], supported_premises: [] }] }, output: [] }), async dispose() {} }
  } } as never)
  const state = await createInitialState(f.runDir, 'run'), tree = await ResearchTree.load(f.runDir)
  const ctx = createRunContext({ provider, maxCycles: 3 }, f.runDir, state, tree, context(f))
  await runIdeaGeneration(ctx, { idea: 'alpha', profile: 'fixture' })
  assert.equal(calls, 1)
  assert.ok(tree.nodes.some((node: any) => node.status === 'rejected'))
  const capture = JSON.parse(await readFile(join(f.runDir, 'research', 'idea-capture.json'), 'utf8'))
  assert.ok(capture.source_refs.some((ref: any) => ref.id === f.document.spans[0].id && ref.path && ref.hash))
}))

for (const field of ['sources', 'supported_premises']) test(`reflexion cannot introduce unregistered ${field} into an eligible idea`, async () => literatureFixture(async f => {
  const draft = { statement: 'Test alpha.', intervention: 'Change alpha.', expected_effect: 'Accuracy rises.', supported_premises: [], predicted_observations: ['Accuracy rises.'], disconfirming_observations: ['Accuracy falls.'], sources: [f.document.spans[0].id] }
  const revised = field === 'sources' ? { sources: ['invented-reflexion-span'] } : { supported_premises: [{ statement: 'Fabricated premise', supporting_refs: ['invented-reflexion-span'] }] }
  const provider = new SubagentRoleAgentProvider({ async start(_name: string, options: any) {
    const structured = options.label === 'idea-generator' ? { hypotheses: [draft] } : { is_falsifiable: true, testable_implication: 'Compare accuracy.', unobservable_variables: [], critique: 'Reviewed.', unaddressed_risks: [], fatal_flaw_found: false, revised }
    return { id: options.label, result: Promise.resolve({ stopReason: 'completed', structured, output: [] }), async dispose() {} }
  } } as never)
  const ctx = createRunContext({ provider }, f.runDir, await createInitialState(f.runDir, 'run'), await ResearchTree.load(f.runDir), context(f))
  ctx.policySnapshot.workflow.reflexionRounds = 0
  await runIdeaGeneration(ctx, { idea: 'alpha', profile: '' })
  const pointer = JSON.parse(await readFile(join(f.runDir, 'research', 'idea-capture.json'), 'utf8'))
  const ref = pointer.source_refs.filter((ref: any) => ref.id === 'idea-generation-evaluations').at(-1)
  const evaluation = JSON.parse(await readFile(join(f.runDir, ref.path), 'utf8')).evaluations[0]
  assert.equal(evaluation.status, 'rejected')
  assert.ok(evaluation.reasons.includes('unregistered_source_span'))
  assert.equal(ctx.tree.get(evaluation.id).status, 'rejected')
  assert.ok(JSON.stringify(evaluation.revised).includes('invented-reflexion-span'), 'retain rejected raw revision for audit')
}))
