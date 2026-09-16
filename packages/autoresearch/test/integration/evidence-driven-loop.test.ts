import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { runExperimentTask } from '../../dist/experiment/runner.js'
import { FakeAgentProvider } from './fake-agent-provider.ts'
import { ResearchStore } from '../../dist/research/index.js'
import type { RoleName, RoleInput, RoleExecutionContext } from '../../dist/agents/types.js'

const context = () => ({ parent: { id: 'fixture', session: { id: 'fixture' } }, signal: new AbortController().signal })
async function setup(mode: string) {
  const dir = await mkdtemp(join(tmpdir(), 'ar-evidence-loop-'))
  await mkdir(join(dir, 'input'), { recursive: true })
  await mkdir(join(dir, '.autoresearch'), { recursive: true })
  await writeFile(join(dir, 'input', 'idea.md'), '# Idea\n\n## Direction\n\nTreatment improves success.\n')
  await writeFile(join(dir, 'PROFILE.md'), 'Local deterministic fixture only.')
  await writeFile(join(dir, '.autoresearch', 'project-settings.yaml'), `version: 2\nworkflow:\n  mode: ${mode}\n  brainstorm: never\n  deepDive: never\n  experimentReview: never\n  modelScout: never\n  postResultSynthesis: never\n  paper: never\n`)
  return dir
}

class EvidenceProvider extends FakeAgentProvider {
  workerExecutions = 0
  plannedIdeas: string[] = []
  parentHashBeforeDecision?: string
  readonly invalid: boolean | 'split' | 'null' | 'treatment'
  constructor(invalid: boolean | 'split' | 'null' | 'treatment' = false) { super({ decisions: ['revise', 'finish'] }); this.invalid = invalid }
  override async run(role: RoleName, input: RoleInput, ctx: RoleExecutionContext) {
    if (role === 'planner') {
      this.calls.push(role)
      this.plannedIdeas.push(input.idea ?? '')
      return { text: '', stopReason: 'completed', structured: {
        plan: `Run frozen paired protocol on independent batch ${input.cycle}`, riskLevel: 'low',
        hypothesis: { statement: 'Treatment improves success.', prediction: 'Positive discordant success rate', falsification: 'Negative exact paired sign test', mechanism: 'verified memory helps' },
        protocol: { metric: 'paired success', controls: ['no memory'], sample: '20 independent tasks', split: `fresh-${input.cycle}`,
          seeds: [1], budget: { unit: 'task-pair', limit: 20, tolerance: 0 }, stopping_rule: 'exactly 20 task pairs; no optional stopping',
          failure_policy: 'exclude_from_mechanism', missing_policy: 'block incomplete batch', duplicate_policy: 'block_conflicts',
          fingerprints: { code: 'fixture-v1', data: `data-${input.cycle}`, treatment: 'verified-memory-v1', model: 'deterministic-fixture' }, decision_rule: 'paired_sign_test_v1' },
      } }
    }
    if (role === 'research-worker') {
      this.calls.push(role)
      this.workerExecutions++
      const protocol = JSON.parse(await readFile(join(input.runDir, 'cycles', `cycle-${input.cycle}`, 'protocol.json'), 'utf8'))
      const path = `work/batch-${input.cycle}.json`
      await mkdir(join(input.runDir, 'work'), { recursive: true })
      await writeFile(join(input.runDir, path), JSON.stringify({ schema: 'autoresearch/paired-outcomes/v1', protocol_hash: protocol.content_hash,
        fingerprints: this.invalid === 'treatment' ? { ...protocol.fingerprints, treatment: 'contaminated' } : protocol.fingerprints,
        split: this.invalid === 'split' ? 'wrong-split' : protocol.split, unit: 'task-pair', cost: 20,
        units: Array.from({ length: 20 }, (_, n) => ({ id: this.invalid === true ? 'duplicate' : `task-${input.cycle}-${n}`,
          control: this.invalid === 'null' ? n % 2 : input.cycle === 1 ? 1 : 0, treatment: this.invalid === 'null' ? (n + 1) % 2 : input.cycle === 1 ? 0 : 1 })),
      }))
      return { text: '', stopReason: 'completed', structured: { status: 'completed', summary: 'Raw paired observations saved.', artifacts: [path] } }
    }
    if (role === 'supervisor' && input.cycle === 1) {
      this.parentHashBeforeDecision = (await new ResearchStore(input.runDir).loadCurrent())!.content_hash
      this.calls.push(role)
      const assessment = JSON.parse(await readFile(join(input.runDir, 'cycles', 'cycle-1', 'assessment.json'), 'utf8'))
      return { text: '', stopReason: 'completed', structured: { action: 'fail', reason: 'Original hypothesis was not supported.', candidates: [{
        statement: 'Only task-relevant verified memories improve success.', scope: 'new independent task population', mechanism: 'relevance controls distraction', alternatives: ['length confounding'],
        prediction: 'Positive paired success on independently sampled tasks', falsification: 'Negative or inconclusive exact paired test', measurement: 'paired task success', decision_rule: 'paired_sign_test_v1',
        evidence_ids: assessment.admissible_evidence_ids, rationale: 'Negative result suggests limiting the claim to verified relevant lessons.' }],
      } }
    }
    if (role === 'supervisor') {
      this.calls.push(role)
      return { text: '', stopReason: 'completed', structured: { action: 'finish', reason: 'Fixed validation complete.' } }
    }
    return super.run(role, input, ctx)
  }
}

