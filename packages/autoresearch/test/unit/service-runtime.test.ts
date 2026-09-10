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
import { runExperimentReflexion } from '../../dist/experiment/steps.js'
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

test('runAgent does not retry the whole role and propagates failure', async (t) => {
  let calls = 0
  const ctx = await makeContext(async () => {
    calls += 1
    throw new Error('transient')
  })
  t.after(() => rm(ctx.runDir, { recursive: true, force: true }))
  await assert.rejects(() => runAgent(ctx, {
    role: 'planner',
    label: 'plan',
    input: { runDir: ctx.runDir },
  }), /transient/)
  assert.equal(calls, 1)
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

test('experiment reflexion reviews the second redesign before returning it', async (t) => {
  let reviewCalls = 0
  let designCalls = 0
  const ctx = await makeContext(async (role) => {
    if (role === 'experiment-reflexion') {
      reviewCalls += 1
      return {
        text: '',
        structured: { feasibility: 'high', generalizability: 'high', risks: [], failureDirections: [], verdict: reviewCalls < 3 ? 'revise' : 'proceed' },
        stopReason: 'completed',
      }
    }
    if (role === 'experiment-designer') {
      designCalls += 1
      return { text: '', structured: { design: `revision-${designCalls}` }, stopReason: 'completed' }
    }
    throw new Error(`unexpected role ${role}`)
  })
  t.after(() => rm(ctx.runDir, { recursive: true, force: true }))

  const design = await runExperimentReflexion(ctx, {
    planText: 'plan', minimalVerification: 'probe', modelScout: 'models', initialDesign: 'initial',
  })

  assert.equal(reviewCalls, 3)
  assert.equal(designCalls, 2)
  assert.match(design, /revision-2/)
})

test('experiment reflexion fails closed on an invalid verdict', async (t) => {
  const ctx = await makeContext(async () => ({
    text: '',
    structured: { feasibility: 'high', generalizability: 'high', risks: [], failureDirections: [], verdict: 'maybe' },
    stopReason: 'completed',
  }))
  t.after(() => rm(ctx.runDir, { recursive: true, force: true }))

  await assert.rejects(
    () => runExperimentReflexion(ctx, {
      planText: 'plan', minimalVerification: 'probe', modelScout: 'models', initialDesign: 'initial',
    }),
    /invalid.*verdict|review.*accepted/i,
  )
})
