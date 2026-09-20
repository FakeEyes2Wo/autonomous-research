import { readFile, lstat, realpath, readdir } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { atomicWriteJson, readOptionalText, safeResolve, DEFAULT_MAX_CYCLES, ensureDir } from '../core/utils.js'
import { saveState } from '../core/state.js'
import { ResearchStore } from '../research/store.js'
import { hashBytes, hashContent } from '../research/records.js'
import { assessEvidence } from '../research/assessment.js'
import type { SourceRef } from '../research/contracts.js'
import { freezeAcceptance, parseRecovery, parseAcceptance, continuationInputHash, validateCoverage, mergeFollowups, type FrozenAcceptanceContract, type ControlRevision, type CoverageDecision, type FollowupItem, type ContinuationStop, type RecoveryInput } from '../research/continuation.js'
import { ExperimentPauseError } from '../experiment/errors.js'
import { isBudgetExhaustedError } from '../policy/request-ledger.js'
import type { RunContext } from './context.js'
import { runAgent } from './agent.js'
import { canonicalRelativePath, validateWorkerResult } from '../experiment/validation.js'
import { immutableJson } from '../experiment/task-graph.js'
import type { ActionResult } from '../core/types.js'
import { selectionHintsForMechanisms, ProjectDirectionMemoryStore, renderDirectionMemory } from '../memory/direction-memory.js'

