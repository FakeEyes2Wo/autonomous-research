import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchBaseline, type BaselineSpec, type BaselineCandidate } from '../../dist/literature/baseline.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInitialDeepDive } from '../../dist/brainstorm/deep-dive.js'

const spec: BaselineSpec = { task: 'classification', datasetVersion: 'd1', split: 'dev', metric: 'accuracy', direction: 'max', maxComputeSeconds: 60, allowedComponents: ['classifier'] }
const candidate = (patch: Partial<BaselineCandidate> = {}): BaselineCandidate => ({ workId: 'famous', spanIds: ['s1'], spec: { ...spec }, implementation: 'repo@sha', estimatedComputeSeconds: 10, ...patch })

test('known dataset mismatch excludes a popular baseline regardless of missing fields', () => {
  const fit = matchBaseline(spec, candidate({ spec: { datasetVersion: 'd2' } }))
  assert.equal(fit.status, 'mismatch')
  assert.ok(fit.reasons.includes('datasetVersion'))
})

test('only a sourced, implemented and compatible baseline is matched', () => {
  assert.deepEqual(matchBaseline(spec, candidate()), { workId: 'famous', status: 'matched', reasons: [], spanIds: ['s1'] })
  for (const patch of [{ spanIds: [] }, { implementation: null }, { estimatedComputeSeconds: null }, { spec: {} }]) {
    assert.equal(matchBaseline(spec, candidate(patch)).status, 'unknown')
  }
})

test('metric direction, split, component permissions and compute budget constrain matching', () => {
  for (const [field, value] of [['task', 'regression'], ['split', 'test'], ['metric', 'loss'], ['direction', 'min'], ['allowedComponents', ['classifier', 'dataset']]] as const) {
    const fit = matchBaseline(spec, candidate({ spec: { ...spec, [field]: value } }))
    assert.equal(fit.status, 'mismatch', field)
    assert.ok(fit.reasons.includes(field))
  }
  assert.equal(matchBaseline(spec, candidate({ estimatedComputeSeconds: 61 })).status, 'mismatch')
  assert.equal(matchBaseline(spec, candidate({ estimatedComputeSeconds: 60 })).status, 'matched')
  assert.equal(matchBaseline(spec, candidate({ spec: { ...spec, allowedComponents: [] } })).status, 'matched')
})

test('invalid runtime inputs cannot produce an eligible baseline and outputs do not alias input', () => {
  for (const value of [NaN, Infinity, -1]) assert.equal(matchBaseline(spec, candidate({ estimatedComputeSeconds: value })).status, 'unknown')
  assert.throws(() => matchBaseline({ ...spec, maxComputeSeconds: NaN }, candidate()), /INVALID_BASELINE_SPEC/)
  const input = candidate()
  const fit = matchBaseline(spec, input)
  fit.spanIds.push('other')
  assert.deepEqual(input.spanIds, ['s1'])
})

test('deep-dive does not promote citation counts into baseline compatibility', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'baseline-deep-dive-'))
  try {
    const provider = { run: async (role: string) => ({ text: '', stopReason: 'completed', structured: { papers: role === 'paper-survey'
      ? [{ id: 'famous', title: 'Famous incompatible method', citations: 100000 }, { id: 'new', title: 'New method', citations: 0 }]
      : [] } }) }
    const result = await runInitialDeepDive({ provider: provider as never }, { runDir, idea: 'classification', profile: 'bounded',
      agentContext: { parent: {} as never, signal: new AbortController().signal } })
    const selected = JSON.parse(await readFile(join(runDir, 'brainstorm', 'baselines.json'), 'utf8'))
    assert.deepEqual(selected, [])
    const fits = JSON.parse(await readFile(join(runDir, 'brainstorm', 'baseline_assessments.json'), 'utf8'))
    assert.equal(fits.length, 2)
    assert.ok(fits.every((fit: { status: string }) => fit.status === 'unknown'))
    assert.match(result.baselines, /unknown|unverified/)
    assert.match(result.baselines, /locally designed/)
  } finally { await rm(runDir, { recursive: true, force: true }) }
})
