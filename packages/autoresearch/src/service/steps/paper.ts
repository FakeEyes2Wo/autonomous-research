import { AutoResearchError, type Logger } from '../../core/utils.js'
import { saveState } from '../../core/state.js'
import { DEFAULT_REVIEW_GATES } from '../../core/human-review.js'
import { writeFailureReport } from '../../domain/files.js'
import { exportEvidenceChain } from '../../export/evidence-chain.js'
import { PaperPipeline } from '../../paper/pipeline.js'
import type { RunSession } from '../run-session.js'
import type { ResearchRunnerOptions } from '../types.js'

export class PaperSteps {
  constructor(
    private readonly logger: Logger,
    private readonly options: ResearchRunnerOptions,
  ) {}

  async runPaper(session: RunSession): Promise<void> {
    if (session.tree.query({ kind: 'evidence' }).length === 0) {
      await writeFailureReport(session.runDir, '# FAILURE_REPORT\n\nNo evidence recorded; cannot write a paper.\n')
      throw new AutoResearchError('no evidence recorded before paper generation', 'AGENT_FAILED')
    }
    const evidencePath = await exportEvidenceChain(session.runDir, session.state.runId, session.tree)
    session.state.evidencePath = evidencePath
    await saveState(session.runDir, session.state)

    const pipeline = new PaperPipeline(this.options.provider, {
      ...(this.options.paperOptions ?? {}),
      ...((this.options.reviewGates ?? DEFAULT_REVIEW_GATES).includes('paper_draft') && this.options.reviewer ? { humanReviewer: this.options.reviewer } : {}),
      ...(this.options.humanReviewOverride ? { humanReviewOverride: this.options.humanReviewOverride } : {}),
    })
    const result = await pipeline.run(session.runDir, session.tree, evidencePath, session.context)
    this.logger.info(`paper pipeline done plan=${result.planFile} compileOk=${result.compileOk} audits=${Object.keys(result.audits).length}`)
  }
}
