import { AutoResearchError } from '../../core/utils.js'
import { saveState } from '../../core/state.js'
import { DEFAULT_REVIEW_GATES } from '../../core/human-review.js'
import { writeFailureReport } from '../../domain/files.js'
import { exportEvidenceChain } from '../../export/evidence-chain.js'
import { PaperPipeline } from '../../paper/pipeline.js'
import type { RunContext } from '../context.js'

export async function runPaper(ctx: RunContext): Promise<void> {
  if (ctx.tree.query({ kind: 'evidence' }).length === 0) {
    await writeFailureReport(ctx.runDir, '# FAILURE_REPORT\n\nNo evidence recorded; cannot write a paper.\n')
    throw new AutoResearchError('no evidence recorded before paper generation', 'AGENT_FAILED')
  }
  const evidencePath = await exportEvidenceChain(ctx.runDir, ctx.state.runId, ctx.tree)
  ctx.state.evidencePath = evidencePath
  await saveState(ctx.runDir, ctx.state)

  const pipeline = new PaperPipeline(ctx.deps.provider, {
    ...(ctx.deps.paperOptions ?? {}),
    ...((ctx.deps.reviewGates ?? DEFAULT_REVIEW_GATES).includes('paper_draft') && ctx.deps.reviewer ? { humanReviewer: ctx.deps.reviewer } : {}),
    ...(ctx.deps.humanReviewOverride ? { humanReviewOverride: ctx.deps.humanReviewOverride } : {}),
  })
  const result = await pipeline.run(ctx.runDir, ctx.tree, evidencePath, ctx.context)
  ctx.logger.info(`paper pipeline done plan=${result.planFile} compileOk=${result.compileOk} audits=${Object.keys(result.audits).length}`)
}
