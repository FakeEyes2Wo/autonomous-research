import { join } from 'node:path'
import { readOptionalText } from '../core/utils.js'
import { ResearchStore } from '../research/index.js'
import { sealContextRecord } from '../research-context/index.js'
import type { ResearchContextRequest } from '../research-context/index.js'
import type { RoleName, RoleInput, RoleExecutionContext, RoleAgentProvider } from '../agents/types.js'
import type { RunContext } from './context.js'
import { retrieveLiteratureContext } from '../literature/context-adapter.js'
import { loadClaimAssessments, assessmentEvidenceHash } from '../literature/claim-assessment.js'
import { ContextInsufficientError } from '../research-context/index.js'

/** Only committed records enter scientific context; actor work receives the frozen contract. */
export async function researchContextForRole(ctx: RunContext, role: RoleName, input?: RoleInput): Promise<ResearchContextRequest | undefined> {
  return researchContextForInput(role, input ?? { runDir: ctx.runDir }, { ...ctx.context, runId: ctx.state.runId })
}

export async function researchContextForInput(role: RoleName, input: RoleInput, context: Pick<RoleExecutionContext, 'projectDir' | 'runId' | 'policySnapshot'>): Promise<ResearchContextRequest | undefined> {
  const snapshot = await new ResearchStore(input.runDir).loadCurrent()
  const projectDir = context.projectDir ?? input.projectDir ?? input.runDir
  const runId = context.runId ?? input.runDir
  const constraints = await Promise.all(['input/idea.md', 'PROFILE.md', 'RUBRIC.md'].map(path => readOptionalText(join(input.runDir, path))))
  const assessments = role === 'research-worker' ? [] : (await loadClaimAssessments(input.runDir)).filter(a => a.claimId === snapshot?.active_claim.id && a.locatorValid && a.assessor !== 'unreviewed')
  // Historical opposition remains mandatory even when its claim binding is stale.
  // Downgrade only the contextual relation below; never erase the registered review.
  const opposed = assessments.some(a => a.relation === 'refutes' || a.relation === 'mixed')
  const requiredSpanIds = assessments.filter(a => a.relation === 'refutes' || a.relation === 'mixed' || (opposed && a.relation === 'supports')).flatMap(a => a.spanIds)
  const claim = snapshot?.claims.find(c => c.id === snapshot.active_claim.id && c.version === snapshot.active_claim.version)
  const literature = await retrieveLiteratureContext({ projectDir, runDir: input.runDir, runId, role, stage: role,
    settings: context.policySnapshot?.literature, branchId: snapshot?.branch_id, split: snapshot?.protocol.split,
    query: [claim?.statement, input.idea, constraints[0], input.plan].filter(Boolean).join('\n') || 'research',
    requiredSpanIds, reviewSpanIds: assessments.flatMap(a => a.spanIds), allowedSpanIds: snapshot?.protocol.allowed_literature_span_ids })
  if (!snapshot && !literature) return undefined
  const scope = { projectId: projectDir, branchId: snapshot?.branch_id ?? 'pre-snapshot', runId }
  const visibility = { ...scope, visibility: 'run' as const }
  const records = [
    sealContextRecord({ id: 'constraints', version: 1, layer: 0, kind: 'constraint', scope: visibility, required: true,
      payload: { goal: constraints[0] ?? input.idea ?? '', profile: constraints[1] ?? input.profile ?? '', rubric: constraints[2] ?? '', budget: context.policySnapshot?.budget }, source: { recordType: 'constraints' } }),
  ]
  if (snapshot) records.push(
    sealContextRecord({ id: snapshot.protocol.id, version: snapshot.protocol.version, layer: 0, kind: 'constraint', scope: visibility, required: true,
      payload: snapshot.protocol, source: { recordType: 'protocol', path: 'CURRENT.json' } }),
    sealContextRecord({ id: snapshot.id, version: snapshot.version, layer: 1, kind: 'state', scope: visibility, required: true,
      payload: { snapshot_id: snapshot.id, snapshot_hash: snapshot.content_hash, active_claim: snapshot.active_claim, active_hypothesis: snapshot.active_hypothesis,
        hypothesis: snapshot.hypotheses.find(h => h.id === snapshot.active_hypothesis.id && h.version === snapshot.active_hypothesis.version),
        ...(role === 'research-worker' ? {} : { budget: snapshot.budget, assessment: snapshot.assessment, decision: snapshot.decision }) }, source: { recordType: 'snapshot', path: 'CURRENT.json' } }),
  )
  // No historical evidence, heldout answers or treatment-specific memory is sent to an actor.
  if (snapshot && role !== 'research-worker') for (const evidence of snapshot.evidence) records.push(sealContextRecord({
    id: evidence.id, version: evidence.version, layer: 2, kind: 'evidence', scope: visibility,
    payload: evidence, required: evidence.polarity === 'opposes' || evidence.validity === 'invalid',
    polarity: evidence.polarity === 'opposes' ? 'opposing' : evidence.polarity === 'supports' ? 'supporting' : 'neutral',
    topicIds: [evidence.target_claim.id, evidence.protocol_hash], source: { recordType: 'evidence' },
  }))
  if (literature) {
    for (const assessment of assessments.filter(a => a.spanIds.every(id => literature.requiredRecordIds?.includes(id)))) {
      if (assessmentEvidenceHash(literature.literature!.spans.filter(span => assessment.spanIds.includes(span.id))) !== assessment.evidenceHash) throw new ContextInsufficientError(`registered assessment evidence changed: ${assessment.claimId}: ${assessment.spanIds.join(', ')}`)
    }
    records.push(...literature.records.map(({ contentHash: _hash, ...record }) => {
      const payload = record.payload as Record<string, unknown>
      const semantic = assessments.filter(a => a.spanIds.includes(record.id)).map(a => {
        const claimMatches = a.claimBinding && claim && a.claimBinding.version === claim.version && a.claimBinding.contentHash === claim.content_hash
        const requiresReview = !claimMatches || payload.reviewStatus === 're_review_required'
        return { ...a, ...(requiresReview ? { originalRelation: a.relation, relation: 'unknown', reviewStatus: 're_review_required' } : {}) }
      })
      return sealContextRecord({ ...record, scope: visibility, payload: { ...payload, claimAssessments: semantic } })
    }))
  }
  return { stage: role, scope, ...(snapshot ? { snapshot: { id: snapshot.id, contentHash: snapshot.content_hash }, protocolHash: snapshot.protocol.content_hash } : {}),
    queryTerms: snapshot ? [snapshot.active_claim.id, snapshot.active_hypothesis.id, snapshot.protocol.content_hash] : literature?.queryTerms,
    requiredRecordIds: literature?.requiredRecordIds, ...(literature?.literature ? { literature: literature.literature } : {}), records }
}

/** Brainstorm and paper callers share the same pre-snapshot grounding path. */
export function withResearchContextProvider(provider: RoleAgentProvider): RoleAgentProvider {
  return { run: async (role, input, context) => provider.run(role, { ...input,
    researchContext: input.researchContext ?? await researchContextForInput(role, input, context) }, context) }
}
