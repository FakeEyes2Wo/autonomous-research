import { readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActionResult, ResearchDecision } from '../core/types.js'
import { atomicWriteJson, readOptionalText, safeResolve, writeText } from '../core/utils.js'
import { ResearchStore, sealRecord, hashContent, assessEvidence, createRevision } from '../research/index.js'
import type { Claim, Hypothesis, Protocol, Evidence, ResearchSnapshot, RevisionCandidate } from '../research/contracts.js'
import { ExperimentPauseError } from '../experiment/errors.js'
import type { RunContext } from './context.js'
import { validateScientificEvidence } from '../experiment/evidence-validator.js'
import { recordResearchExperience } from '../memory/index.js'

export const cyclePath = (ctx: RunContext, name: string) => safeResolve(ctx.runDir, 'cycles', `cycle-${ctx.state.cycle}`, name)
const unknownFingerprints = { code: 'unknown', data: 'unknown', treatment: 'unknown', model: 'unknown' }
const stamp = (id: string, version = 1) => ({ id, version, created_at: new Date().toISOString(), source_refs: [] })
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

export async function captureResearchPlan(ctx: RunContext, structured: unknown): Promise<void> {
  await atomicWriteJson(cyclePath(ctx, 'planner-output.json'), record(structured))
}

/** The controller commits the exact scientific contract before any worker can run. */
export async function freezeResearchCycle(ctx: RunContext, planText: string, design: string): Promise<ResearchSnapshot> {
  const store = new ResearchStore(ctx.runDir)
  const saved = await readOptionalText(cyclePath(ctx, 'frozen.json'))
  if (saved) return store.loadSnapshot((JSON.parse(saved) as { snapshotId: string }).snapshotId)
  const orphan = await readOptionalText(safeResolve(ctx.runDir, 'research', 'snapshots', `cycle-${ctx.state.cycle}-frozen`, 'manifest.json'))
  if (orphan) {
    const recovered = await store.commit(await store.loadSnapshot(`cycle-${ctx.state.cycle}-frozen`))
    await atomicWriteJson(cyclePath(ctx, 'protocol.json'), recovered.protocol)
    await atomicWriteJson(cyclePath(ctx, 'frozen.json'), { snapshotId: recovered.id })
    return recovered
  }
  const parent = await store.loadCurrent()
  const planner = record(JSON.parse((await readOptionalText(cyclePath(ctx, 'planner-output.json'))) ?? '{}'))
  const spec = record(planner.protocol)
  const idea = (await readOptionalText(join(ctx.runDir, 'input', 'idea.md'))) ?? planText
  const claim: Claim = parent?.claims.find(c => c.id === parent.active_claim.id && c.version === parent.active_claim.version) ?? sealRecord({
    ...stamp('claim-1'), statement: idea, scope: 'user goal and PROFILE', parents: [], supporting_evidence_ids: [], opposing_evidence_ids: [], status: 'proposed', reason: 'No validated evidence yet.',
  } as Omit<Claim, 'content_hash'>)
  const h = record(planner.hypothesis)
  const hypothesis: Hypothesis = parent?.hypotheses.find(item => item.id === parent.active_hypothesis.id && item.version === parent.active_hypothesis.version) ?? sealRecord({
    ...stamp('hypothesis-1'), statement: typeof h.statement === 'string' ? h.statement : idea,
    claim: { id: claim.id, version: claim.version }, parents: [], mechanism: String(h.mechanism ?? 'unknown'), alternatives: [],
    prediction: String(h.prediction ?? 'unknown'), falsification: String(h.falsification ?? 'unknown'), measurement: String(h.measurement ?? 'unknown'),
    decision_rule: String(spec.decision_rule ?? 'unknown'), scope: claim.scope, mode: 'unknown', status: 'proposed', discovery_source_ids: [],
  } as Omit<Hypothesis, 'content_hash'>)
  const fingerprints = record(spec.fingerprints)
  const known = ['code', 'data', 'treatment', 'model'].every(key => typeof fingerprints[key] === 'string' && fingerprints[key] !== 'unknown') &&
    typeof spec.decision_rule === 'string' && typeof spec.split === 'string' && typeof spec.stopping_rule === 'string' && Array.isArray(spec.controls)
  const protocol: Protocol = sealRecord({
    ...stamp(`protocol-${ctx.state.cycle}`), hypothesis: { id: hypothesis.id, version: hypothesis.version },
    metric: String(spec.metric ?? 'unknown'), controls: Array.isArray(spec.controls) ? spec.controls.map(String) : [], sample: String(spec.sample ?? 'unknown'),
    split: String(spec.split ?? 'unknown'), seeds: Array.isArray(spec.seeds) ? spec.seeds.filter((v): v is number => Number.isSafeInteger(v)) : [],
    budget: { unit: String(record(spec.budget).unit ?? 'unknown'), limit: Number(record(spec.budget).limit ?? 0), tolerance: Number(record(spec.budget).tolerance ?? 0) },
    stopping_rule: String(spec.stopping_rule ?? 'unknown'), failure_policy: spec.failure_policy === 'include_as_outcome' ? 'include_as_outcome' : 'exclude_from_mechanism',
    missing_policy: String(spec.missing_policy ?? 'unknown'), duplicate_policy: 'block_conflicts',
    fingerprints: known ? fingerprints as unknown as Protocol['fingerprints'] : { ...unknownFingerprints }, provenance: known ? 'known' : 'unknown',
    decision_rule: String(spec.decision_rule ?? 'unknown'),
    source_refs: [await store.captureBytes(JSON.stringify({ planText, design }), `execution-plan-${ctx.state.cycle}`)],
  })
  const snapshot = sealRecord({
    ...stamp(`cycle-${ctx.state.cycle}-frozen`, (parent?.version ?? 0) + 1), schema: 'autoresearch/research-snapshot/v1' as const,
    branch_id: parent?.branch_id ?? ctx.state.runId, ...(parent ? { parent_snapshot_id: parent.id } : {}),
    active_claim: { id: claim.id, version: claim.version }, active_hypothesis: { id: hypothesis.id, version: hypothesis.version },
    claims: parent?.claims ?? [claim], hypotheses: parent?.hypotheses ?? [hypothesis], protocol, evidence: parent?.evidence ?? [], budget: parent?.budget ?? { revisions: 0, repairs: 0 },
  })
  const committed = await store.commit(snapshot)
  await atomicWriteJson(cyclePath(ctx, 'protocol.json'), protocol)
  await atomicWriteJson(cyclePath(ctx, 'frozen.json'), { snapshotId: committed.id })
  return committed
}

