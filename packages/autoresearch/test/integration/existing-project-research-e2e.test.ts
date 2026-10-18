import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { literatureFixture } from '../helpers/literature-context.ts'
import { FakeAgentProvider } from './fake-agent-provider.ts'
import { AutoResearchService } from '../../dist/service/autoresearch-service.js'
import { SubagentRoleAgentProvider } from '../../dist/providers/subagent-provider.js'
import { installRequestAccounting } from '../../dist/providers/request-accounting.js'
import { DEFAULT_PROJECT_SETTINGS, saveProjectSettings } from '../../dist/settings/project-settings.js'
import { ResearchStore } from '../../dist/research/index.js'
import { loadTaskGraph } from '../../dist/experiment/task-graph.js'
import { localJobDirectory } from '../../dist/runtime/executors/local.js'
import { collectArtifacts, writeArtifactManifest } from '../../dist/runtime/artifacts.js'
import { openJobStore } from '../../dist/runtime/job-store.js'

const protocol = { metric: 'success', controls: ['control'], sample: '8 independent task pairs', split: 'fresh-heldout', seeds: [], budget: { unit: 'task-pair', limit: 8, tolerance: 0 }, stopping_rule: 'exactly 8 independent pairs', failure_policy: 'exclude_from_mechanism', missing_policy: 'inconclusive', duplicate_policy: 'block_conflicts', fingerprints: { code: 'fixture-code', data: 'fresh-fixture-data', treatment: 'alpha', model: 'controlled-observations' }, provenance: 'known', decision_rule: 'paired_sign_test_v1' }
const jobBudget = { wallMs: 1000, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 1000, maxArtifactBytes: 4000 }

