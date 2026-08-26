import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RoleAgentProvider } from '../../dist/agents/types.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createInitialState } from '../../dist/core/state.js'
import { createRunContext, type RunContext } from '../../dist/service/context.js'
import { runAgent, runStage, structuredText } from '../../dist/service/agent.js'
import { readOptionalText } from '../../dist/core/utils.js'

async function makeContext(run: RoleAgentProvider['run']): Promise<RunContext> {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-runtime-'))
  const state = await createInitialState(runDir)
  const tree = await ResearchTree.load(runDir)
  return createRunContext(
    { provider: { run }, brainstorm: 'off' },
    runDir,
    state,
    tree,
    {
      parent: { id: 'agent-1', session: { id: 'agent-1' } },
      signal: new AbortController().signal,
    },
  )
}

test('runAgent retries once and returns the provider result', async (t) => {
  let calls = 0
  const ctx = await makeContext(async () => {
    calls += 1
    if (calls === 1) throw new Error('transient')
    return { text: 'ok', structured: { plan: 'P' }, stopReason: 'completed' }
  })
  t.after(() => rm(ctx.runDir, { recursive: true, force: true }))
  const result = await runAgent(ctx, {
    role: 'planner',
    label: 'plan',
    input: { runDir: ctx.runDir },
  })
  assert.equal(calls, 2)
  assert.equal(structuredText(result.structured, 'plan'), 'P')
})

test('runStage transitions and writes structured output', async (t) => {
  const ctx = await makeContext(async () => ({
    text: 'fallback', structured: { verdict: 'proceed' }, stopReason: 'completed',
  }))
  t.after(() => rm(ctx.runDir, { recursive: true, force: true }))
  const text = await runStage(ctx, {
    phase: 'experiment_reflexion',
    stepId: 'reflect-1',
    role: 'experiment-reflexion',
    label: 'reflect',
    input: { runDir: ctx.runDir },
    outputFile: 'EXPERIMENT_REFLEXION.md',
  })
  assert.equal(ctx.state.phase, 'experiment_reflexion')
  assert.deepEqual(JSON.parse(text), { verdict: 'proceed' })
  assert.equal(await readFile(join(ctx.runDir, 'EXPERIMENT_REFLEXION.md'), 'utf8'), text)
})

test('readOptionalText ignores only missing files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-optional-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(await readOptionalText(join(dir, 'missing.md')), undefined)
  await assert.rejects(() => readOptionalText(dir))
})
