import { readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActionResult, ResearchDecision } from '../core/types.js'
import { atomicWriteJson, readOptionalText, safeResolve, writeText } from '../core/utils.js'
import { ResearchStore, sealRecord, hashContent, assessEvidence, createRevision } from '../research/index.js'
import type { Claim, Hypothesis, Protocol, Evidence, ResearchSnapshot, SourceRef } from '../research/contracts.js'
import { buildCandidateBatch } from '../research/candidate-batch.js'
import { ExperimentPauseError } from '../experiment/errors.js'
import type { RunContext } from './context.js'
import { validateScientificEvidence } from '../experiment/evidence-validator.js'
import { recordResearchExperience } from '../memory/index.js'
import { selectionHintsForMechanisms } from '../memory/direction-memory.js'
import type { RegisteredLiteratureSource } from '../literature/context-adapter.js'
import { openDirectionManifest } from '../cleanup/manifest.js'
import type { DirectionRef } from '../cleanup/direction-id.js'
import { reserveDirectionCycleBoundary, registerWorkerDirectionArtifacts } from '../cleanup/registration.js'
import { advanceCleanupQueue, enqueueRefutedDirection, registerDirectionCycleArtifacts, refreshRunCleanupTargets, loadDirectionManifest, directionId } from '../cleanup/index.js'
import { readContinuation, loadOrReviewContinuation, runContinuationTasks, currentCoverageBinding, completeScientificFollowup, continuationDecisionRefs } from './continuation.js'

export const cyclePath = (ctx: RunContext, name: string) => safeResolve(ctx.runDir, 'cycles', `cycle-${ctx.state.cycle}`, name)
const unknownFingerprints = { code: 'unknown', data: 'unknown', treatment: 'unknown', model: 'unknown' }
const stamp = (id: string, version = 1) => ({ id, version, created_at: new Date().toISOString(), source_refs: [] })
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

async function ensureDirectionManifest(ctx: RunContext, snapshot: ResearchSnapshot): Promise<void> {
  const direction: DirectionRef = { projectId: ctx.projectDir, branchId: snapshot.branch_id, claim: snapshot.active_claim, hypothesis: snapshot.active_hypothesis, protocolHash: snapshot.protocol.content_hash }
  const manifest = await openDirectionManifest(ctx.runDir, direction)
  await reserveDirectionCycleBoundary({ runDir: ctx.runDir, cycle: ctx.state.cycle, manifestId: manifest.id })
}

function plannerLiteratureIds(spec: Record<string, unknown>): string[] | undefined {
  if (!Object.hasOwn(spec, 'allowed_literature_span_ids')) return undefined
  const ids = spec.allowed_literature_span_ids
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim()) || new Set(ids).size !== ids.length) {
    throw new ExperimentPauseError('PLANNER_LITERATURE_ALLOWLIST_INVALID: expected unique nonempty span IDs')
  }
  return [...ids] as string[]
}

/** Exposure sources come from the trusted provider's final prompt, never from structured model output. */
export async function captureResearchPlan(ctx: RunContext, structured: unknown, exposedSources: readonly RegisteredLiteratureSource[] = []): Promise<void> {
  const planner = record(structured), ids = plannerLiteratureIds(record(planner.protocol))
  if (ids !== undefined) {
    const store = new ResearchStore(ctx.runDir), sources: SourceRef[] = []
    for (const id of ids) {
      const source = exposedSources.find(source => source.spanId === id)?.sourceRef
      if (!source || source.id !== id || !source.path || !source.hash) throw new ExperimentPauseError(`PLANNER_LITERATURE_UNEXPOSED: ${id}`)
      const captured = await store.captureSource(source.path, id)
      if (captured.hash !== source.hash) throw new ExperimentPauseError(`PLANNER_LITERATURE_SOURCE_CHANGED: ${id}`)
      sources.push(captured)
    }
    const receipt = await store.captureBytes(JSON.stringify({ planHash: hashContent(planner), allowedSpanIds: ids, allowlistHash: hashContent(ids), sources }), `planner-literature-${ctx.state.cycle}`)
    // Capture before publishing the plan. Interrupted writes fail closed on a receipt/plan mismatch.
    await atomicWriteJson(cyclePath(ctx, 'planner-literature.json'), receipt)
  }
  await atomicWriteJson(cyclePath(ctx, 'planner-output.json'), planner)
}