async function setup(t: any, f: any, options: { roleCap?: number; validator?: string; wallCap?: number } = {}) {
  t.mock.method(os, 'homedir', () => f.project); syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await writeFile(join(f.project, 'README.md'), '# alpha implementation\nA candidate intervention needs independent validation.\n')
  await writeFile(join(f.project, 'report.md'), 'Historical result: 99% accuracy. Unverified.\n')
  const settings = structuredClone(DEFAULT_PROJECT_SETTINGS)
  Object.assign(settings.workflow, { mode: 'minimal', deepDive: 'never', currentIdeaSearch: 'never', modelScout: 'never', experimentReview: 'never', postResultSynthesis: 'never', reflexionRounds: 0 })
  settings.literature = f.input.settings
  settings.budget.maxRoleCalls = options.roleCap ?? 8
  settings.budget.maxRunTokens = 40000
  await saveProjectSettings(f.project, settings)
  const calls: string[] = [], prompts: Record<string, string> = {}, submissions: string[] = []
  const fake = new FakeAgentProvider({ decisions: ['finish'], minimalRisk: 'low' })
  let active: any, listener: any
  installRequestAccounting({ on(_event: string, callback: any) { listener = callback; return () => {} } } as never)
  const native = new SubagentRoleAgentProvider({ async start(_name: string, request: any) {
    const { role, input, context } = active
    calls.push(role); prompts[role] = request.prompt[0].text
    // Exercise the actual ownership/accounting middleware using declared fixture usage.
    const stream = listener({ provider: 'controlled', model: 'fixture', messages: [{ role: 'user', content: request.prompt }], maxTokens: 100 }, async function* () {
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
      yield { type: 'finish', reason: 'completed' }
    })
    for await (const _chunk of stream) { /* drain accounting */ }
    let structured: any
    if (role === 'project-explorer') {
      assert.deepEqual(request.toolFilter, { allow: [] })
      const inventory = JSON.parse(input.projectInventory)
      const source = inventory.files.find((file: any) => file.relativePath === 'README.md').source.id
      const report = inventory.files.find((file: any) => file.relativePath === 'report.md').source.id
      structured = { contributions: [{ id: 'alpha', claim: 'alpha may improve success on fresh tasks', status: 'proposed', sourceIds: [source], limitations: ['Historical accuracy is unverified'], validation: ['Compare alpha against control on eight fresh independent pairs'], researchQuestion: 'Does alpha improve fresh task success?' }], historicalResults: [{ statement: 'Historical report claims 99% accuracy', sourceIds: [report], status: 'unverified' }], selectedId: 'alpha', selectionReason: 'Bounded supplementary test' }
    } else {
      structured = (await fake.run(role, input, context)).structured
      if (role === 'planner') structured = { ...structured, protocol, taskGraph: { tasks: ['baseline', 'formal'].map((stage, i) => ({ id: stage, dependsOn: i ? ['baseline'] : [], stage, command: process.execPath, argv: ['controlled-fixture.mjs'], cwd: '.', env: {}, budget: jobBudget, inputs: [], outputs: [{ relativePath: 'result.json', kind: i ? 'paired-outcomes' : 'preparation', maxBytes: 4000 }], validatorId: i ? options.validator ?? 'paired_sign_test_v1' : 'artifact_integrity_v1', split: protocol.split, exposure: i ? 'heldout' : 'none' })) } }
    }
    return { id: `fixture-${calls.length}`, result: Promise.resolve({ stopReason: 'completed', structured, output: [] }), async dispose() {} }
  } } as never)
  const provider = { async run(role: any, input: any, context: any) {
    assert.equal(context.projectDir, f.project)
    if (role === 'paper-planner') throw new Error('E2_PAPER_HANDOFF')
    active = { role, input, context }
    return native.run(role, input, context)
  } }
  const runtime = { limits: { maxConcurrentJobs: 1, maxReservedWallMs: options.wallCap ?? 2000 }, authorize: async (spec: any) => { assert.equal(spec.executable, process.execPath); assert.deepEqual(spec.budget, jobBudget) }, backendFactory: (store: any) => ({
    async submit(spec: any) {
      submissions.push(spec.id)
      const dir = localJobDirectory(store.root, spec.id)
      await mkdir(join(dir, 'artifacts'), { recursive: true })
      // Independent executor fixture emits observations only; the trusted validator decides validity/polarity.
      const raw = { schema: 'autoresearch/paired-outcomes/v1', protocol_hash: spec.protocolHash, split: protocol.split, fingerprints: protocol.fingerprints, unit: 'task-pair', cost: 8, units: Array.from({ length: 8 }, (_, i) => ({ id: `fresh-${i}`, control: 0, treatment: 1 })) }
      await writeFile(join(dir, 'artifacts', 'result.json'), JSON.stringify(raw))
      const manifest = await collectArtifacts(join(dir, 'artifacts'), spec.budget.maxArtifactBytes)
      await writeArtifactManifest(dir, manifest)
      return { ...(await store.get(spec.id)).receipt, backendId: 'controlled-E2', status: 'succeeded', exitCode: 0, artifactManifestHash: manifest.hash }
    }, async inspect(id: string) { return (await store.get(id)).receipt }, async collect(id: string) { return (await store.get(id)).receipt }, async cancel(id: string) { return (await store.get(id)).receipt },
  }) }
  const context = { parent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal, experimentRuntime: runtime }
  const start = () => new AutoResearchService(provider).runProjectPaper({ projectDir: f.project, runDir: f.runDir, maxCycles: 1, humanReview: 'off' }, context)
  const resume = () => new AutoResearchService(provider).resume({ runDir: f.runDir, humanReview: 'off' }, context)
  const ledger = async () => JSON.parse(await readFile(join(f.runDir, 'request-ledger.json'), 'utf8'))
  return { calls, prompts, submissions, start, resume, ledger }
}

