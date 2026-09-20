import { readFile, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobBackend, JobSpec, RuntimeLimits, JobReceipt, BudgetSnapshot, JobRecord } from '../runtime/contracts.js'
import { terminal } from '../runtime/contracts.js'
import { openJobStore, type JobStore } from '../runtime/job-store.js'
import { JobController } from '../runtime/job-controller.js'
import { LocalJobBackend } from '../runtime/executors/local.js'
import { ResearchStore } from '../research/store.js'
import { hashBytes, hashContent, sealRecord } from '../research/records.js'
import { assessEvidence } from '../research/assessment.js'
import type { Evidence, ResearchSnapshot, SourceRef } from '../research/contracts.js'
import { validateScientificEvidence, type DomainValidation } from './evidence-validator.js'
import { captureJobArtifacts, type ArtifactManifest } from './artifact-manifest.js'
import { immutableJson, loadTaskGraph, readyTasks, type ExperimentTask, type FrozenTaskGraph, type CompletedTask } from './task-graph.js'
import { writeText } from '../core/utils.js'
import type { ResearchTree } from '../core/research-tree.js'

/** Supplied by the trusted host, never deserialized from planner output or a run file. */
export interface ExperimentRuntimeAuthority {
  authorize(spec: JobSpec, task: ExperimentTask): Promise<void>
  limits?: Partial<RuntimeLimits>
  backendFactory?: (store: JobStore) => JobBackend
}
export interface CollectedTask {
  schema: 'autoresearch/collected-task/v1'; graphHash: string; taskId: string; contentHash: string
  receipt: JobReceipt; manifest: ArtifactManifest | null; manifestHash: string; admissionKey: string
  validatorVersion: string; validation: DomainValidation; artifacts: SourceRef[]; sourceRefs: SourceRef[]
  completed: boolean; scientific: boolean; createdAt: string; hash: string
}
export interface ExperimentGraphResult {
  status: 'waiting' | 'completed' | 'paused'; reason: string; completed: CompletedTask[]
  pendingJobs: JobReceipt[]; artifacts: string[]; budget: BudgetSnapshot
}
const collectionPath = (runDir: string, graph: FrozenTaskGraph, task: ExperimentTask) => join(runDir, 'runtime', 'graphs', graph.id, 'collections', `${task.id}.json`)
const ackPath = (runDir: string, graph: FrozenTaskGraph, task: ExperimentTask) => join(runDir, 'runtime', 'graphs', graph.id, 'admitted', `${task.id}.json`)
async function optionalJson<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e } }

