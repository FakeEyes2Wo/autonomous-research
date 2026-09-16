import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
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
import { renderPaperWiki } from './wiki-render.js'
import { selectCuratedPapers, writeCuratedPapers } from './curated-papers.js'

const DEFAULTS = {
  surveyMinSurveys: 3,
  // A paper count is a caller-owned upper bound, not a hidden quality gate.
  // Keep the legacy lower-bound option opt-in for API compatibility only.
  surveyMinPapers: 0,
  surveyMinClusters: 5,
  latestPerDirection: 5,
  latestWindowYears: 1,
  maxSelectedDirections: 3,
}

export interface BrainstormOptions {
  ranking?: RankingStrategy
  // Two-stage survey options
  surveyMinSurveys?: number
  /** Maximum number of survey papers retained (when supplied by project policy). */
  maxPapers?: number
  /** @deprecated Explicit legacy lower-bound; defaults to zero. */
  surveyMinPapers?: number
  surveyMinClusters?: number
  latestPerDirection?: number
  latestWindowYears?: number
  maxSelectedDirections?: number
  enableKnowledgeGraph?: boolean
  curatedEnabled?: boolean
  curatedTopN?: number
  curatedMaxAgeYears?: number
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

  const base: BrainstormContext = { runDir, wikiIndex: '', agentContext }
  let state: BrainstormState = {
    ...base,
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
  await writeWikis(state, surveyPapers)
  await writeSurveyOverview(deps, state, surveyRaw)

  const surveyIndex = renderUnifiedWikiIndex(surveyPapers)
  state = { ...state, wikiIndex: surveyIndex }
  await writeText(wikiIndexPath(runDir), surveyIndex)
  const kgSummary = await rebuildKnowledgeGraph(deps, state)

  // Stage 2: select directions, then query latest/frontier
  const directions = await selectDirections(deps, state, kgSummary)
  state = { ...state, directions }
  await atomicWriteJson(selectedDirectionsPath(runDir), directions)

  const paperCap = deps.options.maxPapers
  // Once the survey pool has consumed the caller's cap there is no reason to
  // spend another model call mining a pool that must be discarded.
  const frontierRaw = paperCap !== undefined && surveyPapers.length >= paperCap
    ? { papers: [] }
    : await frontierMine(deps, state)
  const frontierLimit = paperCap === undefined ? undefined : Math.max(0, paperCap - surveyPapers.length)
  const boundedFrontierRaw: RawFrontier = frontierLimit === undefined
    ? frontierRaw
    : { ...frontierRaw, papers: (frontierRaw.papers ?? []).slice(0, frontierLimit) }
  const frontierPapers = normalizeFrontierPapers(boundedFrontierRaw)
  const records = mergePaperRecords(surveyPapers, frontierPapers).slice(0, paperCap ?? Number.POSITIVE_INFINITY)
  state = { ...state, frontierRaw, frontierPapers, records }

  await atomicWriteJson(frontierPoolPath(runDir), boundedFrontierRaw)
  await atomicWriteJson(paperRecordsPath(runDir), records)

  if (deps.options.curatedEnabled !== false) {
    const curated = selectCuratedPapers(records, {
      topN: deps.options.curatedTopN,
      maxAgeYears: deps.options.curatedMaxAgeYears,
    })
    await writeCuratedPapers(runDir, curated, {
      topN: deps.options.curatedTopN,
      maxAgeYears: deps.options.curatedMaxAgeYears,
    })
  }

  await writeWikis(state, frontierPapers)
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

// ---------- Stage 1 ----------

function surveyPlan(deps: BrainstormDependencies): string {
  return [
    `Stage: survey`,
    `Goal: breadth first; find field surveys/reviews first`,
    `Min surveys: ${deps.options.surveyMinSurveys ?? DEFAULTS.surveyMinSurveys}`,
    `Min clusters: ${deps.options.surveyMinClusters ?? DEFAULTS.surveyMinClusters}`,
    `Max papers: ${deps.options.maxPapers === undefined ? 'caller default' : deps.options.maxPapers}`,
    `Legacy minimum papers (only if explicitly configured): ${deps.options.surveyMinPapers ?? DEFAULTS.surveyMinPapers}`,
  ].join('\n')
}

async function survey(deps: BrainstormDependencies, ctx: BrainstormState): Promise<RawSurvey> {
  const result = await deps.provider.run('paper-survey', {
    runDir: ctx.runDir,
    plan: surveyPlan(deps),
  }, ctx.agentContext)
  const raw = (result.structured ?? {}) as RawSurvey
  const surveys = raw.surveys ?? []
  const clusters = raw.clusters ?? []
  const maxPapers = deps.options.maxPapers
  if (maxPapers !== undefined && (!Number.isInteger(maxPapers) || maxPapers < 0)) {
    throw new AutoResearchError(`maxPapers must be a non-negative integer; got ${String(maxPapers)}`, 'INVALID_ARGUMENT')
  }
  // Apply the cap before normalization and persistence. This makes maxPapers
  // a real resource bound even when a provider returns a larger pool.
  const papers = maxPapers === undefined ? (raw.papers ?? []) : (raw.papers ?? []).slice(0, maxPapers)
  const boundedRaw: RawSurvey = maxPapers === undefined ? raw : { ...raw, papers }
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
  return boundedRaw
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
  ctx: BrainstormState,
  records: readonly PaperRecord[],
): Promise<void> {
  if (records.length === 0) return
  for (const paper of records) {
    await writeText(paperWikiPath(ctx.runDir, paper.id), renderPaperWiki(paper))
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
    // The structured output object may be non-extensible; return a copy instead
    // of mutating it in place.
    return { ...raw, expectedMin: expected }
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
  const rawsByView = await Promise.all(VIEWS.map(async (view) => {
    const result = await deps.provider.run('brainstorm', {
      runDir: ctx.runDir,
      perspective: `propose:${view}`,
      plan: `Wiki index:\n${ctx.wikiIndex}`,
    }, ctx.agentContext)
    return (result.structured as { directions?: Array<Record<string, unknown>> } | undefined)?.directions ?? []
  }))

  const candidates: CandidateDirection[] = []
  VIEWS.forEach((view, index) => {
    for (const raw of rawsByView[index] ?? []) {
      const direction = toDirection({ view, raw, existing: candidates })
      if (direction) candidates.push(direction)
    }
  })
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
  const results = await Promise.all(candidates.map((candidate) => deps.provider.run('brainstorm', {
    runDir: ctx.runDir,
    perspective: 'debate',
    plan: [
      `Target direction to attack and revise (id ${candidate.id}): ${candidate.direction}`,
      'All candidates:',
      JSON.stringify(candidates, null, 2),
      'Wiki index:',
      ctx.wikiIndex,
    ].join('\n'),
  }, ctx.agentContext)))

  const lines = ['# Brainstorm Debate', '']
  candidates.forEach((candidate, index) => {
    const value = results[index]?.structured as { attack?: string[]; support?: string[]; revisedDirection?: string } | undefined
    lines.push(`## Debate ${candidate.id}`)
    lines.push(...(value?.attack ?? []).map((x) => `- ATTACK: ${x}`))
    lines.push(...(value?.support ?? []).map((x) => `- SUPPORT: ${x}`))
    const revised = value?.revisedDirection?.trim()
    if (revised) candidate.direction = revised
    lines.push(`- REVISED: ${candidate.direction}`)
  })
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
