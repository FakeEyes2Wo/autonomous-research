import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { appendHumanReview, type HumanReviewer } from '../core/human-review.js'
import { humanReviewEnabled, type HumanReviewMode } from '../session/auto-mode.js'
import {
  atomicWriteJson,
  AutoResearchError,
  ensureDir,
  safeResolve,
  writeText,
} from '../core/utils.js'
import {
  brainstormDirPath,
  buildIdeaHandoff,
  countPaperWikiCitations,
  debatePath,
  ideaPath,
  paperWikiPath,
  renderUnifiedWikiIndex,
  seedPath,
  wikiIndexPath,
  writeBrainstormHandoff,
  type IdeaHandoff,
} from './handoff.js'
import {
  rankCandidates,
  type BrainstormContext,
  type CandidateDirection,
  type RankingStrategy,
} from './ranking.js'
import type { FrontierPaper, PaperRecord, SurveyPaper } from './paper-record.js'
import {
  mergePaperRecords,
  normalizeFrontierPapers,
  normalizeSurveyPapers,
  type RawFrontier,
  type RawSurvey,
} from './normalize.js'
import {
  buildKnowledgeGraphSummary,
  buildPaperKnowledgeGraph,
  writePaperKnowledgeGraph,
  type KnowledgeCluster,
  type KnowledgeDirection,
} from './knowledge-graph.js'

const DEFAULTS = {
  surveyMinSurveys: 3,
  surveyMinPapers: 60,
  surveyMinClusters: 5,
  latestPerDirection: 5,
  latestWindowYears: 1,
  maxSelectedDirections: 3,
}

export interface BrainstormOptions {
  idea?: string
  reviewer?: HumanReviewer
  humanReviewOverride?: HumanReviewMode
  ranking?: RankingStrategy
  // Two-stage survey options
  surveyMinSurveys?: number
  surveyMinPapers?: number
  surveyMinClusters?: number
  latestPerDirection?: number
  latestWindowYears?: number
  maxSelectedDirections?: number
  enableKnowledgeGraph?: boolean
}

export interface BrainstormDependencies {
  readonly provider: RoleAgentProvider
  readonly options: Readonly<BrainstormOptions>
}

export interface BrainstormRequest {
  readonly runDir: string
  readonly agentContext: RoleExecutionContext
}

export type { BrainstormContext, CandidateDirection, RankingStrategy } from './ranking.js'
export type { IdeaHandoff } from './handoff.js'
export type { PaperRecord, SurveyPaper, FrontierPaper } from './paper-record.js'
export type { KnowledgeCluster, KnowledgeDirection } from './knowledge-graph.js'

const surveyPoolPath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'survey_pool.json')
const frontierPoolPath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'frontier_pool.json')
const selectedDirectionsPath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'selected_directions.json')
const paperRecordsPath = (runDir: string) => safeResolve(runDir, 'brainstorm', 'paper_records.json')
const surveyOverviewPath = (runDir: string) => safeResolve(runDir, 'paper_wiki', '_survey.md')
const directionsOverviewPath = (runDir: string) => safeResolve(runDir, 'paper_wiki', '_directions.md')

interface RawDirection {
  id?: string
  name?: string
  statement?: string
  why?: string
  evidence?: string[]
  cheapTest?: string
  risk?: string
}

interface SelectedDirectionResult {
  directions?: RawDirection[]
  selectedId?: string
  backups?: string[]
}

interface BrainstormState extends BrainstormContext {
  readonly surveyRaw?: RawSurvey
  readonly frontierRaw?: RawFrontier
  readonly surveyPapers: SurveyPaper[]
  readonly frontierPapers: FrontierPaper[]
  readonly records: PaperRecord[]
  readonly clusters: KnowledgeCluster[]
  readonly directions: KnowledgeDirection[]
  readonly candidates: CandidateDirection[]
  readonly ranked: CandidateDirection[]
  readonly handoff: IdeaHandoff
}

const VIEWS = ['gap', 'feasibility', 'novelty']

/**
 * Two-stage brainstorm pre-phase:
 *   1. broad survey (surveys first) + survey wiki + knowledge graph
 *   2. direction selection + latest/frontier mining + merged wiki/KG
 * then the existing propose/debate/score/chair ideation.
 */