export interface ContinuationState {
  schema: 'autoresearch/continuation/v1'
  acceptance: FrozenAcceptanceContract
  control: ControlRevision
  queue: FollowupItem[]
  evidence: SourceRef[]
  stop?: ContinuationStop
  lastReview?: { inputHash: string; action: CoverageDecision['action'] }
  resumeReviewRequired?: boolean
  recoveryTransaction?: { id: string; status: 'pending' | 'consumed'; controlRevision: number }
}
const statePath = (runDir: string) => join(runDir, 'continuation', 'state.json')
export async function readContinuation(runDir: string): Promise<ContinuationState | undefined> {
  const text = await readOptionalText(statePath(runDir))
  if (!text) return undefined
  const value = JSON.parse(text) as ContinuationState
  const { hash, ...body } = value.acceptance
  if (value.schema !== 'autoresearch/continuation/v1' || hashContent(body) !== hash || !Number.isSafeInteger(value.control.revision) || value.control.maxCycles < value.acceptance.maxCycles) throw new ExperimentPauseError('invalid continuation control manifest')
  return value
}
async function saveContinuation(runDir: string, value: ContinuationState): Promise<void> { await atomicWriteJson(statePath(runDir), value) }
async function publishImmutable(path: string, value: unknown): Promise<void> {
  const existing = await readOptionalText(path)
  if (existing !== undefined) {
    if (hashContent(JSON.parse(existing)) !== hashContent(value)) throw new ExperimentPauseError('immutable continuation control conflict')
    return
  }
  await atomicWriteJson(path, value)
}
export async function initializeContinuation(ctx: RunContext, migration = false): Promise<ContinuationState> {
  const old = await readContinuation(ctx.runDir)
  if (old) {
    if (ctx.deps.acceptance && hashContent(parseAcceptance(ctx.deps.acceptance).criteria) !== hashContent(old.acceptance.criteria.map(({ origin: _origin, ...criterion }) => criterion))) throw new TypeError('acceptance is immutable; create a new run for a changed contract')
    if (ctx.deps.maxCycles !== undefined && ctx.deps.maxCycles !== old.control.maxCycles) throw new TypeError('maxCycles change requires explicit recovery and a monotonic control revision')
    return old
  }
  const [goal, profile, rubric] = await Promise.all(['input/idea.md', 'PROFILE.md', 'RUBRIC.md'].map(path => readOptionalText(join(ctx.runDir, path))))
  const published = await readOptionalText(join(ctx.runDir, 'continuation', 'acceptance.json'))
  const acceptance: FrozenAcceptanceContract = published ? JSON.parse(published) : freezeAcceptance(ctx.deps.acceptance, { goal: goal ?? '', profile: profile ?? '', rubric: rubric ?? '', maxCycles: ctx.deps.maxCycles ?? DEFAULT_MAX_CYCLES })
  const { hash, ...body } = acceptance
  if (hash !== hashContent(body) || (ctx.deps.acceptance && hashContent(parseAcceptance(ctx.deps.acceptance).criteria) !== hashContent(acceptance.criteria.map(({ origin: _origin, ...criterion }) => criterion)))) throw new TypeError('published acceptance is immutable and must retain its verified content')
  if (ctx.deps.maxCycles !== undefined && ctx.deps.maxCycles !== acceptance.maxCycles) throw new TypeError('published acceptance cumulative cap is immutable without recovery')
  const state: ContinuationState = { schema: 'autoresearch/continuation/v1', acceptance, control: { revision: 0, maxCycles: acceptance.maxCycles }, queue: [], evidence: [] }
  await publishImmutable(join(ctx.runDir, 'continuation', 'acceptance.json'), acceptance)
  if (migration) await publishImmutable(join(ctx.runDir, 'continuation', 'migration.json'), { version: 1, acceptanceHash: acceptance.hash, origin: acceptance.origin, cycle: ctx.state.cycle, reason: 'legacy nonterminal run requires independent goal review' })
  await saveContinuation(ctx.runDir, state)
  return state
}
export async function addContinuationEvidence(ctx: RunContext, refs: SourceRef[]): Promise<void> {
  const state = await initializeContinuation(ctx)
  await verifyRefs(ctx.runDir, refs)
  state.evidence = uniqueRefs([...state.evidence, ...refs])
  await saveContinuation(ctx.runDir, state)
}
function uniqueRefs(refs: SourceRef[]): SourceRef[] { return [...new Map(refs.map(ref => [`${ref.id}:${ref.path}:${ref.hash}`, ref])).values()].sort((a, b) => `${a.id}:${a.hash}`.localeCompare(`${b.id}:${b.hash}`)) }
async function verifyRefs(runDir: string, refs: SourceRef[]): Promise<void> {
  for (const ref of refs) {
    if (!ref.path || !ref.hash || hashBytes(await readFile(safeResolve(runDir, ref.path))) !== ref.hash) throw new ExperimentPauseError(`continuation evidence bytes changed or missing: ${ref.id}`)
  }
}
async function reviewBasis(ctx: RunContext, state: ContinuationState) {
  const snapshot = await new ResearchStore(ctx.runDir).loadCurrent()
  const scienceRefs = uniqueRefs(snapshot?.evidence.flatMap(e => [...e.artifacts, ...(e.analysis ? [e.analysis] : [])]) ?? [])
  const refs = uniqueRefs([...scienceRefs, ...state.evidence, ...state.queue.flatMap(item => item.resultRefs ?? []), ...(state.control.sourceRefs ?? [])])
  await verifyRefs(ctx.runDir, refs)
  let scientificSupported = false
  if (snapshot?.assessment && snapshot.protocol.provenance === 'known') {
    const claim = snapshot.claims.find(c => c.id === snapshot.assessment!.claim.id && c.version === snapshot.assessment!.claim.version)
    const hypothesis = snapshot.hypotheses.find(h => h.id === snapshot.active_hypothesis.id && h.version === snapshot.active_hypothesis.version)
    if (claim && hypothesis) scientificSupported = assessEvidence({ claim, hypothesis, protocol: snapshot.protocol, evidence: snapshot.evidence.filter(e => e.protocol_hash === snapshot.protocol.content_hash), discoveryEvidence: snapshot.evidence, discoverySourceRefs: hypothesis.source_refs }).category === 'supported' && snapshot.assessment.category === 'supported'
  }
  // Scientific snapshots, budgets and decisions are deliberately not hashed:
  // only the assessment/protocol/evidence records and source bytes are inputs.
  const directionMemory = { ...await selectionHintsForMechanisms(ctx.projectDir), summary: renderDirectionMemory(await new ProjectDirectionMemoryStore(ctx.projectDir).read()) }
  const scientificObligation = snapshot?.protocol.provenance === 'known'
  const assessmentAndEvidence = { protocol: snapshot?.protocol, assessment: snapshot?.assessment, evidence: snapshot?.evidence, refs, scientificSupported, scientificObligation, directionMemory }
  const admissibleScienceRefs = scienceRefs.filter(ref => snapshot?.evidence.some(e => snapshot.assessment?.admissible_evidence_ids.includes(e.id) && e.artifacts.some(a => a.hash === ref.hash && a.path === ref.path)))
  return { assessmentAndEvidence, refs, scientificSupported, scientificObligation, scientificRefs: admissibleScienceRefs }
}
async function stop(ctx: Pick<RunContext, 'runDir' | 'state'>, state: ContinuationState, stopReason: ContinuationStop['stopReason'], reason: string, inputHash?: string): Promise<void> {
  const snapshot = await new ResearchStore(ctx.runDir).loadCurrent()
  const refs = [...state.evidence, ...state.queue.flatMap(item => [...item.sourceRefs, ...(item.resultRefs ?? [])]), ...(snapshot?.evidence.flatMap(e => e.artifacts) ?? [])]
  state.stop = { stopReason, reason, ...(inputHash ? { inputHash } : {}), resumeCondition: { changedConditionRequired: true, relevantSourceIds: [...new Set(refs.map(ref => ref.id))], mayIncreaseMaxCycles: true } }
  await saveContinuation(ctx.runDir, state)
  ctx.state.continuationStop = state.stop
  await saveState(ctx.runDir, ctx.state)
}
export async function recordContinuationPause(runDir: string, runState: RunContext['state'], reason: string, budget = false): Promise<void> {
  const state = await readContinuation(runDir)
  if (!state) return
  if (state.stop) { runState.continuationStop = state.stop; return }
  await stop({ runDir, state: runState }, state, budget ? 'budget_exhausted' : /unknown|unresolved/i.test(reason) ? 'evidence_unresolved' : 'pause', reason)
}
function isolatedContext(ctx: RunContext) {
  return { stage: 'continuation', scope: { projectId: ctx.projectDir, branchId: 'goal-coverage', runId: ctx.state.runId }, records: [] }
}
function reviewInput(state: ContinuationState, basis: Awaited<ReturnType<typeof reviewBasis>>, strategy: string) {
  return { acceptance: state.acceptance, assessmentAndEvidence: { ...basis.assessmentAndEvidence, strategy }, queue: state.queue.map(({ task: _task, changedCondition: _condition, ...item }) => item), controlRevision: state.control }
}
/** Read-only replay gate: lastReview alone is not proof of current coverage. */
export async function currentCoverageBinding(ctx: RunContext): Promise<{ inputHash: string; action: CoverageDecision['action'] } | undefined> {
  const state = await readContinuation(ctx.runDir)
  if (!state?.lastReview) return undefined
  const basis = await reviewBasis(ctx, state)
  for (const strategy of ['coverage', 'boundary-invariant', 'interaction-cross-check']) {
    const inputHash = continuationInputHash(reviewInput(state, basis, strategy))
    if (inputHash !== state.lastReview.inputHash) continue
    const text = await readOptionalText(join(ctx.runDir, 'continuation', 'reviews', `${inputHash}.json`))
    if (!text) return undefined
    const receipt = JSON.parse(text) as { inputHash: string; inputRef: SourceRef; outputRef: SourceRef; decision: CoverageDecision; decisionHash: string }
    await verifyRefs(ctx.runDir, [receipt.inputRef, receipt.outputRef])
    if (receipt.inputHash !== inputHash || hashContent(JSON.parse(await readFile(safeResolve(ctx.runDir, receipt.inputRef.path!), 'utf8'))) !== inputHash || receipt.decisionHash !== hashContent(receipt.decision) || hashContent(JSON.parse(await readFile(safeResolve(ctx.runDir, receipt.outputRef.path!), 'utf8'))) !== receipt.decisionHash) throw new ExperimentPauseError('coverage replay receipt hash mismatch')
    if (state.lastReview.action === 'complete' && (receipt.decision.action !== 'complete' || state.queue.some(item => item.status !== 'completed') || validateCoverage(state.acceptance, receipt.decision, basis.refs, basis.scientificSupported, basis.scientificRefs, basis.scientificObligation).length)) return undefined
    return state.lastReview
  }
  return undefined
}
async function reviewOnce(ctx: RunContext, state: ContinuationState, basis: Awaited<ReturnType<typeof reviewBasis>>, strategy: string): Promise<{ decision: CoverageDecision; inputHash: string }> {
  const input = reviewInput(state, basis, strategy)
  const inputHash = continuationInputHash(input)
  const path = join(ctx.runDir, 'continuation', 'reviews', `${inputHash}.json`)
  const cached = await readOptionalText(path)
  if (cached) {
    const receipt = JSON.parse(cached) as { inputHash: string; inputRef: SourceRef; outputRef: SourceRef; decision: CoverageDecision; decisionHash: string }
    await verifyRefs(ctx.runDir, [receipt.inputRef, receipt.outputRef])
    if (receipt.inputHash !== inputHash || hashContent(JSON.parse(await readFile(safeResolve(ctx.runDir, receipt.inputRef.path!), 'utf8'))) !== inputHash || receipt.decisionHash !== hashContent(receipt.decision) || JSON.stringify(JSON.parse(await readFile(safeResolve(ctx.runDir, receipt.outputRef.path!), 'utf8'))) !== JSON.stringify(receipt.decision)) throw new ExperimentPauseError('coverage receipt hash mismatch')
    return { decision: receipt.decision, inputHash }
  }
  const intent = path.replace(/\.json$/, '.intent.json')
  if (await readOptionalText(intent)) { await stop(ctx, state, 'evidence_unresolved', 'coverage reviewer outcome is unknown; verify the external receipt before recovery', inputHash); throw new ExperimentPauseError('coverage reviewer outcome unknown; no redispatch') }
  const ledger = await ctx.context.requestLedger?.snapshot()
  if (ledger && (ledger.remainingRoleCalls < 1 || ledger.remainingTokens < 1)) { await stop(ctx, state, 'budget_exhausted', 'coverage review budget exhausted', inputHash); return { inputHash, decision: { action: 'budget_exhausted', reason: 'coverage review budget exhausted', criteria: [], blockers: [], unsupportedClaims: [], followups: [] } } }
  const store = new ResearchStore(ctx.runDir)
  const inputRef = await store.captureBytes(JSON.stringify(input), `coverage-input:${inputHash}`)
  await atomicWriteJson(intent, { taskId: `coverage-review:${inputHash}`, inputRef })
  try {
    const result = await runAgent(ctx, { role: 'coverage-reviewer', label: `coverage-review:${inputHash}`, input: { runDir: ctx.runDir, taskId: `coverage-review:${inputHash}`, continuation: JSON.stringify({ ...input, strategy, sourceRefs: basis.refs, directionMemory: basis.assessmentAndEvidence.directionMemory }), researchContext: isolatedContext(ctx) } })
    const decision = result.structured as CoverageDecision
    const outputRef = await store.captureBytes(JSON.stringify(decision ?? null), `coverage-output:${inputHash}`)
    await atomicWriteJson(path, { inputHash, inputRef, outputRef, decision: decision ?? null, decisionHash: hashContent(decision ?? null) })
    return { decision, inputHash }
  } catch (error) {
    await stop(ctx, state, isBudgetExhaustedError(error) ? 'budget_exhausted' : 'evidence_unresolved', `coverage reviewer outcome unresolved: ${String(error)}`, inputHash)
    throw new ExperimentPauseError(`coverage reviewer outcome unresolved: ${String(error)}`)
  }
}
/** One coverage pass plus two bounded complementary gap searches. No round-count heuristic. */
export async function loadOrReviewContinuation(ctx: RunContext): Promise<CoverageDecision> {
  const state = await initializeContinuation(ctx)
  const basis = await reviewBasis(ctx, state)
  let latest: CoverageDecision = { action: 'pause', reason: 'unreviewed goal', criteria: [], blockers: [], unsupportedClaims: [], followups: [] }
  let lastHash: string | undefined
  for (const strategy of ['coverage', 'boundary-invariant', 'interaction-cross-check']) {
    const { decision, inputHash } = await reviewOnce(ctx, state, basis, strategy)
    lastHash = inputHash
    const issues = validateCoverage(state.acceptance, decision, basis.refs, basis.scientificSupported, basis.scientificRefs, basis.scientificObligation)
    latest = issues.length ? { action: 'pause', reason: issues.join('; '), criteria: [], blockers: issues, unsupportedClaims: [], followups: [] } : decision
    // A bound reviewer receipt and its queue decision are acknowledged together.
    // A local budget refusal has no reviewer receipt to acknowledge.
    if (await readOptionalText(join(ctx.runDir, 'continuation', 'reviews', `${inputHash}.json`))) state.resumeReviewRequired = false
    state.lastReview = { inputHash, action: latest.action }
    if (latest.action === 'complete' && !state.queue.some(item => item.status !== 'completed')) {
      state.stop = undefined
      state.lastReview = { inputHash, action: 'complete' }
      await saveContinuation(ctx.runDir, state)
      return latest
    }
    if (latest.action === 'budget_exhausted') { await stop(ctx, state, 'budget_exhausted', latest.reason, inputHash); return latest }
    if (!issues.length) state.queue = mergeFollowups(state.queue, latest.followups.filter(item => !item.mechanismKey || !basis.assessmentAndEvidence.directionMemory.avoidedMechanismKeys.includes(item.mechanismKey)), state.acceptance, basis.refs)
    if (state.queue.some(item => item.status === 'pending' || item.status === 'running')) {
      if (ctx.state.cycle >= state.control.maxCycles && !state.queue.some(item => item.status === 'running')) {
        await stop(ctx, state, 'budget_exhausted', `maxCycles total reached (${state.control.maxCycles}); queued goal follow-ups remain`, inputHash)
        return { ...latest, action: 'budget_exhausted' }
      }
      state.stop = undefined
      state.lastReview = { inputHash, action: 'followup' }
      await saveContinuation(ctx.runDir, state)
      return { ...latest, action: 'followup' }
    }
  }
  state.lastReview = { inputHash: lastHash!, action: 'pause' }
  await stop(ctx, state, 'no_feasible_followup', `Two complementary searches found no admissible scoped follow-up. ${latest.reason}`, lastHash)
  return { ...latest, action: 'pause' }
}
export async function inspectRecovery(runDir: string, recovery: RecoveryInput, maxCycles?: number): Promise<{ state: ContinuationState; paths: string[] }> {
  const input = parseRecovery(recovery)
  const state = await readContinuation(runDir)
  if (!state) throw new TypeError('recovery requires an existing frozen acceptance contract')
  if (input.criterionIds?.some(id => !state.acceptance.criteria.some(c => c.id === id))) throw new TypeError('recovery criterionIds must link to frozen acceptance criteria')
  if (maxCycles !== undefined && (!Number.isSafeInteger(maxCycles) || maxCycles < state.control.maxCycles)) throw new TypeError('recovery maxCycles must be monotonic; cannot decrease the cumulative cap')
  if (state.recoveryTransaction?.status === 'pending' && state.recoveryTransaction.id === recoveryId(input, maxCycles ?? state.control.maxCycles)) {
    await verifyRefs(runDir, state.control.sourceRefs ?? [])
    return { state, paths: [] }
  }
  const refs = [...state.evidence, ...state.queue.flatMap(item => [...item.sourceRefs, ...(item.resultRefs ?? [])]), ...(state.control.sourceRefs ?? [])]
  const snapshot = await new ResearchStore(runDir).loadCurrent()
  refs.push(...(snapshot?.evidence.flatMap(e => e.artifacts) ?? []))
  const paths: string[] = []
  const root = await realpath(runDir)
  for (const path of input.newEvidencePaths ?? []) {
    const file = safeResolve(runDir, path.replaceAll('\\', '/')), info = await lstat(file), actual = await realpath(file), rel = relative(root, actual)
    if (!info.isFile() || info.isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel)) throw new TypeError('recovery evidence must be a regular run-relative file')
    const normalized = rel.replaceAll('\\', '/')
    if (/^(?:continuation\/(?!tasks\/[^/]+\/work\/)|research\/snapshots\/|request-ledger|state\.json|DECISION|RESEARCH_REPORT|FAILURE_REPORT|\.autoresearch\/)/i.test(normalized)) throw new TypeError('controller outputs are not external recovery evidence')
    if (paths.includes(normalized)) continue
    const hash = hashBytes(await readFile(file))
    if (!refs.some(ref => ref.id === normalized || ref.path === normalized) && !input.criterionIds?.length) throw new TypeError('recovery evidence must be relevant to an existing criterion source or explicitly link frozen criterionIds for independent review')
    if (refs.some(ref => ref.hash === hash)) throw new TypeError('recovery requires genuinely new changed source bytes')
    paths.push(normalized)
  }
  if (!paths.length && !(maxCycles !== undefined && maxCycles > state.control.maxCycles)) throw new TypeError('changedCondition prose is not evidence; provide relevant changed bytes or increase the cumulative cap')
  return { state, paths }
}
export async function validateRecovery(runDir: string, recovery: RecoveryInput, maxCycles?: number): Promise<ControlRevision> {
  const { state, paths } = await inspectRecovery(runDir, recovery, maxCycles)
  if (state.recoveryTransaction?.status === 'pending' && state.recoveryTransaction.id === recoveryId(recovery, maxCycles ?? state.control.maxCycles)) return state.control
  const store = new ResearchStore(runDir)
  const refs: SourceRef[] = []
  for (const path of paths) refs.push(await store.captureSource(path, path))
  const control: ControlRevision = { revision: state.control.revision + 1, maxCycles: maxCycles ?? state.control.maxCycles, changedCondition: recovery.changedCondition, ...(recovery.criterionIds ? { criterionIds: recovery.criterionIds } : {}), sourceRefs: uniqueRefs([...(state.control.sourceRefs ?? []), ...refs]) }
  await publishImmutable(join(runDir, 'continuation', 'controls', `r${control.revision}.json`), { previous: state.control, control })
  state.control = control
  state.evidence = uniqueRefs([...state.evidence, ...refs])
  state.resumeReviewRequired = true
  state.stop = undefined
  state.recoveryTransaction = { id: recoveryId(recovery, control.maxCycles), status: 'pending', controlRevision: control.revision }
  await saveContinuation(runDir, state)
  return control
}
function recoveryId(input: RecoveryInput, maxCycles: number): string { return hashContent({ input: parseRecovery(input), maxCycles }) }
/** RUNNING must be durable before acknowledging the already-authorized transaction. */
export async function consumeRecovery(runDir: string): Promise<void> {
  const state = await readContinuation(runDir)
  if (state?.recoveryTransaction?.status !== 'pending') return
  await publishImmutable(join(runDir, 'continuation', 'controls', `r${state.recoveryTransaction.controlRevision}.consumed.json`), { transactionId: state.recoveryTransaction.id, controlRevision: state.recoveryTransaction.controlRevision })
  state.recoveryTransaction.status = 'consumed'
  await saveContinuation(runDir, state)
}

