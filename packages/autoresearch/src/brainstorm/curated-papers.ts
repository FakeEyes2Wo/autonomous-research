import type { PaperRecord } from './paper-record.js'
import { isFrontierPaper, isSurveyPaper, paperKey } from './paper-record.js'
import { atomicWriteJson, nowIso, safeResolve, writeText } from '../core/utils.js'

export interface CuratedPaperOptions {
  topN?: number
  maxAgeYears?: number
}

export type CuratedPaper = PaperRecord & {
  score: number
  source: 'qualified' | 'fallback'
  reason: string
}

const W = { recency: 0.4, citation: 0.35, recognition: 0.25 }

function recency(paper: PaperRecord, maxAge: number): number {
  const age = new Date().getFullYear() - Number(paper.year)
  if (!Number.isFinite(age) || age < 0 || age > maxAge) return 0
  return age === 0 ? 1 : age === 1 ? 0.6 : 0.3
}

function recognition(paper: PaperRecord): number {
  const role = isSurveyPaper(paper)
    ? paper.isSurvey || paper.role === 'landmark' ? 1 : paper.role === 'method' ? 0.7 : 0.5
    : isFrontierPaper(paper) ? (paper.role === 'A' ? 0.9 : paper.role === 'B' ? 0.5 : 0.3) : 0.5
  const venue = /iclr|neurips|icml|acl|cvpr|emnlp|nips/i.test(paper.venue ?? '') ? 1 : 0.7
  return role * 0.7 + venue * 0.3
}

function score(paper: PaperRecord, maxAgeYears: number, maxCitations: number): { score: number; source: 'qualified' | 'fallback'; reason: string } {
  const r = recency(paper, maxAgeYears)
  const c = paper.citations && maxCitations > 0 ? Math.log1p(paper.citations) / Math.log1p(maxCitations) : 0
  const n = recognition(paper)
  return {
    score: r * W.recency + c * W.citation + n * W.recognition,
    source: r > 0 ? 'qualified' : 'fallback',
    reason: [r > 0 ? '近两年' : '', paper.citations ? `引用 ${paper.citations}` : '', paper.venue ?? ''].filter(Boolean).join('；'),
  }
}

export function selectCuratedPapers(records: readonly PaperRecord[], options: CuratedPaperOptions = {}): CuratedPaper[] {
  const topN = options.topN ?? 20
  const maxAgeYears = options.maxAgeYears ?? 2
  const maxCitations = Math.max(...records.map((p) => p.citations ?? 0), 1)
  const seen = new Set<string>()
  const result: CuratedPaper[] = []
  const add = (paper: PaperRecord, qualifiedFirst: boolean) => {
    const key = paperKey(paper)
    if (seen.has(key) || result.length >= topN) return
    const s = score(paper, maxAgeYears, maxCitations)
    if (!qualifiedFirst && s.source === 'qualified') return
    seen.add(key)
    result.push({ ...paper, ...s })
  }
  const qualified = records.filter((p) => recency(p, maxAgeYears) > 0).sort((a, b) => score(b, maxAgeYears, maxCitations).score - score(a, maxAgeYears, maxCitations).score)
  const rest = [...records].sort((a, b) => score(b, maxAgeYears, maxCitations).score - score(a, maxAgeYears, maxCitations).score)
  for (const p of qualified) add(p, true)
  for (const p of rest) add(p, false)
  return result
}

function renderMarkdown(papers: readonly CuratedPaper[]): string {
  const rows = papers.map((p, i) => `| ${i + 1} | ${p.title} | ${p.year ?? '-'} | ${p.venue ?? '-'} | ${p.citations ?? '-'} | ${p.score.toFixed(3)} | ${p.source} | ${p.reason} |`)
  return ['# Curated Papers', '', '| # | title | year | venue | citations | score | source | why |', '|---|---|---|---|---|---|---|---|', ...rows].join('\n') + '\n'
}

export async function writeCuratedPapers(runDir: string, papers: CuratedPaper[], options: CuratedPaperOptions = {}): Promise<void> {
  const json = safeResolve(runDir, 'brainstorm', 'curated_papers.json')
  const markdown = safeResolve(runDir, 'brainstorm', 'curated_papers.md')
  await atomicWriteJson(json, { schema: 'autoresearch/curated-papers/v1', generatedAt: nowIso(), topN: options.topN ?? 20, papers })
  await writeText(markdown, renderMarkdown(papers))
}
