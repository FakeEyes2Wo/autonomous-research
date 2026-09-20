import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import os from 'node:os'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { ResearchStore, sealRecord } from '../../dist/research/index.js'
import { freezeTaskGraph } from '../../dist/experiment/task-graph.js'
import { localJobDirectory } from '../../dist/runtime/executors/local.js'
import { collectArtifacts, writeArtifactManifest } from '../../dist/runtime/artifacts.js'
import { runExperimentTask } from '../../dist/experiment/runner.js'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { FakeAgentProvider } from './fake-agent-provider.ts'

export async function fixture(t: any, count = 3) {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-durable-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const base = (id: string) => ({ id, version: 1, created_at: '2026-09-16T00:00:00Z', source_refs: [] })
  const claim = sealRecord({ ...base('c'), statement: 'Treatment helps', scope: 'test', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: '' })
  const hypothesis = sealRecord({ ...base('h'), statement: 'Treatment helps', claim: { id: 'c', version: 1 }, parents: [], mechanism: 'recall', alternatives: [], prediction: 'more success', falsification: 'less success', measurement: 'success', decision_rule: 'paired_sign_test_v1', scope: 'test', mode: 'formal', status: 'proposed' })
  const protocol = sealRecord({ ...base('p'), hypothesis: { id: 'h', version: 1 }, metric: 'success', controls: ['control'], sample: '8 tasks', split: 'heldout', seeds: [], budget: { unit: 'task-pair', limit: 8, tolerance: 0 }, stopping_rule: '8 pairs', failure_policy: 'exclude_from_mechanism', missing_policy: 'inconclusive', duplicate_policy: 'block_conflicts', fingerprints: { code: 'c', data: 'd', treatment: 't', model: 'm' }, provenance: 'known', decision_rule: 'paired_sign_test_v1' })
  const snapshot = await new ResearchStore(runDir).commit(sealRecord({ ...base('s'), schema: 'autoresearch/research-snapshot/v1', branch_id: 'run', active_claim: { id: 'c', version: 1 }, active_hypothesis: { id: 'h', version: 1 }, claims: [claim], hypotheses: [hypothesis], protocol, evidence: [], budget: { revisions: 0, repairs: 0 } }))
  const tasks = Array.from({ length: count }, (_, i) => ({ id: `t${i}`, dependsOn: i ? [`t${i-1}`] : [], stage: i === count-1 ? 'formal' : i === count-2 ? 'baseline' : 'prepare', protocolHash: protocol.content_hash, inputHash: `input-${i}`, validatorId: i === count-1 ? 'paired_sign_test_v1' : 'artifact_integrity_v1', inputs: [], outputs: [{ relativePath: 'result.json', kind: i === count-1 ? 'paired-outcomes' : 'preparation', maxBytes: 4000 }], split: 'heldout', exposure: i === count-1 ? 'heldout' : 'none', job: { id: `j${i}`, taskId: `t${i}`, attemptId: `a${i}`, protocolHash: protocol.content_hash, inputHash: `input-${i}`, executable: process.execPath, args: ['controlled.mjs'], cwd: runDir, env: {}, budget: { wallMs: 20000, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 1000, maxArtifactBytes: 4000 }, checkpoint: null } }))
  const raw = { schema: 'autoresearch/paired-outcomes/v1', protocol_hash: protocol.content_hash, split: protocol.split, fingerprints: protocol.fingerprints, unit: 'task-pair', cost: 8, units: Array.from({ length: 8 }, (_,i) => ({ id: `unit-${i}`, control: 1, treatment: 0 })) }
  return { runDir, snapshot, tasks, raw }
}
function runtime(raw: unknown, counts: Record<string, number>, status = 'succeeded') {
  return { authorize: async () => {}, backendFactory: (store: any) => ({
    async submit(spec: any) {
      counts[spec.id] = (counts[spec.id] ?? 0) + 1
      const dir = localJobDirectory(store.root, spec.id)
      await mkdir(join(dir, 'artifacts'), { recursive: true })
      await writeFile(join(dir, 'artifacts', 'result.json'), JSON.stringify({ ...raw as object, protocol_hash: spec.protocolHash }))
      const manifest = await collectArtifacts(join(dir, 'artifacts'), spec.budget.maxArtifactBytes)
      await writeArtifactManifest(dir, manifest)
      return { ...(await store.get(spec.id)).receipt, backendId: 'controlled', status, exitCode: status === 'succeeded' ? 0 : 137, artifactManifestHash: manifest.hash }
    }, async inspect(id: string) { return (await store.get(id)).receipt }, async collect(id: string) { return (await store.get(id)).receipt }, async cancel(id: string) { return (await store.get(id)).receipt },
  }) }
}

