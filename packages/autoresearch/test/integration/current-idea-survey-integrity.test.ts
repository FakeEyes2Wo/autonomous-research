import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { createInitialState } = await import('../../dist/core/state.js')
const { ResearchTree } = await import('../../dist/core/research-tree.js')
const { createRunContext } = await import('../../dist/service/context.js')
const { ensureCurrentIdeaSurvey, readCurrentIdeaSurvey, REPORT_POINTER } = await import('../../dist/research/current-idea-survey.js')
const { DEFAULT_PROJECT_SETTINGS } = await import('../../dist/settings/schema.js')
const { writeDiscoveryRecord } = await import('../../dist/literature/discovery/checkpoint.js')
const { hashContent } = await import('../../dist/research/records.js')

const ideaFingerprint = 'a'.repeat(64)
const configFingerprint = 'b'.repeat(64)
const surveyId = hashContent({ ideaFingerprint, configFingerprint })

function report(patch: Record<string, unknown> = {}) {
  return {
    schema: 'autoresearch/current-idea-similarity/v1', surveyId, ideaFingerprint, configFingerprint,
    authority: 'advisory-discovery-only', status: 'complete', roundsCompleted: 1,
    queries: [], rejectedQueries: [], receipts: [], candidates: [{ id: 'paper-1', title: 'Original title', authors: [], year: 2024, abstract: 'abstract', aliases: [], providerHits: [], observations: [], conflicts: [] }],
    nearest: [{ id: 'paper-1', title: 'Original title', authors: [], year: 2024, abstract: 'abstract', aliases: [], providerHits: [], observations: [], conflicts: [] }],
    assessments: [{ candidateId: 'paper-1', overlap: ['mechanism'], differences: [], uncertainty: [], relevance: 'related', excerptProofs: [], followupQueries: [], citationSeeds: [] }],
    counts: { collected: 1, retained: 1, omitted: 0, shortlisted: 1, reviewed: 1, actualHttpAttempts: 0, cacheHits: 0 }, providerCoverage: { arxiv: { attempts: 0, successful: 0, degraded: 0 }, crossref: { attempts: 0, successful: 0, degraded: 0 }, 'semantic-scholar': { attempts: 0, successful: 0, degraded: 0 } }, gaps: [], uncertainty: [], stopReason: 'max_rounds', createdAt: new Date().toISOString(), elapsedMs: 1, sourceRefs: [], ...patch,
  }
}

async function writeDurableReport(runDir: string, value: unknown) {
  await writeDiscoveryRecord(join(runDir, 'brainstorm', 'current-idea-survey', ideaFingerprint, configFingerprint, 'report.json'), value)
  await writeFile(join(runDir, REPORT_POINTER), JSON.stringify(value) + '\n')
}

test('direct ResearchRunner context honors projectSettings currentIdeaSearch never without a policy snapshot', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'current-idea-settings-never-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const settings = structuredClone(DEFAULT_PROJECT_SETTINGS)
  settings.workflow.currentIdeaSearch = 'never'
  let plannerCalls = 0
  const provider = { name: 'crossref' as const, async search() { throw new Error('provider must not be called') } }
  const sourceStore = { async captureBytes() { return { id: 'source', path: 'research/sources/source', hash: 'source' } }, async readSource() { return new Uint8Array() } }
  const state = await createInitialState(runDir, 'run')
  const ctx = createRunContext({ provider: { async run() { throw new Error('model must not be called') } }, projectSettings: settings, discovery: { providers: [provider], sourceStore, queryPlanner: async () => { plannerCalls++; return [] }, reviewer: async () => [] } }, runDir, state, await ResearchTree.load(runDir), { parent: { id: 'parent' }, signal: new AbortController().signal, projectDir: runDir, runId: 'run' })
  assert.equal(await ensureCurrentIdeaSurvey(ctx, 'idea', 'profile'), undefined)
  assert.equal(plannerCalls, 0)
})

test('current idea pointer resumes only when it matches the checksummed durable report', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'current-idea-pointer-integrity-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const original = report()
  await writeDurableReport(runDir, original)
  assert.equal((await readCurrentIdeaSurvey(runDir))?.surveyId, surveyId)

  const tamperedTitle = { ...original, candidates: [{ ...original.candidates[0], title: 'Tampered title' }] }
  await writeFile(join(runDir, REPORT_POINTER), JSON.stringify(tamperedTitle))
  assert.equal(await readCurrentIdeaSurvey(runDir), undefined)

  const tamperedRelevance = { ...original, assessments: [{ ...original.assessments[0], relevance: 'nearest' }] }
  await writeFile(join(runDir, REPORT_POINTER), JSON.stringify(tamperedRelevance))
  assert.equal(await readCurrentIdeaSurvey(runDir), undefined)
})