type TaskInventoryEntry = { path: string; kind: 'file' | 'directory'; hash?: string }
async function taskInventory(workDir: string): Promise<TaskInventoryEntry[]> {
  const entries: TaskInventoryEntry[] = []
  async function walk(dir: string): Promise<void> {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, item.name), info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new ExperimentPauseError('task baseline contains non-regular path')
      entries.push({ path: await canonicalRelativePath(workDir, path), kind: info.isFile() ? 'file' : 'directory', ...(info.isFile() ? { hash: hashBytes(await readFile(path)) } : {}) })
      if (info.isDirectory()) await walk(path)
    }
  }
  if ((await lstat(workDir)).isSymbolicLink()) throw new ExperimentPauseError('task workDir may not be a symlink')
  await walk(workDir)
  return entries
}

async function validatedTaskAction(runDir: string, root: string, id: string, fresh?: unknown): Promise<ActionResult> {
  const workDir = join(root, 'work'), baselineText = await readOptionalText(join(root, 'baseline.json')), intentText = await readOptionalText(join(root, 'work-intent.json'))
  if (!baselineText || !intentText) throw new ExperimentPauseError('task baseline/intent receipt missing; outcome unknown; no redispatch')
  const baseline = JSON.parse(baselineText), intent = JSON.parse(intentText)
  if (baseline.schema !== 'autoresearch/task-baseline/v1' || baseline.taskId !== id || baseline.workDir !== relative(runDir, workDir).replaceAll('\\', '/') || intent.baselineHash !== hashContent(baseline)) throw new ExperimentPauseError('task baseline receipt hash mismatch')
  const current = await taskInventory(workDir)
  const baselineEntries = await Promise.all((baseline.entries as TaskInventoryEntry[]).map(async entry => ({ ...entry, path: await canonicalRelativePath(workDir, entry.path) })))
  for (const entry of baselineEntries) if (!current.some(now => now.path === entry.path && now.kind === entry.kind && now.hash === entry.hash)) throw new ExperimentPauseError('preexisting task baseline path changed')
  const receiptPath = join(root, 'validated-result.json'), saved = await readOptionalText(receiptPath)
  if (fresh === undefined && !saved) throw new ExperimentPauseError('validated task result receipt missing; outcome unknown; no redispatch')
  const receipt = saved ? JSON.parse(saved) : undefined
  if (receipt) {
    const { hash, ...body } = receipt
    if (receipt.schema !== 'autoresearch/task-result/v1' || receipt.taskId !== id || receipt.baselineHash !== hashContent(baseline) || hashContent(body) !== hash) throw new ExperimentPauseError('validated task result receipt hash mismatch')
  }
  const action = await validateWorkerResult(runDir, workDir, receipt?.action ?? fresh)
  const files = []
  for (const artifact of action.artifacts) {
    const path = safeResolve(runDir, artifact), local = await canonicalRelativePath(workDir, path)
    if (baselineEntries.some(entry => entry.path === local)) throw new ExperimentPauseError('preexisting task artifact cannot become worker evidence')
    files.push({ path: artifact, hash: hashBytes(await readFile(path)) })
  }
  const receiptFiles = receipt ? await Promise.all((receipt.files as Array<{ path: string; hash: string }>).map(async file => ({ ...file, path: await canonicalRelativePath(runDir, file.path) }))) : undefined
  if (receipt && hashContent(receiptFiles) !== hashContent(files)) throw new ExperimentPauseError('validated task artifact bytes changed (hash mismatch)')
  if (!receipt) {
    const body = { schema: 'autoresearch/task-result/v1', taskId: id, baselineHash: hashContent(baseline), action, files }
    await immutableJson(receiptPath, { ...body, hash: hashContent(body) })
  }
  return action
}