for (const cached of [false, true]) test(`final verified durable replication acknowledges its queued followup once: cached=${cached}`, async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const continuation = await import('../../dist/service/continuation.js')
  const { mergeFollowups } = await import('../../dist/research/continuation.js')
  const { runWorker } = await import('../../dist/experiment/steps.js')
  const { createRunContext } = await import('../../dist/service/context.js')
  const { createInitialState } = await import('../../dist/core/state.js')
  const { ResearchTree } = await import('../../dist/core/research-tree.js')
  const f = await fixture(t, 2), counts = {}, authority = runtime(f.raw, counts)
  const graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Replication' })
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  if (cached) await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  await mkdir(join(f.runDir, 'cycles/cycle-1'), { recursive: true })
  await writeFile(join(f.runDir, 'cycles/cycle-1/frozen.json'), JSON.stringify({ snapshotId: f.snapshot.id }))
  const ctx = createRunContext({ provider: { run: async () => { throw new Error('no model dispatch') } }, maxCycles: 1, acceptance: { criteria: ['science', 'science-later'].map(id => ({ id, required: true, text: 'Replicate', evidenceKind: 'scientific' })) } }, f.runDir, await createInitialState(f.runDir), await ResearchTree.load(f.runDir), { parent: { id: 'test', session: { id: 'test' } }, signal: new AbortController().signal, experimentRuntime: authority })
  const saved = await continuation.initializeContinuation(ctx)
  const ref = await new ResearchStore(f.runDir).captureBytes('external replication request', 'request')
  saved.evidence = [ref]
  saved.queue = mergeFollowups([], ['science', 'science-later'].map(id => ({ kind: 'replicate', criterionIds: [id], task: 'Replicate once', changedCondition: '', sourceRefs: [ref] })), saved.acceptance, [ref])
  saved.queue[0].status = 'running'; saved.queue[0].cycle = 1
  await writeFile(join(f.runDir, 'continuation/state.json'), JSON.stringify(saved))
  const args = { workDir: join(f.runDir, 'work/cycle-01'), planText: 'Replication', experimentDesign: '', minimalVerification: '', ...(cached ? { cachedStage: { result: { status: 'completed', summary: 'forged', artifacts: ['untrusted.json'] } } } : {}) }
  const action = await runWorker(ctx, args)
  const after = await continuation.readContinuation(f.runDir)
  assert.equal(after.queue[0].status, 'completed')
  const snapshot = await new ResearchStore(f.runDir).loadCurrent()
  assert.deepEqual(after.queue[0].resultRefs, snapshot.evidence.flatMap(e => e.artifacts).filter(ref => action.artifacts.includes(ref.path)))
  assert.ok(after.queue[0].resultRefs.length > 0)
  const beforeReplay = await readFile(join(f.runDir, 'continuation/state.json'), 'utf8')
  await runWorker(ctx, args)
  assert.equal(await readFile(join(f.runDir, 'continuation/state.json'), 'utf8'), beforeReplay)
  assert.equal((await continuation.readContinuation(f.runDir)).queue[1].status, 'pending', 'cached completion cannot consume another queued replication')
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).content_hash, snapshot.content_hash)
  assert.deepEqual(Object.values(counts), [1, 1])
})