export async function readResearchAttempt(ctx: RunContext): Promise<{ status: string; result?: ActionResult } | undefined> {
  const text = await readOptionalText(cyclePath(ctx, 'attempt.json'))
  return text ? JSON.parse(text) : undefined
}

export async function registerResearchAttempt(ctx: RunContext, status: string, result?: ActionResult): Promise<void> {
  if (status === 'unknown') {
    try {
      const handle = await open(cyclePath(ctx, 'attempt.json'), 'wx')
      try { await handle.writeFile(JSON.stringify({ status, attemptId: `attempt-${ctx.state.cycle}` })) } finally { await handle.close() }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExperimentPauseError('worker receipt already exists; unknown or failed attempts require explicit recovery before redispatch')
      throw error
    }
  }
  await atomicWriteJson(cyclePath(ctx, 'attempt.json'), { status, attemptId: `attempt-${ctx.state.cycle}`, ...(result ? { result } : {}) })
}

export async function assessResearchCycle(ctx: RunContext, action: ActionResult, error?: string, executionUnknown = false): Promise<ResearchSnapshot> {
  const store = new ResearchStore(ctx.runDir)
  const saved = await readOptionalText(cyclePath(ctx, 'assessed.json'))
  if (saved) {
    const snapshot = await store.loadSnapshot(JSON.parse(saved).snapshotId)
    await writeResearchReport(ctx, snapshot)
    return snapshot
  }
  const orphan = await readOptionalText(safeResolve(ctx.runDir, 'research', 'snapshots', `cycle-${ctx.state.cycle}-assessment`, 'manifest.json'))
  if (orphan) {
    const recovered = await store.commit(await store.loadSnapshot(`cycle-${ctx.state.cycle}-assessment`))
    await atomicWriteJson(cyclePath(ctx, 'assessment.json'), recovered.assessment)
    await atomicWriteJson(cyclePath(ctx, 'assessed.json'), { snapshotId: recovered.id })
    await writeResearchReport(ctx, recovered)
    return recovered
  }
  const frozen = await freezeResearchCycle(ctx, '', '')
  const artifacts = []
  for (const path of action.artifacts) artifacts.push(await store.captureSource(path))
  let raw: unknown
  if (artifacts.length === 1 && artifacts[0]!.path) {
    // Validate the captured bytes: producers may still change their live output.
    try { raw = JSON.parse(await readFile(safeResolve(ctx.runDir, artifacts[0]!.path!), 'utf8')) } catch { raw = undefined }
  }
  const validated = validateScientificEvidence(raw, frozen.protocol, frozen)
  if (error) {
    validated.validity = /artifact/i.test(error) ? 'invalid' : 'unknown'
    validated.polarity = 'inconclusive'
    validated.validation = { method: frozen.protocol.decision_rule, passed: false, issues: [error] }
  }
  const analysis = await store.captureBytes(await readFile(new URL('../experiment/evidence-validator.js', import.meta.url)), 'validator:paired_sign_test_v1')
  const evidence: Evidence = sealRecord({
    ...stamp(`evidence-${ctx.state.cycle}`), target_claim: frozen.active_claim, protocol_hash: frozen.protocol.content_hash, attempt_id: `attempt-${ctx.state.cycle}`,
    artifacts, analysis, ...validated, execution: executionUnknown ? 'unknown' : error || action.status === 'failed' ? 'error' : 'completed', observation: error ?? validated.observation,
    split: frozen.protocol.split, mode: frozen.protocol.provenance === 'known' ? 'formal' : 'unknown', fingerprints: frozen.protocol.fingerprints, source_refs: artifacts,
  })
  const claim = frozen.claims.find(c => c.id === frozen.active_claim.id && c.version === frozen.active_claim.version)!
  const hypothesis = frozen.hypotheses.find(h => h.id === frozen.active_hypothesis.id && h.version === frozen.active_hypothesis.version)!
  const allEvidence = [...frozen.evidence, evidence]
  // Historical protocol versions stay in the snapshot but do not masquerade as rows from this frozen batch.
  const assessment = assessEvidence({ claim, hypothesis, protocol: frozen.protocol, evidence: allEvidence.filter(e => e.protocol_hash === frozen.protocol.content_hash), discoveryEvidence: allEvidence, repairAttempts: frozen.budget.repairs, maxRepairAttempts: 2 })
  const updatedClaim = sealRecord({ ...claim, version: claim.version + 1, status: assessment.claim_status,
    parents: [{ id: claim.id, version: claim.version }],
    supporting_evidence_ids: assessment.supporting_evidence_ids, opposing_evidence_ids: assessment.opposing_evidence_ids, reason: assessment.reason })
  const ledger = await ctx.context.requestLedger?.snapshot()
  const actualCost = record(raw).cost
  const snapshot = sealRecord({ ...frozen, id: `cycle-${ctx.state.cycle}-assessment`, version: frozen.version + 1, parent_snapshot_id: frozen.id,
    budget: { ...frozen.budget, role_tokens: ledger?.totals.committedTokens ?? frozen.budget.role_tokens ?? 0,
      role_calls: ledger?.totals.roleStarts ?? frozen.budget.role_calls ?? 0,
      experiment_units: (frozen.budget.experiment_units ?? 0) + (typeof actualCost === 'number' && Number.isFinite(actualCost) && actualCost >= 0 ? actualCost : 0) },
    claims: [...frozen.claims, updatedClaim], active_claim: { id: updatedClaim.id, version: updatedClaim.version }, evidence: allEvidence, assessment })
  const committed = await store.commit(snapshot)
  await atomicWriteJson(cyclePath(ctx, 'assessment.json'), assessment)
  await atomicWriteJson(cyclePath(ctx, 'assessed.json'), { snapshotId: committed.id })
  await writeResearchReport(ctx, committed)
  return committed
}

