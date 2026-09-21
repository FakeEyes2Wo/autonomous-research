import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { literatureFixture } from '../helpers/literature-context.ts'
import { SubagentRoleAgentProvider } from '../../dist/providers/subagent-provider.js'
import { DEFAULT_PROJECT_SETTINGS } from '../../dist/settings/schema.js'
import { createInitialState } from '../../dist/core/state.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createRunContext } from '../../dist/service/context.js'
import { runPlanner, runMinimalPlan, runWorker } from '../../dist/experiment/steps.js'
import { captureResearchPlan, freezeResearchCycle, cyclePath, commitResearchDecision, writeResearchReport } from '../../dist/service/research-cycle.js'
import { ResearchStore, hashContent, sealRecord, assessEvidence } from '../../dist/research/index.js'
import { recordSourceEvent } from '../../dist/literature/source-events.js'

async function setup(f: any, nominated: unknown, entry = 'minimal') {
  const prompts: { role: string; text: string }[] = []
  const provider = new SubagentRoleAgentProvider({ async start(_name: string, input: any) {
    prompts.push({ role: input.label, text: input.prompt[0].text })
    const structured = input.label === 'planner'
      ? { plan: 'Measure alpha independently.', protocol: { split: 'heldout', ...(nominated === undefined ? {} : { allowed_literature_span_ids: nominated }) } }
      : { status: 'completed', summary: 'Executed fixture.', artifacts: [`work/cycle-${String(ctx.state.cycle).padStart(2, '0')}/observation.json`] }
    if (input.label === 'research-worker') await writeFile(join(f.runDir, `work/cycle-${String(ctx.state.cycle).padStart(2, '0')}/observation.json`), '{}')
    return { id: `child-${prompts.length}`, result: Promise.resolve({ stopReason: 'completed', structured, output: [] }), async dispose() {} }
  } } as never)
  await writeFile(join(f.runDir, 'RUBRIC.md'), 'Use a fixed independent comparison.')
  const context = { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal,
    projectDir: f.project, runId: 'run', policySnapshot: { ...structuredClone(DEFAULT_PROJECT_SETTINGS), workflow: { ...DEFAULT_PROJECT_SETTINGS.workflow, currentIdeaSearch: 'never' }, literature: f.input.settings } }
  const ctx = createRunContext({ provider }, f.runDir, await createInitialState(f.runDir, 'run'), await ResearchTree.load(f.runDir), context)
  const plan = () => entry === 'legacy' ? runPlanner(ctx, { idea: 'alpha', profile: '' }) : runMinimalPlan(ctx, { idea: 'alpha', profile: '' })
  const work = () => runWorker(ctx, { workDir: join(f.runDir, 'work', `cycle-${String(ctx.state.cycle).padStart(2, '0')}`), planText: 'Measure alpha independently.', experimentDesign: '', minimalVerification: '' })
  return { ctx, prompts, plan, work }
}

for (const entry of ['minimal', 'legacy']) test(`planner ${entry} freezes only exposed literature and actual worker receives it`, async () => literatureFixture(async f => {
  const span = f.document.spans[0], other = f.document.spans[1]
  const s = await setup(f, [span.id], entry)
  await s.plan()
  assert.ok(s.prompts[0].text.includes(span.evidenceText))
  assert.ok(!s.prompts[0].text.includes(other.evidenceText))
  const frozen = await freezeResearchCycle(s.ctx, 'Measure alpha independently.', '')
  assert.deepEqual(frozen.protocol.allowed_literature_span_ids, [span.id])
  const { content_hash, ...body } = frozen.protocol
  assert.equal(content_hash, hashContent(body))
  assert.notEqual(content_hash, hashContent({ ...body, allowed_literature_span_ids: [] }))
  assert.ok(frozen.protocol.source_refs.some((ref: any) => ref.id === span.id && ref.path && ref.hash))
  await s.work()
  const worker = s.prompts.find(p => p.role === 'research-worker')!
  assert.ok(worker.text.includes(span.evidenceText))
  assert.ok(!worker.text.includes(other.evidenceText))
  assert.equal((await new ResearchStore(f.runDir).loadSnapshot(frozen.id)).content_hash, frozen.content_hash)
  // Replaying an already frozen cycle never replaces its contract with newly written planner bytes.
  await writeFile(cyclePath(s.ctx, 'planner-output.json'), JSON.stringify({ protocol: { allowed_literature_span_ids: [other.id] } }))
  assert.equal((await freezeResearchCycle(s.ctx, 'different plan', '')).content_hash, frozen.content_hash)
}))