export async function runBrainstorm(
  deps: BrainstormDependencies,
  request: BrainstormRequest,
): Promise<string> {
  const { runDir, agentContext } = request
  await ensureDir(brainstormDirPath(runDir))

  const base: BrainstormContext = { runDir, seed: '', wikiIndex: '', agentContext }
  const seed = await resolveSeed(deps, base)
  let state: BrainstormState = {
    ...base,
    seed,
    surveyPapers: [],
    frontierPapers: [],
    records: [],
    clusters: [],
    directions: [],
    candidates: [],
    ranked: [],
    handoff: { direction: '', cheapTest: '', backups: [] },
  }

  // Stage 1: broad survey
  const surveyRaw = await survey(deps, state)
  const clusters = toClusters(surveyRaw)
  const surveyPapers = normalizeSurveyPapers(surveyRaw, clusters)
  state = { ...state, surveyRaw, clusters, surveyPapers, records: surveyPapers }

  await atomicWriteJson(surveyPoolPath(runDir), surveyRaw)
  await writeWikis(deps, state, surveyPapers, 'survey')
  await writeSurveyOverview(deps, state, surveyRaw)

  const surveyIndex = renderUnifiedWikiIndex(surveyPapers)
  state = { ...state, wikiIndex: surveyIndex }
  await writeText(wikiIndexPath(runDir), surveyIndex)
  const kgSummary = await rebuildKnowledgeGraph(deps, state)

  // Stage 2: select directions, then query latest/frontier
  const directions = await selectDirections(deps, state, kgSummary)
  state = { ...state, directions }
  await atomicWriteJson(selectedDirectionsPath(runDir), directions)

  const frontierRaw = await frontierMine(deps, state)
  const frontierPapers = normalizeFrontierPapers(frontierRaw)
  const records = mergePaperRecords(surveyPapers, frontierPapers)
  state = { ...state, frontierRaw, frontierPapers, records }

  await atomicWriteJson(frontierPoolPath(runDir), frontierRaw)
  await atomicWriteJson(paperRecordsPath(runDir), records)
  await writeWikis(deps, state, frontierPapers, 'latest')
  await writeDirectionsOverview(state, directions)

  const mergedIndex = renderUnifiedWikiIndex(records)
  state = { ...state, wikiIndex: mergedIndex }
  await writeText(wikiIndexPath(runDir), mergedIndex)
  await rebuildKnowledgeGraph(deps, state)

  // Existing multi-perspective ideation
  const candidates = await propose(deps, state)
  state = { ...state, candidates }

  const revised = await debate(deps, state)
  state = { ...state, candidates: revised }

  const ranked = await scoreAndRank(deps, state)
  if (ranked.length < 3) throw new AutoResearchError(`brainstorm produced ${ranked.length} candidates; need >= 3`, 'AGENT_FAILED')
  state = { ...state, ranked }

  const handoff = await reform(deps, state)
  state = { ...state, handoff }

  await finishHandoff(state)
  return ideaPath(runDir)
}

// ---------- seed ----------

async function resolveSeed(deps: BrainstormDependencies, ctx: BrainstormContext): Promise<string> {
  const idea = deps.options.idea?.trim()
  if (idea) return idea
  if (deps.options.reviewer?.askOpen && await humanReviewEnabled(deps.options.humanReviewOverride)) {
    try {
      const answer = await deps.options.reviewer.askOpen({
        title: '请指定本次研究的 idea / seed（可留空，留空由系统自动选择）',
        detail: 'Provide a one-sentence research idea or topic seed for the brainstorm.',
      }, ctx.agentContext.signal, ctx.agentContext.parent)
      if (answer) {
        await appendHumanReview(ctx.runDir, { time: new Date().toISOString(), gate: 'idea', verdict: 'approve', feedback: `human seed: ${answer}` })
        return answer
      }
    } catch (error) {
      await appendHumanReview(ctx.runDir, { time: new Date().toISOString(), gate: 'idea', verdict: 'skipped', feedback: `seed ask failed: ${String(error)}` })
    }
  }
  return ''
}

// ---------- Stage 1 ----------