for (const { crashAt, mode, cap } of [
  ...['none', 'review-receipt-publication', 'review-publication', 'assignment-before-publication', 'assignment-publication', 'run-publication', 'graph-publication'].map(crashAt => ({ crashAt, mode: 'legacy', cap: 2 })),
  { crashAt: 'none', mode: 'minimal', cap: 2 }, { crashAt: 'none', mode: 'minimal', cap: 3 }, { crashAt: 'none', mode: 'legacy', cap: 3 },
]) test(`final recovery durable WAITING ordinary resume reconciles the assigned graph: ${mode}/cap-${cap}/${crashAt}`, async t => {
  const continuation = await import('../../dist/service/continuation.js')
  const { createRunContext } = await import('../../dist/service/context.js')
  const { createInitialState, saveState } = await import('../../dist/core/state.js')
  const { ResearchTree } = await import('../../dist/core/research-tree.js')
  const { bindRunProject } = await import('../../dist/service/project-paper.js')
  const f = await fixture(t), counts = {}, authority = runtime({ ...f.raw, units: f.raw.units.map(u => ({ ...u, treatment: 1, control: 0 })) }, counts)
  t.mock.method(os, 'homedir', () => f.runDir); syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await mkdir(join(f.runDir, '.autoresearch'), { recursive: true }); await mkdir(join(f.runDir, 'input'), { recursive: true })
  await writeFile(join(f.runDir, 'input/idea.md'), 'Replicate the checked finding')
  await writeFile(join(f.runDir, 'RUBRIC.md'), 'Check paired replication')
  await writeFile(join(f.runDir, '.autoresearch/project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  brainstorm: never\n  deepDive: never\n  experimentReview: never\n  modelScout: never\n  postResultSynthesis: never\n  paper: never\n')
  if (mode === 'minimal') {
    const { loadProjectSettings } = await import('../../dist/settings/project-settings.js')
    const { createPolicySnapshot } = await import('../../dist/policy/model-routing.js')
    const settings = await loadProjectSettings(f.runDir)
    await writeFile(join(f.runDir, '.autoresearch/policy-snapshot.json'), JSON.stringify({ ...createPolicySnapshot(settings), model: settings.model }))
  }
  const provider = new FakeAgentProvider({ decisions: ['finish'], minimalRisk: 'low' }), original = provider.run.bind(provider)
  let planners = 0, reviews = 0
  provider.run = async (role, input, ctx) => {
    if (role === 'coverage-reviewer') {
      reviews++
      const m = JSON.parse(input.continuation)
      return { text: '', stopReason: 'completed', structured: m.queue.some(q => q.status === 'completed')
        ? { action: 'complete', reason: 'Replication checked', criteria: [{ id: 'artifact', status: 'met', sourceRefs: m.sourceRefs }], blockers: [], unsupportedClaims: [], followups: [] }
        : { action: 'followup', reason: 'Replicate', criteria: [], blockers: [], unsupportedClaims: [], followups: [{ kind: 'replicate', criterionIds: ['artifact'], task: 'Replicate once', changedCondition: '', sourceRefs: m.sourceRefs }] } }
    }
    const output = await original(role, input, ctx)
    if (role === 'planner') { planners++; output.structured = { ...output.structured, protocol: f.snapshot.protocol, taskGraph: { tasks: f.tasks.map(task => ({ id: task.id, dependsOn: task.dependsOn, stage: task.stage, command: task.job.executable, argv: task.job.args, cwd: '.', env: {}, budget: task.job.budget, inputs: task.inputs, outputs: task.outputs, validatorId: task.validatorId, split: task.split, exposure: task.exposure })) } } }
    return output
  }
  const context = { parent: { id: 'test', session: { id: 'test' } }, signal: new AbortController().signal, experimentRuntime: authority }
  const state = await createInitialState(f.runDir)
  await bindRunProject({ runDir: f.runDir }, undefined, true)
  const ctx = createRunContext({ provider, maxCycles: cap, acceptance: { criteria: [{ id: 'artifact', required: true, text: 'Check replication', evidenceKind: 'artifact' }] } }, f.runDir, state, await ResearchTree.load(f.runDir), context)
  await continuation.initializeContinuation(ctx)
  state.status = 'PAUSED'; state.phase = 'decide'; await saveState(f.runDir, state)
  await writeFile(join(f.runDir, 'external.txt'), 'External replication review')
  const service = new AutoResearchService(provider)
  const rename = fsPromises.rename
  const link = fsPromises.link
  let crashed = false
  if (crashAt !== 'none') {
    t.mock.method(fsPromises, 'link', async (from, to) => {
      await link(from, to)
      if (crashAt === 'graph-publication' && String(to).replaceAll('\\', '/').endsWith('/runtime/graphs/cycle-2/graph.json')) { crashed = true; throw new Error('injected publication interruption') }
    })
    t.mock.method(fsPromises, 'rename', async (from, to) => {
      if (crashed) throw new Error('injected publication interruption')
      if (crashAt === 'assignment-before-publication' && String(to).replaceAll('\\', '/').endsWith('/continuation/state.json')) {
        const value = JSON.parse(await readFile(from, 'utf8'))
        if (value.queue?.some(q => q.status === 'running' && q.cycle === 2)) { crashed = true; throw new Error('injected publication interruption') }
      }
      await rename(from, to)
      const path = String(to).replaceAll('\\', '/')
      if (!path.startsWith(f.runDir.replaceAll('\\', '/') + '/')) return
      const value = JSON.parse(await readFile(to, 'utf8'))
      const hit = crashAt === 'review-receipt-publication' && path.includes('/continuation/reviews/') && value.decisionHash
        || crashAt === 'review-publication' && path.endsWith('/continuation/state.json') && value.resumeReviewRequired === false && value.queue?.some(q => q.status === 'pending')
        || crashAt === 'assignment-publication' && path.endsWith('/continuation/state.json') && value.queue?.some(q => q.status === 'running' && q.cycle === 2)
        || crashAt === 'run-publication' && path === f.runDir.replaceAll('\\', '/') + '/state.json' && value.cycle === 2
        || crashAt === 'graph-publication' && path.endsWith('/runtime/graphs/cycle-2/graph.json')
      if (hit) { crashed = true; throw new Error('injected publication interruption') }
    }); syncBuiltinESMExports()
  }
  const options = { runDir: f.runDir, humanReview: 'off', recovery: { changedCondition: 'External review', criterionIds: ['artifact'], newEvidencePaths: ['external.txt'] } }
  let first
  if (crashAt === 'none') first = await service.run(options, context)
  else {
    await assert.rejects(service.run(options, context), /injected publication interruption/)
    assert.equal(crashed, true)
    t.mock.restoreAll(); syncBuiltinESMExports()
    t.mock.method(os, 'homedir', () => f.runDir); syncBuiltinESMExports()
    first = await service.run({ runDir: f.runDir, humanReview: 'off' }, context)
  }
  assert.equal(first.status, 'WAITING'); assert.equal(first.cycle, 2)
  const graphBefore = await readFile(join(f.runDir, 'runtime/graphs/cycle-2/graph.json'), 'utf8')
  const assignment = (await continuation.readContinuation(f.runDir)).queue[0].execution
  assert.deepEqual(assignment, { cycle: 2, planVersion: 2, graphId: 'cycle-2' })
  const { readExperimentGraphState } = await import('../../dist/experiment/runtime-adapter.js')
  const firstBudget = (await readExperimentGraphState(f.runDir, JSON.parse(graphBefore))).budget
  const second = await service.run({ runDir: f.runDir, humanReview: 'off' }, context)
  assert.equal(second.cycle, 2, 'ordinary WAITING resume must not allocate another cycle')
  assert.equal(second.planVersion, first.planVersion); assert.equal(second.status, 'WAITING')
  assert.equal(reviews, 1, 'consumed recovery review is not rerun during graph reconciliation')
  assert.deepEqual((await continuation.readContinuation(f.runDir)).queue[0].execution, assignment)
  const secondBudget = (await readExperimentGraphState(f.runDir, JSON.parse(graphBefore))).budget
  assert.ok(secondBudget.settledWallMs >= firstBudget.settledWallMs)
  assert.equal((await continuation.readContinuation(f.runDir)).resumeReviewRequired, false)
  const final = await service.run({ runDir: f.runDir, humanReview: 'off' }, context)
  assert.equal(final.status, 'COMPLETED'); assert.equal(final.cycle, 2)
  assert.equal(planners, 1); assert.deepEqual(Object.values(counts), [1, 1, 1])
  assert.equal(await readFile(join(f.runDir, 'runtime/graphs/cycle-2/graph.json'), 'utf8'), graphBefore)
  assert.equal((await continuation.readContinuation(f.runDir)).queue[0].status, 'completed')
  assert.equal((await continuation.readContinuation(f.runDir)).control.maxCycles, cap)
})

for (const mutation of ['none', 'collection', 'source']) test(`durable cached action rehydrates canonical host artifacts: ${mutation}`, async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const { runWorker } = await import('../../dist/experiment/steps.js')
  const { createRunContext } = await import('../../dist/service/context.js')
  const { createInitialState } = await import('../../dist/core/state.js')
  const { ResearchTree } = await import('../../dist/core/research-tree.js')
  const f = await fixture(t, 2), counts = {}
  const graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Canonical proof' })
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: runtime(f.raw, counts) })
  const first = await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: runtime(f.raw, counts) })
  assert.equal(first.status, 'completed')
  await mkdir(join(f.runDir, 'cycles/cycle-1'), { recursive: true })
  await writeFile(join(f.runDir, 'cycles/cycle-1/frozen.json'), JSON.stringify({ snapshotId: f.snapshot.id }))
  const ctx = createRunContext({ provider: { run: async () => { throw new Error('must not dispatch') } } }, f.runDir, await createInitialState(f.runDir), await ResearchTree.load(f.runDir), { parent: { id: 'test', session: { id: 'test' } }, signal: new AbortController().signal })
  if (mutation === 'collection') {
    const path = join(f.runDir, 'runtime/graphs/cycle-1/collections/t0.json')
    const c = JSON.parse(await readFile(path, 'utf8')); c.artifacts = []
    await writeFile(path, JSON.stringify(c))
  }
  if (mutation === 'source') await writeFile(join(f.runDir, first.artifacts[0]), 'tampered source')
  const replay = () => runWorker(ctx, { workDir: join(f.runDir, 'work/experiment-cycle-01'), planText: 'test', experimentDesign: '', minimalVerification: '', cachedStage: { result: { status: 'completed', summary: 'forged stage', artifacts: ['raw/user.json'] } } } as any)
  if (mutation === 'none') {
    const action = await replay()
    assert.deepEqual(action.artifacts, first.artifacts)
    assert.ok(action.artifacts.every(p => p.startsWith('research/sources/')))
  } else await assert.rejects(replay(), /COLLECTION.*HASH|source hash mismatch/)
  assert.deepEqual(Object.values(counts), [1, 1])
})
test('durable graph resumes after node seven, admits negative evidence once, and rebuilds handoff', async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js').catch(() => undefined)
  assert.ok(api, 'durable runtime adapter is implemented')
  const f = await fixture(t, 9), counts = {}, options = runtime(f.raw, counts)
  const graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Test negative effect' })
  for (let i = 0; i < 7; i++) await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: options })
  assert.equal(Object.keys(counts).length, 7)
  for (let i = 0; i < 3; i++) await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: options })
  const snapshot = (await new ResearchStore(f.runDir).loadCurrent())!
  assert.equal(snapshot.evidence.length, 1)
  assert.equal(snapshot.evidence[0].polarity, 'opposes')
  assert.equal(snapshot.assessment.claim_status, 'refuted')
  assert.deepEqual(Object.values(counts), Array(9).fill(1))
  const handoff = await readFile(join(f.runDir, 'HANDOFF.md'), 'utf8')
  assert.ok(handoff.includes(snapshot.content_hash)); assert.ok(handoff.includes(graph.hash))
})
test('collection is durable before scientific commit, and replay after commit cannot duplicate evidence', async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js').catch(() => undefined)
  assert.ok(api, 'durable runtime adapter is implemented')
  const f = await fixture(t), counts = {}, options = runtime(f.raw, counts)
  const graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Crash safety' })
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: options })
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: options })
  const commit = ResearchStore.prototype.commit; let failed = false
  t.mock.method(ResearchStore.prototype, 'commit', async function(snapshot: any, expectedHash?: string) {
    if (!failed && snapshot.evidence.length) { failed = true; throw new Error('injected before commit') }
    return commit.call(this, snapshot, expectedHash)
  })
  await assert.rejects(api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: options }), /injected/)
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).evidence.length, 0)
  const collection = JSON.parse(await readFile(join(f.runDir, 'runtime', 'graphs', graph.id, 'collections', 't2.json'), 'utf8'))
  assert.ok(collection.admissionKey); assert.equal(collection.validation.polarity, 'opposes')
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: options })
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: options })
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).evidence.length, 1)
  assert.equal(counts.j2, 1)
})
test('unknown execution never produces scientific negative evidence or resubmits', async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js').catch(() => undefined)
  assert.ok(api, 'durable runtime adapter is implemented')
  const f = await fixture(t), counts = {}, options = runtime(f.raw, counts, 'unknown')
  const graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Unknown is pause' })
  for (let i = 0; i < 2; i++) assert.equal((await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: options })).status, 'waiting')
  assert.equal(counts.j0, 1)
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).evidence.length, 0)
})
for (const mode of ['minimal', 'legacy']) for (const entry of ['experiment', 'research']) test(`both runners execute frozen graphs through adapter: ${entry}/${mode}`, async t => {
  const f = await fixture(t), counts = {}, options = runtime({ ...f.raw, units: f.raw.units.map(u => ({ ...u, treatment: 1, control: 0 })) }, counts)
  t.mock.method(os, 'homedir', () => f.runDir); syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await mkdir(join(f.runDir, '.autoresearch'), { recursive: true })
  await mkdir(join(f.runDir, 'input'), { recursive: true })
  await writeFile(join(f.runDir, 'input', 'idea.md'), '# Idea\n\n## Direction\n\nControlled experiment')
  await writeFile(join(f.runDir, 'PROFILE.md'), 'Controlled local files only.')
  await writeFile(join(f.runDir, '.autoresearch', 'project-settings.yaml'), `version: 2\nworkflow:\n  mode: ${mode}\n  brainstorm: never\n  deepDive: never\n  experimentReview: never\n  modelScout: never\n  postResultSynthesis: never\n  paper: never\n`)
  const provider = new FakeAgentProvider({ decisions: ['finish'] }), original = provider.run.bind(provider)
  let workerCalls = 0, plannerCalls = 0, designCalls = 0
  provider.run = async (role, input, ctx) => {
    if (role === 'research-worker') workerCalls++
    if (role === 'experiment-designer') designCalls++
    const output = await original(role, input, ctx)
    if (role === 'planner') { plannerCalls++; output.structured = { ...output.structured, protocol: f.snapshot.protocol, taskGraph: { tasks: f.tasks.map(task => ({ id: task.id, dependsOn: task.dependsOn, stage: task.stage, command: task.job.executable, argv: task.job.args, cwd: '.', env: {}, budget: task.job.budget, inputs: task.inputs, outputs: task.outputs, validatorId: task.validatorId, split: task.split, exposure: task.exposure })) } } }
    return output
  }
  const context = { parent: { id: 'test', session: { id: 'test' } }, signal: new AbortController().signal, experimentRuntime: options }
  const run = () => entry === 'experiment' ? runExperimentTask({ provider }, { runDir: f.runDir, task: 'Controlled experiment', maxRounds: 1, agentContext: context }) : new AutoResearchService(provider).run({ runDir: f.runDir, maxCycles: 1, humanReview: 'off', brainstorm: 'off' }, context)
  const first = await run()
  assert.match(first.status, /waiting/i)
  await run(); await run()
  assert.equal(workerCalls, 0)
  assert.equal(plannerCalls, 1)
  assert.equal(designCalls, mode === 'legacy' ? 1 : 0)
  assert.equal(Object.keys(counts).length, 3)
  const current = (await new ResearchStore(f.runDir).loadCurrent())!
  assert.equal(current.evidence.length, 1)
  assert.equal(current.evidence[0].polarity, 'supports')
  const tree = JSON.parse(await readFile(join(f.runDir, 'research_tree.json'), 'utf8'))
  assert.equal(tree.nodes.filter(n => n.runtimeTask).length, 3)
})

