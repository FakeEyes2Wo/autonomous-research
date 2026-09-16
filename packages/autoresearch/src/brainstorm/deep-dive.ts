import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { atomicWriteJson, safeResolve, writeText } from '../core/utils.js'
import { mergePaperRecords, normalizeFrontierPapers, normalizeSurveyPapers, type RawFrontier, type RawSurvey } from './normalize.js'
import { paperWikiPath } from './handoff.js'
import { renderPaperWiki } from './wiki-render.js'
import { matchBaseline, type BaselineSpec, type BaselineCandidate, type BaselineFit } from '../literature/baseline.js'
import { checkCitationLocators } from '../literature/claim-assessment.js'
import type { SourceSpan } from '../literature/contracts.js'
import { withResearchContextProvider } from '../service/research-context.js'

export interface DeepDiveRequest {
  runDir: string
  idea: string
  profile: string
  agentContext: RoleExecutionContext
  /** Trusted protocol/configuration and registered sources, never fields from survey output. */
  baselineSpec?: BaselineSpec
  baselineCandidates?: BaselineCandidate[]
  baselineSpans?: SourceSpan[]
}

export interface DeepDiveResult {
  relatedPapers: string
  baselines: string
}

export interface DeepDiveDeps {
  provider: RoleAgentProvider
  topN?: number
}

export async function runInitialDeepDive(deps: DeepDiveDeps, request: DeepDiveRequest): Promise<DeepDiveResult> {
  deps = { ...deps, provider: withResearchContextProvider(deps.provider) }
  const topN = deps.topN ?? 15

  const surveyRaw = await deps.provider.run('paper-survey', {
    runDir: request.runDir,
    plan: [
      `Mode: deep-dive`,
      `Target idea: ${request.idea}`,
      `Profile: ${request.profile}`,
      'Do not build a broad field map.',
      `Find up to ${topN} papers most similar to this idea, including direct baselines when they exist.`,
    ].join('\n'),
  }, request.agentContext)

  const surveyPapers = normalizeSurveyPapers((surveyRaw.structured ?? {}) as RawSurvey)
  const frontierRaw = await deps.provider.run('paper-frontier-miner', {
    runDir: request.runDir,
    plan: JSON.stringify({
      selectedDirections: [
        {
          id: 'idea',
          name: request.idea.slice(0, 80),
          statement: request.idea,
          evidence: [],
        },
      ],
      existingSurveyIds: surveyPapers.map((paper) => paper.id),
      latestWindowYears: 5,
      latestPerDirection: topN,
    }, null, 2),
  }, request.agentContext)
  const frontierPapers = normalizeFrontierPapers((frontierRaw.structured ?? {}) as RawFrontier)
  const records = mergePaperRecords(surveyPapers, frontierPapers)

  await atomicWriteJson(safeResolve(request.runDir, 'brainstorm', 'deep_dive_papers.json'), records)
  for (const paper of records) {
    await writeText(paperWikiPath(request.runDir, paper.id), renderPaperWiki(paper))
  }

  const assessments: BaselineFit[] = records.map(paper => {
    const workId = paper.workId ?? paper.id
    const candidate = request.baselineCandidates?.find(c => c.workId === workId)
    if (!request.baselineSpec || !candidate) return { workId, status: 'unknown', reasons: ['protocol_or_source_configuration_missing'], spanIds: [] }
    const fit = matchBaseline(request.baselineSpec, candidate)
    const spans = (request.baselineSpans ?? []).filter(s => s.workId === workId)
    if (checkCitationLocators([{ id: workId, spanIds: fit.spanIds }], spans).missing.length) {
      fit.reasons.push('registered_source_missing')
      if (fit.status === 'matched') fit.status = 'unknown'
    }
    return fit
  })
  const compatible = new Set(assessments.filter(fit => fit.status === 'matched').map(fit => fit.workId))
  const baselines = records.filter(paper => compatible.has(paper.workId ?? paper.id))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, 3)
  const selectedText = baselines.map((paper, i) => `${i + 1}. ${paper.title}: matched to the supplied task, data, split, metric, component and compute conditions.`)
  const unresolvedText = assessments.filter(fit => fit.status !== 'matched').map(fit => `- ${fit.workId}: ${fit.status} (${fit.reasons.join(', ')}).`)
  const baselineText = [
    ...selectedText,
    ...(baselines.length ? [] : ['No external baseline has verified compatibility. Any ablation or heuristic baseline must be labeled locally designed.']),
    ...unresolvedText,
  ].join('\n')

  await atomicWriteJson(safeResolve(request.runDir, 'brainstorm', 'baselines.json'), baselines)
  await atomicWriteJson(safeResolve(request.runDir, 'brainstorm', 'baseline_assessments.json'), assessments)
  await writeText(safeResolve(request.runDir, 'brainstorm', 'baselines.md'), `# Baselines\n\n${baselineText}\n`)

  const relatedText = records.slice(0, topN).map((paper) => `- ${paper.title} (${paper.year ?? '?'}; ${paper.venue ?? '?'}; citations=${paper.citations ?? '?'})\n  ${paper.oneLiner}`).join('\n')
  return {
    relatedPapers: relatedText,
    baselines: baselineText,
  }
}