for (const mode of ['minimal', 'legacy']) for (const entry of ['research', 'experiment']) {
  test(`${entry} ${mode}: raw refutation selects a new hypothesis and executes fresh protocol`, async (t) => {
    const dir = await setup(mode)
    t.after(() => rm(dir, { recursive: true, force: true }))
    const provider = new EvidenceProvider()
    const result = entry === 'research'
      ? await new AutoResearchService(provider).run({ runDir: dir, maxCycles: 2, brainstorm: 'off', humanReview: 'off' }, context())
      : await runExperimentTask({ provider }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() })
    assert.equal(result.status.toLowerCase(), 'completed')
    const store = new ResearchStore(dir)
    const parent = await store.loadSnapshot('cycle-1-assessment')
    const successor = await store.loadSnapshot('snapshot-decision-1')
    assert.notEqual(successor.active_hypothesis.version, parent.active_hypothesis.version)
    assert.ok(successor.hypotheses.some(h => h.id === parent.active_hypothesis.id && h.version === parent.active_hypothesis.version))
    assert.equal(parent.content_hash, provider.parentHashBeforeDecision)
    assert.equal(provider.workerExecutions, 2)
    assert.match(provider.plannedIdeas[1], /Only task-relevant verified memories/)
    const first = JSON.parse(await readFile(join(dir, 'cycles', 'cycle-1', 'assessment.json'), 'utf8'))
    assert.equal(first.category, 'hypothesis_refuted')
    const second = JSON.parse(await readFile(join(dir, 'cycles', 'cycle-2', 'protocol.json'), 'utf8'))
    assert.equal(second.hypothesis.version, 2)
    assert.notEqual(second.split, 'fresh-1')
    assert.match(await readFile(join(dir, 'RESEARCH_REPORT.md'), 'utf8'), /snapshot-decision-2/)
    const chain = JSON.parse(await readFile(join(dir, 'evidence_chain.json'), 'utf8'))
    assert.equal(chain.snapshot_id, 'snapshot-decision-2')
    assert.match(await readFile(join(dir, 'HANDOFF.md'), 'utf8'), /snapshot-decision-2/)
    if (mode === 'minimal') assert.deepEqual(provider.calls, ['planner', 'research-worker', 'supervisor', 'planner', 'research-worker', 'supervisor'])
  })
}