/** Match B3's canonical full JobSpec digest, including ordered argv and all resource limits. */
function jobSpecHash(spec: JobSpec): string {
  const encode = (value: unknown): string => Array.isArray(value) ? `[${value.map(encode).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`).join(',')}}`
    : JSON.stringify(value)
  return hashBytes(encode(spec))
}

async function bindJobIdentity(runDir: string, graph: FrozenTaskGraph, task: ExperimentTask, jobs: JobRecord[]): Promise<void> {
  const digest = jobSpecHash(task.job), existing = jobs.find(job => job.spec.id === task.job.id)
  if (existing && (existing.specHash !== digest || jobSpecHash(existing.spec) !== digest)) throw new Error('RUNTIME_JOB_SPEC_CONFLICT')
  if (jobs.some(job => job.spec.attemptId === task.job.attemptId && job.spec.id !== task.job.id)) throw new Error('RUNTIME_ATTEMPT_OWNER_CONFLICT')
  const binding = { graphId: graph.id, graphHash: graph.hash, taskId: task.id, contentHash: graph.contentHashes[task.id], jobId: task.job.id, attemptId: task.job.attemptId, specHash: digest }
  // Atomic ownership precedes enqueue. A crash here permits only this exact graph/spec to retry.
  for (const [kind, id] of [['ATTEMPT', task.job.attemptId], ['JOB', task.job.id]] as const) {
    const file = join(runDir, 'runtime', 'bindings', kind.toLowerCase(), `${hashBytes(id)}.json`)
    const prior = await optionalJson<typeof binding>(file)
    if (prior && hashContent(prior) !== hashContent(binding)) throw new Error(`RUNTIME_${kind}_OWNERSHIP_CONFLICT`)
    if (existing && !prior) {
      // Legacy/pre-enqueued jobs have no binding. Do not guess between two frozen owners.
      const otherOwner = (await listFrozenTaskGraphs(runDir)).some(other => other.hash !== graph.hash && other.tasks.some(t => t.job.id === task.job.id || t.job.attemptId === task.job.attemptId))
      if (otherOwner) throw new Error(`RUNTIME_${kind}_LEGACY_OWNER_CONFLICT`)
    }
    try { await immutableJson(file, binding) }
    catch (error) { if (/IMMUTABLE_RUNTIME_RECORD_CONFLICT/.test(String(error))) throw new Error(`RUNTIME_${kind}_OWNERSHIP_CONFLICT`); throw error }
  }
}

/** Only this graph's committed, status-only claim descendants may change active claim version. */
async function graphStaleness(runDir: string, graph: FrozenTaskGraph, current?: ResearchSnapshot): Promise<string | undefined> {
  const store = new ResearchStore(runDir), frozen = await store.loadSnapshot(graph.snapshotId)
  let cursor = current ?? await store.loadCurrent()
  if (!cursor) return 'RUNTIME_GRAPH_STALE_SNAPSHOT'
  const frozenClaim = frozen.claims.find(claim => claim.id === frozen.active_claim.id && claim.version === frozen.active_claim.version)!
  const frozenHypothesis = frozen.hypotheses.find(h => h.id === frozen.active_hypothesis.id && h.version === frozen.active_hypothesis.version)!
  const meaning = (claim: typeof frozenClaim) => {
    const { version, content_hash, created_at, status, reason, parents, supporting_evidence_ids, opposing_evidence_ids, ...content } = claim
    return hashContent(content)
  }
  const owned = new Map<string, CollectedTask>()
  for (const task of graph.tasks) {
    const collection = await readCollection(runDir, graph, task)
    if (collection) owned.set(`runtime-admission-${collection.admissionKey}`, collection)
  }
  while (true) {
    if (cursor.protocol.content_hash !== graph.protocolHash) return 'RUNTIME_GRAPH_STALE_PROTOCOL'
    if (cursor.branch_id !== frozen.branch_id) return 'RUNTIME_GRAPH_STALE_BRANCH'
    const hypothesis = cursor.hypotheses.find(h => h.id === cursor!.active_hypothesis.id && h.version === cursor!.active_hypothesis.version)
    if (!hypothesis || hypothesis.content_hash !== frozenHypothesis.content_hash) return 'RUNTIME_GRAPH_STALE_HYPOTHESIS'
    const claim = cursor.claims.find(c => c.id === cursor!.active_claim.id && c.version === cursor!.active_claim.version)
    if (!claim || claim.id !== frozenClaim.id || meaning(claim) !== meaning(frozenClaim)) return 'RUNTIME_GRAPH_STALE_CLAIM'
    if (cursor.id === frozen.id) return cursor.content_hash === graph.snapshotHash ? undefined : 'RUNTIME_GRAPH_STALE_SNAPSHOT'
    if (!cursor.parent_snapshot_id) return 'RUNTIME_GRAPH_STALE_LINEAGE'
    const parent = await store.loadSnapshot(cursor.parent_snapshot_id)
    if (hashContent(cursor.active_claim) !== hashContent(parent.active_claim)) {
      const collection = owned.get(cursor.id)
      if (!collection || !cursor.evidence.some(e => e.id === `runtime-evidence-${collection.admissionKey}`) || claim.version !== parent.active_claim.version + 1 ||
        hashContent(claim.parents) !== hashContent([parent.active_claim])) return 'RUNTIME_GRAPH_STALE_CLAIM_LINEAGE'
    }
    cursor = parent
  }
}
async function readCollection(runDir: string, graph: FrozenTaskGraph, task: ExperimentTask): Promise<CollectedTask | undefined> {
  const value = await optionalJson<CollectedTask>(collectionPath(runDir, graph, task))
  if (!value) return undefined
  const { hash, ...body } = value
  if (hashContent(body) !== hash || value.graphHash !== graph.hash || value.contentHash !== graph.contentHashes[task.id] || value.receipt.jobId !== task.job.id || value.admissionKey !== hashContent([task.job.attemptId, value.manifestHash, value.validatorVersion])) throw new Error('COLLECTION_HASH_MISMATCH')
  for (const ref of [...value.artifacts, ...value.sourceRefs]) if (!ref.path || !ref.hash || (await new ResearchStore(runDir).captureSource(ref.path, ref.id)).hash !== ref.hash) throw new Error('COLLECTION_SOURCE_HASH_MISMATCH')
  return value
}
async function collectTask(runDir: string, graph: FrozenTaskGraph, task: ExperimentTask, receipt: JobReceipt, runtimeRoot: string, snapshot: ResearchSnapshot): Promise<CollectedTask> {
  const analysisBytes = await readFile(new URL('./evidence-validator.js', import.meta.url))
  const validatorVersion = `${task.validatorId}:${hashBytes(analysisBytes)}`
  const scientific = task.stage === 'formal' || task.stage === 'reproduce'
  let manifest: ArtifactManifest | null = null, artifacts: SourceRef[] = [], validation: DomainValidation
  const unknown = (reason: string, invalid = false): DomainValidation => ({ validity: invalid ? 'invalid' : 'unknown', polarity: 'inconclusive', observation: reason, validation: { method: task.validatorId, passed: false, issues: [reason] } })
  if (receipt.status !== 'succeeded') validation = unknown(`job ${receipt.status}; exit code ${receipt.exitCode}; execution diagnostics only`)
  else {
    try {
      const captured = await captureJobArtifacts({ runDir, runtimeRoot, task, receipt, evaluatorVersion: validatorVersion })
      manifest = captured.manifest; artifacts = captured.artifacts
      if (scientific) validation = task.validatorId === snapshot.protocol.decision_rule ? validateScientificEvidence(captured.raw, snapshot.protocol, snapshot) : unknown('validator does not match frozen scientific protocol')
      else if (task.validatorId === 'artifact_integrity_v1') validation = { validity: 'valid', polarity: 'inconclusive', observation: 'Frozen output types, sizes and hashes verified; no scientific inference.', validation: { method: task.validatorId, passed: true, issues: [] } }
      else validation = unknown('unsupported task validator; exploratory output only')
    } catch (error) { validation = unknown(String(error), true) }
  }
  const manifestHash = hashContent(manifest ?? { receipt, collectionFailure: validation.validation.issues })
  const admissionKey = hashContent([task.job.attemptId, manifestHash, validatorVersion])
  const store = new ResearchStore(runDir)
  const sourceRefs = [await store.captureBytes(analysisBytes, `validator:${validatorVersion}`), await store.captureBytes(JSON.stringify({ receipt, manifest }), `collection:${task.id}`)]
  const body = { schema: 'autoresearch/collected-task/v1' as const, graphHash: graph.hash, taskId: task.id, contentHash: graph.contentHashes[task.id]!, receipt, manifest, manifestHash, admissionKey, validatorVersion, validation, artifacts, sourceRefs, completed: receipt.status === 'succeeded' && validation.validity === 'valid' && validation.validation.passed, scientific, createdAt: new Date().toISOString() }
  const collected = { ...body, hash: hashContent(body) }
  // This immutable collection is also the pending scientific-admission outbox.
  await immutableJson(collectionPath(runDir, graph, task), collected)
  return collected
}
async function admitCollection(runDir: string, graph: FrozenTaskGraph, task: ExperimentTask, collection: CollectedTask): Promise<void> {
  const store = new ResearchStore(runDir)
  if (collection.scientific || !collection.completed) {
    let current = (await store.loadCurrent())!
    const evidenceId = `runtime-evidence-${collection.admissionKey}`
    if (!current.evidence.some(e => e.id === evidenceId)) {
      const stale = await graphStaleness(runDir, graph, current)
      if (stale) throw new Error(stale)
      const frozen = await store.loadSnapshot(graph.snapshotId)
      const claim = frozen.claims.find(c => c.id === frozen.active_claim.id && c.version === frozen.active_claim.version)!
      const currentClaim = current.claims.find(c => c.id === current.active_claim.id && c.version === current.active_claim.version)!
      const hypothesis = current.hypotheses.find(h => h.id === current.active_hypothesis.id && h.version === current.active_hypothesis.version)!
      const evidence: Evidence = sealRecord({ id: evidenceId, version: 1, created_at: collection.createdAt, source_refs: [...collection.artifacts, ...collection.sourceRefs], target_claim: frozen.active_claim, protocol_hash: graph.protocolHash, attempt_id: task.job.attemptId, artifacts: collection.artifacts, analysis: collection.sourceRefs[0], ...collection.validation, execution: collection.receipt.status === 'succeeded' ? 'completed' : 'error', split: task.split!, mode: collection.scientific ? 'formal' : 'exploratory', fingerprints: frozen.protocol.fingerprints })
      const allEvidence = [...current.evidence, evidence]
      const assessment = assessEvidence({ claim, hypothesis, protocol: frozen.protocol, evidence: allEvidence.filter(e => e.protocol_hash === graph.protocolHash), discoveryEvidence: allEvidence, discoverySourceRefs: hypothesis.source_refs, createdAt: collection.createdAt })
      const updatedClaim = sealRecord({ ...claim, version: currentClaim.version + 1, parents: [{ id: currentClaim.id, version: currentClaim.version }], status: assessment.claim_status, supporting_evidence_ids: assessment.supporting_evidence_ids, opposing_evidence_ids: assessment.opposing_evidence_ids, reason: assessment.reason })
      const next = sealRecord({ ...current, id: `runtime-admission-${collection.admissionKey}`, version: current.version + 1, created_at: collection.createdAt, parent_snapshot_id: current.id, source_refs: [...current.source_refs, ...graph.sourceRefs, ...collection.sourceRefs], claims: [...current.claims, updatedClaim], active_claim: { id: updatedClaim.id, version: updatedClaim.version }, evidence: allEvidence, assessment })
      // ResearchStore CAS serializes writers. An interrupted CURRENT update can be replayed.
      const orphan = await optionalJson<ResearchSnapshot>(join(runDir, 'research', 'snapshots', next.id, 'manifest.json'))
      current = await store.commit(orphan ? await store.loadSnapshot(orphan.id) : next, current.content_hash)
    }
  }
  // Only acknowledgement follows ResearchStore commit. Restart checks evidence ID before replay.
  await immutableJson(ackPath(runDir, graph, task), { admissionKey: collection.admissionKey, collectionHash: collection.hash })
}
export async function advanceExperimentGraph(input: { runDir: string; graph: FrozenTaskGraph; runtime: ExperimentRuntimeAuthority }): Promise<ExperimentGraphResult> {
  const { runDir, runtime } = input
  const graph = await loadTaskGraph(runDir, input.graph.id)
  if (!graph || graph.hash !== input.graph.hash) throw new Error('TASK_GRAPH_FROZEN_IDENTITY_MISMATCH')
  if (!runtime || typeof runtime.authorize !== 'function') throw new Error('DURABLE_AUTHORITY_REQUIRED: configure trusted host localExecution authority; task graph was not dispatched')
  const snapshot = await new ResearchStore(runDir).loadSnapshot(graph.snapshotId)
  if (snapshot.content_hash !== graph.snapshotHash || snapshot.protocol.content_hash !== graph.protocolHash) throw new Error('TASK_GRAPH_SNAPSHOT_MISMATCH')
  const runtimeRoot = join(runDir, 'runtime', 'jobs')
  const limits = { maxConcurrentJobs: Math.min(graph.budget.maxConcurrentJobs, runtime.limits?.maxConcurrentJobs ?? 1), maxReservedWallMs: runtime.limits?.maxReservedWallMs ?? graph.budget.maxReservedWallMs }
  const store = await openJobStore(runtimeRoot, limits)
  try {
    const controller = new JobController(store, runtime.backendFactory?.(store) ?? new LocalJobBackend(store))
    const completed: CompletedTask[] = [], artifacts: string[] = []
    let blocked = await graphStaleness(runDir, graph)
    const accept = async (task: ExperimentTask, collected: CollectedTask) => {
      const stale = await graphStaleness(runDir, graph)
      if (stale) { blocked = stale; return }
      try { await admitCollection(runDir, graph, task, collected) }
      catch (error) { if (error instanceof Error && error.message.startsWith('RUNTIME_GRAPH_STALE_')) { blocked = error.message; return }; throw error }
      if (collected.completed) { completed.push({ taskId: task.id, protocolHash: task.protocolHash, inputHash: task.inputHash, contentHash: graph.contentHashes[task.id] }); artifacts.push(...collected.artifacts.map(ref => ref.path!)) }
      else blocked = `${task.id}: ${collected.validation.observation}`
    }
    const jobs = await store.list()
    const authorize = async (task: ExperimentTask): Promise<boolean> => {
      const before = await graphStaleness(runDir, graph)
      if (before) { blocked = before; return false }
      for (const source of task.inputs ?? []) if ((await new ResearchStore(runDir).captureSource(source.path!, source.id)).hash !== source.hash) throw new Error('TASK_GRAPH_INPUT_CHANGED_BEFORE_DISPATCH')
      await runtime.authorize(structuredClone(task.job), structuredClone(task))
      // Host approval may await user input; its return does not freeze scientific state.
      const after = await graphStaleness(runDir, graph)
      if (after) { blocked = after; return false }
      return true
    }
    for (const task of graph.tasks) {
      if (jobs.some(job => job.spec.id === task.job.id || job.spec.attemptId === task.job.attemptId)) await bindJobIdentity(runDir, graph, task, jobs)
      const collected = await readCollection(runDir, graph, task)
      if (collected) { await accept(task, collected); continue }
      if (jobs.some(j => j.spec.id === task.job.id)) {
        if (jobs.find(j => j.spec.id === task.job.id)!.receipt.status === 'queued') {
          if (!readyTasks(graph.tasks, completed).some(t => t.id === task.id)) continue
          if (!await authorize(task)) continue
        }
        const receipt = await controller.advance(task.job.id)
        if (terminal(receipt.status)) await accept(task, await collectTask(runDir, graph, task, receipt, runtimeRoot, snapshot))
      }
    }
    let live = (await store.list()).filter(j => !terminal(j.receipt.status))
    if (!blocked && live.length < limits.maxConcurrentJobs) {
      const next = readyTasks(graph.tasks, completed).find(task => !jobs.some(j => j.spec.id === task.job.id))
      if (next) {
        if (await authorize(next)) {
        await bindJobIdentity(runDir, graph, next, await store.list())
        await controller.enqueue(next.job)
        const stale = await graphStaleness(runDir, graph)
        if (stale) blocked = stale
        else {
          const receipt = await controller.advance(next.job.id)
          if (terminal(receipt.status)) await accept(next, await collectTask(runDir, graph, next, receipt, runtimeRoot, snapshot))
        }
        }
      }
    }
    live = (await store.list()).filter(j => !terminal(j.receipt.status))
    const result: ExperimentGraphResult = { status: blocked ? 'paused' : completed.length === graph.tasks.length ? 'completed' : 'waiting', reason: blocked ?? (completed.length === graph.tasks.length ? 'Every task passed its frozen validator.' : live.some(j => j.receipt.status === 'unknown') ? 'Job outcome unknown; inspect the same job, never redispatch.' : 'Durable jobs pending; resume to inspect and collect.'), completed, pendingJobs: live.map(j => j.receipt), artifacts, budget: await store.budget() }
    await writeRuntimeHandoff(runDir, graph, result)
    return result
  } finally { await store.close() }
}
export async function writeRuntimeHandoff(runDir: string, graph: FrozenTaskGraph, result?: ExperimentGraphResult): Promise<void> {
  const snapshot = await new ResearchStore(runDir).loadCurrent()
  const text = ['# Research handoff', '', `Goal: ${graph.goal}`, `Snapshot: ${snapshot?.id} (${snapshot?.content_hash})`, `Protocol: ${graph.protocolHash}`, `Graph: ${graph.id} (${graph.hash})`, `Status: ${result?.status ?? 'frozen'}`, `Next action: ${result?.reason ?? 'Resume durable job reconciliation.'}`, `Conflicts: ${snapshot?.assessment?.conflicts.join('; ') || 'none recorded'}`, `Budget: ${JSON.stringify(result?.budget ?? graph.budget)}`, '', '## Sources', ...graph.sourceRefs.map(s => `- ${s.id}: ${s.path}#${s.hash}`), '', '## Tasks and jobs', ...graph.tasks.map(t => `- ${t.id} -> ${t.job.id} / ${t.job.attemptId}; stage=${t.stage}; dependencies=${t.dependsOn.join(',')}; state=${result?.completed.some(c => c.taskId === t.id) ? 'validated' : result?.pendingJobs.find(j => j.jobId === t.job.id)?.status ?? 'pending'}`), '', 'This view is rebuilt from frozen graphs, job receipts, immutable collection outbox and committed ResearchStore snapshots. It is not a recovery input.', ''].join('\n')
  await writeText(join(runDir, 'HANDOFF.md'), text)
}
export async function listFrozenTaskGraphs(runDir: string): Promise<FrozenTaskGraph[]> {
  let ids: string[]; try { ids = await readdir(join(runDir, 'runtime', 'graphs')) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  const graphs: FrozenTaskGraph[] = []
  for (const id of ids.sort()) { const graph = await loadTaskGraph(runDir, id); if (graph) graphs.push(graph) }
  return graphs
}

export async function readExperimentGraphState(runDir: string, graph: FrozenTaskGraph): Promise<ExperimentGraphResult> {
  try { await access(join(runDir, 'runtime', 'jobs', 'jobs.sqlite')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { status: 'waiting', reason: 'No job submitted. Configure trusted host localExperiments authority and resume.', completed: [], pendingJobs: [], artifacts: [], budget: { reservedWallMs: 0, settledWallMs: 0, activeJobs: 0, cpuSeconds: null, gpuSeconds: null, costMicros: null } }
  }
  const store = await openJobStore(join(runDir, 'runtime', 'jobs'))
  try {
    const completed: CompletedTask[] = [], artifacts: string[] = []; let blocked: string | undefined
    for (const task of graph.tasks) {
      const collection = await readCollection(runDir, graph, task)
      const ack = await optionalJson<{ admissionKey: string; collectionHash: string }>(ackPath(runDir, graph, task))
      if (collection && ack && (ack.admissionKey !== collection.admissionKey || ack.collectionHash !== collection.hash)) throw new Error('ADMISSION_ACK_MISMATCH')
      if (collection?.completed && ack) { completed.push({ taskId: task.id, protocolHash: task.protocolHash, inputHash: task.inputHash, contentHash: graph.contentHashes[task.id] }); artifacts.push(...collection.artifacts.map(ref => ref.path!)) }
      if (collection && !collection.completed) blocked = collection.validation.observation
    }
    const pendingJobs = (await store.list()).filter(j => graph.tasks.some(t => t.job.id === j.spec.id) && !terminal(j.receipt.status)).map(j => j.receipt)
    return { status: blocked ? 'paused' : completed.length === graph.tasks.length ? 'completed' : 'waiting', reason: blocked ?? (completed.length === graph.tasks.length ? 'Every task passed its frozen validator.' : 'Resume to inspect persisted jobs and consume pending collection outbox.'), completed, pendingJobs, artifacts, budget: await store.budget() }
  } finally { await store.close() }
}

/** Reconstruct from host state; no model/stage artifact path participates in admission. */
export async function rehydrateVerifiedCompletedGraphAction(runDir: string, graph: FrozenTaskGraph): Promise<import('../core/types.js').ActionResult | undefined> {
  const frozen = await loadTaskGraph(runDir, graph.id)
  if (!frozen || frozen.hash !== graph.hash) throw new Error('RUNTIME_GRAPH_HASH_MISMATCH')
  const state = await readExperimentGraphState(runDir, frozen)
  if (state.status !== 'completed') return undefined
  const stale = await graphStaleness(runDir, frozen)
  if (stale) throw new Error(stale)
  const store = await openJobStore(join(runDir, 'runtime', 'jobs'))
  try {
    const jobs = await store.list()
    for (const task of frozen.tasks) {
      const job = jobs.find(job => job.spec.id === task.job.id)
      const collection = await readCollection(runDir, frozen, task)
      if (!job || !collection?.completed || job.specHash !== jobSpecHash(task.job) || jobSpecHash(job.spec) !== jobSpecHash(task.job) || hashContent(job.receipt) !== hashContent(collection.receipt) || job.receipt.status !== 'succeeded' || collection.receipt.protocolHash !== frozen.protocolHash || collection.receipt.inputHash !== task.inputHash || !collection.manifest || hashContent(collection.manifest) !== collection.manifestHash || hashBytes(JSON.stringify(collection.manifest.artifacts.map(file => ({ path: file.relativePath, bytes: file.bytes, hash: file.sha256 })))) !== job.receipt.artifactManifestHash) throw new Error('RUNTIME_COMPLETED_HOST_PROOF_MISMATCH')
      if (collection.artifacts.some(ref => !ref.path?.startsWith('research/sources/'))) throw new Error('RUNTIME_CAPTURED_SOURCE_REQUIRED')
    }
    return { status: 'completed', summary: state.reason, artifacts: state.artifacts }
  } finally { await store.close() }
}

export async function projectRuntimeTasks(runDir: string, tree: ResearchTree): Promise<void> {
  for (const graph of await listFrozenTaskGraphs(runDir)) {
    const snapshot = await new ResearchStore(runDir).loadSnapshot(graph.snapshotId)
    const parent = `research:${snapshot.active_hypothesis.id}@${snapshot.active_hypothesis.version}`
    if (!tree.query({ id: parent }).length) tree.add('hypothesis', snapshot.hypotheses.find(h => h.id === snapshot.active_hypothesis.id && h.version === snapshot.active_hypothesis.version)!.statement, { id: parent })
    const state = await readExperimentGraphState(runDir, graph)
    for (const task of graph.tasks) {
      const id = `runtime:${graph.id}:${task.id}`, collection = await readCollection(runDir, graph, task)
      const status = state.completed.some(c => c.taskId === task.id) ? 'completed' : collection ? collection.validation.validity : state.pendingJobs.find(j => j.jobId === task.job.id)?.status ?? 'queued'
      const attrs = { status, parent, artifacts: collection?.artifacts.map(ref => ref.path!) ?? [], content: `${task.stage}: ${task.id}; job ${task.job.id}; validator ${task.validatorId}` }
      const node = tree.query({ id }).length ? tree.update(id, attrs) : tree.add('action', attrs.content, { id, ...attrs })
      node.runtimeTask = { graphId: graph.id, graphHash: graph.hash, taskId: task.id, jobId: task.job.id, attemptId: task.job.attemptId, dependsOn: task.dependsOn, candidateIds: (snapshot.candidate_batches ?? []).flatMap(b => b.selection.selectedId ? [b.selection.selectedId] : []), snapshotHash: graph.snapshotHash, ...(collection ? { admissionKey: collection.admissionKey } : {}) }
    }
  }
}
