import { join } from 'node:path'
import { readOptionalText } from '../core/utils.js'
import { ResearchStore } from '../research/index.js'
import { sealContextRecord } from '../research-context/index.js'
import type { ResearchContextRequest } from '../research-context/index.js'
import type { RoleName } from '../agents/types.js'
import type { RunContext } from './context.js'

/** Only committed records enter scientific context; actor work receives the frozen contract. */
export async function researchContextForRole(ctx: RunContext, role: RoleName): Promise<ResearchContextRequest | undefined> {
  const snapshot = await new ResearchStore(ctx.runDir).loadCurrent()
  if (!snapshot) return undefined
  const scope = { projectId: ctx.projectDir, branchId: snapshot.branch_id, runId: ctx.state.runId }
  const visibility = { ...scope, visibility: 'run' as const }
  const constraints = await Promise.all(['input/idea.md', 'PROFILE.md', 'RUBRIC.md'].map(path => readOptionalText(join(ctx.runDir, path))))
  const records = [
    sealContextRecord({ id: 'constraints', version: 1, layer: 0, kind: 'constraint', scope: visibility, required: true,
      payload: { goal: constraints[0] ?? '', profile: constraints[1] ?? '', rubric: constraints[2] ?? '', budget: ctx.policySnapshot.budget }, source: { recordType: 'constraints' } }),
    sealContextRecord({ id: snapshot.protocol.id, version: snapshot.protocol.version, layer: 0, kind: 'constraint', scope: visibility, required: true,
      payload: snapshot.protocol, source: { recordType: 'protocol', path: 'CURRENT.json' } }),
    sealContextRecord({ id: snapshot.id, version: snapshot.version, layer: 1, kind: 'state', scope: visibility, required: true,
      payload: { snapshot_id: snapshot.id, snapshot_hash: snapshot.content_hash, active_claim: snapshot.active_claim, active_hypothesis: snapshot.active_hypothesis,
        hypothesis: snapshot.hypotheses.find(h => h.id === snapshot.active_hypothesis.id && h.version === snapshot.active_hypothesis.version),
        budget: snapshot.budget, assessment: snapshot.assessment, decision: snapshot.decision }, source: { recordType: 'snapshot', path: 'CURRENT.json' } }),
  ]
  // No historical evidence, heldout answers or treatment-specific memory is sent to an actor.
  if (role !== 'research-worker') for (const evidence of snapshot.evidence) records.push(sealContextRecord({
    id: evidence.id, version: evidence.version, layer: 2, kind: 'evidence', scope: visibility,
    payload: evidence, required: evidence.polarity === 'opposes' || evidence.validity === 'invalid',
    polarity: evidence.polarity === 'opposes' ? 'opposing' : evidence.polarity === 'supports' ? 'supporting' : 'neutral',
    topicIds: [evidence.target_claim.id, evidence.protocol_hash], source: { recordType: 'evidence' },
  }))
  return { stage: ctx.state.phase, scope, snapshot: { id: snapshot.id, contentHash: snapshot.content_hash }, protocolHash: snapshot.protocol.content_hash,
    queryTerms: [snapshot.active_claim.id, snapshot.active_hypothesis.id, snapshot.protocol.content_hash], records }
}
