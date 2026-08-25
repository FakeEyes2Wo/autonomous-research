import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir, nowIso } from './utils.js'

export const REVIEW_GATES = ['idea', 'rubric', 'experiment', 'evidence', 'paper_draft'] as const
export type ReviewGateId = typeof REVIEW_GATES[number]

export const REVIEW_VERDICTS = ['approve', 'revise', 'reject'] as const
export type ReviewVerdict = typeof REVIEW_VERDICTS[number]

export interface HumanReviewRequest {
  gate: ReviewGateId
  title: string
  detail: string
}

export interface HumanReviewAnswer {
  verdict: ReviewVerdict
  feedback?: string
}

export interface HumanOpenRequest {
  title: string
  detail: string
}

export interface HumanReviewer {
  ask(request: HumanReviewRequest, signal: AbortSignal, agent?: unknown): Promise<HumanReviewAnswer>
  askOpen?(request: HumanOpenRequest, signal: AbortSignal, agent?: unknown): Promise<string | undefined>
}

export interface HumanReviewRecord {
  time: string
  gate: ReviewGateId
  verdict: ReviewVerdict | 'skipped'
  feedback?: string
}

export const HUMAN_REVIEW_FILE = 'HUMAN_REVIEW.md'

export async function appendHumanReview(runDir: string, record: HumanReviewRecord): Promise<void> {
  const file = join(runDir, HUMAN_REVIEW_FILE)
  await ensureDir(runDir)
  const feedback = record.feedback?.trim()
  const block = [
    `## ${record.gate} — ${record.verdict} — ${record.time}`,
    '',
    ...(feedback ? [`${feedback}`, ''] : []),
  ].join('\n')
  await appendFile(file, `${block}\n`, 'utf8')
}

export const DEFAULT_REVIEW_GATES: readonly ReviewGateId[] = [...REVIEW_GATES]
