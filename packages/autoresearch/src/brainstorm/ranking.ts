import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'

/**
 * Shared per-run context for the brainstorm pre-phase. Grouping the commonly
 * repeated values keeps phase functions to a single `ctx` argument.
 */
export interface BrainstormContext {
  readonly runDir: string
  readonly wikiIndex: string
  readonly agentContext: RoleExecutionContext
}

/**
 * One proposed research direction. Score fields are optional so the same shape
 * can be used before voting (proposal/debate) and after ranking.
 */
export interface CandidateDirection {
  id: string
  source: string
  direction: string
  evidence: string[]
  cheapTest: string
  risk: string
  total?: number
  novelty?: number
  feasibility?: number
  evidenceScore?: number
}

export type RankingStrategy = (
  ctx: BrainstormContext,
  candidates: CandidateDirection[],
  provider: RoleAgentProvider,
) => Promise<CandidateDirection[]>

/**
 * Shared ranking implementation: ask the brainstorm role to score every
 * candidate, then sort by total score with deterministic tie-breakers.
 */
export const rankCandidates: RankingStrategy = async (ctx, candidates, provider) => {
  const result = await provider.run('brainstorm', {
    runDir: ctx.runDir,
    perspective: 'score',
    plan: JSON.stringify(candidates, null, 2),
  }, ctx.agentContext)
  const scores = (result.structured as { scores?: Array<{ candidateId?: string; novelty?: number; feasibility?: number; evidence?: number }> } | undefined)?.scores ?? []
  const totals = new Map<string, { novelty: number; feasibility: number; evidenceScore: number }>()
  for (const score of scores) {
    if (!score.candidateId) continue
    const previous = totals.get(score.candidateId) ?? { novelty: 0, feasibility: 0, evidenceScore: 0 }
    totals.set(score.candidateId, {
      novelty: previous.novelty + (score.novelty ?? 0),
      feasibility: previous.feasibility + (score.feasibility ?? 0),
      evidenceScore: previous.evidenceScore + (score.evidence ?? 0),
    })
  }
  return candidates.map((candidate) => {
    const score = totals.get(candidate.id) ?? { novelty: 0, feasibility: 0, evidenceScore: 0 }
    return {
      ...candidate,
      ...score,
      total: score.novelty + score.feasibility + score.evidenceScore,
    }
  }).sort((a, b) => b.total - a.total || b.evidenceScore - a.evidenceScore || b.novelty - a.novelty)
}
