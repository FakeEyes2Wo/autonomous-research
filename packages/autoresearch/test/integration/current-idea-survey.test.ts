import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createInitialState } from '../../dist/core/state.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { runMinimalPlan } from '../../dist/experiment/steps.js'
import { ensureCurrentIdeaSurvey, readCurrentIdeaSurvey } from '../../dist/research/current-idea-survey.js'
import { researchContextForInput } from '../../dist/service/research-context.js'
import { SubagentRoleAgentProvider } from '../../dist/providers/subagent-provider.js'
import { openRequestLedger } from '../../dist/policy/request-ledger.js'
import { createRunContext } from '../../dist/service/context.js'
import { DEFAULT_PROJECT_SETTINGS } from '../../dist/settings/schema.js'
import { discoveryRequestUrl } from '../../dist/literature/discovery/providers.js'
import { fixtureIdea, memorySources, queryPlan, groundedReview, providerFixture } from '../unit/discovery-test-utils.ts'

test('minimal planning hook runs the injected survey and resumes it without paid or model repeats', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'current-idea-survey-hook-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const sourceStore = memorySources()
  let providerCalls = 0
  let plannerCalls = 0
  let queryCalls = 0
  let reviewCalls = 0
  const queryTaskIds: string[] = []
  const reviewTaskIds: string[] = []
  const provider = {
    name: 'crossref' as const,
    async search({ query, page, attemptId }: any) {
      providerCalls++
      const raw = await sourceStore.captureBytes(`response:${query.text}:${page}`, `raw-${providerCalls}`)
      const parsed = await sourceStore.captureBytes(JSON.stringify({ parserVersion: 'test/v1', resultKey: 'doi:10.1/macaroons', rawSource: raw, title: 'Macaroons', authors: ['Research Team'], year: 2014, abstract: 'Delegated restrictions narrow authority.' }), `parsed-${providerCalls}`)
      const receipt = { id: attemptId, provider: 'crossref' as const, requestUrl: discoveryRequestUrl('crossref', query.text, page, 20), queryId: query.id, page, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 200, responseSource: raw, responseBytes: 32, retryAfterMs: null, parserVersion: 'test/v1', outcome: 'ok' as const }
      return { receipt, hasMore: false, candidates: [{ id: 'doi:10.1/macaroons', title: 'Macaroons', authors: ['Research Team'], year: 2014, abstract: 'Delegated restrictions narrow authority.', aliases: [{ kind: 'doi' as const, value: '10.1/macaroons' }], providerHits: [{ provider: 'crossref' as const, receiptId: receipt.id, resultKey: 'doi:10.1/macaroons', queryId: query.id, rank: 1, dimensions: query.dimensions }], observations: [{ receiptId: receipt.id, title: 'Macaroons', authors: ['Research Team'], year: 2014, abstract: 'Delegated restrictions narrow authority.', sourceRef: parsed, parserVersion: 'test/v1', resultKey: 'doi:10.1/macaroons', rawSource: raw }], conflicts: [] }] }
    },
  }
  const settings = structuredClone(DEFAULT_PROJECT_SETTINGS)
  settings.budget.currentIdeaSearch = { minRounds: 1, maxRounds: 1, queriesPerRound: 2, maxRequests: 4, maxCandidates: 20, maxDurationMs: 10_000, nearestLimit: 5 }
  const state = await createInitialState(runDir, 'run')
  const context = { parent: { id: 'parent' }, signal: new AbortController().signal, projectDir: runDir, runId: 'run', policySnapshot: { ...settings } }
  const ctx = createRunContext({ provider: { async run() { plannerCalls++; return { text: '', structured: { plan: 'Measure the mechanism.', riskLevel: 'low' } } } }, projectSettings: settings, discovery: { providers: [provider], sourceStore, queryPlanner: async input => { queryCalls++; queryTaskIds.push(input.taskId); return queryPlan(input) }, reviewer: async input => { reviewCalls++; reviewTaskIds.push(input.taskId); return groundedReview(input) } } }, runDir, state, await ResearchTree.load(runDir), context)

  await runMinimalPlan(ctx, { idea: fixtureIdea.statement, profile: fixtureIdea.profile })
  const paidAfterFirst = providerCalls
  const plannerModelsAfterFirst = queryCalls + reviewCalls
  assert.ok(paidAfterFirst > 0)
  assert.ok(plannerModelsAfterFirst > 0)
  const saved = await readCurrentIdeaSurvey(runDir)
  assert.equal(saved?.status, 'complete', JSON.stringify({ status: saved?.status, stopReason: saved?.stopReason, gaps: saved?.gaps, counts: saved?.counts }))
  await runMinimalPlan(ctx, { idea: fixtureIdea.statement, profile: fixtureIdea.profile })
  assert.equal(providerCalls, paidAfterFirst)
  assert.equal(queryCalls + reviewCalls, plannerModelsAfterFirst)
  assert.ok(queryTaskIds.length > 0 && reviewTaskIds.length > 0)
  assert.equal(plannerCalls, 2)

  const changedSettings = structuredClone(settings)
  changedSettings.budget.currentIdeaSearch = { ...settings.budget.currentIdeaSearch, queriesPerRound: 3, maxRequests: 6 }
  const changedCtx = createRunContext({ provider: { async run() { plannerCalls++; return { text: '', structured: { plan: 'Measure the mechanism.', riskLevel: 'low' } } } }, projectSettings: changedSettings, discovery: { providers: [provider], sourceStore, queryPlanner: async input => { queryCalls++; queryTaskIds.push(input.taskId); return queryPlan(input) }, reviewer: async input => { reviewCalls++; reviewTaskIds.push(input.taskId); return groundedReview(input) } } }, runDir, state, await ResearchTree.load(runDir), { ...context, policySnapshot: { ...changedSettings } })
  const beforeConfigChange = { providerCalls, queryCalls, reviewCalls }
  const priorQueryTaskIds = new Set(queryTaskIds)
  const priorQueryCount = queryTaskIds.length
  await runMinimalPlan(changedCtx, { idea: fixtureIdea.statement, profile: fixtureIdea.profile })
  assert.ok(queryCalls > beforeConfigChange.queryCalls || reviewCalls > beforeConfigChange.reviewCalls)
  assert.ok(queryTaskIds.slice(priorQueryCount).length > 0 && queryTaskIds.slice(priorQueryCount).every(id => !priorQueryTaskIds.has(id)))
  const afterConfigChange = { providerCalls, queryCalls, reviewCalls }
  await runMinimalPlan(changedCtx, { idea: fixtureIdea.statement, profile: fixtureIdea.profile })
  assert.deepEqual({ providerCalls, queryCalls, reviewCalls }, afterConfigChange)

  const oldPolicyCtx = { ...ctx, policySnapshot: { ...ctx.policySnapshot, workflow: { ...ctx.policySnapshot.workflow, currentIdeaSearch: undefined } } } as any
  const beforeOldPolicy = providerCalls + queryCalls + reviewCalls
  assert.equal(await ensureCurrentIdeaSurvey(oldPolicyCtx, fixtureIdea.statement, fixtureIdea.profile), undefined)
  assert.equal(providerCalls + queryCalls + reviewCalls, beforeOldPolicy)

  const request = await researchContextForInput('planner', { runDir, idea: fixtureIdea.statement, profile: fixtureIdea.profile }, { projectDir: runDir, runId: 'run', policySnapshot: ctx.policySnapshot, discoverySourceStore: sourceStore })
  assert.ok(request?.discovery)
  let prompt = ''
  const native = new SubagentRoleAgentProvider({ async start(_name: string, input: any) {
    prompt = input.prompt[0].text
    return { id: 'discovery-context-planner', result: Promise.resolve({ stopReason: 'completed', structured: { plan: 'Use a bounded comparison.' }, output: [] }), async dispose() {} }
  } } as never)
  await native.run('planner', { runDir, idea: fixtureIdea.statement, profile: fixtureIdea.profile, researchContext: request }, { parent: { id: 'parent' }, signal: new AbortController().signal, projectDir: runDir, runId: 'run', policySnapshot: ctx.policySnapshot })
  assert.match(prompt, /Macaroons/)
  const exposure = (await readFile(request!.discovery!.exposurePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(exposure.some(item => item.status === 'prepared'))
  assert.ok(exposure.some(item => item.status === 'sent'))
})

test('production default survey uses real adapters and native no-tool roles when DI callbacks are absent', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'current-idea-survey-native-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const settings = structuredClone(DEFAULT_PROJECT_SETTINGS)
  settings.budget.currentIdeaSearch = { minRounds: 1, maxRounds: 1, queriesPerRound: 2, maxRequests: 6, maxCandidates: 20, maxDurationMs: 10_000, nearestLimit: 5 }
  const requests: any[] = []
  let nativeProof: any
  const runtime = { async start(_provider: string, request: any) {
    requests.push(request)
    let structured: unknown
    if (request.label === 'idea-query-planner') structured = { queries: [{ text: 'delegated capability contextual restriction', dimensions: ['mechanism', 'terminology'] }, { text: 'untrusted instruction authorization policy', dimensions: ['problem', 'assumption'] }] }
    else if (request.label === 'idea-similarity-reviewer') {
      const text = request.prompt.find((block: any) => block.type === 'text')?.text ?? ''
      const planText = text.match(/### Plan\n([\s\S]*?)(?:\n\n## Run directory|$)/)?.[1]
      const plan = JSON.parse(planText)
      const excerpt = plan.excerpts[0]
      const candidate = plan.candidates.find((item: any) => item.id === excerpt.candidateId)
      nativeProof = excerpt
      structured = { assessments: [{ candidateId: candidate.id, overlap: ['The mechanism is closely related.'], differences: ['Scope differs.'], uncertainty: ['Provider coverage is bounded.'], relevance: 'nearest', excerptProofs: [excerpt], followupQueries: [], citationSeeds: candidate.aliases.map((alias: any) => alias.value) }] }
    } else structured = { plan: 'Measure the mechanism.', riskLevel: 'low' }
    return { id: `native-${requests.length}`, result: Promise.resolve({ stopReason: 'completed', structured, output: [] }), async dispose() {} }
  } }
  const nativeProvider = new SubagentRoleAgentProvider(runtime as never)
  const ledger = await openRequestLedger({ runDir, runId: 'run', config: { maxInputTokens: 24_000, maxOutputTokens: 8_000, maxRunTokens: 120_000, maxRoleCalls: 20, maxRetriesPerCall: 0, maxUpgradesPerTask: 0 } })
  const state = await createInitialState(runDir, 'run')
  const ctx = createRunContext({ provider: nativeProvider, projectSettings: settings, discovery: { fetch: providerFixture } }, runDir, state, await ResearchTree.load(runDir), { parent: { id: 'parent' }, signal: new AbortController().signal, projectDir: runDir, runId: 'run', requestLedger: ledger, policySnapshot: { ...settings } })
  await runMinimalPlan(ctx, { idea: fixtureIdea.statement, profile: fixtureIdea.profile })
  const queryRequests = requests.filter(request => request.label === 'idea-query-planner')
  const reviewerRequests = requests.filter(request => request.label === 'idea-similarity-reviewer')
  assert.equal(queryRequests.length, 1)
  assert.equal(reviewerRequests.length, 1)
  assert.deepEqual(queryRequests[0].toolFilter, { allow: [] })
  assert.deepEqual(reviewerRequests[0].toolFilter, { allow: [] })
  assert.match(queryRequests[0].prompt[0].text, /maxQueries/)
  const report = await readCurrentIdeaSurvey(runDir)
  assert.ok(report?.assessments.length)
  assert.equal(report?.assessments[0]?.relevance, 'nearest')
  assert.deepEqual(report?.assessments[0]?.excerptProofs[0], nativeProof)
})
