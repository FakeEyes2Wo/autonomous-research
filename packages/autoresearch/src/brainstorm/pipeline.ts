import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { appendHumanReview, type HumanReviewer } from '../core/human-review.js'
import { humanReviewEnabled } from '../session/auto-mode.js'
import {
  atomicWriteJson, AutoResearchError, ensureDir, IDEA_FILE, INPUT_DIR, PROFILE_FILE,
  readText, safeResolve, writeText,
} from '../core/utils.js'

const DEFAULTS = { minPapers: 30, minRelevant: 15, maxRelevant: 20 }

export interface BrainstormOptions {
  idea?: string
  minPapers?: number
  minRelevant?: number
  maxRelevant?: number
  reviewer?: HumanReviewer
  humanReviewOverride?: 'auto' | 'on' | 'off'
}

interface PaperEntry {
  id: string
  title: string
  arxivId?: string
  doi?: string
  url?: string
  year?: string
  venue?: string
  citations?: number
  abstract?: string
  relevance?: 'A' | 'B' | 'C'
}

interface CandidateDirection {
  id: string
  source: string
  direction: string
  evidence: string[]
  cheapTest: string
  risk: string
}

interface RankedDirection extends CandidateDirection {
  total: number
  novelty: number
  feasibility: number
  evidenceScore: number
}

const path = (runDir: string, ...parts: string[]) => safeResolve(runDir, ...parts)
const seedPath = (runDir: string) => path(runDir, 'brainstorm', 'SEED.md')
const poolPath = (runDir: string) => path(runDir, 'brainstorm', 'paper_pool.json')
const debatePath = (runDir: string) => path(runDir, 'brainstorm', 'DEBATE.md')
const ideaPath = (runDir: string) => path(runDir, 'brainstorm', 'IDEA.md')
const wikiIndexPath = (runDir: string) => path(runDir, 'paper_wiki', '_index.md')
const VIEWS = ['gap', 'feasibility', 'novelty']

/**
 * Minimal brainstorm pre-phase: mine papers, write a wiki, propose/debate/score
 * directions from three perspectives, let a chair reform only the vote winner,
 * and hand the winner off as input/idea.md for the normal research loop.
 */
export class BrainstormPipeline {
  private readonly provider: RoleAgentProvider
  private readonly options: BrainstormOptions

  constructor(provider: RoleAgentProvider, options: BrainstormOptions = {}) {
    this.provider = provider
    this.options = options
  }

  async run(runDir: string, context: RoleExecutionContext): Promise<string> {
    await ensureDir(path(runDir, 'brainstorm'))

    const seed = await this.resolveSeed(runDir, context)
    await writeText(seedPath(runDir), seed)

    const pool = await this.mine(runDir, seed, context)
    await atomicWriteJson(poolPath(runDir), pool)

    const wikiIndex = await this.writeWikis(runDir, pool, context)
    const candidates = await this.propose(runDir, seed, wikiIndex, context)
    const revised = await this.debate(runDir, seed, wikiIndex, candidates, context)
    const ranked = await this.scoreAndRank(runDir, revised, context)
    if (ranked.length < 3) throw new AutoResearchError(`brainstorm produced ${ranked.length} candidates; need >= 3`, 'AGENT_FAILED')

    const ideaFile = await this.reform(runDir, seed, wikiIndex, ranked, context)
    await this.handoff(runDir, ideaFile)
    return ideaFile
  }

  // ---------- seed ----------

  private async resolveSeed(runDir: string, context: RoleExecutionContext): Promise<string> {
    const idea = this.options.idea?.trim()
    if (idea) return idea
    if (this.options.reviewer?.askOpen && await humanReviewEnabled(this.options.humanReviewOverride)) {
      try {
        const answer = await this.options.reviewer.askOpen({
          title: '请指定本次研究的 idea / seed（可留空，留空由系统自动选择）',
          detail: 'Provide a one-sentence research idea or topic seed for the brainstorm.',
        }, context.signal, context.parent)
        if (answer) {
          await appendHumanReview(runDir, { time: new Date().toISOString(), gate: 'idea', verdict: 'approve', feedback: `human seed: ${answer}` })
          return answer
        }
      } catch (error) {
        await appendHumanReview(runDir, { time: new Date().toISOString(), gate: 'idea', verdict: 'skipped', feedback: `seed ask failed: ${String(error)}` })
      }
    }
    return ''
  }

