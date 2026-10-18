import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const api = await import('../../dist/literature/discovery/context.js') as any

function store() {
  const bytes = new Map<string, Uint8Array>()
  return {
    async captureBytes(value: string | Uint8Array, id: string) {
      const data = typeof value === 'string' ? Buffer.from(value) : value
      const hash = createHash('sha256').update(data).digest('hex')
      const ref = { id, path: `research/sources/${hash}`, hash }
      bytes.set(ref.path, data)
      return ref
    },
    async readSource(ref: { path?: string }) { return bytes.get(ref.path ?? '')! },
  }
}

test('discovery context exposes compact neutral records to approved roles only', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'discovery-context-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const sourceStore = store()
  const raw = await sourceStore.captureBytes('raw response', 'raw')
  const parsed = await sourceStore.captureBytes(JSON.stringify({ parserVersion: 'provider-metadata/v1', provider: 'crossref', resultKey: 'doi', rawSource: raw, title: 'Anchor', authors: [], year: 2020, abstract: 'bounded abstract' }), 'parsed')
  const report = {
    schema: 'autoresearch/current-idea-similarity/v1', surveyId: 'survey-1', ideaFingerprint: 'target', configFingerprint: 'config', authority: 'advisory-discovery-only', status: 'complete', roundsCompleted: 3,
    queries: [], rejectedQueries: [], receipts: [], candidates: [{ id: 'paper-1', title: 'Anchor', authors: [], year: 2020, abstract: 'bounded abstract', aliases: [{ kind: 'doi', value: '10.1/anchor' }], providerHits: [], observations: [{ receiptId: 'receipt', title: 'Anchor', authors: [], year: 2020, abstract: 'bounded abstract', sourceRef: parsed, parserVersion: 'provider-metadata/v1', resultKey: 'doi', rawSource: raw }], conflicts: [] }], nearest: [], assessments: [], counts: { collected: 1, retained: 1, omitted: 0, shortlisted: 1, reviewed: 1, actualHttpAttempts: 1, cacheHits: 0 }, providerCoverage: { arxiv: { attempts: 0, successful: 0, degraded: 0 }, crossref: { attempts: 1, successful: 1, degraded: 0 }, 'semantic-scholar': { attempts: 0, successful: 0, degraded: 0 } }, gaps: [], uncertainty: [], stopReason: 'max_rounds', createdAt: new Date().toISOString(), elapsedMs: 1, sourceRefs: [raw, parsed], executionBinding: { runId: 'run' },
  }
  report.nearest = report.candidates
  const built = await api.buildDiscoveryContext({ runDir, report, scope: { projectId: runDir, branchId: 'branch', runId: 'run' }, role: 'planner', maxContextChars: 12_000, currentTargetFingerprint: 'target', sourceStore })
  assert.equal(built.records.every((record: any) => record.kind === 'artifact' || record.kind === 'summary'), true)
  assert.ok(built.records.every((record: any) => record.polarity === 'neutral'))
  assert.deepEqual(built.records[0].accessRoles, ['planner', 'idea-generator', 'idea-reflexion', 'hypothesis-reviser'])
  const worker = await api.buildDiscoveryContext({ runDir, report, scope: { projectId: runDir, branchId: 'branch', runId: 'run' }, role: 'research-worker', maxContextChars: 12_000, currentTargetFingerprint: 'target', sourceStore })
  assert.equal(worker.records.length, 0)
  await assert.rejects(() => api.buildDiscoveryContext({ runDir, report, scope: { projectId: runDir, branchId: 'branch', runId: 'run' }, role: 'planner', maxContextChars: 12_000, currentTargetFingerprint: 'changed', sourceStore }), /stale|fingerprint/i)
})

test('discovery exposure records prepared and unknown without literature source binding', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'discovery-exposure-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const binding = { surveyId: 'survey', ideaFingerprint: 'target', reportHash: 'report', selectedRecordIds: ['discovery-summary-survey'], sourceRefs: [], exposurePath: join(runDir, 'exposure.jsonl') }
  const context = { rendered: 'summary', selection: { selected: [], excluded: [], inputTokens: 0, estimated: true }, manifest: {} }
  const prepared = await api.prepareDiscoveryExposure({ runDir, binding, context, prompt: 'summary', role: 'planner' })
  assert.equal(prepared.status, 'prepared')
  await api.finishDiscoveryExposure(binding, prepared, 'unknown')
})

