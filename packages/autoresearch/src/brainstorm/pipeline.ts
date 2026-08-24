import { join } from 'node:path'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { appendHumanReview, type HumanReviewer } from '../core/human-review.js'
import { humanReviewEnabled } from '../session/auto-mode.js'
import {
  atomicWriteJson, AutoResearchError, ensureDir, IDEA_FILE, INPUT_DIR, PROFILE_FILE,
  readJson, readText, safeResolve, writeText,
} from '../core/utils.js'

const MIN_PAPERS = 30
const MIN_A = 15
const MAX_A = 20
const MAX_ROUNDS = 3

export interface PaperEntry {
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
  reasons?: string[]
}

export interface CandidateDirection {
  id: string
  source: string
  direction: string
  evidence: string[]
  cheapTest: string
  risk: string
}

export interface RankedDirection extends CandidateDirection {
  total: number
  novelty: number
  feasibility: number
  evidenceScore: number
}

export interface BrainstormOptions {
  idea?: string
  reviewer?: HumanReviewer
  humanReviewOverride?: 'auto' | 'on' | 'off'
}

interface BrainstormCheckpoint {
  schema: 'autoresearch/brainstorm-checkpoint/v1'
  updated_at: string
  phases: Record<string, 'done' | 'failed'>
  data: Record<string, unknown>
}

const seedPath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'SEED.md')
const poolPath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'paper_pool.json')
const candidatesPath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'candidates.json')
const debatePath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'DEBATE.md')
const ideaPath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'IDEA.md')
const checkpointPath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'checkpoint.json')
const wikiIndexPath = (runDir: string) => safeResolve(runDir, 'paper_wiki', '_index.md')

/**
 * BrainstormPipeline runs before the research loop: mine >=30 papers, write a
 * paper wiki for 15-20 A-level papers, debate candidate directions across
 * three perspectives, vote, and let a chair reform only the rank-1 winner.
 * The winning direction is handed off as input/candidate.md + PROFILE.md.
 */
export class BrainstormPipeline {
  private readonly provider: RoleAgentProvider
  private readonly options: BrainstormOptions

  constructor(provider: RoleAgentProvider, options: BrainstormOptions = {}) {
    this.provider = provider
    this.options = options
  }

  async run(runDir: string, context: RoleExecutionContext): Promise<string> {
    await ensureDir(safeResolve(runDir, 'brainstorm'))
    const cp = await this.loadCheckpoint(runDir)

    // 1. Seed (human idea or auto seed).
    if (cp.phases.seed !== 'done') {
      const seed = this.options.idea?.trim() || await this.askHumanSeed(runDir, context)
      await writeText(seedPath(runDir), seed || 'AUTO-SEED: choose a recent, broad, falsifiable ML direction')
      await this.commitPhase(runDir, cp, 'seed')
    }
    const seed = (await readText(seedPath(runDir))).trim()

    // 2. Mine and screen papers (one role, programmatic hard checks).
    let pool: PaperEntry[]
    if (cp.phases.mining !== 'done') {
      pool = await this.mine(runDir, seed, context)
      await atomicWriteJson(poolPath(runDir), pool)
      await this.commitPhase(runDir, cp, 'mining')
    } else {
      pool = await readJson<PaperEntry[]>(poolPath(runDir))
    }

    // 3. Paper wiki for A-level papers only.
    let wikiIndex: string
    if (cp.phases.wiki !== 'done') {
      wikiIndex = await this.writeWikis(runDir, pool, context)
      await this.commitPhase(runDir, cp, 'wiki')
    } else {
      wikiIndex = await readText(wikiIndexPath(runDir)).catch(() => '')
    }

    // 4. Propose + debate + score.
    let ranked: RankedDirection[]
    if (cp.phases.debate !== 'done') {
      const candidates = await this.propose(runDir, seed, wikiIndex, context)
      const debated = await this.debate(runDir, seed, wikiIndex, candidates, context)
      ranked = await this.scoreAndRank(runDir, debated, context)
      await atomicWriteJson(candidatesPath(runDir), ranked)
      await this.commitPhase(runDir, cp, 'debate')
    } else {
      ranked = await readJson<RankedDirection[]>(candidatesPath(runDir))
    }
    if (ranked.length < 3) throw new AutoResearchError(`brainstorm produced only ${ranked.length} candidates; need >= 3`, 'AGENT_FAILED')

    // 5. Chair reforms ONLY the vote winner; backups are rank 2/3.
    let ideaFile: string
    if (cp.phases.reform !== 'done') {
      ideaFile = await this.reform(runDir, seed, wikiIndex, ranked, context)
      await this.commitPhase(runDir, cp, 'reform')
    } else {
      ideaFile = ideaPath(runDir)
    }

    // 6. Handoff into the existing research loop.
    await this.handoff(runDir, ideaFile)
    return ideaFile
  }