  // ---------- phases ----------

  private async mine(runDir: string, seed: string, context: RoleExecutionContext): Promise<PaperEntry[]> {
    const minPapers = this.options.minPapers ?? DEFAULTS.minPapers
    const minRelevant = this.options.minRelevant ?? DEFAULTS.minRelevant
    const maxRelevant = this.options.maxRelevant ?? DEFAULTS.maxRelevant
    const result = await this.provider.run('paper-miner', {
      runDir,
      plan: `Seed: ${seed || 'None'}\nHard constraints: >= ${minPapers} papers; A-level papers must be ${minRelevant}-${maxRelevant}.`,
    }, context)
    const papers = ((result.structured as { papers?: Array<Record<string, unknown>> } | undefined)?.papers ?? [])
      .map((paper, index) => ({
        ...paper,
        id: typeof paper.id === 'string' && paper.id ? paper.id : `p${String(index + 1).padStart(3, '0')}`,
      })) as PaperEntry[]
    const aCount = papers.filter((paper) => paper.relevance === 'A').length
    if (papers.length < minPapers || aCount < minRelevant || aCount > maxRelevant) {
      throw new AutoResearchError(`paper-miner constraints failed: papers=${papers.length} A=${aCount}`, 'AGENT_FAILED')
    }
    return papers
  }

  private async writeWikis(runDir: string, pool: PaperEntry[], context: RoleExecutionContext): Promise<string> {
    const aPapers = pool.filter((paper) => paper.relevance === 'A')
    const result = await this.provider.run('paper-wiki-writer', {
      runDir,
      plan: JSON.stringify(aPapers, null, 2),
    }, context)
    const wikis = (result.structured as { wikis?: Record<string, string> } | undefined)?.wikis ?? {}
    const missing = aPapers.filter((paper) => !wikis[paper.id])
    if (missing.length > 0) {
      throw new AutoResearchError(`paper wiki missing ${missing.length} A-level papers`, 'AGENT_FAILED')
    }
    for (const [id, markdown] of Object.entries(wikis)) {
      await writeText(path(runDir, 'paper_wiki', `${id}.md`), markdown)
    }
    const rows = pool.map((paper) => `| ${paper.id} | ${paper.title} | ${paper.relevance ?? '-'} | ${paper.relevance === 'A' ? `paper_wiki/${paper.id}.md` : ''} |`)
    const index = ['# Paper Wiki Index', '', '| id | title | relevance | wiki |', '|---|---|---|---|', ...rows].join('\n')
    await writeText(wikiIndexPath(runDir), index)
    return index
  }

  private async propose(runDir: string, seed: string, wikiIndex: string, context: RoleExecutionContext): Promise<CandidateDirection[]> {
    const candidates: CandidateDirection[] = []
    for (const view of VIEWS) {
      const result = await this.provider.run('brainstorm', {
        runDir,
        perspective: `propose:${view}`,
        plan: `Seed: ${seed || 'None'}\nWiki index:\n${wikiIndex}`,
      }, context)
      for (const raw of (result.structured as { directions?: Array<Record<string, unknown>> } | undefined)?.directions ?? []) {
        const direction = this.toDirection(view, raw, candidates)
        if (direction) candidates.push(direction)
      }
    }
    if (candidates.length < 3) throw new AutoResearchError(`brainstorm proposals valid=${candidates.length}; need >= 3`, 'AGENT_FAILED')
    return candidates
  }

  private toDirection(view: string, raw: Record<string, unknown>, existing: CandidateDirection[]): CandidateDirection | undefined {
    const evidence = Array.isArray(raw.evidence) ? raw.evidence.map(String) : []
    const direction = String(raw.direction ?? '').trim()
    if (!direction || evidence.length < 3 || existing.some((c) => c.direction === direction)) return undefined
    const baseId = typeof raw.id === 'string' && raw.id ? raw.id : `${view}-${existing.length + 1}`
    return {
      id: existing.some((c) => c.id === baseId) ? `${baseId}-${view}-${existing.length + 1}` : baseId,
      source: view,
      direction,
      evidence,
      cheapTest: String(raw.cheapTest ?? ''),
      risk: String(raw.risk ?? ''),
    }
  }

