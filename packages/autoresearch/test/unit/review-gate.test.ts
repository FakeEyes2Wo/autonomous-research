import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RoleAgentProvider } from '../../dist/agents/types.js'
import { ResearchTree } from '../../dist/core/research-tree.js'
import { createInitialState } from '../../dist/core/state.js'
import { createRunContext } from '../../dist/service/context.js'
import { reviewGate } from '../../dist/service/review.js'

test('disabled review gate approves and records why review was skipped', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'ar-review-gate-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const state = await createInitialState(runDir)
  const tree = await ResearchTree.load(runDir)
  const provider: RoleAgentProvider = {
    run: async () => ({ text: '', stopReason: 'completed' }),
  }
  const ctx = createRunContext(
    { provider, reviewGates: [] },
    runDir,
    state,
    tree,
    {
      parent: { id: 'agent-1', session: { id: 'agent-1' } },
      signal: new AbortController().signal,
    },
  )

  const answer = await reviewGate(ctx, {
    gate: 'idea',
    title: 'Proceed?',
    detail: 'details',
  })

  assert.deepEqual(answer, { verdict: 'approve' })
  assert.match(await readFile(join(ctx.runDir, 'HUMAN_REVIEW.md'), 'utf8'), /gate disabled/)
})
