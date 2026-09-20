import { listCleanupTasks, enqueueRetirement, persistRetirementMemory, saveCleanupTask, refreshCleanupTargets, isCleanupTaskRetired } from './queue.js'
import { executeCleanupTask } from './executor.js'
import { loadDirectionManifest } from './manifest.js'
import { registerDirectionCycleArtifacts } from './registration.js'
import { directionId, type CleanupTask, type DirectionRef, type ManagedArtifact } from './direction-id.js'
import type { ResearchSnapshot } from '../research/contracts.js'
import { hashContent } from '../research/records.js'
import { mechanismKey } from '../research/candidates.js'
import { ResearchStore } from '../research/store.js'

export * from './direction-id.js'
export * from './manifest.js'
export * from './queue.js'
export * from './runtime.js'
export * from './tombstones.js'
export * from './executor.js'
export * from './registration.js'

function directionFromSnapshot(projectDir: string, snapshot: ResearchSnapshot): DirectionRef {
  return { projectId: projectDir, branchId: snapshot.branch_id, claim: snapshot.active_claim, hypothesis: snapshot.active_hypothesis, protocolHash: snapshot.protocol.content_hash }
}

function selectedMechanismKey(snapshot: ResearchSnapshot): string | undefined {
  const active = snapshot.hypotheses.find(item => item.id === snapshot.active_hypothesis.id && item.version === snapshot.active_hypothesis.version)
  const parent = active?.parents[0]
  if (!active || !parent) return undefined
  for (const batch of [...(snapshot.candidate_batches ?? [])].reverse()) for (const entry of [...batch.entries].reverse()) {
    const candidate = entry.candidate, revision = entry.revision
    if (candidate.status !== 'selected' || candidate.parent.id !== parent.id || candidate.parent.version !== parent.version || !revision) continue
    if (revision.statement === active.statement && revision.scope === active.scope && revision.mechanism === active.mechanism &&
      revision.prediction === active.prediction && revision.falsification === active.falsification && revision.measurement === active.measurement &&
      revision.decision_rule === active.decision_rule) return candidate.mechanismKey
  }
  return undefined
}

/** A retired direction may be resumed only as a lifecycle no-op. */
export async function isDirectionRetired(input: { projectDir: string; runDir: string; snapshot: ResearchSnapshot }): Promise<boolean> {
  const id = directionId(directionFromSnapshot(input.projectDir, input.snapshot))
  const task = (await listCleanupTasks(input.projectDir)).find(item => item.runDir === input.runDir && item.directionId === id)
  return task ? await isCleanupTaskRetired(input.projectDir, task) : false
}

/**
 * Complete the last direction-owned write boundary in one idempotent sequence.
 * A retired manifest is immutable, so a completed/deleting task skips new
 * registration but still advances its resumable queue.
 */
export async function finalizeDirectionRetirement(input: { projectDir: string; runDir: string; cycle: number; snapshot: ResearchSnapshot }): Promise<void> {
  const direction = directionFromSnapshot(input.projectDir, input.snapshot)
  const id = directionId(direction)
  const existing = (await listCleanupTasks(input.projectDir)).find(task => task.runDir === input.runDir && task.directionId === id)
  const retired = existing ? await isCleanupTaskRetired(input.projectDir, existing) : false
  if (!retired) {
    try {
      await registerDirectionCycleArtifacts({ runDir: input.runDir, cycle: input.cycle, direction, snapshot: input.snapshot })
      const manifest = await loadDirectionManifest(input.runDir, id)
      await refreshRunCleanupTargets(input.projectDir, input.runDir, direction, manifest)
    } catch (error) {
      // The canonical refutation still gets a durable pending task. The task
      // will become blocked with a concise retry error until registration is
      // repaired; cleanup failure must not become a science failure.
      void error
    }
  }
  await enqueueRefutedDirection({ projectDir: input.projectDir, runDir: input.runDir, snapshot: input.snapshot })
  await advanceCleanupQueue(input.projectDir)
}