function surveyPlan(deps: BrainstormDependencies, ctx: BrainstormState): string {
  return [
    `Seed: ${ctx.seed || 'None'}`,
    `Stage: survey`,
    `Goal: breadth first; find field surveys/reviews first`,
    `Min surveys: ${deps.options.surveyMinSurveys ?? DEFAULTS.surveyMinSurveys}`,
    `Min clusters: ${deps.options.surveyMinClusters ?? DEFAULTS.surveyMinClusters}`,
    `Min papers: ${deps.options.surveyMinPapers ?? DEFAULTS.surveyMinPapers}`,
  ].join('\n')
}

async function survey(deps: BrainstormDependencies, ctx: BrainstormState): Promise<RawSurvey> {
  const result = await deps.provider.run('paper-survey', {
    runDir: ctx.runDir,
    plan: surveyPlan(deps, ctx),
  }, ctx.agentContext)
  const raw = (result.structured ?? {}) as RawSurvey
  const surveys = raw.surveys ?? []
  const clusters = raw.clusters ?? []
  const papers = raw.papers ?? []
  const minSurveys = deps.options.surveyMinSurveys ?? DEFAULTS.surveyMinSurveys
  const minClusters = deps.options.surveyMinClusters ?? DEFAULTS.surveyMinClusters
  const minPapers = deps.options.surveyMinPapers ?? DEFAULTS.surveyMinPapers
  if (surveys.length < minSurveys) {
    throw new AutoResearchError(`paper-survey must find >= ${minSurveys} field surveys; got ${surveys.length}`, 'AGENT_FAILED')
  }
  if (clusters.length < minClusters) {
    throw new AutoResearchError(`paper-survey must return >= ${minClusters} clusters; got ${clusters.length}`, 'AGENT_FAILED')
  }
  if (papers.length < minPapers) {
    throw new AutoResearchError(`paper-survey must return >= ${minPapers} papers; got ${papers.length}`, 'AGENT_FAILED')
  }
  return raw
}

function toClusters(raw: RawSurvey): KnowledgeCluster[] {
  return (raw.clusters ?? []).map((cluster, index) => ({
    id: typeof cluster.id === 'string' && cluster.id ? cluster.id : `c${String(index + 1).padStart(2, '0')}`,
    name: typeof cluster.name === 'string' && cluster.name ? cluster.name : `Cluster ${index + 1}`,
    summary: typeof cluster.summary === 'string' ? cluster.summary : '',
    sourceSurveyIds: Array.isArray(cluster.sourceSurveyIds) ? cluster.sourceSurveyIds.map(String) : [],
    openQuestions: Array.isArray(cluster.openQuestions) ? cluster.openQuestions.map(String) : [],
  }))
}

async function writeWikis(
  deps: BrainstormDependencies,
  ctx: BrainstormState,
  records: readonly PaperRecord[],
  stage: 'survey' | 'latest',
): Promise<void> {
  if (records.length === 0) return
  const result = await deps.provider.run('paper-wiki-writer', {
    runDir: ctx.runDir,
    plan: JSON.stringify({ papers: records, stageHint: stage }, null, 2),
  }, ctx.agentContext)
  const wikis = (result.structured as { wikis?: Record<string, string> } | undefined)?.wikis ?? {}
  const missing = records.filter((paper) => !wikis[paper.id])
  if (missing.length > 0) {
    throw new AutoResearchError(`paper wiki missing ${missing.length} ${stage} papers`, 'AGENT_FAILED')
  }
  for (const [id, markdown] of Object.entries(wikis)) {
    await writeText(paperWikiPath(ctx.runDir, id), markdown)
  }
}

async function writeSurveyOverview(deps: BrainstormDependencies, ctx: BrainstormState, raw: RawSurvey): Promise<void> {
  const surveys = raw.surveys ?? []
  const clusters = ctx.clusters
  const lines = ['# Field Survey Overview', '', '## Found Surveys', '']
  for (const survey of surveys) {
    lines.push(`- ${survey.title ?? survey.id ?? 'Unnamed survey'} (${survey.year ?? 'year?'}): ${survey.scope ?? ''}`)
  }
  lines.push('', '## Cluster Map', '')
  for (const cluster of clusters) {
    lines.push(`- ${cluster.name} (${cluster.id})`)
    lines.push(`  - source surveys: ${(cluster.sourceSurveyIds ?? []).join(', ') || '-'}`)
    lines.push(`  - open questions: ${(cluster.openQuestions ?? []).join('; ') || '-'}`)
  }
  lines.push('', '## Coverage Gap', '')
  const minSurveys = deps.options.surveyMinSurveys ?? DEFAULTS.surveyMinSurveys
  if (surveys.length < minSurveys) {
    lines.push(`- Only ${surveys.length} field surveys found; expected at least ${minSurveys}. This gap must be explicit.`)
  } else {
    lines.push('- No explicit coverage gap recorded.')
  }
  await writeText(surveyOverviewPath(ctx.runDir), `${lines.join('\n')}\n`)
}