test('discovery exposure records only records selected and rendered by the assembler', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'discovery-exposure-selection-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const { assembleResearchContext } = await import('../../dist/research-context/assemble.js')
  const { canonicalContextJson, sealContextRecord } = await import('../../dist/research-context/index.js')
  const scope = { projectId: runDir, branchId: 'pre-snapshot', runId: 'run' }
  const binding = { surveyId: 'survey', ideaFingerprint: 'target', reportHash: 'report', selectedRecordIds: ['discovery-summary-survey', 'discovery-candidate-omitted'], sourceRefs: [], exposurePath: join(runDir, 'exposure.jsonl') }
  const records = [
    sealContextRecord({ id: 'discovery-summary-survey', version: 1, layer: 3, kind: 'summary', scope: { ...scope, visibility: 'run' }, required: true, accessRoles: ['planner'], polarity: 'neutral', payload: { surveyId: 'survey', summary: 'summary' }, source: { recordType: 'discovery-report' } }),
    sealContextRecord({ id: 'discovery-candidate-omitted', version: 1, layer: 3, kind: 'artifact', scope: { ...scope, visibility: 'run' }, accessRoles: ['planner'], polarity: 'neutral', payload: { candidateId: 'omitted', title: 'A candidate that does not fit '.repeat(10_000) }, source: { recordType: 'discovery-candidate' } }),
  ]
  const request = { stage: 'planner', scope, discovery: binding, records }
  const narrow = await assembleResearchContext({ runDir, role: 'planner', taskId: 'planner-narrow', request, budget: { maxInputTokens: 2_000 } })
  assert.deepEqual(narrow.selection.selected.map((entry: any) => entry.record.id), ['discovery-summary-survey'])
  const prepared = await api.prepareDiscoveryExposure({ runDir, binding, context: narrow, prompt: narrow.rendered, role: 'planner' })
  assert.deepEqual(prepared.selectedRecordIds, ['discovery-summary-survey'])
  assert.ok(narrow.rendered.includes(canonicalContextJson(narrow.selection.selected[0].record)))
})

test('discovery repair exposure is empty when repair prompt does not render discovery records', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'discovery-exposure-repair-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const { sealContextRecord } = await import('../../dist/research-context/index.js')
  const { DEFAULT_PROJECT_SETTINGS } = await import('../../dist/settings/schema.js')
  const { SubagentRoleAgentProvider } = await import('../../dist/providers/subagent-provider.js')
  const scope = { projectId: runDir, branchId: 'pre-snapshot', runId: 'run' }
  const binding = { surveyId: 'survey', ideaFingerprint: 'target', reportHash: 'report', selectedRecordIds: ['discovery-summary-survey'], sourceRefs: [], exposurePath: join(runDir, 'exposure.jsonl') }
  const records = [sealContextRecord({ id: 'discovery-summary-survey', version: 1, layer: 3, kind: 'summary', scope: { ...scope, visibility: 'run' }, required: true, accessRoles: ['planner'], polarity: 'neutral', payload: { surveyId: 'survey', summary: 'summary' }, source: { recordType: 'discovery-report' } })]
  let starts = 0
  const provider = new SubagentRoleAgentProvider({ async start(_provider: string, input: any) {
    starts++
    const text = starts === 1 ? 'not json' : '{"plan":"repaired"}'
    return { id: `repair-${starts}`, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }), async dispose() {} }
  } } as never)
  await provider.run('planner', { runDir, taskId: 'repair-task', idea: 'idea', profile: 'profile', researchContext: { stage: 'planner', scope, discovery: binding, records } }, { parent: { id: 'parent' }, signal: new AbortController().signal, projectDir: runDir, runId: 'run', policySnapshot: { ...DEFAULT_PROJECT_SETTINGS } })
  const exposure = (await (await import('node:fs/promises')).readFile(binding.exposurePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const prepared = exposure.filter((item: any) => item.status === 'prepared')
  assert.equal(starts, 2)
  assert.deepEqual(prepared[0].selectedRecordIds, ['discovery-summary-survey'])
  assert.deepEqual(prepared[1].selectedRecordIds, [])
})

test('discovery exposure is marked unknown when native transport fails', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'discovery-exposure-unknown-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const { sealContextRecord } = await import('../../dist/research-context/index.js')
  const { DEFAULT_PROJECT_SETTINGS } = await import('../../dist/settings/schema.js')
  const { SubagentRoleAgentProvider } = await import('../../dist/providers/subagent-provider.js')
  const scope = { projectId: runDir, branchId: 'pre-snapshot', runId: 'run' }
  const binding = { surveyId: 'survey', ideaFingerprint: 'target', reportHash: 'report', selectedRecordIds: ['discovery-summary-survey'], sourceRefs: [], exposurePath: join(runDir, 'exposure.jsonl') }
  const records = [sealContextRecord({ id: 'discovery-summary-survey', version: 1, layer: 3, kind: 'summary', scope: { ...scope, visibility: 'run' }, required: true, accessRoles: ['planner'], polarity: 'neutral', payload: { surveyId: 'survey', summary: 'summary' }, source: { recordType: 'discovery-report' } })]
  const provider = new SubagentRoleAgentProvider({ async start() { throw new Error('transport failed') } } as never)
  await assert.rejects(() => provider.run('planner', { runDir, taskId: 'unknown-task', idea: 'idea', profile: 'profile', researchContext: { stage: 'planner', scope, discovery: binding, records } }, { parent: { id: 'parent' }, signal: new AbortController().signal, projectDir: runDir, runId: 'run', policySnapshot: { ...DEFAULT_PROJECT_SETTINGS } }), /transport failed/)
  const exposure = (await (await import('node:fs/promises')).readFile(binding.exposurePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(exposure.map((item: any) => item.status), ['prepared', 'unknown'])
})
