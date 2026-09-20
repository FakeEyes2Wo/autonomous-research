import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInitialState } from '../../dist/core/state.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createRunContext } from '../../dist/service/context.js'
import { ResearchStore } from '../../dist/research/store.js'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { FakeAgentProvider } from '../integration/fake-agent-provider.ts'
import { openRequestLedger } from '../../dist/policy/request-ledger.js'
import { bindRunProject } from '../../dist/service/project-paper.js'
import { prepareStartup } from '../../dist/startup/prepare.js'
import { saveState } from '../../dist/core/state.js'
import { captureResearchPlan, freezeResearchCycle, assessResearchCycle, commitResearchDecision, committedDecision } from '../../dist/service/research-cycle.js'
import { toResearchRunOptions } from '../../dist/tools/options.js'
import { ProjectDirectionMemoryStore } from '../../dist/memory/direction-memory.js'

const api = await import('../../dist/service/continuation.js').catch(() => ({})) as any
const acceptance = { criteria: [{ id: 'artifact', required: true, text: 'Produce checked bytes', evidenceKind: 'artifact' }] }
async function fixture(t: any, reviewer: (input: any) => any) {
  const runDir = await mkdtemp(join(tmpdir(), 'continuation-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, 'input'))
  await writeFile(join(runDir, 'input/idea.md'), 'Implement and check the full goal')
  const state = await createInitialState(runDir)
  const calls: any[] = []
  const provider = { run: async (role: any, input: any) => { calls.push({ role, input }); return { text: '', structured: await reviewer(input), stopReason: 'completed' } } }
  const ctx = createRunContext({ provider, acceptance, maxCycles: 8 }, runDir, state, await ResearchTree.load(runDir), { parent: { id: 'test', session: { id: 'test' } }, signal: new AbortController().signal })
  return { ctx, calls, runDir }
}
const pause = { action: 'pause', reason: 'Required evidence unavailable', criteria: [], blockers: ['unfinished'], unsupportedClaims: [], followups: [] }

for (const path of ['./continuation/state.json', '.\\continuation\\state.json']) for (const seam of ['inspect', 'startup', 'service']) test(`final recovery rejects canonical controller alias before mutation: ${seam}/${path}`, async t => {
  const { ctx, runDir, calls } = await fixture(t, () => pause)
  await bindRunProject({ runDir }, undefined, true)
  await api.initializeContinuation(ctx); await api.loadOrReviewContinuation(ctx)
  ctx.state.status = 'PAUSED'; await saveState(runDir, ctx.state)
  const before = await readFile(join(runDir, 'continuation/state.json'), 'utf8')
  const sources = await readdir(join(runDir, 'research/sources')), n = calls.length
  const recovery = { changedCondition: 'Controller bytes changed', newEvidencePaths: [path], criterionIds: ['artifact'] }
  if (seam === 'inspect') await assert.rejects(api.inspectRecovery(runDir, recovery), /controller/)
  if (seam === 'startup') {
    const result = await prepareStartup({ intent: 'resume', projectDir: runDir, runDir, recovery })
    assert.equal(result.status, 'blocked'); assert.equal(result.nextAction, undefined)
  }
  if (seam === 'service') await assert.rejects(new AutoResearchService(ctx.deps.provider).run({ runDir, recovery }, ctx.context), /controller/)
  assert.equal(await readFile(join(runDir, 'continuation/state.json'), 'utf8'), before)
  assert.deepEqual(await readdir(join(runDir, 'research/sources')), sources)
  await assert.rejects(readdir(join(runDir, 'continuation/controls')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(runDir, 'request-ledger.json')), { code: 'ENOENT' })
  assert.equal(calls.length, n)
})

test('final recovery deduplicates external filesystem aliases into one admitted source', async t => {
  const { ctx, runDir } = await fixture(t, () => pause)
  await api.initializeContinuation(ctx)
  await writeFile(join(runDir, 'review.txt'), 'independent external review')
  const recovery = { changedCondition: 'External review arrived', newEvidencePaths: ['review.txt', './review.txt', '.\\review.txt'], criterionIds: ['artifact'] }
  assert.deepEqual((await api.inspectRecovery(runDir, recovery)).paths, ['review.txt'])
  const control = await api.validateRecovery(runDir, recovery)
  assert.equal(control.sourceRefs.length, 1); assert.equal(control.sourceRefs[0].id, 'review.txt')
  assert.deepEqual(control.criterionIds, ['artifact'])
})

for (const scenario of ['preexisting', 'case-alias', 'receipt-alias', 'cached-changed', 'cached-valid', 'raw-deleted', 'baseline-changed', 'raw-only']) test(`task-local artifact authority: ${scenario}`, async t => {
  const { ctx, runDir } = await fixture(t, () => pause)
  await api.initializeContinuation(ctx)
  await writeFile(join(runDir, 'seed.txt'), 'seed')
  await api.addContinuationEvidence(ctx, [await new ResearchStore(runDir).captureSource('seed.txt')])
  const state = await api.readContinuation(runDir)
  const { mergeFollowups } = await import('../../dist/research/continuation.js')
  state.queue = mergeFollowups([], [{ kind: 'investigate', criterionIds: ['artifact'], task: 'Inspect', changedCondition: '', sourceRefs: state.evidence }], state.acceptance, state.evidence)
  await writeFile(join(runDir, 'continuation/state.json'), JSON.stringify(state))
  const root = join(runDir, 'continuation/tasks', `${state.queue[0].fingerprint}-g0`), work = join(root, 'work')
  await mkdir(work, { recursive: true })
  if (scenario === 'preexisting' || scenario === 'case-alias') await writeFile(join(work, 'result.txt'), 'old user bytes')
  if (scenario === 'case-alias' || scenario === 'receipt-alias') {
    await writeFile(join(work, 'case-probe'), 'probe')
    try { if (await realpath(join(work, 'CASE-PROBE')) !== await realpath(join(work, 'case-probe'))) return t.skip('distinct case identities') }
    catch { return t.skip('filesystem is case-sensitive') }
  }
  let workers = 0
  ctx.deps.provider.run = async (role: string, input: any) => {
    if (role === 'planner') return { text: '', stopReason: 'completed', structured: { plan: 'Inspect', riskLevel: 'low' } }
    if (role === 'research-worker') {
      workers++
      if (scenario !== 'case-alias') await writeFile(join(input.workDir, 'result.txt'), 'checked bytes')
      return { text: '', stopReason: 'completed', structured: { status: 'completed', summary: 'checked', artifacts: [join(input.workDir, scenario === 'case-alias' ? 'RESULT.txt' : 'result.txt').slice(runDir.length + 1).replaceAll('\\', '/')] } }
    }
    return { text: '', stopReason: 'completed', structured: pause }
  }
  if (scenario === 'preexisting' || scenario === 'case-alias') {
    await assert.rejects(api.runContinuationTasks(ctx), /preexisting|baseline|ownership/i)
    if (scenario === 'case-alias') {
      assert.equal(await readFile(join(work, 'result.txt'), 'utf8'), 'old user bytes')
      const { hashBytes } = await import('../../dist/research/records.js')
      await assert.rejects(readFile(join(runDir, 'research/sources', hashBytes('old user bytes'))), { code: 'ENOENT' })
      await assert.rejects(readFile(join(root, 'validated-result.json')), { code: 'ENOENT' })
      assert.equal((await api.readContinuation(runDir)).evidence.length, state.evidence.length)
    }
  } else {
    await api.runContinuationTasks(ctx)
    const saved = await api.readContinuation(runDir)
    saved.queue[0].status = 'running'
    await writeFile(join(runDir, 'continuation/state.json'), JSON.stringify(saved))
    if (scenario === 'cached-changed') await writeFile(join(work, 'result.txt'), 'tampered')
    if (scenario === 'baseline-changed') await writeFile(join(root, 'baseline.json'), '{}')
    if (scenario === 'raw-only') await rm(join(root, 'validated-result.json'), { force: true })
    if (scenario === 'receipt-alias') {
      const receiptPath = join(root, 'validated-result.json'), { hash: _hash, ...body } = JSON.parse(await readFile(receiptPath, 'utf8'))
      body.files[0].path = body.files[0].path.replace('result.txt', 'RESULT.txt')
      const { hashContent } = await import('../../dist/research/records.js')
      await writeFile(receiptPath, JSON.stringify({ ...body, hash: hashContent(body) }))
    }
    if (scenario === 'cached-valid' || scenario === 'raw-deleted' || scenario === 'receipt-alias') {
      if (scenario === 'raw-deleted') await rm(join(root, 'result.json'))
      else await writeFile(join(root, 'result.json'), JSON.stringify({ status: 'completed', summary: 'forged', artifacts: ['seed.txt'] }))
      await api.runContinuationTasks(ctx)
      assert.equal((await api.readContinuation(runDir)).queue[0].status, 'completed')
    } else await assert.rejects(api.runContinuationTasks(ctx), /receipt|hash|changed|unknown/i)
  }
  assert.equal(workers, 1)
  assert.equal(await new ResearchStore(runDir).loadCurrent(), undefined)
  await assert.rejects(readdir(join(runDir, '.autoresearch/directions')), { code: 'ENOENT' })
})

test('round1 post-delivery evidence invalidates finish shortcut and commits a fresh paired decision', async t => {
  let reject = false
  const { ctx, runDir, calls } = await fixture(t, input => reject ? { ...pause, blockers: ['Paper contradicts the checked artifact'] } : { action: 'complete', reason: 'Checked artifact', criteria: [{ id: 'artifact', status: 'met', sourceRefs: JSON.parse(input.continuation).sourceRefs }], blockers: [], unsupportedClaims: [], followups: [] })
  await api.initializeContinuation(ctx); await assessedFixture(ctx)
  const finish = { action: 'finish', reason: 'Ready' }
  await commitResearchDecision(ctx, finish, finish, undefined, { deliveryReady: true })
  const store = new ResearchStore(runDir), old = await store.loadCurrent()
  assert.equal((await committedDecision(ctx))?.action, 'finish')
  await mkdir(join(runDir, 'paper')); await writeFile(join(runDir, 'paper/main.tex'), 'New paper contradicts checked bytes')
  await api.addContinuationEvidence(ctx, [await store.captureSource('paper/main.tex')]); reject = true
  const n = calls.length
  assert.equal(await committedDecision(ctx), undefined, 'stale shortcut cannot replay finish')
  assert.equal(calls.length, n, 'shortcut checks are read-only')
  await assert.rejects(commitResearchDecision(ctx, finish, finish, undefined, { deliveryReady: true }), /pause|contradict|follow-up/i)
  const current = await store.loadCurrent()
  assert.equal(current.decision.action, 'pause')
  assert.equal(current.decision.id, 'decision-1-r1')
  assert.deepEqual(current.candidate_batches.map(b => b.id), ['candidate-batch-1-r0', 'candidate-batch-1-r1'])
  assert.equal((await store.loadSnapshot(old.id)).decision.action, 'finish')
})

for (const failure of ['worker', 'risk', 'unknown']) test(`round1 ${failure} failure recovery preserves receipts and charges a distinct confirmed retry only`, async t => {
  const { ctx, runDir } = await fixture(t, () => pause)
  await api.initializeContinuation(ctx)
  await writeFile(join(runDir, 'seed.txt'), 'original bytes')
  await api.addContinuationEvidence(ctx, [await new ResearchStore(runDir).captureSource('seed.txt')])
  let recover = false, completed = false, workers = 0, risks = 0
  const workIds: string[] = []
  ctx.deps.provider.run = async (role: string, input: any) => {
    let structured: any
    if (role === 'planner') structured = { plan: 'Inspect scoped boundary', riskLevel: failure === 'risk' ? 'medium' : 'low' }
    else if (role === 'experiment-reflexion') { risks++; structured = { verdict: recover ? 'proceed' : 'revise' } }
    else if (role === 'research-worker') {
      workers++; workIds.push(input.taskId)
      if (failure === 'unknown') throw new Error('transport lost')
      if (!recover) structured = { status: 'failed', summary: 'Confirmed failed execution', artifacts: [] }
      else { const path = join(input.workDir, 'result.txt'); await writeFile(path, 'fixed'); completed = true; structured = { status: 'completed', summary: 'fixed', artifacts: [path.slice(runDir.length + 1).replaceAll('\\', '/')] } }
    } else {
      const m = JSON.parse(input.continuation)
      structured = completed ? { action: 'complete', reason: 'Repair checked', criteria: [{ id: 'artifact', status: 'met', sourceRefs: m.sourceRefs }], blockers: [], unsupportedClaims: [], followups: [] } : { ...pause, action: 'followup', followups: [{ mechanismKey: 'f'.repeat(64), kind: recover ? 'repair' : 'investigate', criterionIds: ['artifact'], task: 'Check boundary', changedCondition: recover ? 'New verified implementation bytes' : '', sourceRefs: [m.sourceRefs.find(r => r.hash === m.controlRevision.sourceRefs?.at(-1)?.hash) ?? m.sourceRefs[0]] }] }
    }
    return { text: '', stopReason: 'completed', structured }
  }
  ctx.policySnapshot.workflow.experimentReview = 'enabled'
  await api.loadOrReviewContinuation(ctx)
  await assert.rejects(api.runContinuationTasks(ctx), /failed|risk|transport/)
  const debit = ctx.state.cycle, before = { workers, risks }
  await assert.rejects(api.runContinuationTasks(ctx), /failed|risk|unknown|confirmed/)
  assert.deepEqual({ workers, risks }, before)
  assert.equal(ctx.state.cycle, debit)
  await writeFile(join(runDir, 'seed.txt'), 'externally corrected bytes'); recover = true
  await api.validateRecovery(runDir, { changedCondition: 'Implementation was corrected', newEvidencePaths: ['seed.txt'] })
  await api.loadOrReviewContinuation(ctx)
  if (failure === 'unknown') {
    await assert.rejects(api.runContinuationTasks(ctx), /unknown/)
    assert.equal(workers, 1); assert.equal(ctx.state.cycle, debit)
  } else {
    assert.equal((await api.runContinuationTasks(ctx)).action, 'complete')
    assert.equal(ctx.state.cycle, debit + 1)
    const queue = (await api.readContinuation(runDir)).queue
    assert.equal(queue.length, 1); assert.equal(queue[0].generation, 1)
    if (failure === 'worker') assert.equal(new Set(workIds).size, 2)
    else assert.equal(risks, 2)
    const oldRoot = join(runDir, 'continuation/tasks', `${queue[0].fingerprint}-g0`)
    assert.ok(await readFile(join(oldRoot, failure === 'worker' ? 'result.json' : 'risk-review.json'), 'utf8'))
  }
})

for (const crashAt of ['control-publication', 'running-publication', 'consumed-before-dispatch']) test(`round1 recovery crash at ${crashAt} reconciles authorized control once`, async t => {
  const { ctx, runDir } = await fixture(t, () => pause)
  await bindRunProject({ runDir }, undefined, true); await api.initializeContinuation(ctx)
  await api.loadOrReviewContinuation(ctx); ctx.state.status = 'PAUSED'; await saveState(runDir, ctx.state)
  await writeFile(join(runDir, 'review.txt'), 'new external review')
  const recovery = { changedCondition: 'New review arrived', criterionIds: ['artifact'], newEvidencePaths: ['review.txt'] }
  await api.validateRecovery(runDir, recovery, 9) // Inject crash before publishing RUNNING.
  assert.equal((await api.validateRecovery(runDir, recovery, 9)).revision, 1, 'same pending transaction is idempotent')
  if (crashAt !== 'control-publication') { ctx.state.status = 'RUNNING'; await saveState(runDir, ctx.state) }
  if (crashAt === 'consumed-before-dispatch') await api.consumeRecovery(runDir)
  const provider = new FakeAgentProvider({ decisions: ['finish'] }), service = new AutoResearchService(provider)
  const context = { parent: { id: 'recovery', session: { id: 'recovery' } }, signal: new AbortController().signal }
  assert.equal((await service.run({ runDir }, context)).status, 'PAUSED')
  assert.equal(provider.calls.filter(role => role === 'coverage-reviewer').length, 3)
  assert.equal((await api.readContinuation(runDir)).control.revision, 1)
  const n = provider.calls.length
  await service.run({ runDir }, context); assert.equal(provider.calls.length, n)
  await assert.rejects(api.validateRecovery(runDir, recovery, 9), /changed|new/)
})

test('round1 stale CAS retry rechecks coverage and preserves the competing finish as immutable history', async t => {
  let reject = false
  const { ctx, runDir } = await fixture(t, input => reject ? pause : { action: 'complete', reason: 'Checked before publication', criteria: [{ id: 'artifact', status: 'met', sourceRefs: JSON.parse(input.continuation).sourceRefs }], blockers: [], unsupportedClaims: [], followups: [] })
  await api.initializeContinuation(ctx); await assessedFixture(ctx)
  const original = ResearchStore.prototype.commit
  let injected = false
  ResearchStore.prototype.commit = async function(snapshot, expectedHash) {
    if (!injected && snapshot.decision?.action === 'finish') {
      injected = true
      await original.call(this, snapshot, expectedHash)
      await writeFile(join(runDir, 'new-paper.txt'), 'Late contradictory delivery bytes')
      await api.addContinuationEvidence(ctx, [await this.captureSource('new-paper.txt')]); reject = true
      throw new Error('stale snapshot hash; injected competing writer')
    }
    return original.call(this, snapshot, expectedHash)
  }
  try {
    const finish = { action: 'finish', reason: 'Ready' }
    await assert.rejects(commitResearchDecision(ctx, finish, finish, undefined, { deliveryReady: true }), /pause|follow-up/)
    const current = await new ResearchStore(runDir).loadCurrent()
    assert.equal(current.decision.id, 'decision-1-r1'); assert.equal(current.decision.action, 'pause')
    assert.equal(current.candidate_batches.length, 2)
  } finally { ResearchStore.prototype.commit = original }
})

for (const formal of [false, true]) test(`round1 derived static audit can finish only without a known scientific obligation (formal=${formal})`, async t => {
  const { ctx, runDir } = await fixture(t, input => {
    const refs = JSON.parse(input.continuation).sourceRefs
    return { action: 'complete', reason: 'Static obligations independently checked', criteria: [{ id: 'goal-coverage', status: 'met', sourceRefs: refs }, { id: 'scientific-claims', status: 'not_applicable', rationale: 'Static code audit and captured inspection contain no empirical claims.', sourceRefs: refs }], blockers: [], unsupportedClaims: [], followups: [] }
  })
  await writeFile(join(runDir, 'input/idea.md'), 'Perform a static code audit; make no empirical performance claims.')
  const derived = { ...ctx, deps: { ...ctx.deps, acceptance: undefined } }
  await api.initializeContinuation(derived); await assessedFixture(derived, formal)
  const finish = { action: 'finish', reason: 'Static audit ready' }
  if (formal) await assert.rejects(commitResearchDecision(derived, finish, finish, undefined, { deliveryReady: true }), /applicability|pause/)
  else assert.equal((await commitResearchDecision(derived, finish, finish, undefined, { deliveryReady: true })).action, 'finish')
})

test('independent coverage receipt is reused after decision crash and missing required coverage runs two complementary searches', async t => {
  assert.equal(typeof api.loadOrReviewContinuation, 'function')
  const { ctx, calls } = await fixture(t, () => pause)
  await api.initializeContinuation(ctx)
  const first = await api.loadOrReviewContinuation(ctx)
  assert.equal(first.action, 'pause')
  assert.deepEqual(calls.map(c => JSON.parse(c.input.continuation).strategy), ['coverage', 'boundary-invariant', 'interaction-cross-check'])
  const n = calls.length
  const second = await api.loadOrReviewContinuation(ctx)
  assert.deepEqual(second, first)
  assert.equal(calls.length, n)
  assert.ok(calls.every(c => c.role === 'coverage-reviewer' && c.input.taskId.startsWith('coverage-review:')))
})

test('review dispatch with unknown result is durably paused rather than paid again', async t => {
  assert.equal(typeof api.loadOrReviewContinuation, 'function')
  const { ctx, calls } = await fixture(t, () => { throw new Error('transport lost after dispatch') })
  await api.initializeContinuation(ctx)
  await assert.rejects(api.loadOrReviewContinuation(ctx), /unknown|unresolved/i)
  await assert.rejects(api.loadOrReviewContinuation(ctx), /unknown|unresolved/i)
  assert.equal(calls.length, 1)
})

test('recovery rejects prose-only, internal controller files and unrelated bytes, and captures relevant changed bytes once', async t => {
  assert.equal(typeof api.validateRecovery, 'function')
  const { ctx, runDir } = await fixture(t, () => pause)
  await api.initializeContinuation(ctx)
  await writeFile(join(runDir, 'result.txt'), 'old')
  const source = await new ResearchStore(runDir).captureSource('result.txt')
  await api.addContinuationEvidence(ctx, [source])
  await api.loadOrReviewContinuation(ctx)
  await assert.rejects(api.validateRecovery(runDir, { changedCondition: 'Please retry' }), /changed|relevant/i)
  await assert.rejects(api.validateRecovery(runDir, { changedCondition: 'Controller changed', newEvidencePaths: ['continuation/state.json'] }), /controller|relevant/i)
  await writeFile(join(runDir, 'unrelated.txt'), 'unrelated')
  await assert.rejects(api.validateRecovery(runDir, { changedCondition: 'Anything new', newEvidencePaths: ['unrelated.txt'] }), /relevant/i)
  await writeFile(join(runDir, 'result.txt'), 'new')
  const revision = await api.validateRecovery(runDir, { changedCondition: 'Result bytes corrected', newEvidencePaths: ['result.txt'] })
  assert.equal(revision.revision, 1)
  assert.equal(revision.maxCycles, 8)
  assert.equal(await readFile(join(runDir, revision.sourceRefs[0].path), 'utf8'), 'new')
  await assert.rejects(api.validateRecovery(runDir, { changedCondition: 'Reworded', newEvidencePaths: ['result.txt'] }), /changed|new/i)
  const increased = await api.validateRecovery(runDir, { changedCondition: 'Allow one additional total cycle' }, 9)
  assert.equal(increased.revision, 2)
  assert.equal(increased.maxCycles, 9)
  await assert.rejects(api.validateRecovery(runDir, { changedCondition: 'Reset cycles' }, 2), /decrease|monotonic/i)
})

test('contract is immutable on resume and cap omission inherits the frozen cumulative cap', async t => {
  assert.equal(typeof api.initializeContinuation, 'function')
  const { ctx } = await fixture(t, () => pause)
  const first = await api.initializeContinuation(ctx)
  const second = await api.initializeContinuation({ ...ctx, deps: { ...ctx.deps, maxCycles: undefined } })
  assert.equal(second.control.maxCycles, first.control.maxCycles)
  await assert.rejects(api.initializeContinuation({ ...ctx, deps: { ...ctx.deps, acceptance: { criteria: [{ ...acceptance.criteria[0], text: 'Replace the goal' }] } } }), /immutable|acceptance/i)
})

test('supervisor finish with tests green and one artifact pauses; unchanged service resume makes zero additional calls', async t => {
  const { runDir } = await fixture(t, () => pause)
  await mkdir(join(runDir, '.autoresearch'), { recursive: true })
  await writeFile(join(runDir, '.autoresearch/project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  paper: never\n  experimentReview: never\n')
  const provider = new FakeAgentProvider({ decisions: ['finish'] })
  const service = new AutoResearchService(provider)
  const context = { parent: { id: 'integration', session: { id: 'integration' } }, signal: new AbortController().signal }
  const first = await service.run({ runDir, acceptance, maxCycles: 8 }, context)
  assert.equal(first.status, 'PAUSED', 'supervisor finish cannot replace independent goal acceptance')
  assert.equal(provider.calls.filter(role => role === 'coverage-reviewer').length, 3)
  const calls = provider.calls.length
  const second = await service.run({ runDir }, context)
  assert.equal(second.status, 'PAUSED')
  assert.equal(provider.calls.length, calls)
})

test('five genuinely new scoped follow-ups continue past cycle four and preserve the scientific snapshot', async t => {
  assert.equal(typeof api.runContinuationTasks, 'function')
  const { ctx, runDir, calls } = await fixture(t, () => pause)
  await api.initializeContinuation(ctx)
  await writeFile(join(runDir, 'seed.txt'), 'initial evidence')
  await api.addContinuationEvidence(ctx, [await new ResearchStore(runDir).captureSource('seed.txt')])
  let done = 0
  ctx.deps.provider.run = async (role: string, input: any) => {
    calls.push({ role, input })
    if (role === 'planner') return { text: '', structured: { plan: 'Investigate the next boundary', riskLevel: 'low' }, stopReason: 'completed' }
    if (role === 'research-worker') {
      done++
      await mkdir(input.workDir, { recursive: true })
      const path = join(input.workDir, 'result.txt')
      await writeFile(path, `New gap evidence ${done}`)
      return { text: '', structured: { status: 'completed', summary: 'Inspected', artifacts: [path.slice(runDir.length + 1).replaceAll('\\', '/')] }, stopReason: 'completed' }
    }
    const manifest = JSON.parse(input.continuation)
    const refs = manifest.sourceRefs
    if (done === 5) return { text: '', stopReason: 'completed', structured: { action: 'complete', reason: 'All five scoped boundaries checked', criteria: [{ id: 'artifact', status: 'met', sourceRefs: refs }], blockers: [], unsupportedClaims: [], followups: [] } }
    const source = done ? refs.find((ref: any) => ref.id.includes('continuation/tasks') && ref.hash && !manifest.queue.some((item: any) => item.sourceRefs.some((old: any) => old.hash === ref.hash))) : refs[0]
    return { text: '', stopReason: 'completed', structured: { ...pause, action: 'followup', followups: [{ kind: done % 2 ? 'repair' : 'investigate', criterionIds: ['artifact'], task: `Check discovered gap ${done + 1}`, changedCondition: 'Prior investigation exposed a distinct gap', sourceRefs: [source] }] } }
  }
  assert.equal((await api.loadOrReviewContinuation(ctx)).action, 'followup')
  const result = await api.runContinuationTasks(ctx)
  assert.equal(result.action, 'complete')
  assert.equal(done, 5)
  assert.equal(ctx.state.cycle, 6)
  assert.equal(await new ResearchStore(runDir).loadCurrent(), undefined, 'investigation must not create or modify scientific records')
  assert.equal((await api.readContinuation(runDir)).queue.filter((item: any) => item.status === 'completed').length, 5)
})

test('native acceptance/recovery normalization rejects extra fields and malformed links or paths', () => {
  assert.throws(() => toResearchRunOptions({ runDir: 'run', acceptance: { ...acceptance, forged: true } }), /acceptance/)
  assert.throws(() => toResearchRunOptions({ runDir: 'run', recovery: { changedCondition: 'x', newEvidencePaths: ['../foreign'] } }), /paths/)
  assert.throws(() => toResearchRunOptions({ runDir: 'run', recovery: { changedCondition: 'x', criterionIds: [] } }), /criterionIds/)
  assert.throws(() => toResearchRunOptions({ runDir: 'run', recovery: { changedCondition: 'x', resetBudget: true } }), /fields/)
})

test('read-only startup exposes explicit linked new-file recovery without writing captures or controls', async t => {
  const { ctx, runDir } = await fixture(t, () => pause)
  await bindRunProject({ runDir }, undefined, true)
  await api.initializeContinuation(ctx)
  await api.loadOrReviewContinuation(ctx)
  ctx.state.status = 'PAUSED'; await saveState(runDir, ctx.state)
  const projectDir = runDir
  assert.equal((await prepareStartup({ intent: 'resume', projectDir, runDir })).nextAction, undefined)
  await writeFile(join(runDir, 'new-review.txt'), 'Independent externally supplied review bytes')
  const recovery = { changedCondition: 'New independent review arrived', newEvidencePaths: ['new-review.txt'], criterionIds: ['artifact'] }
  const before = await readFile(join(runDir, 'continuation/state.json'), 'utf8')
  const sources = await readdir(join(runDir, 'research/sources'))
  const prepared = await prepareStartup({ intent: 'resume', projectDir, runDir, recovery })
  assert.equal(prepared.status, 'resumable')
  assert.deepEqual(prepared.nextAction?.args.recovery, recovery)
  assert.equal(await readFile(join(runDir, 'continuation/state.json'), 'utf8'), before)
  assert.deepEqual(await readdir(join(runDir, 'research/sources')), sources)
  const control = await api.validateRecovery(runDir, recovery)
  assert.deepEqual(control.criterionIds, ['artifact'])
  assert.equal(control.revision, 1)
  await assert.rejects(api.validateRecovery(runDir, { ...recovery, criterionIds: ['invented'] }), /frozen/)
})

test('paid review cache survives ledger spending and budget exhaustion cannot become acceptance', async t => {
  const { ctx, runDir, calls } = await fixture(t, input => {
    const m = JSON.parse(input.continuation)
    return { action: 'complete', reason: 'Explicit artifact checked', criteria: [{ id: 'artifact', status: 'met', sourceRefs: m.sourceRefs }], blockers: [], unsupportedClaims: [], followups: [] }
  })
  await api.initializeContinuation(ctx)
  await writeFile(join(runDir, 'result.txt'), 'verified artifact')
  await api.addContinuationEvidence(ctx, [await new ResearchStore(runDir).captureSource('result.txt')])
  const ledger = await openRequestLedger({ runDir, runId: ctx.state.runId, config: { maxInputTokens: 100, maxOutputTokens: 100, maxRunTokens: 1000, maxRoleCalls: 1, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 } })
  const paid = { ...ctx, context: { ...ctx.context, requestLedger: ledger } }
  const original = paid.deps.provider.run
  paid.deps.provider.run = async (role: any, input: any, context: any) => {
    await ledger.beginRole({ roleStartId: input.taskId, taskId: input.taskId, role, tier: 'standard', childId: input.taskId })
    await ledger.beginRequest({ requestId: input.taskId, taskId: input.taskId, childId: input.taskId, role, tier: 'standard', kind: 'worker', estimatedInputTokens: 10, maxOutputTokens: 10 })
    const output = await original(role, input, context)
    await ledger.settleRequest(input.taskId, { inputTokens: 10, outputTokens: 10, usageSource: 'provider', stopReason: 'stop' })
    return output
  }
  assert.equal((await api.loadOrReviewContinuation(paid)).action, 'complete')
  const spent = (await ledger.snapshot()).totals
  assert.equal(spent.roleStarts, 1)
  assert.equal((await api.loadOrReviewContinuation(paid)).action, 'complete')
  assert.equal(calls.length, 1)
  assert.deepEqual((await ledger.snapshot()).totals, spent)
  await api.validateRecovery(runDir, { changedCondition: 'Increase total cycles' }, 9)
  const recovered = { ...paid, deps: { ...paid.deps, maxCycles: 9 } }
  assert.equal((await api.loadOrReviewContinuation(recovered)).action, 'budget_exhausted')
  assert.equal(calls.length, 1)
  assert.deepEqual((await ledger.snapshot()).totals, spent)
})

async function assessedFixture(ctx: any, formal = false) {
  await captureResearchPlan(ctx, { plan: 'Check artifact only', ...(formal ? { protocol: { metric: 'paired success', controls: ['control'], sample: '20 independent tasks', split: 'fresh-heldout', seeds: [1], budget: { unit: 'task-pair', limit: 20, tolerance: 0 }, stopping_rule: 'exactly 20 independent pairs', failure_policy: 'exclude_from_mechanism', missing_policy: 'block incomplete batch', duplicate_policy: 'block_conflicts', fingerprints: { code: 'v1', data: 'fresh', treatment: 'v1', model: 'fixture' }, decision_rule: 'paired_sign_test_v1' } } : {}) })
  const frozen = await freezeResearchCycle(ctx, 'Check artifact only', 'Check artifact only')
  await mkdir(join(ctx.runDir, 'work/cycle-01'), { recursive: true })
  await writeFile(join(ctx.runDir, 'work/cycle-01/result.txt'), formal ? JSON.stringify({ schema: 'autoresearch/paired-outcomes/v1', protocol_hash: frozen.protocol.content_hash, fingerprints: frozen.protocol.fingerprints, split: frozen.protocol.split, unit: 'task-pair', cost: 20, units: Array.from({ length: 20 }, (_, n) => ({ id: `unit-${n}`, control: 0, treatment: 1 })) }) : 'scientifically unknown engineering result')
  await (await import('../../dist/cleanup/registration.js')).issueWorkerRoot(ctx.runDir, ctx.state.cycle, join(ctx.runDir, 'work/cycle-01'))
  return assessResearchCycle(ctx, { status: 'completed', summary: 'Produced result', artifacts: ['work/cycle-01/result.txt'] })
}

test('control revisions create unique decision and candidate-batch identities without resetting scientific evidence', async t => {
  const { ctx, runDir } = await fixture(t, input => {
    const m = JSON.parse(input.continuation)
    return { action: 'complete', reason: 'Scoped artifact independently checked', criteria: [{ id: 'artifact', status: 'met', sourceRefs: m.sourceRefs }], blockers: [], unsupportedClaims: [], followups: [] }
  })
  await api.initializeContinuation(ctx)
  await assessedFixture(ctx)
  const legacy = { action: 'finish', reason: 'Artifact ready' }
  await commitResearchDecision(ctx, legacy, legacy, undefined, { deliveryReady: true })
  const store = new ResearchStore(runDir)
  const first = await store.loadCurrent()
  assert.equal(first?.decision?.id, 'decision-1-r0')
  await api.validateRecovery(runDir, { changedCondition: 'Increase cumulative cap for further independent review' }, 9)
  await commitResearchDecision({ ...ctx, deps: { ...ctx.deps, maxCycles: 9 } }, legacy, legacy, undefined, { deliveryReady: true })
  const second = await store.loadCurrent()
  assert.equal(second?.decision?.id, 'decision-1-r1')
  assert.deepEqual(second?.candidate_batches?.map(b => b.id), ['candidate-batch-1-r0', 'candidate-batch-1-r1'])
  assert.deepEqual(second?.evidence, first?.evidence)
  assert.equal(second?.budget.revisions, first?.budget.revisions)
})

test('legacy nonterminal migrates once and derived science cannot pass from an unverified artifact', async t => {
  const { ctx, runDir } = await fixture(t, () => pause)
  ctx.state.phase = 'decide'; await saveState(runDir, ctx.state)
  const provider = new FakeAgentProvider({ decisions: ['finish'] })
  const service = new AutoResearchService(provider)
  const context = { parent: { id: 'migration', session: { id: 'migration' } }, signal: new AbortController().signal }
  assert.equal((await service.run({ runDir }, context)).status, 'PAUSED')
  const migration = await readFile(join(runDir, 'continuation/migration.json'), 'utf8')
  assert.equal(JSON.parse(migration).origin, 'derived')
  const n = provider.calls.length
  await service.run({ runDir }, context)
  assert.equal(provider.calls.length, n)
  assert.equal(await readFile(join(runDir, 'continuation/migration.json'), 'utf8'), migration)
})

test('contract survives a crash between immutable acceptance publication and control publication', async t => {
  const { ctx, runDir } = await fixture(t, () => pause)
  await api.initializeContinuation(ctx)
  await rm(join(runDir, 'continuation/state.json'))
  await assert.rejects(api.initializeContinuation({ ...ctx, deps: { ...ctx.deps, acceptance: { criteria: [{ ...acceptance.criteria[0], text: 'Silent replacement' }] } } }), /immutable|acceptance/i)
})

test('investigation artifacts never overwrite a supported scientific assessment', async t => {
  const { ctx, runDir } = await fixture(t, () => pause)
  await api.initializeContinuation(ctx)
  const science = await assessedFixture(ctx, true)
  assert.equal(science.assessment?.category, 'supported')
  let worked = false
  ctx.deps.provider.run = async (role: string, input: any) => {
    if (role === 'planner') return { text: '', stopReason: 'completed', structured: { plan: 'Inspect one implementation boundary', riskLevel: 'low' } }
    if (role === 'research-worker') {
      assert.deepEqual(input.researchContext.records, [], 'ordinary investigation is not a frozen scientific experiment')
      const path = join(input.workDir, 'check.txt'); await writeFile(path, 'boundary checked'); worked = true
      return { text: '', stopReason: 'completed', structured: { status: 'completed', summary: 'boundary checked', artifacts: [path.slice(runDir.length + 1).replaceAll('\\', '/')] } }
    }
    const m = JSON.parse(input.continuation)
    return { text: '', stopReason: 'completed', structured: worked ? { action: 'complete', reason: 'Artifact checked separately', criteria: [{ id: 'artifact', status: 'met', sourceRefs: m.sourceRefs }], blockers: [], unsupportedClaims: [], followups: [] } : { ...pause, action: 'followup', followups: [{ kind: 'investigate', criterionIds: ['artifact'], task: 'Check implementation boundary', changedCondition: '', sourceRefs: m.sourceRefs }] } }
  }
  await api.loadOrReviewContinuation(ctx)
  assert.equal((await api.runContinuationTasks(ctx)).action, 'complete')
  assert.deepEqual(await new ResearchStore(runDir).loadCurrent(), science)
})

test('changed captured evidence rejects cached completion before any new paid review', async t => {
  const { ctx, runDir, calls } = await fixture(t, input => ({ action: 'complete', reason: 'Artifact checked', criteria: [{ id: 'artifact', status: 'met', sourceRefs: JSON.parse(input.continuation).sourceRefs }], blockers: [], unsupportedClaims: [], followups: [] }))
  await api.initializeContinuation(ctx)
  const source = await new ResearchStore(runDir).captureBytes('original artifact', 'result')
  await api.addContinuationEvidence(ctx, [source])
  assert.equal((await api.loadOrReviewContinuation(ctx)).action, 'complete')
  await writeFile(join(runDir, source.path!), 'tampered bytes')
  await assert.rejects(api.loadOrReviewContinuation(ctx), /bytes changed|hash/i)
  assert.equal(calls.length, 1)
})

test('a nonempty but wholly rejected candidate list still requires independent coverage and two searches', async t => {
  const { ctx, calls } = await fixture(t, () => pause)
  await api.initializeContinuation(ctx)
  await assessedFixture(ctx)
  await assert.rejects(commitResearchDecision(ctx, { action: 'revise', reason: 'Proposal list is nonempty', candidates: [{ statement: 'Unsupported revision', evidence_ids: ['forged'] }] }, { action: 'revise', reason: 'Try proposal' }), /coverage|evidence|pause/i)
  assert.equal(calls.filter(c => c.role === 'coverage-reviewer').length, 3)
  const current = await new ResearchStore(ctx.runDir).loadCurrent()
  assert.equal(current?.decision?.action, 'pause')
  assert.equal(current?.candidate_batches?.at(-1)?.entries.length, 1)
  assert.equal(current?.candidate_batches?.at(-1)?.selection.selectedId, null)
})

test('coverage and follow-up admission preserve compact project-wide eliminated mechanism memory', async t => {
  const mechanismKey = 'a'.repeat(64)
  const { ctx, runDir, calls } = await fixture(t, input => {
    const m = JSON.parse(input.continuation)
    return { ...pause, action: 'followup', followups: [{ kind: 'repair', mechanismKey, criterionIds: ['artifact'], task: 'Repeat the discarded mechanism with new wording', changedCondition: 'I say it is different', sourceRefs: m.sourceRefs }] }
  })
  await new ProjectDirectionMemoryStore(runDir).upsert({ idea: 'Discarded approach', eliminationReason: 'Mechanism cannot satisfy the objective', avoid: 'Avoid repeating the same mechanism', reasonCode: 'explicit_abandonment', mechanismKey })
  await api.initializeContinuation(ctx)
  await api.addContinuationEvidence(ctx, [await new ResearchStore(runDir).captureBytes('available artifact', 'result')])
  assert.equal((await api.loadOrReviewContinuation(ctx)).action, 'pause')
  assert.equal((await api.readContinuation(runDir)).queue.length, 0)
  assert.ok(calls.every(c => JSON.parse(c.input.continuation).directionMemory.avoidedMechanismKeys.includes(mechanismKey)))
})
