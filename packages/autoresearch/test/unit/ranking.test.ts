import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RoleAgentProvider } from '../../dist/agents/types.js'
import { rankCandidates, type BrainstormContext, type CandidateDirection } from '../../dist/brainstorm/ranking.js'

test('rankCandidates sorts by total, then evidence, then novelty', async () => {
  const provider: RoleAgentProvider = {
    run: async () => ({
      text: '',
      structured: {
        scores: [
          { candidateId: 'strong', novelty: 4, feasibility: 2, evidence: 3 },
          { candidateId: 'weak', novelty: 1, feasibility: 1, evidence: 1 },
        ],
      },
      stopReason: 'completed',
    }),
  }
  const ctx: BrainstormContext = {
    runDir: '/tmp/ar-ranking',
    wikiIndex: '',
    agentContext: {
      parent: { id: 'agent-1', session: { id: 'agent-1' } },
      signal: new AbortController().signal,
    },
  }
  const candidates: CandidateDirection[] = [
    { id: 'strong', source: 'gap', direction: 'Strong', evidence: ['a', 'b', 'c'], cheapTest: 't', risk: 'r' },
    { id: 'weak', source: 'gap', direction: 'Weak', evidence: ['a', 'b', 'c'], cheapTest: 't', risk: 'r' },
  ]

  const ranked = await rankCandidates(ctx, candidates, provider)

  assert.deepEqual(ranked.map(({ id }) => id), ['strong', 'weak'])
  assert.equal(ranked[0]?.total, 9)
})
