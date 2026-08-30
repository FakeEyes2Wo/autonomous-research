import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectCuratedPapers } from '../../dist/brainstorm/curated-papers.js'
import type { SurveyPaper } from '../../dist/brainstorm/paper-record.js'

function paper(id: string, year: string, citations: number, role: SurveyPaper['role'] = 'method'): SurveyPaper {
  return {
    id,
    title: `Paper ${id}`,
    arxivId: `2401.${id}`,
    url: `https://arxiv.org/abs/2401.${id}`,
    year,
    venue: 'ICLR',
    citations,
    abstract: `abstract ${id}`,
    oneLiner: `one ${id}`,
    keyFinding: `finding ${id}`,
    weakness: `weak ${id}`,
    implication: `implication ${id}`,
    contributions: [],
    methods: [],
    experiments: [],
    results: [],
    limitations: [],
    futureDirections: [],
    insights: [],
    relevance: '',
    stage: 'survey',
    role,
    clusterId: 'C1',
    clusterIds: ['C1'],
    sourceSurveyIds: [],
    isSurvey: role === 'survey',
    surveyScope: undefined,
    taxonomy: undefined,
    openQuestions: [],
    recommendedDirections: [],
  }
}

test('selectCuratedPapers keeps 20 and fills from older papers when needed', () => {
  const currentYear = new Date().getFullYear()
  const records: SurveyPaper[] = []
  // 5 recent papers (qualified)
  for (let i = 1; i <= 5; i += 1) {
    records.push(paper(`r${i}`, String(currentYear), 500 - i, 'method'))
  }
  // 20 older papers (fallback)
  for (let i = 1; i <= 20; i += 1) {
    records.push(paper(`o${i}`, String(currentYear - 5), 1000 - i, 'method'))
  }

  const curated = selectCuratedPapers(records, { topN: 20, maxAgeYears: 2 })

  assert.equal(curated.length, 20)
  assert.equal(curated.filter((p) => p.source === 'qualified').length, 5)
  assert.equal(curated.filter((p) => p.source === 'fallback').length, 15)
  // Qualified papers must come before fallback papers.
  const firstFallback = curated.findIndex((p) => p.source === 'fallback')
  const lastQualified = curated.findLastIndex((p) => p.source === 'qualified')
  assert.equal(lastQualified < firstFallback, true)
})
