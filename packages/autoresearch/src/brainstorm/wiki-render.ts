import type { PaperRecord } from './paper-record.js'
import { isFrontierPaper, isSurveyPaper } from './paper-record.js'

/**
 * Render a deterministic paper-wiki card from the normalized PaperRecord.
 *
 * The survey/frontier roles already return structured metadata and analysis
 * fields, so this renderer writes paper_wiki/*.md without a slow LLM round-trip.
 */
export function renderPaperWiki(paper: PaperRecord): string {
  const lines = [
    `# ${paper.title}`,
    '',
    '## Metadata',
    '',
    `- id: ${paper.id}`,
    `- year: ${paper.year ?? 'unknown'}`,
    `- venue: ${paper.venue ?? 'unknown'}`,
    ...(paper.arxivId ? [`- arxiv: ${paper.arxivId}`] : []),
    ...(paper.doi ? [`- doi: ${paper.doi}`] : []),
    ...(paper.url ? [`- url: ${paper.url}`] : []),
    ...(paper.citations !== undefined ? [`- citations: ${paper.citations}`] : []),
  ]

  if (isSurveyPaper(paper)) {
    lines.push(
      '',
      '## Survey Context',
      '',
      `- role: ${paper.role}`,
      ...(paper.clusterId ? [`- cluster: ${paper.clusterId}`] : []),
      ...((paper.clusterIds ?? []).length > 0 ? [`- clusters: ${paper.clusterIds?.join(', ')}`] : []),
      ...(paper.sourceSurveyIds.length > 0 ? [`- source surveys: ${paper.sourceSurveyIds.join(', ')}`] : []),
      ...(paper.surveyScope ? [`- scope: ${paper.surveyScope}`] : []),
      ...((paper.taxonomy ?? []).length > 0 ? [`- taxonomy: ${paper.taxonomy?.join(', ')}`] : []),
      ...((paper.openQuestions ?? []).length > 0 ? [`- open questions: ${paper.openQuestions?.join('; ')}`] : []),
    )
  }

  if (isFrontierPaper(paper)) {
    lines.push(
      '',
      '## Frontier Context',
      '',
      `- role: ${paper.role}`,
      `- direction: ${paper.directionId}`,
      ...(paper.whyLatest ? [`- why latest: ${paper.whyLatest}`] : []),
      ...(paper.novelty ? [`- novelty: ${paper.novelty}`] : []),
      ...((paper.sourceSurveyIds ?? []).length > 0 ? [`- source surveys: ${paper.sourceSurveyIds?.join(', ')}`] : []),
    )
  }

  lines.push(
    '',
    '## One-liner',
    '',
    paper.oneLiner || '(not provided)',
    '',
    '## Key Finding',
    '',
    paper.keyFinding || '(not provided)',
    '',
    '## Contributions',
    '',
    ...(paper.contributions.length > 0 ? paper.contributions.map((item) => `- ${item}`) : ['- (not provided)']),
    '',
    '## Methods',
    '',
    ...(paper.methods.length > 0 ? paper.methods.map((item) => `- ${item}`) : ['- (not provided)']),
    '',
    '## Experiments',
    '',
    ...(paper.experiments.length > 0 ? paper.experiments.map((item) => `- ${item}`) : ['- (not provided)']),
    '',
    '## Results',
    '',
    ...(paper.results.length > 0 ? paper.results.map((item) => `- ${item}`) : ['- (not provided)']),
    '',
    '## Weakness',
    '',
    paper.weakness || '(not provided)',
    '',
    '## Limitations',
    '',
    ...(paper.limitations.length > 0 ? paper.limitations.map((item) => `- ${item}`) : ['- (not provided)']),
    '',
    '## Future Directions',
    '',
    ...(paper.futureDirections.length > 0 ? paper.futureDirections.map((item) => `- ${item}`) : ['- (not provided)']),
    '',
    '## Implications / Insights',
    '',
    paper.implication || '(not provided)',
    ...(paper.insights.length > 0 ? ['', ...paper.insights.map((item) => `- ${item}`)] : []),
    '',
    '## Relevance to Us',
    '',
    paper.relevance || '(not provided)',
  )

  if (paper.abstract) {
    lines.push('', '## Abstract', '', paper.abstract)
  }

  return `${lines.join('\n')}\n`
}