/** Non-scientific work lives outside ResearchSnapshot and cannot demote a supported claim. */
export async function runContinuationTasks(ctx: RunContext): Promise<CoverageDecision> {
  while (true) {
    const state = await initializeContinuation(ctx)
    const item = state.queue.find(item => item.status !== 'completed')
    if (!item) return loadOrReviewContinuation(ctx)
    if (item.status === 'failed') throw new ExperimentPauseError(`confirmed follow-up failed; new verified conditions and independent admission required: ${item.failureReason}`)
    const fail = async (reason: string): Promise<never> => {
      item.status = 'failed'; item.failureReason = reason
      await saveContinuation(ctx.runDir, state)
      throw new ExperimentPauseError(reason)
    }
    const directionMemory = { ...await selectionHintsForMechanisms(ctx.projectDir), summary: renderDirectionMemory(await new ProjectDirectionMemoryStore(ctx.projectDir).read()) }
    if (item.mechanismKey && directionMemory.avoidedMechanismKeys.includes(item.mechanismKey)) throw new ExperimentPauseError('project_direction_memory: queued follow-up repeats an eliminated mechanism')
    if (item.kind === 'replicate' || item.criterionIds.some(id => state.acceptance.criteria.find(c => c.id === id)?.evidenceKind === 'scientific')) return { action: 'followup', reason: 'follow-up requires the frozen scientific execution path', criteria: [], blockers: [], unsupportedClaims: [], followups: [item] }
    if (ctx.context.signal.aborted) throw new ExperimentPauseError('continuation cancelled before dispatch')
    const id = `${item.fingerprint}-g${item.generation}`
    const root = join(ctx.runDir, 'continuation', 'tasks', id), workDir = join(root, 'work')
    if (item.status === 'pending') {
      if (ctx.state.cycle >= state.control.maxCycles) { await stop(ctx, state, 'budget_exhausted', 'cumulative maxCycles exhausted before follow-up'); return { action: 'budget_exhausted', reason: 'cumulative maxCycles exhausted', criteria: [], blockers: [], unsupportedClaims: [], followups: [] } }
      // Durable cycle debit precedes any paid task. Replay restores this debit.
      item.cycle = ctx.state.cycle + 1
      item.status = 'running'
      await saveContinuation(ctx.runDir, state)
    }
    ctx.state.cycle = Math.max(ctx.state.cycle, item.cycle!)
    ctx.state.phase = 'decide'
    await saveState(ctx.runDir, ctx.state)
    const planPath = join(root, 'plan.json'), intentPath = join(root, 'work-intent.json'), resultPath = join(root, 'result.json')
    let planText = await readOptionalText(planPath)
    if (!planText) {
      const intent = join(root, 'plan-intent.json')
      if (await readOptionalText(intent)) throw new ExperimentPauseError('follow-up planner outcome unknown; no redispatch')
      await atomicWriteJson(intent, { taskId: `followup:${id}:plan` })
      const planned = await runAgent(ctx, { role: 'planner', label: `followup:${id}:plan`, input: { runDir: ctx.runDir, taskId: `followup:${id}:plan`, idea: JSON.stringify({ goal: state.acceptance.goalProfileRubric, followup: item, directionMemory, constraints: 'Non-scientific investigation. Preserve compact project-wide elimination memory; do not repeat a discarded mechanism by rewording it. Return a scoped plan and riskLevel; formal experiments require the scientific path. Do not alter existing records.' }), researchContext: isolatedContext(ctx) } })
      await atomicWriteJson(planPath, planned.structured ?? {})
      planText = JSON.stringify(planned.structured ?? {})
    }
    const plan = JSON.parse(planText) as { plan?: string; riskLevel?: string; protocol?: unknown; taskGraph?: unknown }
    if (!plan.plan?.trim() || plan.protocol || plan.taskGraph) throw new ExperimentPauseError('continuation plan requires explicit scientific/durable admission; generic investigation cannot execute it')
    if (plan.riskLevel !== 'low') {
      if (ctx.policySnapshot.workflow.experimentReview === 'never') await fail('non-low-risk continuation requires independent risk review')
      const reviewPath = join(root, 'risk-review.json')
      let review = await readOptionalText(reviewPath)
      if (!review) {
        const intent = join(root, 'risk-review-intent.json')
        if (await readOptionalText(intent)) throw new ExperimentPauseError('follow-up risk review outcome unknown')
        await atomicWriteJson(intent, { taskId: `followup:${id}:risk` })
        const out = await runAgent(ctx, { role: 'experiment-reflexion', label: `followup:${id}:risk`, input: { runDir: ctx.runDir, taskId: `followup:${id}:risk`, plan: plan.plan, researchContext: isolatedContext(ctx) } })
        await atomicWriteJson(reviewPath, out.structured ?? {})
        review = JSON.stringify(out.structured ?? {})
      }
      if (JSON.parse(review).verdict !== 'proceed') await fail('continuation risk review requires revision')
    }
    let result = await readOptionalText(resultPath)
    let fresh = false
    const validatedReceipt = await readOptionalText(join(root, 'validated-result.json'))
    if (!result && !validatedReceipt) {
      if (await readOptionalText(intentPath)) throw new ExperimentPauseError('follow-up worker outcome unknown; no redispatch')
      await ensureDir(workDir)
      const baseline = { schema: 'autoresearch/task-baseline/v1', taskId: id, workDir: relative(ctx.runDir, workDir).replaceAll('\\', '/'), entries: await taskInventory(workDir) }
      await immutableJson(join(root, 'baseline.json'), baseline)
      await atomicWriteJson(intentPath, { taskId: `followup:${id}:work`, workDir, baselineHash: hashContent(baseline) })
      const worked = await runAgent(ctx, { role: 'research-worker', label: `followup:${id}:work`, input: { runDir: ctx.runDir, workDir, taskId: `followup:${id}:work`, plan: plan.plan, researchContext: isolatedContext(ctx), experimentDesign: 'Non-scientific goal investigation: create new artifacts only inside the issued workDir. Never modify, move or delete existing records.' } })
      await atomicWriteJson(resultPath, worked.structured ?? {})
      result = JSON.stringify(worked.structured ?? {})
      fresh = true
    }
    if (!validatedReceipt && result && JSON.parse(result).status === 'failed') await fail('continuation work failed; no scientific inference admitted')
    const action = await validatedTaskAction(ctx.runDir, root, id, fresh ? JSON.parse(result!) : undefined)
    if (action.status !== 'completed') throw new ExperimentPauseError('continuation work failed; no scientific inference admitted')
    const store = new ResearchStore(ctx.runDir)
    item.resultRefs = []
    for (const path of action.artifacts) item.resultRefs.push(await store.captureSource(path))
    item.status = 'completed'
    state.evidence = uniqueRefs([...state.evidence, ...item.resultRefs])
    await saveContinuation(ctx.runDir, state)
    const reviewed = await loadOrReviewContinuation(ctx)
    if (reviewed.action !== 'followup') return reviewed
  }
}