for (const kind of ['unexposed', 'unknown', 'malformed', 'duplicate']) test(`planner rejects ${kind} literature nomination before freeze or worker`, async () => literatureFixture(async f => {
  const ids = kind === 'unexposed' ? [f.document.spans[1].id] : kind === 'unknown' ? ['invented-span'] : kind === 'malformed' ? 'not-an-array' : [f.document.spans[0].id, f.document.spans[0].id]
  const s = await setup(f, ids)
  await assert.rejects(s.plan(), /PLANNER_LITERATURE_/)
  assert.ok(!s.prompts[0].text.includes(f.document.spans[1].evidenceText))
  assert.equal(s.prompts.length, 1)
  assert.equal(await new ResearchStore(f.runDir).loadCurrent(), undefined)
  await assert.rejects(readFile(cyclePath(s.ctx, 'planner-output.json')), { code: 'ENOENT' })
}))

test('omission denies actor literature and new protocols do not inherit previous allowlists', async () => literatureFixture(async f => {
  const s = await setup(f, [f.document.spans[0].id])
  await s.plan()
  await freezeResearchCycle(s.ctx, 'alpha', '')
  s.ctx.state.cycle++
  await captureResearchPlan(s.ctx, { plan: 'Fresh experiment.', protocol: { split: 'fresh-heldout' } })
  const frozen = await freezeResearchCycle(s.ctx, 'Fresh experiment.', '')
  assert.equal(frozen.protocol.allowed_literature_span_ids, undefined)
  await s.work()
  const worker = s.prompts.find(p => p.role === 'research-worker')!
  for (const span of f.document.spans) assert.ok(!worker.text.includes(span.evidenceText))
}))

test('frozen nomination never bypasses live source revocation on worker retrieval', async () => literatureFixture(async f => {
  const s = await setup(f, [f.document.spans[0].id])
  await s.plan()
  await freezeResearchCycle(s.ctx, 'alpha', '')
  await recordSourceEvent(f.catalog, { id: 'revoked', documentId: f.document.document.id, createdAt: new Date().toISOString(), kind: 'access_revoked', sourceHash: f.document.document.rawHash, reason: 'withdrawn' })
  await assert.rejects(s.work(), /SOURCE_UNAVAILABLE/)
  assert.equal(s.prompts.filter(p => p.role === 'research-worker').length, 0)
}))

test('uncaptured planner allowlist cannot be introduced through saved output at freeze', async () => literatureFixture(async f => {
  const s = await setup(f, undefined)
  await s.plan()
  const file = cyclePath(s.ctx, 'planner-output.json')
  const output = JSON.parse(await readFile(file, 'utf8'))
  output.protocol.allowed_literature_span_ids = [f.document.spans[0].id]
  await writeFile(file, JSON.stringify(output))
  await assert.rejects(freezeResearchCycle(s.ctx, 'alpha', ''), /PLANNER_LITERATURE_/)
  assert.equal(await new ResearchStore(f.runDir).loadCurrent(), undefined)
}))

test('hypothesis revision clears the old actor allowlist even before the next planner freeze', async () => literatureFixture(async f => {
  const s = await setup(f, [f.document.spans[0].id])
  await s.plan()
  const frozen = await freezeResearchCycle(s.ctx, 'Measure alpha independently.', '')
  const store = new ResearchStore(f.runDir)
  const assessment = assessEvidence({ claim: frozen.claims[0], hypothesis: frozen.hypotheses[0], protocol: frozen.protocol, evidence: [] })
  const current = await store.commit(sealRecord({ ...frozen, id: 'needs-literature-revision', version: frozen.version + 1, parent_snapshot_id: frozen.id, assessment }), frozen.content_hash)
  await writeResearchReport(s.ctx, current)
  const source = current.protocol.source_refs.find((ref: any) => ref.id === f.document.spans[0].id)
  const candidate = { statement: 'Relevant alpha works under a narrower condition.', scope: 'fresh tasks', mechanism: 'relevance', prediction: 'gated alpha improves success', falsification: 'gated alpha reduces success', measurement: 'success', decision_rule: 'paired_sign_test_v1', evidence_ids: [], sourceSpanIds: [source.id], alternatives: [], distinguishes: [], unresolvedConstraints: [], rationale: 'The exposed source motivates a different condition.', changedAssumption: 'only relevant alpha helps', feasible: true, estimatedCost: null }
  const decision = await commitResearchDecision(s.ctx, { candidates: [candidate] }, { action: 'revise', reason: candidate.rationale }, undefined, { registeredSpans: [source] })
  assert.equal(decision.action, 'revise')
  const successor = await store.loadCurrent()
  assert.notEqual(successor.active_hypothesis.version, current.active_hypothesis.version)
  assert.equal(successor.protocol.allowed_literature_span_ids, undefined)
  assert.deepEqual((await store.loadSnapshot(current.id)).protocol.allowed_literature_span_ids, [source.id])
}))