async function frozenPlannerLiterature(ctx: RunContext, planner: Record<string, unknown>): Promise<{ ids?: string[]; sourceRefs: SourceRef[] }> {
  const ids = plannerLiteratureIds(record(planner.protocol))
  if (ids === undefined) return { sourceRefs: [] }
  const fail = (): never => { throw new ExperimentPauseError('PLANNER_LITERATURE_RECEIPT_MISMATCH: recapture the plan with its exposed sources') }
  const receipt = record(JSON.parse((await readOptionalText(cyclePath(ctx, 'planner-literature.json'))) ?? '{}')) as unknown as SourceRef
  if (!receipt.path || !receipt.hash) fail()
  const store = new ResearchStore(ctx.runDir)
  if ((await store.captureSource(receipt.path!, receipt.id)).hash !== receipt.hash) fail()
  const saved = record(JSON.parse(await readFile(safeResolve(ctx.runDir, receipt.path!), 'utf8')))
  if (saved.planHash !== hashContent(planner) || saved.allowlistHash !== hashContent(ids) || hashContent(saved.allowedSpanIds) !== hashContent(ids) || !Array.isArray(saved.sources)) fail()
  const sources = saved.sources as SourceRef[]
  if (sources.length !== ids.length) fail()
  for (const [index, source] of sources.entries()) {
    if (!source || source.id !== ids[index] || !source.path || !source.hash || (await store.captureSource(source.path, source.id)).hash !== source.hash) fail()
  }
  return { ids, sourceRefs: [receipt, ...sources] }
}

/** The controller commits the exact scientific contract before any worker can run. */
export async function freezeResearchCycle(ctx: RunContext, planText: string, design: string): Promise<ResearchSnapshot> {
  const store = new ResearchStore(ctx.runDir)
  const saved = await readOptionalText(cyclePath(ctx, 'frozen.json'))
  if (saved) {
    const snapshot = await store.loadSnapshot((JSON.parse(saved) as { snapshotId: string }).snapshotId)
    await ensureDirectionManifest(ctx, snapshot)
    return snapshot
  }
  const orphan = await readOptionalText(safeResolve(ctx.runDir, 'research', 'snapshots', `cycle-${ctx.state.cycle}-frozen`, 'manifest.json'))
  if (orphan) {
    const recovered = await store.commit(await store.loadSnapshot(`cycle-${ctx.state.cycle}-frozen`))
    await atomicWriteJson(cyclePath(ctx, 'protocol.json'), recovered.protocol)
    await atomicWriteJson(cyclePath(ctx, 'frozen.json'), { snapshotId: recovered.id })
    await ensureDirectionManifest(ctx, recovered)
    return recovered
  }
  const parent = await store.loadCurrent()
  const planner = record(JSON.parse((await readOptionalText(cyclePath(ctx, 'planner-output.json'))) ?? '{}'))
  const spec = record(planner.protocol)
  const literature = await frozenPlannerLiterature(ctx, planner)
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
  const ideaCapture = record(JSON.parse((await readOptionalText(safeResolve(ctx.runDir, 'research', 'idea-capture.json'))) ?? '{}'))
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
    ...(literature.ids === undefined ? {} : { allowed_literature_span_ids: literature.ids }),
    source_refs: [await store.captureBytes(JSON.stringify({ planText, design }), `execution-plan-${ctx.state.cycle}`), ...literature.sourceRefs],
  })
  const snapshot = sealRecord({
    ...stamp(`cycle-${ctx.state.cycle}-frozen`, (parent?.version ?? 0) + 1), schema: 'autoresearch/research-snapshot/v1' as const,
    source_refs: Array.isArray(ideaCapture.source_refs) ? ideaCapture.source_refs as SourceRef[] : [],
    branch_id: parent?.branch_id ?? ctx.state.runId, ...(parent ? { parent_snapshot_id: parent.id } : {}),
    active_claim: { id: claim.id, version: claim.version }, active_hypothesis: { id: hypothesis.id, version: hypothesis.version },
    claims: parent?.claims ?? [claim], hypotheses: parent?.hypotheses ?? [hypothesis], protocol, evidence: parent?.evidence ?? [], budget: parent?.budget ?? { revisions: 0, repairs: 0 },
    ...(parent?.candidate_batches ? { candidate_batches: parent.candidate_batches } : {}),
  })
  const committed = await store.commit(snapshot)
  await atomicWriteJson(cyclePath(ctx, 'protocol.json'), protocol)
  await atomicWriteJson(cyclePath(ctx, 'frozen.json'), { snapshotId: committed.id })
  await ensureDirectionManifest(ctx, committed)
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