export async function continuationRevision(ctx: RunContext): Promise<number> { return (await readContinuation(ctx.runDir))?.control.revision ?? 0 }

export async function continuationDecisionRefs(ctx: RunContext): Promise<SourceRef[]> {
  const state = await readContinuation(ctx.runDir)
  if (!state?.lastReview || !(await currentCoverageBinding(ctx))) return []
  const receipt = JSON.parse(await readFile(join(ctx.runDir, 'continuation', 'reviews', `${state.lastReview.inputHash}.json`), 'utf8')) as { inputRef: SourceRef; outputRef: SourceRef; decision: CoverageDecision }
  const refs = uniqueRefs([receipt.inputRef, receipt.outputRef, ...receipt.decision.criteria.flatMap(c => c.sourceRefs)])
  await verifyRefs(ctx.runDir, refs)
  return refs
}

export async function completeScientificFollowup(ctx: RunContext, refs: SourceRef[]): Promise<void> {
  const state = await readContinuation(ctx.runDir)
  const item = state?.queue.find(item => item.status === 'running' && item.cycle === ctx.state.cycle && (!item.execution || item.execution.cycle === ctx.state.cycle) && scientificFollowup(state, item))
  if (!state || !item) return
  await verifyRefs(ctx.runDir, refs)
  item.status = 'completed'
  item.cycle = ctx.state.cycle
  item.resultRefs = refs
  await saveContinuation(ctx.runDir, state)
}

function scientificFollowup(state: ContinuationState, item: FollowupItem): boolean {
  return item.kind === 'replicate' || item.criterionIds.some(id => state.acceptance.criteria.find(c => c.id === id)?.evidenceKind === 'scientific')
}

/** Publish the cycle/graph reservation before run-state publication or dispatch. */
export async function bindScientificFollowup(ctx: RunContext, execution: NonNullable<FollowupItem['execution']>): Promise<FollowupItem['execution']> {
  const state = await readContinuation(ctx.runDir)
  const item = state?.queue.find(item => (item.status === 'pending' || item.status === 'running') && scientificFollowup(state, item))
  if (!state || !item) return undefined
  // A completed cycle cannot be rebound to the next queue item during replay.
  if (state.queue.some(prior => prior.status === 'completed' && prior.cycle === execution.cycle && scientificFollowup(state, prior))) return undefined
  if (item.execution) return item.execution
  if (execution.cycle > state.control.maxCycles) throw new ExperimentPauseError('cumulative maxCycles exhausted before scientific follow-up')
  item.execution = execution
  item.cycle = execution.cycle
  item.status = 'running'
  await saveContinuation(ctx.runDir, state)
  return execution
}
