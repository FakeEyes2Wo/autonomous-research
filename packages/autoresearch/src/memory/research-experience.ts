import type { ResearchContextScope } from '../research-context/types.js'
import { FileMemoryStore } from './store.js'
import type { MemoryRecord, MemoryRecordInput } from './types.js'

interface ResearchSourceIdentity {
  readonly id: string
  readonly version: number
  readonly contentHash: string
}

export interface ResearchExperienceEvidence extends ResearchSourceIdentity {
  readonly observation: string
  readonly interpretation?: string
  readonly polarity: 'supports' | 'opposes' | 'inconclusive'
  readonly validity: 'valid' | 'invalid' | 'unknown'
  readonly mode: 'formal' | 'exploratory' | 'unknown'
  readonly split: string
}

export interface ResearchExperienceInput {
  readonly scope: ResearchContextScope
  readonly createdAt: string
  readonly snapshot: ResearchSourceIdentity
  readonly protocolHash: string
  readonly evidence: readonly ResearchExperienceEvidence[]
  readonly assessment?: ResearchSourceIdentity & { readonly reason: string }
  readonly assessmentDependency?: ResearchSourceIdentity
  readonly decision?: ResearchSourceIdentity & { readonly action: string; readonly reason: string }
}

function runScope(input: ResearchExperienceInput) {
  return input.scope.runId
    ? { visibility: 'run' as const, projectId: input.scope.projectId, branchId: input.scope.branchId, runId: input.scope.runId }
    : { visibility: 'branch' as const, projectId: input.scope.projectId, branchId: input.scope.branchId }
}

function evidenceScope(input: ResearchExperienceInput, split: string) {
  return { visibility: 'split' as const, projectId: input.scope.projectId, branchId: input.scope.branchId, ...(input.scope.runId ? { runId: input.scope.runId } : {}), split }
}

function provenance(input: ResearchExperienceInput, sources: readonly ResearchSourceIdentity[]) {
  return {
    sourceIds: sources.map((source) => source.id),
    sourceHashes: Object.fromEntries(sources.map((source) => [source.id, source.contentHash])),
    protocolHash: input.protocolHash,
    snapshotId: input.snapshot.id,
    createdAt: input.createdAt,
    derivedFromIds: sources.map((source) => `${source.id}@${source.version}`),
  }
}

export async function recordResearchExperience(runDir: string, input: ResearchExperienceInput): Promise<readonly MemoryRecord[]> {
  const store = new FileMemoryStore(runDir)
  const written: MemoryRecord[] = []
  const append = async (record: MemoryRecordInput) => { written.push((await store.append(record)).record) }
  const observationRecords = new Map<string, MemoryRecord>()
  for (const evidence of input.evidence) {
    const observation = (await store.append({
      id: `observation:${evidence.id}`,
      version: evidence.version,
      kind: 'observation',
      scope: evidenceScope(input, evidence.split),
      content: { observation: evidence.observation },
      provenance: provenance(input, [evidence, input.snapshot]),
      applicability: { appliesWhen: [`protocol:${input.protocolHash}`, `split:${evidence.split}`], doesNotApplyWhen: ['different protocol or treatment'] },
      assessment: {
        status: evidence.validity === 'valid' && evidence.mode === 'formal' ? 'validated_in_scope' : 'candidate',
        method: evidence.validity === 'valid' && evidence.mode === 'formal' ? 'formal evidence validated in its protocol scope' : `${evidence.mode} evidence with ${evidence.validity} validity`,
        supportingSourceIds: evidence.validity === 'valid' && evidence.mode === 'formal' ? [evidence.id] : [],
        opposingSourceIds: evidence.validity === 'invalid' ? [evidence.id] : [],
      },
      dependencies: [],
      topicIds: [input.protocolHash],
      polarity: evidence.polarity === 'opposes' ? 'opposing' : evidence.polarity === 'supports' ? 'supporting' : 'neutral',
    })).record
    written.push(observation)
    observationRecords.set(evidence.id, observation)
    if (evidence.interpretation) await append({
      id: `interpretation:${evidence.id}`,
      version: evidence.version,
      kind: 'interpretation',
      scope: evidenceScope(input, evidence.split),
      content: { observation: evidence.observation, interpretation: evidence.interpretation },
      provenance: provenance(input, [evidence, input.snapshot]),
      applicability: { appliesWhen: [`protocol:${input.protocolHash}`, `split:${evidence.split}`], doesNotApplyWhen: ['different protocol, treatment, or target claim'] },
      assessment: { status: 'candidate', method: 'unvalidated interpretation extracted from evidence', supportingSourceIds: [], opposingSourceIds: [] },
      dependencies: [{ id: observation.id, version: observation.version, contentHash: observation.contentHash }],
      topicIds: [input.protocolHash],
      polarity: observation.polarity,
    })
  }
  let assessmentRecord: MemoryRecord | undefined
  if (input.assessment) {
    const observationText = input.evidence.map((evidence) => evidence.observation).join('\n') || 'assessment committed without an evidence observation'
    assessmentRecord = (await store.append({
      id: `assessment:${input.assessment.id}`,
      version: input.assessment.version,
      kind: 'interpretation',
      scope: runScope(input),
      content: { observation: observationText, interpretation: input.assessment.reason },
      provenance: provenance(input, [input.assessment, input.snapshot]),
      applicability: { appliesWhen: [`protocol:${input.protocolHash}`], doesNotApplyWhen: ['evidence or protocol dependency changed'] },
      assessment: { status: 'candidate', method: 'committed assessment awaiting independent validation', supportingSourceIds: [], opposingSourceIds: [] },
      dependencies: [...observationRecords.values()].map((record) => ({ id: record.id, version: record.version, contentHash: record.contentHash })),
      topicIds: [input.protocolHash],
      summary: true,
    })).record
    written.push(assessmentRecord)
  }
  const storedAssessment = input.assessmentDependency
    ? (await store.readAll()).filter((record) => record.id === `assessment:${input.assessmentDependency!.id}`).sort((left, right) => right.version - left.version)[0]
    : assessmentRecord
  if (input.assessmentDependency && (!storedAssessment || storedAssessment.provenance.sourceHashes[input.assessmentDependency.id] !== input.assessmentDependency.contentHash)) {
    throw new Error(`assessment memory dependency ${input.assessmentDependency.id}@${input.assessmentDependency.version} is unavailable or stale`)
  }
  if (input.decision) await append({
    id: `decision:${input.decision.id}`,
    version: input.decision.version,
    kind: 'decision',
    scope: runScope(input),
    content: { decision: input.decision.action, rationale: input.decision.reason },
    provenance: provenance(input, [input.decision, input.snapshot]),
    applicability: { appliesWhen: [`snapshot:${input.snapshot.id}`, `protocol:${input.protocolHash}`], doesNotApplyWhen: ['snapshot or protocol dependency changed'] },
    assessment: { status: 'validated_in_scope', method: 'decision exists in a committed research snapshot', supportingSourceIds: [input.decision.id], opposingSourceIds: [] },
    dependencies: storedAssessment ? [{ id: storedAssessment.id, version: storedAssessment.version, contentHash: storedAssessment.contentHash }] : [],
    topicIds: [input.protocolHash],
  })
  return written
}