  // ---------- phases ----------

  private async mine(runDir: string, seed: string, context: RoleExecutionContext): Promise<PaperEntry[]> {
    let feedback: string | undefined
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const result = await this.provider.run('paper-miner', {
        runDir,
        plan: [
          `Seed: ${seed}`,
          `Hard constraints: total >= ${MIN_PAPERS}; relevance A count must be ${MIN_A}-${MAX_A}.`,
          ...(feedback ? [`Previous failure: ${feedback}`] : []),
        ].join('\n'),
      }, context)
      const papers = (result.structured as { papers?: PaperEntry[] } | undefined)?.papers ?? []
      const normalized = papers.map((paper, index) => ({
        ...paper,
        id: typeof paper.id === 'string' && paper.id ? paper.id : `p${String(index + 1).padStart(3, '0')}`,
      }))
      const a = normalized.filter((paper) => paper.relevance === 'A').length
      if (normalized.length >= MIN_PAPERS && a >= MIN_A && a <= MAX_A) return normalized
      feedback = `got ${normalized.length} papers and ${a} A-level; need >= ${MIN_PAPERS} papers and ${MIN_A}-${MAX_A} A-level. Keep real verified papers only.`
    }
    throw new AutoResearchError(`paper mining failed constraints after ${MAX_ROUNDS} rounds`, 'AGENT_FAILED')
  }

  private async writeWikis(runDir: string, pool: PaperEntry[], context: RoleExecutionContext): Promise<string> {
    const aPapers = pool.filter((paper) => paper.relevance === 'A')
    const result = await this.provider.run('paper-wiki-writer', {
      runDir,
      plan: JSON.stringify(aPapers, null, 2),
    }, context)
    const wikis = (result.structured as { wikis?: Record<string, string> } | undefined)?.wikis ?? {}
    const lines = ['# Paper Wiki Index', '', '| id | title | relevance | wiki |', '|---|---|---|---|']
    for (const paper of pool) {
      const wiki = paper.relevance === 'A' ? `paper_wiki/${paper.id}.md` : ''
      lines.push(`| ${paper.id} | ${paper.title} | ${paper.relevance ?? '-'} | ${wiki} |`)
    }
    for (const [id, markdown] of Object.entries(wikis)) {
      await writeText(safeResolve(runDir, 'paper_wiki', `${id}.md`), markdown)
    }
    const index = lines.join('\n')
    await writeText(wikiIndexPath(runDir), index)
    return index
  }

  private async propose(runDir: string, seed: string, wikiIndex: string, context: RoleExecutionContext): Promise<CandidateDirection[]> {
    const views = ['gap', 'feasibility', 'novelty'] as const
    const candidates: CandidateDirection[] = []
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      for (const view of views) {
        const result = await this.provider.run('brainstorm', {
          runDir,
          perspective: `propose:${view}`,
          plan: [
            `Seed: ${seed}`,
            'Wiki index:',
            wikiIndex,
            ...(round > 1 ? [`Only ${candidates.length} valid candidates so far; propose more, non-duplicate directions.`] : []),
          ].join('\n'),
        }, context)
        const directions = (result.structured as { directions?: Array<Record<string, unknown>> } | undefined)?.directions ?? []
        directions.forEach((raw, index) => {
          const evidence = Array.isArray(raw.evidence) ? raw.evidence.map(String) : []
          const baseId = typeof raw.id === 'string' && raw.id ? raw.id : `${view}-${index + 1}`
          const direction = {
            id: candidates.some((c) => c.id === baseId) ? `${baseId}-${view}-${index + 1}` : baseId,
            source: view,
            direction: String(raw.direction ?? ''),
            evidence,
            cheapTest: String(raw.cheapTest ?? ''),
            risk: String(raw.risk ?? ''),
          }
          if (direction.direction && evidence.length >= 3 && !candidates.some((c) => c.direction === direction.direction)) {
            candidates.push(direction)
          }
        })
      }
      if (candidates.length >= 3) return candidates
    }
    if (candidates.length < 3) throw new AutoResearchError(`brainstorm proposals valid=${candidates.length}; need >= 3`, 'AGENT_FAILED')
    return candidates
  }

  private async debate(runDir: string, seed: string, wikiIndex: string, candidates: CandidateDirection[], context: RoleExecutionContext): Promise<CandidateDirection[]> {
    const lines = ['# Brainstorm Debate', '']
    const revised = candidates.map((candidate) => ({ ...candidate }))
    const stances = ['gap', 'feasibility', 'novelty']

    // Round 1: every other stance attacks every candidate.
    for (const candidate of revised) {
      const attackers = stances.filter((stance) => stance !== candidate.source)
      for (const stance of attackers) {
        const result = await this.provider.run('brainstorm', {
          runDir,
          perspective: 'debate',
          plan: [
            `Your stance: ${stance}`,
            `Target direction (${candidate.source}): ${candidate.direction}`,
            'All candidates:',
            JSON.stringify(revised, null, 2),
            'Wiki index:',
            wikiIndex,
            `Seed: ${seed}`,
          ].join('\n'),
        }, context)
        const value = result.structured as { attack?: string[]; support?: string[]; revisedDirection?: string } | undefined
        lines.push(`## Attack ${stance} -> ${candidate.id}`)
        lines.push(...(value?.attack ?? []).map((x) => `- ATTACK: ${x}`))
        lines.push(...(value?.support ?? []).map((x) => `- SUPPORT: ${x}`))
      }
    }

    // Round 2: the proposing stance responds and revises, id unchanged.
    for (const candidate of revised) {
      const result = await this.provider.run('brainstorm', {
        runDir,
        perspective: 'debate',
        plan: [
          `Your stance: ${candidate.source}`,
          `You proposed: ${candidate.direction}`,
          'Debate attacks above apply to your candidate. Tighten your direction and keep the same id.',
        ].join('\n'),
      }, context)
      const value = result.structured as { revisedDirection?: string } | undefined
      const next = value?.revisedDirection?.trim()
      if (next) candidate.direction = next
      lines.push(`## Revision ${candidate.id}`)
      lines.push(`- ${candidate.direction}`)
    }

    await writeText(debatePath(runDir), `${lines.join('\n')}\n`)
    return revised
  }

  private async scoreAndRank(runDir: string, candidates: CandidateDirection[], context: RoleExecutionContext): Promise<RankedDirection[]> {
    const totals = new Map<string, { novelty: number; feasibility: number; evidenceScore: number }>()
    const result = await this.provider.run('brainstorm', {
      runDir,
      perspective: 'score',
      plan: JSON.stringify(candidates, null, 2),
    }, context)
    const scores = (result.structured as { scores?: Array<{ candidateId?: string; novelty?: number; feasibility?: number; evidence?: number }> } | undefined)?.scores ?? []
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
        novelty: score.novelty,
        feasibility: score.feasibility,
        evidenceScore: score.evidenceScore,
        total: score.novelty + score.feasibility + score.evidenceScore,
      }
    }).sort((a, b) =>
      b.total - a.total ||
      b.evidenceScore - a.evidenceScore ||
      b.novelty - a.novelty,
    )
  }

  private async reform(runDir: string, seed: string, wikiIndex: string, ranked: RankedDirection[], context: RoleExecutionContext): Promise<string> {
    const winner = ranked[0]
    if (!winner) throw new AutoResearchError('no vote winner to reform', 'AGENT_FAILED')
    let feedback: string | undefined
    for (let round = 1; round <= 2; round += 1) {
      const result = await this.provider.run('brainstorm', {
        runDir,
        perspective: 'chair',
        plan: [
          `Seed: ${seed}`,
          'Ranked candidates (rank 1 is the only reform target; rank 2/3 are backups):',
          JSON.stringify(ranked, null, 2),
          'Wiki index:',
          wikiIndex,
          ...(feedback ? [`Previous failure: ${feedback}`] : []),
        ].join('\n'),
      }, context)
      const value = result.structured as { selectedId?: string; ideaMd?: string } | undefined
      const ideaMd = value?.ideaMd?.trim()
      const wikiRefs = (ideaMd?.match(/paper_wiki\//g) ?? []).length
      if (value?.selectedId === winner.id && ideaMd && wikiRefs >= 3) {
        await writeText(ideaPath(runDir), ideaMd)
        return ideaPath(runDir)
      }
      feedback = `You must reform rank-1 candidate "${winner.id}" only, and cite at least 3 paper_wiki/ files.`
    }
    throw new AutoResearchError('chair failed to reform the vote winner', 'AGENT_FAILED')
  }

  private async handoff(runDir: string, ideaFile: string): Promise<void> {
    const idea = await readText(ideaFile)
    await writeText(safeResolve(runDir, INPUT_DIR, IDEA_FILE), `## Direction\n\n${this.directionFrom(idea)}\n\n## A-priori ideas\n\n${this.ideasFrom(idea)}\n`)
    await writeText(safeResolve(runDir, PROFILE_FILE), [
      '# PROFILE',
      '',
      `- Brainstorm source: ${ideaFile}`,
      `- Paper wiki: ${wikiIndexPath(runDir)}`,
      '- Allowed: public literature search, local code, small real-data experiments.',
      '- Forbidden: hidden target papers, fabricated citations or results.',
      '',
    ].join('\n'))
  }

  private directionFrom(idea: string): string {
    const match = idea.match(/- direction:\s*(.+)/)
    return match?.[1]?.trim() || idea.split('\n').find((line) => line.trim().startsWith('# '))?.trim() || 'Autonomously refined research direction'
  }

  private ideasFrom(idea: string): string {
    const lines: string[] = []
    const cheap = idea.match(/- cheap_test[:\s]*(.+)/i) || idea.match(/## cheap_test\s*\n([\s\S]*?)(?=\n## |$)/)
    if (cheap) lines.push(`- ${(cheap[1] ?? cheap[0]).trim()}`)
    const backup = idea.match(/## backups\s*\n([\s\S]*)/)
    if (backup?.[1]) backup[1].split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3).forEach((line) => lines.push(`- ${line}`))
    if (lines.length === 0) lines.push('- Minimal validation experiment for the reformed direction')
    return lines.join('\n')
  }

  // ---------- seed + checkpoint ----------

  private async askHumanSeed(runDir: string, context: RoleExecutionContext): Promise<string | undefined> {
    if (!this.options.reviewer?.askOpen || !(await humanReviewEnabled(this.options.humanReviewOverride))) return undefined
    try {
      const answer = await this.options.reviewer.askOpen({
        title: '请指定本次研究的 idea / seed（可留空，留空由系统自动选择）',
        detail: 'Provide a one-sentence research idea or topic seed for the brainstorm.',
      }, context.signal, context.parent)
      if (answer) {
        await appendHumanReview(runDir, { time: new Date().toISOString(), gate: 'idea', verdict: 'approve', feedback: `human seed: ${answer}` })
      }
      return answer
    } catch (error) {
      await appendHumanReview(runDir, { time: new Date().toISOString(), gate: 'idea', verdict: 'skipped', feedback: `seed ask failed: ${String(error)}` })
      return undefined
    }
  }

  private async loadCheckpoint(runDir: string): Promise<BrainstormCheckpoint> {
    try {
      const cp = await readJson<BrainstormCheckpoint>(checkpointPath(runDir))
      if (cp.schema === 'autoresearch/brainstorm-checkpoint/v1') return cp
    } catch {
      // fall through to a fresh checkpoint
    }
    return { schema: 'autoresearch/brainstorm-checkpoint/v1', updated_at: new Date().toISOString(), phases: {}, data: {} }
  }

  private async commitPhase(runDir: string, cp: BrainstormCheckpoint, phase: string): Promise<void> {
    cp.phases[phase] = 'done'
    cp.updated_at = new Date().toISOString()
    await atomicWriteJson(checkpointPath(runDir), cp)
  }
}