test('existing project discovery and RAG feed frozen validation before ordinary paper handoff; resume spends nothing twice', async t => literatureFixture(async f => {
  const harness = await setup(t, f)
  assert.equal((await harness.start()).status, 'WAITING')
  const firstLedger = await harness.ledger()
  assert.deepEqual(harness.calls, ['project-explorer', 'planner'])
  assert.equal(firstLedger.totals.committedTokens, 240)
  const inventory = JSON.parse(await readFile(join(f.runDir, 'input', 'project-inventory.json'), 'utf8'))
  const source = inventory.files.find((file: any) => file.relativePath === 'README.md').source
  assert.equal(await readFile(join(f.runDir, source.path), 'utf8'), await readFile(join(f.project, 'README.md'), 'utf8'))
  assert.ok(harness.prompts.planner.includes(source.id) && harness.prompts.planner.includes(source.hash))
  assert.ok(harness.prompts.planner.includes(f.document.spans[0].evidenceText))
  assert.match(harness.prompts.planner, /unverified/)
  const graph = (await loadTaskGraph(f.runDir, 'cycle-1'))!
  const frozen = await new ResearchStore(f.runDir).loadSnapshot(graph.snapshotId)
  assert.equal(frozen.evidence.length, 0)
  assert.equal(frozen.claims[0].status, 'proposed')
  assert.deepEqual(graph.tasks.map(task => task.stage), ['baseline', 'formal'])
  await assert.rejects(harness.resume(), /E2_PAPER_HANDOFF/)
  const current = (await new ResearchStore(f.runDir).loadCurrent())!
  assert.equal(current.evidence.length, 1)
  assert.equal(current.evidence[0].validity, 'valid'); assert.equal(current.evidence[0].polarity, 'supports')
  assert.equal(current.evidence[0].validation.method, 'paired_sign_test_v1')
  assert.equal(current.evidence[0].protocol_hash, graph.protocolHash)
  const discovery = JSON.parse(await readFile(join(f.runDir, 'input', 'project-discovery.json'), 'utf8'))
  assert.equal(discovery.discovery.historicalResults[0].status, 'unverified')
  assert.ok(!current.evidence.some(e => e.observation.includes('99%')))
  const checkpoint = JSON.parse(await readFile(join(f.runDir, 'paper', 'pipeline_checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.schema, 'autoresearch/paper-pipeline-checkpoint/v1')
  const before = await harness.ledger()
  assert.equal(before.totals.committedTokens, 360)
  assert.equal((await harness.resume()).status, 'PAUSED')
  assert.equal((await new ResearchStore(f.runDir).loadCurrent())!.assessment!.claim_status, 'supported')
  assert.deepEqual((await harness.ledger()).totals, before.totals)
  assert.deepEqual((await harness.ledger()).requests, before.requests)
  assert.deepEqual(harness.calls, ['project-explorer', 'planner', 'supervisor'])
  assert.deepEqual(harness.submissions, ['cycle-1-baseline', 'cycle-1-formal'])
  assert.equal((await loadTaskGraph(f.runDir, 'cycle-1'))!.hash, graph.hash)
  assert.equal((await new ResearchStore(f.runDir).loadSnapshot(graph.snapshotId)).content_hash, frozen.content_hash)
  const jobs = await openJobStore(join(f.runDir, 'runtime', 'jobs'))
  try { assert.equal((await jobs.list()).length, 2); assert.equal((await jobs.budget()).activeJobs, 0) } finally { await jobs.close() }
  const [events] = await f.catalog.transact([{ sql: 'SELECT body FROM exposures', params: [] }])
  assert.ok(events.some((row: any) => { const e = JSON.parse(row.body); return e.actor === 'planner' && e.status === 'sent' && e.spanIds.includes(f.document.spans[0].id) }))
}))

test('historical accuracy and successful job exit cannot promote an unsupported validator or enter paper', async t => literatureFixture(async f => {
  const harness = await setup(t, f, { validator: 'unsupported-project-validator' })
  assert.equal((await harness.start()).status, 'WAITING')
  assert.equal((await harness.resume()).status, 'PAUSED')
  const current = (await new ResearchStore(f.runDir).loadCurrent())!
  assert.equal(current.evidence.length, 1)
  assert.notEqual(current.evidence[0].validity, 'valid')
  assert.equal(current.evidence[0].polarity, 'inconclusive')
  assert.equal(current.assessment.admissible_evidence_ids.length, 0)
  await assert.rejects(readFile(join(f.runDir, 'paper', 'pipeline_checkpoint.json')), { code: 'ENOENT' })
  const before = await harness.ledger()
  await harness.resume()
  assert.deepEqual((await harness.ledger()).totals, before.totals)
  assert.equal(harness.submissions.length, 2)
}))

test('existing-project role budget prevents supplementary planning before dispatch', async t => literatureFixture(async f => {
  const harness = await setup(t, f, { roleCap: 1 })
  assert.equal((await harness.start()).status, 'PAUSED')
  assert.deepEqual(harness.calls, ['project-explorer'])
  assert.deepEqual(harness.submissions, [])
  const before = await harness.ledger()
  assert.equal(before.totals.roleStarts, 1)
  assert.equal(before.totals.committedTokens, 120)
  await harness.resume()
  assert.deepEqual((await harness.ledger()).totals, before.totals)
  assert.deepEqual(harness.calls, ['project-explorer'])
}))

test('host runtime wall ceiling prevents oversized supplementary jobs and survives resume', async t => literatureFixture(async f => {
  const harness = await setup(t, f, { wallCap: 500 })
  assert.equal((await harness.start()).status, 'PAUSED')
  assert.deepEqual(harness.submissions, [])
  const before = await harness.ledger()
  assert.equal((await harness.resume()).status, 'PAUSED')
  assert.deepEqual(harness.submissions, [])
  assert.deepEqual((await harness.ledger()).totals, before.totals)
  assert.deepEqual(harness.calls, ['project-explorer', 'planner'])
  assert.equal((await new ResearchStore(f.runDir).loadCurrent())!.evidence.length, 0)
  await assert.rejects(readFile(join(f.runDir, 'paper', 'pipeline_checkpoint.json')), { code: 'ENOENT' })
}))
