import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import { atomicWriteJson, safeResolve, writeText } from '../core/utils.js'
import type { PaperRecord } from './paper-record.js'
import { mergePaperRecords, normalizeFrontierPapers, normalizeSurveyPapers, type RawFrontier, type RawSurvey } from './normalize.js'
import { paperWikiPath } from './handoff.js'
import { renderPaperWiki } from './wiki-render.js'

export interface DeepDiveRequest {
  runDir: string
  idea: string
  profile: string
  agentContext: RoleExecutionContext
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

  const baselines = records
    .filter((paper) => paper.citations !== undefined)
    .sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0))
    .slice(0, 3)

  const baselineText = baselines.length > 0
    ? baselines.map((paper, i) => `${i + 1}. ${paper.title} (${paper.year ?? '?'}, citations=${paper.citations ?? '?'})`).join('\n')
    : 'No external baseline found. We will design a baseline ourselves (e.g. remove the proposed component, random/heuristic baseline, or strongest existing public config).'

  await atomicWriteJson(safeResolve(request.runDir, 'brainstorm', 'baselines.json'), baselines)
  await writeText(safeResolve(request.runDir, 'brainstorm', 'baselines.md'), `# Baselines\n\n${baselineText}\n`)

  const relatedText = records.slice(0, topN).map((paper) => `- ${paper.title} (${paper.year ?? '?'}; ${paper.venue ?? '?'}; citations=${paper.citations ?? '?'})\n  ${paper.oneLiner}`).join('\n')
  return {
    relatedPapers: relatedText,
    baselines: baselineText,
  }
}