// ---------- Stage 2 ----------

async function selectDirections(deps: BrainstormDependencies, ctx: BrainstormState, kgSummary: string): Promise<KnowledgeDirection[]> {
  const result = await deps.provider.run('direction-select', {
    runDir: ctx.runDir,
    plan: [
      `Seed: ${ctx.seed || 'None'}`,
      'Survey wiki index:',
      ctx.wikiIndex,
      '',
      'Knowledge graph summary:',
      kgSummary,
    ].join('\n'),
  }, ctx.agentContext)
  const value = (result.structured ?? {}) as SelectedDirectionResult
  const directions = toDirections(value.directions ?? [])
  if (directions.length < 1) throw new AutoResearchError('direction-select produced no directions', 'AGENT_FAILED')
  const weak = directions.filter((direction) => (direction.evidence?.length ?? 0) < 3)
  if (weak.length > 0) {
    throw new AutoResearchError(`direction-select must cite >= 3 items for each direction; weak: ${weak.map((d) => d.id).join(', ')}`, 'AGENT_FAILED')
  }
  return directions.slice(0, deps.options.maxSelectedDirections ?? DEFAULTS.maxSelectedDirections)
}

function toDirections(raw: RawDirection[]): KnowledgeDirection[] {
  return raw.map((direction, index) => ({
    id: direction.id?.trim() || `d${index + 1}`,
    name: direction.name?.trim() || direction.statement?.trim() || `Direction ${index + 1}`,
    statement: direction.statement?.trim() ?? '',
    evidence: Array.isArray(direction.evidence) ? direction.evidence.map(String) : [],
    cheapTest: direction.cheapTest ?? '',
    risk: direction.risk ?? '',
  }))
}

async function frontierMine(deps: BrainstormDependencies, ctx: BrainstormState): Promise<RawFrontier> {
  const latestPerDirection = deps.options.latestPerDirection ?? DEFAULTS.latestPerDirection
  const latestWindowYears = deps.options.latestWindowYears ?? DEFAULTS.latestWindowYears
  const result = await deps.provider.run('paper-frontier-miner', {
    runDir: ctx.runDir,
    plan: JSON.stringify({
      selectedDirections: ctx.directions,
      existingSurveyIds: ctx.surveyPapers.map((paper) => paper.id),
      latestWindowYears,
      latestPerDirection,
    }, null, 2),
  }, ctx.agentContext)
  const raw = (result.structured ?? {}) as RawFrontier
  const papers = raw.papers ?? []
  const expected = ctx.directions.length * latestPerDirection
  if (papers.length < 1) {
    throw new AutoResearchError('paper-frontier-miner returned no latest papers', 'AGENT_FAILED')
  }
  if (papers.length < expected) {
    raw.expectedMin = expected
  }
  return raw
}

async function writeDirectionsOverview(ctx: BrainstormState, directions: KnowledgeDirection[]): Promise<void> {
  const lines = ['# Selected Directions', '']
  for (const direction of directions) {
    lines.push(`## ${direction.id} — ${direction.name}`)
    lines.push(`- statement: ${direction.statement || '-'}`)
    lines.push(`- evidence: ${direction.evidence?.join(', ') || '-'}`)
    lines.push(`- cheapTest: ${direction.cheapTest || '-'}`)
    lines.push(`- risk: ${direction.risk || '-'}`)
  }
  await writeText(directionsOverviewPath(ctx.runDir), `${lines.join('\n')}\n`)
}

// ---------- knowledge graph ----------

async function rebuildKnowledgeGraph(deps: BrainstormDependencies, ctx: BrainstormState): Promise<string> {
  if (deps.options.enableKnowledgeGraph === false) return ''
  const kg = buildPaperKnowledgeGraph(ctx.records, ctx.clusters, ctx.directions)
  await writePaperKnowledgeGraph(ctx.runDir, kg)
  return buildKnowledgeGraphSummary(kg)
}