  private async debate(runDir: string, seed: string, wikiIndex: string, candidates: CandidateDirection[], context: RoleExecutionContext): Promise<CandidateDirection[]> {
    const lines = ['# Brainstorm Debate', '']
    for (const candidate of candidates) {
      const result = await this.provider.run('brainstorm', {
        runDir,
        perspective: 'debate',
        plan: [
          `Seed: ${seed || 'None'}`,
          `Target direction to attack and revise (id ${candidate.id}): ${candidate.direction}`,
          'All candidates:',
          JSON.stringify(candidates, null, 2),
          'Wiki index:',
          wikiIndex,
        ].join('\n'),
      }, context)
      const value = result.structured as { attack?: string[]; support?: string[]; revisedDirection?: string } | undefined
      lines.push(`## Debate ${candidate.id}`)
      lines.push(...(value?.attack ?? []).map((x) => `- ATTACK: ${x}`))
      lines.push(...(value?.support ?? []).map((x) => `- SUPPORT: ${x}`))
      const revised = value?.revisedDirection?.trim()
      if (revised) candidate.direction = revised
      lines.push(`- REVISED: ${candidate.direction}`)
    }
    await writeText(debatePath(runDir), `${lines.join('\n')}\n`)
    return candidates
  }

  private async scoreAndRank(runDir: string, candidates: CandidateDirection[], context: RoleExecutionContext): Promise<RankedDirection[]> {
    const result = await this.provider.run('brainstorm', {
      runDir,
      perspective: 'score',
      plan: JSON.stringify(candidates, null, 2),
    }, context)
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

  private async reform(runDir: string, seed: string, wikiIndex: string, ranked: RankedDirection[], context: RoleExecutionContext): Promise<string> {
    const winner = ranked[0]
    if (!winner) throw new AutoResearchError('no vote winner to reform', 'AGENT_FAILED')
    const result = await this.provider.run('brainstorm', {
      runDir,
      perspective: 'chair',
      plan: [
        `Seed: ${seed || 'None'}`,
        'Ranked candidates (rank 1 is the only reform target; rank 2/3 are backups):',
        JSON.stringify(ranked, null, 2),
        'Wiki index:',
        wikiIndex,
      ].join('\n'),
    }, context)
    const value = result.structured as { selectedId?: string; ideaMd?: string } | undefined
    const ideaMd = value?.ideaMd?.trim()
    if (value?.selectedId !== winner.id || !ideaMd || (ideaMd.match(/paper_wiki\//g) ?? []).length < 3) {
      throw new AutoResearchError(`chair must reform rank-1 candidate "${winner.id}" and cite >= 3 paper_wiki files`, 'AGENT_FAILED')
    }
    await writeText(ideaPath(runDir), ideaMd)
    return ideaPath(runDir)
  }

  private async handoff(runDir: string, ideaFile: string): Promise<void> {
    const idea = await readText(ideaFile)
    const direction = idea.match(/^\s*- direction:\s*(.+)$/mi)?.[1]?.trim() ?? 'Reformed research direction'
    const cheap = idea.match(/^\s*- cheap_test:\s*(.+)$/mi)?.[1]
      ?? idea.match(/^## cheap_test\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim()
      ?? 'Run the minimal validation experiment'
    const backups = [...idea.matchAll(/^\s*- rank [23]:\s*(.+)$/gm)].map((m) => m[1]?.trim()).filter(Boolean)
    await writeText(path(runDir, INPUT_DIR, IDEA_FILE), [
      '## Direction', '', direction, '', '## A-priori ideas', '',
      `- ${cheap}`,
      ...backups.map((backup) => `- ${backup}`),
      '',
    ].join('\n'))
    await writeText(path(runDir, PROFILE_FILE), [
      '# PROFILE', '',
      `- Brainstorm source: ${ideaFile}`,
      `- Paper wiki: ${wikiIndexPath(runDir)}`,
      '- Allowed: public literature search, local code, small real-data experiments.',
      '- Forbidden: hidden target papers, fabricated citations or results.',
      '',
    ].join('\n'))
  }
}
