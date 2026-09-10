import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipContext, estimateTokens } from '../../dist/policy/context.js'
import { resolveBudget } from '../../dist/policy/budget.js'
import { resolveModelRoute, resolveRoleTier } from '../../dist/policy/model-routing.js'
import { normalizeUsage, summarizeUsage, totalTokens, type UsageRecord } from '../../dist/policy/usage.js'
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../dist/settings/schema.js'

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({ callId: 'call-1', requestId: 'req-1', childId: 'child-1', runId: 'run', role: 'worker', task: 'task', tier: 'standard', inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 5, reasoningTokens: 5, attempt: 1, cacheHit: false, stopReason: 'stop', usageSource: 'provider', ...overrides })

test('context estimation is conservative for CJK and clipping keeps complete records', () => {
  assert.ok(estimateTokens('研究问题') > estimateTokens('abcd'))
  const clipped = clipContext([{ name: 'evidence', text: '证据一\n证据二\n证据三\n', priority: 10, required: true }, { name: 'paper', text: 'paper line\n', priority: 1 }], { maxInputTokens: 4, evidenceTokens: 2, paperTokens: 2 })
  assert.equal(clipped.estimated, true)
  assert.ok(clipped.inputTokens <= 4)
  assert.ok(clipped.truncated.includes('evidence'))
  assert.ok(clipped.insufficientSections.includes('evidence'))
  assert.ok(!clipped.sections.evidence?.includes('证据一证据'))
})

test('usage total excludes reasoning double count and unknown fields remain unknown', () => {
  assert.equal(totalTokens(record()), 18)
  assert.equal(normalizeUsage(record({ outputTokens: undefined })).totalTokens, undefined)
  const summary = summarizeUsage([record(), record({ attempt: 2 }), record({ requestId: 'req-2', callId: 'call-2', inputTokens: undefined, usageSource: 'unknown' })])
  assert.equal(summary.calls, 2)
  assert.equal(summary.totalTokens, 18)
  assert.equal(summary.retries, 1)
  assert.equal(summary.unknownUsage, 1)
})

test('routing requires role escalation signals and remains independent from workflow mode', () => {
  const settings: ProjectSettings = structuredClone(DEFAULT_PROJECT_SETTINGS)
  settings.model.useGlobal = true
  settings.modelRouting.enabled = true
  settings.modelRouting.defaultTier = 'standard'
  settings.modelRouting.tiers.standard = { provider: 'p-standard', model: 'm-standard' }
  settings.modelRouting.tiers.deep = { provider: 'p-deep', model: 'm-deep' }
  settings.modelRouting.roles.worker = { tier: 'standard', provider: 'p-role', model: 'm-role', escalateTo: 'deep', escalateOn: ['fatal_flaw'] }
  settings.workflow.mode = 'legacy'
  assert.equal(resolveRoleTier(settings, 'worker', { quality_low: true }).tier, 'standard')
  const route = resolveModelRoute(settings, { role: 'worker', task: 'x', signals: { fatal_flaw: true } })
  assert.equal(route.tier, 'deep')
  assert.equal(route.provider, 'p-deep')
  assert.equal(route.escalated, true)
})

test('disabled routing explicitly inherits parent model when useGlobal is true', () => {
  const settings: ProjectSettings = structuredClone(DEFAULT_PROJECT_SETTINGS)
  settings.modelRouting.enabled = false
  settings.model.useGlobal = true
  const route = resolveModelRoute(settings, { role: 'worker', task: 'x' })
  assert.equal(route.source, 'inherit')
  assert.equal(route.provider, undefined)
})

test('budget reserves output before input and respects model context cap', () => {
  const settings: ProjectSettings = structuredClone(DEFAULT_PROJECT_SETTINGS)
  const route = { tier: 'standard' as const, source: 'default' as const, escalated: false, provider: 'p', model: 'm' }
  const budget = resolveBudget(settings, route, 100, 2, { contextWindow: 60, maxOutputTokens: 80 })
  assert.equal(budget.maxOutputTokens, 60)
  assert.ok(budget.maxInputTokens + budget.reservedOutputTokens <= 60)
  assert.ok(budget.maxInputTokens + budget.reservedOutputTokens <= 100)
})