test('experiment explicit failure import preserves source bytes and supplies source hashes', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'ar-failure-source-'))
  const dir = await setup('minimal')
  t.after(async () => { await rm(dir, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }) })
  const report = '# FAILURE_REPORT\nThe old model claimed refutation, but no raw data survives.\n'
  const sourcePath = join(source, 'FAILURE_REPORT.md')
  await writeFile(sourcePath, report)
  const provider = new FakeAgentProvider({ decisions: ['finish'] })
  await runExperimentTask({ provider }, { runDir: dir, task: 'Recover prior evidence.', maxRounds: 1, agentContext: context(), failureReport: { sourceRunId: 'old-terminal-run', sourcePath } })
  const imported = JSON.parse(await readFile(join(dir, 'research', 'imported-failure.json'), 'utf8'))
  assert.equal(imported.source_run_id, 'old-terminal-run')
  assert.equal(imported.provenance, 'unknown')
  assert.equal(await readFile(sourcePath, 'utf8'), report)
  assert.match(imported.source_refs[0].hash, /^[a-f0-9]{64}$/)
  assert.equal(await readFile(join(dir, imported.source_refs[0].path), 'utf8'), report)
  assert.match(provider.inputs.find(i => i.role === 'planner')!.input.idea!, /Recover and verify imported failure sources/)
})

test('experiment records actual executor health without asserting isolation', async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, { runDir: dir, task: 'Local task.', agentContext: context() })
  const registry = JSON.parse(await readFile(join(dir, '.autoresearch', 'capabilities.json'), 'utf8'))
  assert.equal(registry.records.find(r => r.capabilityId === 'research-worker').status, 'available')
  assert.equal(registry.records.find(r => r.capabilityId === 'execution-isolation').status, 'discovered')
})

test('experiment rejects duplicate units without refuting the mechanism or selecting a new hypothesis', async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const provider = new EvidenceProvider(true)
  const result = await runExperimentTask({ provider }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() })
  assert.equal(result.status, 'paused')
  const assessment = JSON.parse(await readFile(join(dir, 'cycles', 'cycle-1', 'assessment.json'), 'utf8'))
  assert.equal(assessment.category, 'invalid_measurement')
  assert.equal(assessment.claim_status, 'inconclusive')
  assert.equal(provider.workerExecutions, 1)
})

for (const mode of ['minimal', 'legacy']) for (const entry of ['research', 'experiment']) {
  const execute = (dir: string, provider: FakeAgentProvider) => entry === 'research'
    ? new AutoResearchService(provider).run({ runDir: dir, maxCycles: 2, brainstorm: 'off', humanReview: 'off' }, context())
    : runExperimentTask({ provider }, { runDir: dir, task: 'Resume receipt fixture.', maxRounds: 2, agentContext: context() })

  test(`${entry} ${mode}: unknown worker receipt pauses resume before dispatch`, async (t) => {
    const dir = await setup(mode)
    t.after(() => rm(dir, { recursive: true, force: true }))
    const first = new FakeAgentProvider({ decisions: ['finish'], throwOnRole: 'research-worker' })
    await assert.rejects(() => execute(dir, first), /fake research-worker failure/)
    const second = new FakeAgentProvider({ decisions: ['finish'] })
    const result = await execute(dir, second)
    assert.equal(result.status.toLowerCase(), 'paused')
    assert.equal(second.calls.includes('research-worker'), false)
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.match(state.lastError, /unknown.*receipt|outcome is unknown/)
    assert.equal(JSON.parse(await readFile(join(dir, 'cycles/cycle-1/attempt.json'), 'utf8')).status, 'unknown')
  })

  test(`${entry} ${mode}: completed execution survives supervisor interruption without duplicate work`, async (t) => {
    const dir = await setup(mode)
    t.after(() => rm(dir, { recursive: true, force: true }))
    const first = new FakeAgentProvider({ decisions: ['finish'], throwOnRole: 'supervisor' })
    await assert.rejects(() => execute(dir, first), /fake supervisor failure/)
    const before = await readFile(join(dir, 'cycles/cycle-1/assessment.json'), 'utf8')
    const second = new FakeAgentProvider({ decisions: ['finish'] })
    const result = await execute(dir, second)
    assert.equal(result.status.toLowerCase(), 'completed')
    assert.equal(second.calls.includes('research-worker'), false)
    assert.equal(await readFile(join(dir, 'cycles/cycle-1/assessment.json'), 'utf8'), before)
  })
}

test('experiment cycle cap pauses a refuted question without further execution', async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const provider = new EvidenceProvider()
  const result = await runExperimentTask({ provider }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 1, agentContext: context() })
  assert.equal(result.status, 'paused')
  assert.equal(provider.workerExecutions, 1)
  assert.match(await readFile(join(dir, 'HANDOFF.md'), 'utf8'), /budget_exhausted|maxRounds/)
})