export async function writeResearchReport(ctx: RunContext, snapshot: ResearchSnapshot): Promise<void> {
  const identity = (r: { id: string; version: number; content_hash: string }) => ({ id: r.id, version: r.version, contentHash: r.content_hash })
  await recordResearchExperience(ctx.runDir, {
    scope: { projectId: ctx.projectDir, branchId: snapshot.branch_id, runId: ctx.state.runId }, createdAt: snapshot.created_at,
    snapshot: identity(snapshot), protocolHash: snapshot.assessment?.protocol_hash ?? snapshot.protocol.content_hash,
    evidence: snapshot.decision ? [] : snapshot.evidence.filter(e => e.protocol_hash === snapshot.protocol.content_hash).map(e => ({ ...identity(e),
      observation: e.observation, interpretation: e.interpretation, polarity: e.polarity, validity: e.validity, mode: e.mode, split: e.split })),
    ...(snapshot.decision ? { decision: { ...identity(snapshot.decision), action: snapshot.decision.action, reason: snapshot.decision.reason },
      ...(snapshot.assessment ? { assessmentDependency: identity(snapshot.assessment) } : {}) } :
      snapshot.assessment ? { assessment: { ...identity(snapshot.assessment), reason: snapshot.assessment.reason } } : {}),
  })
  const text = [ '# Research evidence report', '', `snapshot_id: ${snapshot.id}`, `snapshot_hash: ${snapshot.content_hash}`,
    `protocol_hash: ${snapshot.assessment?.protocol_hash ?? snapshot.protocol.content_hash}`, `next_protocol_hash: ${snapshot.protocol.content_hash}`, `assessed claim status: ${snapshot.assessment?.claim_status ?? 'proposed'}`,
    `category: ${snapshot.assessment?.category ?? 'unknown'}`, `decision: ${snapshot.decision?.action ?? 'pending'}`,
    `decision_reason: ${snapshot.decision?.reason ?? 'pending'}`,
    `reason: ${snapshot.assessment?.reason ?? 'unknown'}`, '', '## Observations / interpretations / unverified',
    ...snapshot.evidence.map(e => `- ${e.id}: ${e.observation}; validity=${e.validity}; mode=${e.mode}; sources=${e.artifacts.map(a => `${a.path}#${a.hash}`).join(', ')}`),
    '', 'Legacy prose and unvalidated observations do not establish formal scientific support. Isolation and blinded evaluation are unverified unless an executor capability proves them.', '',
  ].join('\n')
  await writeText(cyclePath(ctx, 'REPORT.md'), text)
  await writeText(join(ctx.runDir, 'RESEARCH_REPORT.md'), text)
  ctx.state.evidencePath = join(ctx.runDir, 'RESEARCH_REPORT.md')
}

export async function committedDecision(ctx: RunContext): Promise<ResearchDecision | undefined> {
  const current = await new ResearchStore(ctx.runDir).loadCurrent()
  if (current?.decision?.id !== `decision-${ctx.state.cycle}`) return undefined
  return materializeCommittedDecision(ctx, current)
}

/** CURRENT is authoritative; this checkpoint is only a rebuildable runtime view. */
async function materializeCommittedDecision(ctx: RunContext, snapshot: ResearchSnapshot): Promise<ResearchDecision> {
  const decision = snapshot.decision!
  const action = decision.action === 'pause' ? 'pause' : decision.action === 'finish' ? 'finish' : decision.action === 'replicate' ? 'continue' : 'revise'
  await writeResearchReport(ctx, snapshot)
  await atomicWriteJson(cyclePath(ctx, 'runtime-decision.json'), { action, reason: decision.reason, snapshotId: snapshot.id, snapshotHash: snapshot.content_hash })
  if (action === 'pause') throw new ExperimentPauseError(decision.reason)
  return { action, reason: decision.reason }
}

export async function commitResearchDecision(ctx: RunContext, output: unknown, legacy: ResearchDecision, expectedSnapshot?: { id: string; hash: string }): Promise<ResearchDecision> {
  if (ctx.context.signal.aborted) throw new ExperimentPauseError('research cancelled before scientific revision')
  const store = new ResearchStore(ctx.runDir)
  const parent = await store.loadCurrent()
  if (expectedSnapshot && (parent?.id !== expectedSnapshot.id || parent.content_hash !== expectedSnapshot.hash)) throw new ExperimentPauseError('research snapshot changed after supervisor input; reassessment is required')
  if (!parent?.assessment) return legacy
  const raw = record(output)
  const candidates = Array.isArray(raw.candidates) ? raw.candidates.slice(0, 3) as RevisionCandidate[] : []
  const oldHypothesis = parent.hypotheses.find(h => h.id === parent.active_hypothesis.id && h.version === parent.active_hypothesis.version)!
  const candidate = ['invalid_measurement', 'execution_error'].includes(parent.assessment.category) ? undefined : candidates.find(c => c &&
    ['statement', 'scope', 'mechanism', 'prediction', 'falsification', 'measurement', 'decision_rule', 'rationale'].every(key => typeof record(c)[key] === 'string' && String(record(c)[key]).trim()) &&
    c.statement.trim() !== oldHypothesis.statement.trim() && c.prediction.trim() !== oldHypothesis.prediction.trim() &&
    Array.isArray(c.alternatives) && c.alternatives.every(v => typeof v === 'string') && Array.isArray(c.evidence_ids) && c.evidence_ids.length > 0 &&
    c.evidence_ids.every(id => parent.assessment!.admissible_evidence_ids.includes(id)))
  const strict = parent.protocol.provenance === 'known'
  const taskFinished = legacy.action === 'finish' && (!strict || parent.assessment.category === 'supported')
  const ledger = await ctx.context.requestLedger?.snapshot()
  const atLimit = !taskFinished && (ctx.state.cycle >= (ctx.deps.maxCycles ?? 10) || (ledger !== undefined && (ledger.remainingRoleCalls === 0 || ledger.remainingTokens === 0)))
  const limitReason = `budget_exhausted: maxCycles/maxRounds or global role/token limit reached; ${parent.assessment.reason}`
  const nextProtocol = candidate ? sealRecord({ ...parent.protocol, id: `pending-protocol-${ctx.state.cycle + 1}`, version: 1,
    hypothesis: { id: parent.active_hypothesis.id, version: Math.max(...parent.hypotheses.filter(h => h.id === parent.active_hypothesis.id).map(h => h.version)) + 1 },
    provenance: 'unknown' as const, fingerprints: { ...unknownFingerprints }, split: 'requires fresh validation data',
  }) : undefined
  const revised = createRevision({ decisionId: `decision-${ctx.state.cycle}`, parentSnapshot: parent, assessment: parent.assessment,
    ...(candidate && !atLimit && !taskFinished ? { candidate, nextProtocol } : {}), reason: atLimit ? limitReason : strict && !taskFinished ? parent.assessment.reason : legacy.reason, maxRevisions: ctx.deps.maxCycles ?? 10 })
  const shouldPause = atLimit || (legacy.action === 'fail' && (!strict || !candidate))
  const finalSnapshot = shouldPause ? sealRecord({ ...revised, decision: sealRecord({ ...revised.decision!, action: 'pause' as const }) }) : taskFinished
    ? sealRecord({ ...revised, decision: sealRecord({ ...revised.decision!, action: 'finish' as const }) }) : revised
  const committed = await store.commit(finalSnapshot)
  if (candidate && committed.decision?.candidate) {
    await writeText(join(ctx.runDir, 'RESEARCH_NEXT_PLAN.md'), JSON.stringify({ hypothesis: committed.decision.candidate, evidence_snapshot: parent.id, constraints: 'New hypothesis is exploratory; use fresh validation data and a newly frozen protocol.' }, null, 2))
  } else if (strict && parent.assessment.next_action === 'repair') {
    await writeText(join(ctx.runDir, 'RESEARCH_NEXT_PLAN.md'), `Repair measurement/execution before further science: ${parent.assessment.reason}`)
  }
  return materializeCommittedDecision(ctx, committed)
}

export async function researchPlanInput(ctx: RunContext, idea: string): Promise<string> {
  const current = await new ResearchStore(ctx.runDir).loadCurrent()
  const next = current?.decision?.candidate ? JSON.stringify({ hypothesis: current.decision.candidate, evidence_snapshot: current.decision.parent_snapshot_id,
    constraints: 'Exploratory hypothesis; validate on fresh data under a newly frozen protocol.' }) :
    current?.decision?.action === 'repair' ? `Repair the measurement/execution: ${current.decision.reason}` : undefined
  const imported = await readOptionalText(join(ctx.runDir, 'research', 'imported-failure.json'))
  return [idea, next ? `## Committed next research action\n${next}` : '', imported ? `## Recover and verify imported failure sources\n${imported}\nThis is unknown historical provenance, not formal evidence or an established refutation.` : ''].filter(Boolean).join('\n\n')
}