// ---------- existing ideation ----------

async function propose(deps: BrainstormDependencies, ctx: BrainstormState): Promise<CandidateDirection[]> {
  const candidates: CandidateDirection[] = []
  for (const view of VIEWS) {
    const result = await deps.provider.run('brainstorm', {
      runDir: ctx.runDir,
      perspective: `propose:${view}`,
      plan: `Seed: ${ctx.seed || 'None'}\nWiki index:\n${ctx.wikiIndex}`,
    }, ctx.agentContext)
    for (const raw of (result.structured as { directions?: Array<Record<string, unknown>> } | undefined)?.directions ?? []) {
      const direction = toDirection({ view, raw, existing: candidates })
      if (direction) candidates.push(direction)
    }
  }
  if (candidates.length < 3) throw new AutoResearchError(`brainstorm proposals valid=${candidates.length}; need >= 3`, 'AGENT_FAILED')
  return candidates
}

function toDirection(request: {
  view: string
  raw: Record<string, unknown>
  existing: CandidateDirection[]
}): CandidateDirection | undefined {
  const { view, raw, existing } = request
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

async function debate(deps: BrainstormDependencies, ctx: BrainstormState): Promise<CandidateDirection[]> {
  const { candidates } = ctx
  const lines = ['# Brainstorm Debate', '']
  for (const candidate of candidates) {
    const result = await deps.provider.run('brainstorm', {
      runDir: ctx.runDir,
      perspective: 'debate',
      plan: [
        `Seed: ${ctx.seed || 'None'}`,
        `Target direction to attack and revise (id ${candidate.id}): ${candidate.direction}`,
        'All candidates:',
        JSON.stringify(candidates, null, 2),
        'Wiki index:',
        ctx.wikiIndex,
      ].join('\n'),
    }, ctx.agentContext)
    const value = result.structured as { attack?: string[]; support?: string[]; revisedDirection?: string } | undefined
    lines.push(`## Debate ${candidate.id}`)
    lines.push(...(value?.attack ?? []).map((x) => `- ATTACK: ${x}`))
    lines.push(...(value?.support ?? []).map((x) => `- SUPPORT: ${x}`))
    const revised = value?.revisedDirection?.trim()
    if (revised) candidate.direction = revised
    lines.push(`- REVISED: ${candidate.direction}`)
  }
  await writeText(debatePath(ctx.runDir), `${lines.join('\n')}\n`)
  return candidates
}

async function scoreAndRank(deps: BrainstormDependencies, ctx: BrainstormState): Promise<CandidateDirection[]> {
  const ranking = deps.options.ranking ?? rankCandidates
  return ranking(ctx, ctx.candidates, deps.provider)
}

async function reform(deps: BrainstormDependencies, ctx: BrainstormState): Promise<IdeaHandoff> {
  const { ranked } = ctx
  const winner = ranked[0]
  if (!winner) throw new AutoResearchError('no vote winner to reform', 'AGENT_FAILED')
  const result = await deps.provider.run('brainstorm', {
    runDir: ctx.runDir,
    perspective: 'chair',
    plan: [
      `Seed: ${ctx.seed || 'None'}`,
      'Ranked candidates (rank 1 is the only reform target; rank 2/3 are backups):',
      JSON.stringify(ranked, null, 2),
      'Wiki index:',
      ctx.wikiIndex,
    ].join('\n'),
  }, ctx.agentContext)
  const value = result.structured as { selectedId?: string; ideaMd?: string } | undefined
  const ideaMd = value?.ideaMd?.trim()
  if (value?.selectedId !== winner.id || !ideaMd || countPaperWikiCitations(ideaMd) < 3) {
    throw new AutoResearchError(`chair must reform rank-1 candidate "${winner.id}" and cite >= 3 paper_wiki files`, 'AGENT_FAILED')
  }
  await writeText(ideaPath(ctx.runDir), ideaMd)
  return buildIdeaHandoff(ideaMd)
}

async function finishHandoff(ctx: BrainstormState): Promise<void> {
  await writeBrainstormHandoff({ runDir: ctx.runDir, handoff: ctx.handoff })
}
