import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir, nowIso } from './utils.js'

export type ReviewGateId = 'idea' | 'rubric' | 'experiment' | 'evidence' | 'paper_draft'
export type ReviewVerdict = 'approve' | 'revise' | 'reject'

export interface HumanReviewRequest {
  gate: ReviewGateId
  title: string
  detail: string
}

export interface HumanReviewAnswer {
  verdict: ReviewVerdict
  feedback?: string
}

export interface HumanReviewer {
  ask(request: HumanReviewRequest, signal: AbortSignal, agent?: unknown): Promise<HumanReviewAnswer>
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

export const DEFAULT_REVIEW_GATES: readonly ReviewGateId[] = ['idea', 'rubric', 'experiment', 'evidence', 'paper_draft']