for (const [condition, expected] of [['split', 'invalid_measurement'], ['treatment', 'invalid_measurement'], ['null', 'insufficient_evidence']] as const) {
  test(`experiment ${condition} observations cannot establish a refutation`, async (t) => {
    const dir = await setup('minimal')
    t.after(() => rm(dir, { recursive: true, force: true }))
    await runExperimentTask({ provider: new EvidenceProvider(condition) }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 1, agentContext: context() })
    const assessment = JSON.parse(await readFile(join(dir, 'cycles', 'cycle-1', 'assessment.json'), 'utf8'))
    assert.equal(assessment.category, expected)
    assert.equal(assessment.claim_status, 'inconclusive')
  })
}

test('experiment failure import rejects nested target before creating source-side files', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'ar-immutable-source-'))
  t.after(() => rm(source, { recursive: true, force: true }))
  const sourcePath = join(source, 'FAILURE_REPORT.md')
  await writeFile(sourcePath, 'historical report')
  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    runDir: join(source, 'new-run'), task: 'recover', failureReport: { sourceRunId: 'old', sourcePath }, agentContext: context(),
  }), /outside source history/)
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(source)), ['FAILURE_REPORT.md'])
})

test('experiment resume after revision rebuilds next plan from committed state and does not duplicate decisions', async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = new EvidenceProvider()
  const originalRun = first.run.bind(first)
  first.run = async (role, input, ctx) => {
    if (role === 'planner' && input.cycle === 2) throw new Error('interrupted after committed revision')
    return originalRun(role, input, ctx)
  }
  await assert.rejects(() => runExperimentTask({ provider: first }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() }))
  const firstDecision = await readFile(join(dir, 'research', 'snapshots', 'snapshot-decision-1', 'manifest.json'), 'utf8')
  await writeFile(join(dir, 'RESEARCH_NEXT_PLAN.md'), 'Stale HANDOFF: repeat the rejected original claim.')
  const second = new EvidenceProvider()
  const result = await runExperimentTask({ provider: second }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() })
  assert.equal(result.status, 'completed')
  assert.equal(second.workerExecutions, 1)
  assert.match(second.plannedIdeas[0], /Only task-relevant verified memories/)
  assert.doesNotMatch(second.plannedIdeas[0], /Stale HANDOFF/)
  assert.equal(await readFile(join(dir, 'research', 'snapshots', 'snapshot-decision-1', 'manifest.json'), 'utf8'), firstDecision)
})

test('experiment rejects supervisor output when CURRENT changed after its input snapshot', async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const provider = new FakeAgentProvider({ decisions: ['finish'] })
  const originalRun = provider.run.bind(provider)
  provider.run = async (role, input, ctx) => {
    const result = await originalRun(role, input, ctx)
    if (role === 'supervisor') {
      const old = JSON.parse(await readFile(join(dir, 'research', 'snapshots', 'cycle-1-frozen', 'manifest.json'), 'utf8'))
      await writeFile(join(dir, 'CURRENT.json'), JSON.stringify({ snapshot_id: old.id, content_hash: old.content_hash }))
    }
    return result
  }
  const result = await runExperimentTask({ provider }, { runDir: dir, task: 'Snapshot race fixture.', agentContext: context() })
  assert.equal(result.status, 'paused')
  assert.match(result.reason!, /snapshot changed/)
})

test('research enabled paper consumes the final committed scientific snapshot', async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const settingsFile = join(dir, '.autoresearch', 'project-settings.yaml')
  await writeFile(settingsFile, (await readFile(settingsFile, 'utf8')).replace('paper: never', 'paper: enabled'))
  const provider = new EvidenceProvider()
  const result = await new AutoResearchService(provider).run({ runDir: dir, maxCycles: 2, humanReview: 'off' }, context())
  assert.equal(result.status, 'COMPLETED')
  assert.ok(provider.calls.includes('writer'))
  const writer = provider.inputs.find(i => i.role === 'writer')
  assert.equal(writer?.input.researchContext?.snapshot?.id, 'snapshot-decision-2')
  assert.match(await readFile(join(dir, 'FINAL_REPORT.md'), 'utf8'), /snapshot-decision-2/)
})

