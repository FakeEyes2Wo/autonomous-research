import {
  appendHumanReview,
  DEFAULT_REVIEW_GATES,
  type HumanReviewAnswer,
  type ReviewGateId,
} from '../core/human-review.js'
import { humanReviewEnabled } from '../session/auto-mode.js'
import type { RunContext } from './context.js'

export interface ReviewGateRequest {
  gate: ReviewGateId
  title: string
  detail: string
}

/**
 * The single human-review execution path used by research orchestration.
 * Skip conditions, reviewer calls, persistence, and ask-failure downgrade all
 * live here so feature modules cannot duplicate them.
 */
export async function reviewGate(
  ctx: RunContext,
  request: ReviewGateRequest,
): Promise<HumanReviewAnswer> {
  const { gate, title, detail } = request
  const runDir = ctx.runDir
  const skipped: HumanReviewAnswer = { verdict: 'approve' }
  const skip = async (reason: string) => {
    ctx.logger.warn(`human review gate ${gate} skipped: ${reason}`)
    await appendHumanReview(runDir, {
      time: new Date().toISOString(),
      gate,
      verdict: 'skipped',
      feedback: reason,
    })
    return skipped
  }

  if (!(ctx.deps.reviewGates ?? DEFAULT_REVIEW_GATES).includes(gate)) {
    return skip('gate disabled')
  }
  if (!(await humanReviewEnabled(ctx.deps.humanReviewOverride))) {
    return skip('auto mode')
  }
  if (!ctx.deps.reviewer) {
    return skip('no reviewer available')
  }

  try {
    const answer = await ctx.deps.reviewer.ask(
      { gate, title, detail },
      ctx.context.signal,
      ctx.context.parent,
    )
    await appendHumanReview(runDir, {
      time: new Date().toISOString(),
      gate,
      verdict: answer.verdict,
      feedback: answer.feedback,
    })
    return answer
  } catch (error) {
    return skip(`ask failed: ${String(error)}`)
  }
}