test('view before host authorization does not create a job database or poison later authorization', async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const f = await fixture(t), counts = {}, graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Pending authorization' })
  const view = await api.readExperimentGraphState(f.runDir, graph)
  assert.equal(view.status, 'waiting')
  await assert.rejects(readFile(join(f.runDir, 'runtime', 'jobs', 'jobs.sqlite')), { code: 'ENOENT' })
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: runtime(f.raw, counts) })
  assert.equal(counts.j0, 1)
})
test('queued jobs recheck current host authority after restart', async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const { openJobStore } = await import('../../dist/runtime/job-store.js')
  const f = await fixture(t), graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Revoked authority' }), counts = {}
  const store = await openJobStore(join(f.runDir, 'runtime', 'jobs'), { maxConcurrentJobs: 1, maxReservedWallMs: graph.budget.maxReservedWallMs })
  await store.enqueue(graph.tasks[0].job); await store.close()
  const authority = runtime(f.raw, counts); authority.authorize = async () => { throw new Error('authority revoked') }
  await assert.rejects(api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority }), /authority revoked/)
  assert.deepEqual(counts, {})
})
for (const kind of ['tamper', 'shrink', 'unknown-validator', 'oom']) test(`exit status cannot bypass ${kind} admission`, async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const f = await fixture(t), counts = {}
  if (kind === 'unknown-validator') f.tasks[2].validatorId = 'model-says-valid'
  const graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Admission boundary' })
  const authority = runtime(kind === 'shrink' ? { ...f.raw, units: f.raw.units.slice(0, 1) } : f.raw, counts)
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  const factory = authority.backendFactory
  authority.backendFactory = store => {
    const backend = factory(store), submit = backend.submit
    backend.submit = async spec => {
      const receipt = await submit(spec)
      if (kind === 'tamper') await writeFile(join(localJobDirectory(store.root, spec.id), 'artifacts', 'result.json'), '{"modified":true}')
      return kind === 'oom' ? { ...receipt, status: 'failed', exitCode: 137 } : receipt
    }
    return backend
  }
  const result = await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  assert.equal(result.status, 'paused')
  assert.equal(result.completed.length, 2)
  const snapshot = (await new ResearchStore(f.runDir).loadCurrent())!
  assert.equal(snapshot.evidence.length, 1)
  assert.notEqual(snapshot.evidence[0].validity, 'valid')
  assert.equal(snapshot.evidence[0].polarity, 'inconclusive')
  assert.equal(snapshot.assessment.admissible_evidence_ids.length, 0)
  if (kind === 'oom') assert.equal(snapshot.assessment.category, 'execution_error')
})
test('formal protocol cannot omit baseline or change heldout split', async t => {
  const f = await fixture(t)
  const missing = structuredClone(f.tasks); missing[2].dependsOn = ['t0']
  await assert.rejects(freezeTaskGraph({ ...f, tasks: missing, id: 'missing', goal: 'Must have baseline' }), /BASELINE_MISSING/)
  const wrong = structuredClone(f.tasks); wrong[2].split = 'development'
  await assert.rejects(freezeTaskGraph({ ...f, tasks: wrong, id: 'wrong', goal: 'Frozen split' }), /SPLIT_MISMATCH/)
})
test('crash after CURRENT commit before outbox ack replays without a second scientific row', async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const f = await fixture(t), counts = {}, graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'After-commit crash' }), authority = runtime(f.raw, counts)
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority }); await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  const commit = ResearchStore.prototype.commit; let crashed = false
  t.mock.method(ResearchStore.prototype, 'commit', async function(snapshot, expectedHash) {
    const result = await commit.call(this, snapshot, expectedHash)
    if (!crashed && snapshot.evidence.length) { crashed = true; throw new Error('after CURRENT') }
    return result
  })
  await assert.rejects(api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority }), /after CURRENT/)
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).evidence.length, 1)
  await assert.rejects(readFile(join(f.runDir, 'runtime', 'graphs', graph.id, 'admitted', 't2.json')), { code: 'ENOENT' })
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).evidence.length, 1)
  assert.equal(counts.j2, 1)
})
test('missing host authority explicitly pauses the actual runner without a worker fallback', async t => {
  const f = await fixture(t)
  await mkdir(join(f.runDir, '.autoresearch'), { recursive: true })
  await writeFile(join(f.runDir, '.autoresearch', 'project-settings.yaml'), 'version: 2\nworkflow:\n  mode: minimal\n  experimentReview: never\n')
  const provider = new FakeAgentProvider({ decisions: ['finish'] }), original = provider.run.bind(provider)
  let workerCalls = 0
  provider.run = async (role, input, ctx) => {
    if (role === 'research-worker') workerCalls++
    const output = await original(role, input, ctx)
    if (role === 'planner') output.structured = { ...output.structured, protocol: f.snapshot.protocol, taskGraph: { tasks: f.tasks.map(task => ({ ...task, command: task.job.executable, argv: task.job.args, cwd: '.', env: {}, budget: task.job.budget })) } }
    return output
  }
  const result = await runExperimentTask({ provider }, { runDir: f.runDir, task: 'Requires host authority', maxRounds: 1, agentContext: { parent: { id: 'test', session: { id: 'test' } }, signal: new AbortController().signal } })
  assert.equal(result.status, 'paused')
  assert.match(result.reason!, /DURABLE_AUTHORITY_REQUIRED/)
  assert.equal(workerCalls, 0)
  await assert.rejects(readFile(join(f.runDir, 'runtime', 'jobs', 'jobs.sqlite')), { code: 'ENOENT' })
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).evidence.length, 0)
})
test('actual Windows local jobs survive adapter recreation and produce one captured formal admission', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const f = await fixture(t)
  for (const task of f.tasks) task.job.args = ['--input-type=module', '-e', `import fs from 'node:fs';import path from 'node:path';fs.appendFileSync('counter','${task.id}\\n');fs.writeFileSync(path.join(process.env.AUTORESEARCH_ARTIFACT_DIR,'result.json'),JSON.stringify(${JSON.stringify(f.raw)}));`]
  const graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Real process execution' })
  const runtime = { authorize: async (spec) => { assert.equal(spec.executable, process.execPath); assert.deepEqual(spec.args, graph.tasks.find(t => t.job.id === spec.id).job.args) } }
  let result
  const deadline = Date.now() + 35000
  do {
    result = await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime })
    assert.notEqual(result.status, 'paused', result.reason)
    if (result.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 200))
  } while (Date.now() < deadline)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).evidence.length, 1)
  assert.deepEqual((await readFile(join(f.runDir, 'counter'), 'utf8')).trim().split('\n'), ['t0', 't1', 't2'])
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime })
  assert.equal((await readFile(join(f.runDir, 'counter'), 'utf8')).trim().split('\n').length, 3)
})