for (const checkpointGap of [false, true]) test(`known null finish uses canonical replication and budget pause${checkpointGap ? ' across a decision checkpoint gap' : ''}`, async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const provider = new EvidenceProvider('null')
  const originalRun = provider.run.bind(provider)
  provider.run = async (role, input, ctx) => {
    if (role === 'supervisor') {
      provider.calls.push(role)
      return { text: '', stopReason: 'completed', structured: { action: 'finish', reason: 'Task execution finished.' } }
    }
    return originalRun(role, input, ctx)
  }
  if (checkpointGap) {
    const originalCommit = ResearchStore.prototype.commit
    let interrupted = false
    t.mock.method(ResearchStore.prototype, 'commit', async function(snapshot) {
      const committed = await originalCommit.call(this, snapshot)
      if (!interrupted && committed.decision?.id === 'decision-1') {
        interrupted = true
        throw new Error('interrupted after CURRENT commit before runtime checkpoint')
      }
      return committed
    })
    await assert.rejects(() => runExperimentTask({ provider }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() }), /interrupted after CURRENT/)
    assert.equal((await new ResearchStore(dir).loadCurrent())!.decision!.action, 'replicate')
    await assert.rejects(() => readFile(join(dir, 'cycles/cycle-1/runtime-decision.json')), { code: 'ENOENT' })
    assert.equal(provider.workerExecutions, 1)
  }
  const result = await runExperimentTask({ provider }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() })
  assert.equal(result.status, 'paused')
  assert.equal(provider.workerExecutions, 2)
  assert.equal(provider.calls.filter(role => role === 'supervisor').length, 2)
  const store = new ResearchStore(dir)
  const first = await store.loadSnapshot('snapshot-decision-1')
  const checkpoint = JSON.parse(await readFile(join(dir, 'cycles/cycle-1/runtime-decision.json'), 'utf8'))
  assert.equal(first.decision!.action, 'replicate')
  assert.equal(checkpoint.action, 'continue')
  assert.equal(checkpoint.reason, first.decision!.reason)
  assert.equal(checkpoint.snapshotHash, first.content_hash)
  const final = await store.loadCurrent()
  assert.equal(final!.assessment!.claim_status, 'inconclusive')
  assert.equal(final!.decision!.action, 'pause')
  assert.match(final!.decision!.reason, /budget_exhausted/)
  assert.equal(JSON.parse(await readFile(join(dir, 'cycles/cycle-2/runtime-decision.json'), 'utf8')).action, 'pause')
  assert.match(await readFile(join(dir, 'HANDOFF.md'), 'utf8'), /decision: pause/)
  const decisionHash = final!.content_hash
  await rm(join(dir, 'cycles/cycle-2/runtime-decision.json'))
  const resumed = await runExperimentTask({ provider }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() })
  assert.equal(resumed.status, 'paused')
  assert.equal(provider.workerExecutions, 2)
  assert.equal((await store.loadCurrent())!.content_hash, decisionHash)
  assert.equal(JSON.parse(await readFile(join(dir, 'cycles/cycle-2/runtime-decision.json'), 'utf8')).action, 'pause')
})

test('review regression: assessment uses archived bytes when a producer changes the live artifact', async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const captureSource = ResearchStore.prototype.captureSource
  t.mock.method(ResearchStore.prototype, 'captureSource', async function(path: string, sourceId?: string) {
    const captured = await captureSource.call(this, path, sourceId)
    if (path === 'work/batch-1.json') {
      const live = JSON.parse(await readFile(join(dir, path), 'utf8'))
      live.units = live.units.map(unit => ({ ...unit, control: 0, treatment: 1 }))
      await writeFile(join(dir, path), JSON.stringify(live))
    }
    return captured
  })
  await runExperimentTask({ provider: new EvidenceProvider() }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 1, agentContext: context() })
  const snapshot = await new ResearchStore(dir).loadCurrent()
  const evidence = snapshot!.evidence[0]!
  const archived = JSON.parse(await readFile(join(dir, evidence.artifacts[0]!.path!), 'utf8'))
  assert.equal(archived.units[0].control, 1)
  assert.equal(archived.units[0].treatment, 0)
  assert.equal(evidence.polarity, 'opposes')
  assert.equal(snapshot!.assessment!.claim_status, 'refuted')
  assert.equal(JSON.parse(await readFile(join(dir, 'work/batch-1.json'), 'utf8')).units[0].treatment, 1)
})