export async function assessResearchCycle(ctx: RunContext, action: ActionResult, error?: string, executionUnknown = false, replay = false): Promise<ResearchSnapshot> {
  if (action.artifacts.length) {
    try {
      const frozenText = await readOptionalText(cyclePath(ctx, 'frozen.json'))
      const issued = await readOptionalText(cyclePath(ctx, 'worker-root.json'))
      if (!frozenText || !issued) throw new ExperimentPauseError('worker artifact proof missing frozen boundary or issued root')
      const frozen = await new ResearchStore(ctx.runDir).loadSnapshot(JSON.parse(frozenText).snapshotId)
      const direction = { projectId: ctx.projectDir, branchId: frozen.branch_id, claim: frozen.active_claim, hypothesis: frozen.active_hypothesis, protocolHash: frozen.protocol.content_hash }
      await registerWorkerDirectionArtifacts({ runDir: ctx.runDir, workDir: safeResolve(ctx.runDir, JSON.parse(issued).workDir), frozenManifest: await loadDirectionManifest(ctx.runDir, directionId(direction)), action, replay })
    } catch (error) {
      if (error instanceof ExperimentPauseError) throw error
      throw new ExperimentPauseError(`worker ownership proof rejected: ${String(error)}`)
    }
  }
  const store = new ResearchStore(ctx.runDir)
  const saved = await readOptionalText(cyclePath(ctx, 'assessed.json'))
  if (saved) {
    const snapshot = await store.loadSnapshot(JSON.parse(saved).snapshotId)
    await writeResearchReport(ctx, snapshot)
    await completeScientificFollowup(ctx, snapshot.evidence.filter(e => e.protocol_hash === snapshot.protocol.content_hash).flatMap(e => e.artifacts))
    return snapshot
  }
  const orphan = await readOptionalText(safeResolve(ctx.runDir, 'research', 'snapshots', `cycle-${ctx.state.cycle}-assessment`, 'manifest.json'))
  if (orphan) {
    const recovered = await store.commit(await store.loadSnapshot(`cycle-${ctx.state.cycle}-assessment`))
    await atomicWriteJson(cyclePath(ctx, 'assessment.json'), recovered.assessment)
    await atomicWriteJson(cyclePath(ctx, 'assessed.json'), { snapshotId: recovered.id })
    await writeResearchReport(ctx, recovered)
    await completeScientificFollowup(ctx, recovered.evidence.filter(e => e.protocol_hash === recovered.protocol.content_hash).flatMap(e => e.artifacts))
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
  const assessment = assessEvidence({ claim, hypothesis, protocol: frozen.protocol, evidence: allEvidence.filter(e => e.protocol_hash === frozen.protocol.content_hash), discoveryEvidence: allEvidence, discoverySourceRefs: hypothesis.source_refs, repairAttempts: frozen.budget.repairs, maxRepairAttempts: 2 })
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
  await completeScientificFollowup(ctx, artifacts)
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
  if (!current?.decision) return undefined
  if (await readContinuation(ctx.runDir)) {
    if (!current.decision.id.startsWith(`decision-${ctx.state.cycle}-r`) || !await matchesCoverageDecision(ctx, current)) return undefined
  } else if (current.decision.id !== `decision-${ctx.state.cycle}`) return undefined
  return materializeCommittedDecision(ctx, current)
}

async function matchesCoverageDecision(ctx: RunContext, snapshot: ResearchSnapshot): Promise<boolean> {
  const binding = await currentCoverageBinding(ctx)
  if (!binding || !snapshot.decision?.source_refs.some(ref => ref.id === `coverage-input:${binding.inputHash}`)) return false
  const expected = binding.action === 'complete' ? 'finish' : binding.action === 'followup' ? 'replicate' : 'pause'
  return snapshot.decision.action === expected
}

function decisionIdentity(parent: ResearchSnapshot, cycle: number, continuation: boolean) {
  const prefix = `candidate-batch-${cycle}-r`
  const revisions = (parent.candidate_batches ?? []).filter(batch => batch.id.startsWith(prefix)).map(batch => Number(batch.id.slice(prefix.length))).filter(Number.isSafeInteger)
  const suffix = continuation ? `-r${Math.max(-1, ...revisions) + 1}` : ''
  return { decisionId: `decision-${cycle}${suffix}`, batchId: `candidate-batch-${cycle}${suffix}` }
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

export async function commitResearchDecision(ctx: RunContext, output: unknown, legacy: ResearchDecision, expectedSnapshot?: { id: string; hash: string }, admission: { registeredSpans?: SourceRef[]; remainingCostMicros?: number; deliveryReady?: boolean } = {}): Promise<ResearchDecision> {
  if (ctx.context.signal.aborted) throw new ExperimentPauseError('research cancelled before scientific revision')
  const continuation = await readContinuation(ctx.runDir)
  // Delivering an authorized paper is a phase transition, never acceptance.
  // The runner reviews the complete goal after capturing the actual paper bytes.
  if (continuation && legacy.action === 'finish' && !admission.deliveryReady && ctx.state.phase !== 'paper' && ctx.policySnapshot.workflow.paper !== 'never') return { action: 'finish', reason: 'Research phase ready for paper delivery; final goal acceptance remains pending.' }
  const proposals = record(output)
  let goalAction: 'complete' | 'followup' | 'pause' | 'budget_exhausted' | undefined
  let goalReason: string | undefined
  if (continuation && (legacy.action === 'finish' || !Array.isArray(proposals.candidates) || !proposals.candidates.length)) {
    let reviewed = await loadOrReviewContinuation(ctx)
    if (reviewed.action === 'followup') reviewed = await runContinuationTasks(ctx)
    goalAction = reviewed.action
    goalReason = reviewed.reason
  }
  const store = new ResearchStore(ctx.runDir)
  const initial = await store.loadCurrent()
  if (!initial?.assessment) {
    if (expectedSnapshot && initial?.content_hash !== expectedSnapshot.hash) throw new ExperimentPauseError('research snapshot changed after supervisor input; reassessment is required')
    if (goalAction === 'pause' || goalAction === 'budget_exhausted') throw new ExperimentPauseError(`${goalAction}: ${goalReason}`)
    return goalAction === 'complete' ? { action: 'finish', reason: 'Independent goal coverage verified' } : goalAction === 'followup' ? { action: 'revise', reason: 'Execute admitted scientific follow-up under a new frozen protocol' } : legacy
  }
  const proposalSnapshot = expectedSnapshot ? await store.loadSnapshot(expectedSnapshot.id) : initial
  if (expectedSnapshot && proposalSnapshot.content_hash !== expectedSnapshot.hash) throw new ExperimentPauseError('research proposal snapshot hash mismatch')
  const raw = record(output)
  const rawSource = await store.captureBytes(JSON.stringify({ output, expectedSnapshot: expectedSnapshot ?? { id: initial.id, hash: initial.content_hash } }), `candidate-proposals-${ctx.state.cycle}`)
  const ideaCapture = record(JSON.parse((await readOptionalText(safeResolve(ctx.runDir, 'research', 'idea-capture.json'))) ?? '{}'))
  for (let retry = 0; retry < 3; retry++) {
  const parent = await store.loadCurrent()
  if (!parent?.assessment) throw new ExperimentPauseError('research snapshot changed; reassessment is required')
  if (parent.assessment.category === 'hypothesis_refuted' && parent.assessment.claim_status === 'refuted') {
    // Persist the compact negative memory before candidate selection. The run
    // is still live, so cleanup itself remains protected until the final hook.
    const direction: DirectionRef = { projectId: ctx.projectDir, branchId: parent.branch_id, claim: parent.active_claim, hypothesis: parent.active_hypothesis, protocolHash: parent.protocol.content_hash }
    try {
      await registerDirectionCycleArtifacts({ runDir: ctx.runDir, cycle: ctx.state.cycle, direction, snapshot: parent })
      const manifest = await loadDirectionManifest(ctx.runDir, directionId(direction))
      await refreshRunCleanupTargets(ctx.projectDir, ctx.runDir, direction, manifest)
    } catch (error) {
      ctx.logger.warn(`direction cleanup registration deferred: ${String(error)}`)
    }
    await enqueueRefutedDirection({ projectDir: ctx.projectDir, runDir: ctx.runDir, snapshot: parent })
    await advanceCleanupQueue(ctx.projectDir)
  }
  let { decisionId, batchId } = decisionIdentity(parent, ctx.state.cycle, !!continuation)
  if (continuation ? parent.decision?.id.startsWith(`decision-${ctx.state.cycle}-r`) && await matchesCoverageDecision(ctx, parent) : parent.decision?.id === decisionId) return materializeCommittedDecision(ctx, parent)
  const ledger = await ctx.context.requestLedger?.snapshot()
  const directionMemory = await selectionHintsForMechanisms(ctx.projectDir)
  let batch = buildCandidateBatch({ id: batchId, parent, proposalParent: proposalSnapshot.active_hypothesis,
    proposalSnapshotHash: proposalSnapshot.content_hash, rawCandidates: Array.isArray(raw.candidates) ? raw.candidates : [], rawSource,
    registeredSpans: admission.registeredSpans, selectionInput: { snapshotHash: parent.content_hash, remainingCost: admission.remainingCostMicros ?? null,
      registeredAlternatives: [...new Set(parent.hypotheses.flatMap(h => h.alternatives))],
      testedMechanismKeys: (parent.candidate_batches ?? []).flatMap(b => b.entries.filter(e => e.candidate.status === 'selected').map(e => e.candidate.mechanismKey)),
      avoidedMechanismKeys: directionMemory.avoidedMechanismKeys,
      directionMemoryIds: directionMemory.directionMemoryIds,
      directionMemoryMatches: directionMemory.directionMemoryMatches,
      exploratoryBudget: { policy: 'controller-caps-v1', remainingCycles: Math.max(0, Math.min((ctx.deps.maxCycles ?? 10) - ctx.state.cycle, (ctx.deps.maxCycles ?? 10) - parent.budget.revisions)),
        remainingRoleCalls: ledger?.remainingRoleCalls ?? null, remainingTokens: ledger?.remainingTokens ?? null } } })
  const candidate = batch.entries.find(entry => entry.candidate.id === batch.selection.selectedId)?.revision
  if (continuation && goalAction === undefined && (!candidate || batch.selection.stopReason === 'budget' || ctx.state.cycle >= (ctx.deps.maxCycles ?? 10))) {
    let reviewed = await loadOrReviewContinuation(ctx)
    if (reviewed.action === 'followup') reviewed = await runContinuationTasks(ctx)
    goalAction = reviewed.action
    goalReason = reviewed.reason
    ;({ decisionId, batchId } = decisionIdentity(parent, ctx.state.cycle, true))
    batch = sealRecord({ ...batch, id: batchId })
  }
  const strict = parent.protocol.provenance === 'known'
  // A CAS retry may have a different assessment/evidence basis. Revalidate the
  // content-bound receipt against CURRENT rather than carrying an old verdict.
  if (continuation && goalAction === 'complete') {
    const fresh = await loadOrReviewContinuation(ctx)
    goalAction = fresh.action
    goalReason = fresh.reason
  }
  const taskFinished = continuation ? goalAction === 'complete' : legacy.action === 'finish' && ((!strict && !candidate) || parent.assessment.category === 'supported')
  const atLimit = !taskFinished && (batch.selection.stopReason === 'budget' || ctx.state.cycle >= (ctx.deps.maxCycles ?? 10) || (ledger !== undefined && (ledger.remainingRoleCalls === 0 || ledger.remainingTokens === 0)))
  const limitReason = `budget_exhausted: maxCycles/maxRounds, role/token caps, or monetary admission limit reached; ${parent.assessment.reason}`
  const nextProtocol = candidate ? sealRecord({ ...parent.protocol, id: `pending-protocol-${ctx.state.cycle + 1}`, version: 1,
    hypothesis: { id: parent.active_hypothesis.id, version: Math.max(...parent.hypotheses.filter(h => h.id === parent.active_hypothesis.id).map(h => h.version)) + 1 },
    allowed_literature_span_ids: undefined,
    provenance: 'unknown' as const, fingerprints: { ...unknownFingerprints }, split: 'requires fresh validation data',
  }) : undefined
  const revised = createRevision({ decisionId, parentSnapshot: parent, assessment: parent.assessment,
    ...(candidate && !atLimit && !taskFinished && goalAction !== 'pause' && goalAction !== 'budget_exhausted' ? { candidate, nextProtocol } : {}), reason: goalReason ? `${goalAction}: ${goalReason}` : atLimit ? limitReason : strict && !taskFinished ? parent.assessment.reason : legacy.reason, maxRevisions: ctx.deps.maxCycles ?? 10 })
  const shouldPause = atLimit || goalAction === 'pause' || goalAction === 'budget_exhausted' || (legacy.action === 'fail' && !candidate && !taskFinished && goalAction !== 'followup')
  const finalAction = shouldPause ? sealRecord({ ...revised, decision: sealRecord({ ...revised.decision!, action: 'pause' as const }) }) : taskFinished
    ? sealRecord({ ...revised, decision: sealRecord({ ...revised.decision!, action: 'finish' as const }) }) : goalAction === 'followup'
    ? sealRecord({ ...revised, decision: sealRecord({ ...revised.decision!, action: 'replicate' as const }) }) : revised
  if (batch.selection.selectedId && finalAction.decision!.action !== 'revise') {
    const id = batch.selection.selectedId
    const reason = `deferred_controller_action:${finalAction.decision!.action}`
    const reasons = [...batch.selection.reasons[id]!.filter(item => item !== 'selected'), reason]
    batch = sealRecord({ ...batch, selection: { ...batch.selection, selectedId: null, reasons: { ...batch.selection.reasons, [id]: reasons } },
      entries: batch.entries.map(entry => entry.candidate.id === id ? { ...entry, candidate: { ...entry.candidate, status: 'deferred' as const }, reasons: [...entry.admissionReasons, ...reasons] } : entry) })
  }
  if (Array.isArray(ideaCapture.source_refs)) batch = sealRecord({ ...batch, source_refs: [...batch.source_refs, ...ideaCapture.source_refs as SourceRef[]] })
  const finalSnapshot = sealRecord({ ...finalAction, candidate_batches: [...(parent.candidate_batches ?? []), batch],
    decision: sealRecord({ ...finalAction.decision!, candidate_batch_id: batch.id, source_refs: [...finalAction.decision!.source_refs, { id: batch.id, hash: batch.content_hash }, ...(continuation ? await continuationDecisionRefs(ctx) : [])] }) })
  let committed: ResearchSnapshot
  try { committed = await store.commit(finalSnapshot, parent.content_hash) }
  catch (error) { if (/stale snapshot/.test(String(error)) && retry < 2) continue; throw error }
  if (candidate && committed.decision?.candidate) {
    await writeText(join(ctx.runDir, 'RESEARCH_NEXT_PLAN.md'), JSON.stringify({ hypothesis: committed.decision.candidate, evidence_snapshot: parent.id, constraints: 'New hypothesis is exploratory; use fresh validation data and a newly frozen protocol.' }, null, 2))
  } else if (strict && parent.assessment.next_action === 'repair') {
    await writeText(join(ctx.runDir, 'RESEARCH_NEXT_PLAN.md'), `Repair measurement/execution before further science: ${parent.assessment.reason}`)
  }
  return materializeCommittedDecision(ctx, committed)
  }
  throw new ExperimentPauseError('research snapshot kept changing; rebuild selection on resume')
}

export async function researchPlanInput(ctx: RunContext, idea: string): Promise<string> {
  const continuation = await readContinuation(ctx.runDir)
  const followup = continuation?.queue.find(item => item.status !== 'completed')
  const current = await new ResearchStore(ctx.runDir).loadCurrent()
  const next = current?.decision?.candidate ? JSON.stringify({ hypothesis: current.decision.candidate, evidence_snapshot: current.decision.parent_snapshot_id,
    constraints: 'Exploratory hypothesis; validate on fresh data under a newly frozen protocol.' }) :
    current?.decision?.action === 'repair' ? `Repair the measurement/execution: ${current.decision.reason}` : undefined
  const imported = await readOptionalText(join(ctx.runDir, 'research', 'imported-failure.json'))
  return [idea, followup ? `## Admitted goal follow-up\n${JSON.stringify(followup)}\nStay inside its frozen criteria; scientific work requires a newly frozen protocol. A proposed revision still requires strict candidate admission.` : '', next ? `## Committed next research action\n${next}` : '', imported ? `## Recover and verify imported failure sources\n${imported}\nThis is unknown historical provenance, not formal evidence or an established refutation.` : ''].filter(Boolean).join('\n\n')
}