/** Confirmed formal refutation is the only automatic scientific retirement trigger. */
export async function enqueueRefutedDirection(input: { projectDir: string; runDir: string; snapshot: ResearchSnapshot }): Promise<CleanupTask | undefined> {
  const canonical = await new ResearchStore(input.runDir).loadSnapshot(input.snapshot.id)
  if (canonical.content_hash !== input.snapshot.content_hash) throw new Error('cleanup refutation snapshot is not canonical')
  const snapshot = canonical
  if (snapshot.assessment?.category !== 'hypothesis_refuted' || snapshot.assessment.claim_status !== 'refuted') return undefined
  const activeClaim = snapshot.claims.find(claim => claim.id === snapshot.active_claim.id && claim.version === snapshot.active_claim.version)
  if (!activeClaim || activeClaim.status !== 'refuted' || snapshot.assessment.claim.id !== snapshot.active_claim.id || snapshot.assessment.claim.version > snapshot.active_claim.version || snapshot.assessment.protocol_hash !== snapshot.protocol.content_hash) return undefined
  const direction = directionFromSnapshot(input.projectDir, snapshot)
  const id = directionId(direction)
  let targets: ManagedArtifact[] = []
  let manifestId: string | undefined
  let manifestHash: string | undefined
  try {
    const manifest = await loadDirectionManifest(input.runDir, id)
    manifestId = manifest.id
    manifestHash = manifest.contentHash
    targets = manifest.artifacts.filter(artifact => artifact.ownership === 'direction')
  } catch { /* historical/unregistered ownership is intentionally blocked by the executor */ }
  const hypothesis = snapshot.hypotheses.find(item => item.id === snapshot.active_hypothesis.id && item.version === snapshot.active_hypothesis.version)
  const compactIdea = hypothesis?.statement.replace(/[\\/]+/gu, ' ').replace(/[\r\n]+/gu, ' ').trim().slice(0, 220) || `Hypothesis ${snapshot.active_hypothesis.id}@${snapshot.active_hypothesis.version}`
  const mechanism = selectedMechanismKey(snapshot)
  return enqueueRetirement({
    projectDir: input.projectDir,
    runDir: input.runDir,
    direction,
    disposition: 'refuted',
    idea: compactIdea,
    reason: 'Validated formal evidence refuted this direction.',
    avoidRepeat: 'Do not retry this hypothesis under the same frozen protocol.',
    ...(mechanism ? { mechanismKey: mechanism } : {}),
    targets,
    ...(manifestId ? { manifestId } : {}),
    ...(manifestHash ? { manifestHash } : {}),
  })
}

/** Explicit user-facing abandonment entry point; it never changes scientific status. */
export async function abandonDirection(input: { projectDir: string; runDir: string; direction: DirectionRef; idea: string; reason: string; avoidRepeat: string; targets?: ManagedArtifact[]; manifestId?: string; manifestHash?: string }): Promise<CleanupTask> {
  return enqueueRetirement({ ...input, disposition: 'abandoned' })
}

/** Startup/resume and post-decision hook. Memory failures remain pending and retryable. */
export async function advanceCleanupQueue(projectDir: string): Promise<CleanupTask[]> {
  const results: CleanupTask[] = []
  for (const original of await listCleanupTasks(projectDir)) {
    if (original.state === 'completed') { results.push(original); continue }
    let task = original
    if (task.state === 'pending') {
      try { task = await persistRetirementMemory(projectDir, task) }
      catch (error) {
        task = await saveCleanupTask(projectDir, { ...task, lastError: `memory: ${String(error)}` })
        results.push(task)
        continue
      }
    }
    const result = await executeCleanupTask(projectDir, task)
    results.push(result.task)
  }
  return results
}

export async function refreshRunCleanupTargets(projectDir: string, runDir: string, direction: DirectionRef, manifest: { id: string; contentHash: string; artifacts: ManagedArtifact[] }): Promise<void> {
  for (const task of await listCleanupTasks(projectDir)) if (task.runDir === runDir && task.directionId === directionId(direction)) {
    await refreshCleanupTargets(projectDir, task.id, manifest.artifacts.filter(artifact => artifact.ownership === 'direction'), manifest.id, manifest.contentHash)
  }
}