test('review regression: derived views preserve historical judgments and evidence lineage across revision', async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = new EvidenceProvider()
  const originalRun = first.run.bind(first)
  first.run = async (role, input, ctx) => {
    if (role === 'planner' && input.cycle === 2) throw new Error('inspect pending successor')
    return originalRun(role, input, ctx)
  }
  await assert.rejects(() => runExperimentTask({ provider: first }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() }))
  const pending = JSON.parse(await readFile(join(dir, 'research_tree.json'), 'utf8')).nodes
  assert.equal(pending.find(n => n.id === 'research:hypothesis-1@1').status, 'refuted')
  assert.equal(pending.find(n => n.id === 'research:hypothesis-1@2').status, 'proposed')
  assert.equal(pending.find(n => n.id === 'research:evidence-1@1').parent, 'research:hypothesis-1@1')
  await rm(join(dir, 'research_tree.json')) // Rebuild historical judgments from committed ancestry.
  await runExperimentTask({ provider: new EvidenceProvider() }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() })
  const final = JSON.parse(await readFile(join(dir, 'research_tree.json'), 'utf8')).nodes
  assert.equal(final.find(n => n.id === 'research:hypothesis-1@1').status, 'refuted')
  assert.equal(final.find(n => n.id === 'research:hypothesis-1@2').status, 'supported')
  assert.equal(final.find(n => n.id === 'research:evidence-1@1').parent, 'research:hypothesis-1@1')
  assert.equal(final.find(n => n.id === 'research:evidence-2@1').parent, 'research:hypothesis-1@2')
})

test('review regression: rejected same-source import preserves all terminal output bytes', async (t) => {
  const dir = await setup('minimal')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, { runDir: dir, task: 'Terminal source.', agentContext: context() })
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, status: 'FAILED', phase: 'failed' }))
  await writeFile(join(dir, 'HANDOFF.md'), 'Immutable terminal source handoff.\n')
  const sourcePath = join(dir, 'FAILURE_REPORT.md')
  await writeFile(sourcePath, 'Historical source failure.\n')
  const names = ['state.json', 'CURRENT.json', 'HANDOFF.md', 'research_tree.json', 'evidence_chain.json', 'RESEARCH_REPORT.md', 'EXPERIMENT_REPORT.md', 'FAILURE_REPORT.md']
  const before = await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')))
  await assert.rejects(() => runExperimentTask({ provider: new FakeAgentProvider({ decisions: ['finish'] }) }, {
    runDir: dir, task: 'Import source.', failureReport: { sourceRunId: state.runId, sourcePath }, agentContext: context(),
  }), /outside source history/)
  assert.deepEqual(await Promise.all(names.map(name => readFile(join(dir, name), 'utf8'))), before)
})

for (const mode of ['minimal', 'legacy']) for (const entry of ['research', 'experiment']) {
  test(`${entry} ${mode}: legacy artifacts remain unknown in committed report`, async (t) => {
    const dir = await setup(mode)
    t.after(() => rm(dir, { recursive: true, force: true }))
    const provider = new FakeAgentProvider({ decisions: ['finish'] })
    if (entry === 'research') await new AutoResearchService(provider).run({ runDir: dir, brainstorm: 'off', humanReview: 'off' }, context())
    else await runExperimentTask({ provider }, { runDir: dir, task: 'Treatment improves success.', maxRounds: 2, agentContext: context() })
    const pointer = JSON.parse(await readFile(join(dir, 'CURRENT.json'), 'utf8'))
    assert.ok(pointer, 'actual runner must commit research state')
    const report = await readFile(join(dir, 'RESEARCH_REPORT.md'), 'utf8')
    assert.match(report, /unknown|insufficient_evidence/)
    assert.doesNotMatch(report, /claim status: supported/)
    if (mode === 'minimal') assert.deepEqual(provider.calls, ['planner', 'research-worker', 'supervisor'])
  })
}