async function changeResearchState(f: Awaited<ReturnType<typeof fixture>>, kind: 'claim' | 'hypothesis' | 'protocol') {
  const store = new ResearchStore(f.runDir), current = (await store.loadCurrent())!
  const claim = sealRecord({ ...current.claims[0], version: 2, parents: [{ id: 'c', version: 1 }], statement: 'A revised, different claim' })
  const hypothesis = sealRecord({ ...current.hypotheses[0], version: 2, parents: [{ id: 'h', version: 1 }], mechanism: 'different mechanism' })
  const protocol = sealRecord({ ...current.protocol, version: 2, split: 'fresh-heldout' })
  return store.commit(sealRecord({ ...current, id: `external-${kind}`, version: current.version + 1, parent_snapshot_id: current.id,
    ...(kind === 'claim' ? { claims: [...current.claims, claim], active_claim: { id: 'c', version: 2 } } : {}),
    ...(kind === 'hypothesis' ? { hypotheses: [...current.hypotheses, hypothesis], active_hypothesis: { id: 'h', version: 2 } } : {}),
    ...(kind === 'protocol' ? { protocol } : {}) }), current.content_hash)
}
for (const kind of ['claim', 'hypothesis'] as const) test(`review regression: running old graph cannot overwrite external ${kind} lineage`, async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const f = await fixture(t), counts = {}, authority = runtime(f.raw, counts)
  const graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Preserve newer science' })
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority }); await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  const factory = authority.backendFactory; let inspections = 0
  authority.backendFactory = store => {
    const backend = factory(store), submit = backend.submit
    backend.submit = async spec => ({ ...await submit(spec), status: 'running', exitCode: null })
    backend.inspect = async id => { inspections++; return { ...(await store.get(id)).receipt, status: 'succeeded', exitCode: 0 } }
    return backend
  }
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  const external = await changeResearchState(f, kind)
  const result = await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  assert.equal(result.status, 'paused')
  assert.match(result.reason, /STALE/)
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).content_hash, external.content_hash)
  assert.equal(inspections, 1)
  assert.equal(counts.j2, 1)
  assert.ok(JSON.parse(await readFile(join(f.runDir, 'runtime', 'graphs', graph.id, 'collections', 't2.json'), 'utf8')).admissionKey)
  await assert.rejects(readFile(join(f.runDir, 'runtime', 'graphs', graph.id, 'admitted', 't2.json')), { code: 'ENOENT' })
})
for (const phase of ['unstarted', 'queued', 'authority-await']) test(`review regression: changed protocol blocks ${phase} dispatch`, async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const f = await fixture(t), counts = {}, authority = runtime(f.raw, counts)
  const graph = await freezeTaskGraph({ ...f, id: 'cycle-1', goal: 'Never start stale work' })
  if (phase === 'queued') {
    const { openJobStore } = await import('../../dist/runtime/job-store.js')
    const jobs = await openJobStore(join(f.runDir, 'runtime', 'jobs'), { maxConcurrentJobs: 1, maxReservedWallMs: graph.budget.maxReservedWallMs })
    await jobs.enqueue(graph.tasks[0].job); await jobs.close()
  }
  let external
  if (phase === 'authority-await') authority.authorize = async () => { external = await changeResearchState(f, 'protocol') }
  else external = await changeResearchState(f, 'protocol')
  const result = await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  assert.equal(result.status, 'paused'); assert.match(result.reason, /STALE_PROTOCOL/)
  assert.deepEqual(counts, {})
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).content_hash, external.content_hash)
})
for (const mutation of ['command', 'task-contract', 'attempt-owner', 'legacy-unbound']) test(`review regression: existing job cannot be relabelled by changed ${mutation}`, async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const f = await fixture(t), counts = {}, authority = runtime(f.raw, counts)
  const first = await freezeTaskGraph({ ...f, tasks: [f.tasks[0]], id: 'first', goal: 'Original execution' })
  const tasks = [structuredClone(f.tasks[0])]
  if (mutation === 'command') tasks[0].job.args = ['different-program.mjs']
  if (mutation === 'task-contract' || mutation === 'legacy-unbound') tasks[0].outputs[0].kind = 'different-evaluator-input'
  if (mutation === 'attempt-owner') tasks[0].job.id = 'different-job-same-attempt'
  const changed = await freezeTaskGraph({ ...f, tasks, id: 'changed', goal: 'Different execution' })
  if (mutation === 'legacy-unbound') {
    const { openJobStore } = await import('../../dist/runtime/job-store.js')
    const { JobController } = await import('../../dist/runtime/job-controller.js')
    const jobs = await openJobStore(join(f.runDir, 'runtime', 'jobs'), { maxConcurrentJobs: 1, maxReservedWallMs: first.budget.maxReservedWallMs })
    const controller = new JobController(jobs, authority.backendFactory(jobs))
    await controller.enqueue(first.tasks[0].job); await controller.advance(first.tasks[0].job.id); await jobs.close()
  } else await api.advanceExperimentGraph({ runDir: f.runDir, graph: first, runtime: authority })
  await assert.rejects(api.advanceExperimentGraph({ runDir: f.runDir, graph: changed, runtime: authority }), /RUNTIME_(JOB|ATTEMPT)_.*CONFLICT/)
  assert.deepEqual(counts, { j0: 1 })
  await assert.rejects(readFile(join(f.runDir, 'runtime', 'graphs', changed.id, 'collections', 't0.json')), { code: 'ENOENT' })
})
test('review regression: own graph formal admissions accumulate through its status-only claim descendants', async t => {
  const api = await import('../../dist/experiment/runtime-adapter.js')
  const f = await fixture(t), counts = {}, authority = runtime(f.raw, counts)
  const reproduce = structuredClone(f.tasks[2]); reproduce.id = 'reproduce'; reproduce.dependsOn = ['t2']; reproduce.stage = 'reproduce'; reproduce.job = { ...reproduce.job, id: 'jr', taskId: 'reproduce', attemptId: 'ar' }
  const graph = await freezeTaskGraph({ ...f, tasks: [...f.tasks, reproduce], id: 'cycle-1', goal: 'Accumulate own results' })
  for (let n = 0; n < 4; n++) await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  const current = (await new ResearchStore(f.runDir).loadCurrent())!
  assert.equal(current.evidence.length, 2)
  assert.equal(current.active_claim.version, 3)
  assert.equal(current.claims.at(-1).statement, f.snapshot.claims[0].statement)
  await api.advanceExperimentGraph({ runDir: f.runDir, graph, runtime: authority })
  assert.equal((await new ResearchStore(f.runDir).loadCurrent()).evidence.length, 2)
  assert.deepEqual(counts, { j0: 1, j1: 1, j2: 1, jr: 1 })
})
