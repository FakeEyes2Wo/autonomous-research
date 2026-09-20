import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { hashBytes } from '../../dist/research/records.js'
import { createInitialState, saveState } from '../../dist/core/state.js'
import { atomicWriteJson } from '../../dist/core/utils.js'
import { enqueueRetirement, isCleanupTaskRetired, persistRetirementMemory } from '../../dist/cleanup/queue.js'
import { isDirectionRetired } from '../../dist/cleanup/index.js'
import { executeCleanupTask } from '../../dist/cleanup/executor.js'
import { inspectCleanupProtection } from '../../dist/cleanup/runtime.js'
import { markDirectionBoundaryCaptured, openDirectionManifest, registerManagedArtifact } from '../../dist/cleanup/manifest.js'
import { directionId, type DirectionRef, type ManagedArtifact } from '../../dist/cleanup/direction-id.js'
import { findSourceTombstone, loadSourceTombstones } from '../../dist/cleanup/tombstones.js'
import { openJobStore } from '../../dist/runtime/job-store.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ar-cleanup-safety-'))
  const projectDir = join(root, 'project')
  const runDir = join(root, 'run')
  await mkdir(projectDir, { recursive: true })
  await mkdir(runDir, { recursive: true })
  const project = resolve(projectDir)
  const identity = { version: 1, projectDir: project, projectId: hashBytes(JSON.stringify({ projectDir: project })), workflow: 'research', validation: 'bounded-supplementary', options: {} }
  await atomicWriteJson(join(runDir, '.autoresearch', 'project-identity.json'), identity)
  const state = await createInitialState(runDir)
  state.status = 'COMPLETED'
  await saveState(runDir, state)
  const direction: DirectionRef = { projectId: project, branchId: 'branch', claim: { id: 'claim', version: 1 }, hypothesis: { id: 'hypothesis', version: 1 }, protocolHash: 'protocol' }
  return { root, projectDir: project, runDir, direction }
}

async function target(f: Awaited<ReturnType<typeof fixture>>, name = 'result.txt'): Promise<{ manifest: Awaited<ReturnType<typeof openDirectionManifest>>; artifact: ManagedArtifact }> {
  const relativePath = `work/cycle-01/${name}`
  const file = join(f.runDir, relativePath)
  await mkdir(join(f.runDir, 'work', 'cycle-01'), { recursive: true })
  await writeFile(file, 'direction output')
  const manifest = await openDirectionManifest(f.runDir, f.direction)
  const artifact = await registerManagedArtifact(f.runDir, manifest.id, { relativePath, sourceId: 'source-output', kind: 'experiment', producer: 'autoresearch-controller' })
  return { manifest: await openDirectionManifest(f.runDir, f.direction), artifact }
}

async function taskFor(f: Awaited<ReturnType<typeof fixture>>, manifest: Awaited<ReturnType<typeof openDirectionManifest>>, artifact: ManagedArtifact) {
  const pending = await enqueueRetirement({ projectDir: f.projectDir, runDir: f.runDir, direction: f.direction, disposition: 'abandoned', idea: 'A bounded idea', reason: 'Explicitly abandoned by the user', avoidRepeat: 'Do not retry this exact direction', targets: [artifact], manifestId: manifest.id, manifestHash: manifest.contentHash })
  return persistRetirementMemory(f.projectDir, pending)
}

test('cleanup verifies project identity and removes an exact exclusive target', async () => {
  const f = await fixture()
  try {
    const { manifest, artifact } = await target(f)
    const task = await taskFor(f, manifest, artifact)
    const result = await executeCleanupTask(f.projectDir, task)
    assert.equal(result.task.state, 'completed')
    await assert.rejects(readFile(join(f.runDir, artifact.relativePath)), { code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('cleanup blocks a run whose durable project identity does not match the task', async () => {
  const f = await fixture()
  try {
    const { manifest, artifact } = await target(f)
    const task = await taskFor(f, manifest, artifact)
    await atomicWriteJson(join(f.runDir, '.autoresearch', 'project-identity.json'), { version: 1, projectDir: resolve(f.root, 'other'), projectId: 'wrong', workflow: 'research', validation: 'bounded-supplementary', options: {} })
    const result = await executeCleanupTask(f.projectDir, task)
    assert.equal(result.task.state, 'blocked')
    assert.match(result.blocked.join(' '), /identity|scope/i)
    assert.equal(await readFile(join(f.runDir, artifact.relativePath), 'utf8'), 'direction output')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('cleanup fails closed when a parent directory becomes a junction or symlink', async () => {
  const f = await fixture()
  const outside = join(f.root, 'outside')
  try {
    const { manifest, artifact } = await target(f)
    const task = await taskFor(f, manifest, artifact)
    await rm(join(f.runDir, 'work'), { recursive: true, force: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'result.txt'), 'outside')
    await symlink(outside, join(f.runDir, 'work'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await executeCleanupTask(f.projectDir, task)
    assert.equal(result.task.state, 'blocked')
    assert.match(result.blocked.join(' '), /symlink|escape|unreadable/i)
    assert.equal(await readFile(join(outside, 'result.txt'), 'utf8'), 'outside')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('cleanup fails closed on a malformed sibling direction manifest', async () => {
  const f = await fixture()
  try {
    const { manifest, artifact } = await target(f)
    await writeFile(join(f.runDir, '.autoresearch', 'directions', 'malformed.json'), '{not-json')
    const task = await taskFor(f, manifest, artifact)
    const result = await executeCleanupTask(f.projectDir, task)
    assert.equal(result.task.state, 'blocked')
    assert.equal(await readFile(join(f.runDir, artifact.relativePath), 'utf8'), 'direction output')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('cleanup protects a target referenced by another direction regardless of ownership label', async () => {
  const f = await fixture()
  try {
    const { manifest, artifact } = await target(f)
    const otherDirection = { ...f.direction, hypothesis: { id: 'other-hypothesis', version: 1 } }
    const other = await openDirectionManifest(f.runDir, otherDirection)
    await writeFile(join(f.runDir, artifact.relativePath), 'direction output')
    await registerManagedArtifact(f.runDir, other.id, { relativePath: artifact.relativePath, sourceId: artifact.sourceId, kind: artifact.kind, producer: artifact.producer, ownership: 'user' })
    const task = await taskFor(f, manifest, artifact)
    const result = await executeCleanupTask(f.projectDir, task)
    assert.equal(result.task.state, 'blocked')
    assert.match(result.blocked.join(' '), /shared|target/i)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('cleanup protects every nonterminal orphan job in the durable jobs database', async () => {
  const f = await fixture()
  try {
    const { manifest, artifact } = await target(f)
    const task = await taskFor(f, manifest, artifact)
    const jobs = await openJobStore(join(f.runDir, 'runtime', 'jobs'), { maxConcurrentJobs: 1, maxReservedWallMs: 10_000 })
    await jobs.enqueue({
      id: 'orphan-job', attemptId: 'orphan-attempt', taskId: 'orphan-task', protocolHash: 'protocol', inputHash: 'input',
      executable: process.execPath, args: [], cwd: f.runDir, env: {}, checkpoint: null,
      budget: { wallMs: 100, cpuSeconds: null, gpuSeconds: null, costMicros: null, maxLogBytes: 100, maxArtifactBytes: 100 },
    })
    await jobs.close()
    const protection = await inspectCleanupProtection(task)
    assert.equal(protection.safe, false)
    assert.match(protection.reasons.join(' '), /live_job:orphan-job:queued/)
    assert.match(protection.reasons.join(' '), /orphan_job:orphan-job/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('concurrent cleanup callers observe the durable completed state after one deletion', async () => {
  const f = await fixture()
  try {
    const { manifest, artifact } = await target(f)
    const task = await taskFor(f, manifest, artifact)
    const results = await Promise.all([executeCleanupTask(f.projectDir, task), executeCleanupTask(f.projectDir, task)])
    assert.ok(results.every(result => result.task.state === 'completed'))
    assert.equal(await readFile(join(f.runDir, artifact.relativePath)).catch(error => (error as NodeJS.ErrnoException).code), 'ENOENT')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('a blocked partial deletion resumes from durable per-target progress', async () => {
  const f = await fixture()
  try {
    const first = await target(f, 'first.txt')
    const second = await target(f, 'second.txt')
    const pending = await enqueueRetirement({ projectDir: f.projectDir, runDir: f.runDir, direction: f.direction, disposition: 'abandoned', idea: 'A bounded idea', reason: 'Explicitly abandoned by the user', avoidRepeat: 'Do not retry this exact direction', targets: [first.artifact, second.artifact], manifestId: second.manifest.id, manifestHash: second.manifest.contentHash })
    const task = await persistRetirementMemory(f.projectDir, pending)
    await writeFile(join(f.runDir, second.artifact.relativePath), 'changed after registration')
    const blocked = await executeCleanupTask(f.projectDir, task)
    assert.equal(blocked.task.state, 'blocked')
    await writeFile(join(f.runDir, second.artifact.relativePath), 'direction output')
    const resumed = await executeCleanupTask(f.projectDir, blocked.task)
    assert.equal(resumed.task.state, 'completed')
    await assert.rejects(readFile(join(f.runDir, first.artifact.relativePath)), { code: 'ENOENT' })
    await assert.rejects(readFile(join(f.runDir, second.artifact.relativePath)), { code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('empty target receipt blocks when the manifest still proves exclusive payload', async () => {
  const f = await fixture()
  try {
    const { manifest } = await target(f)
    const pending = await enqueueRetirement({ projectDir: f.projectDir, runDir: f.runDir, direction: f.direction, disposition: 'abandoned', idea: 'A bounded idea', reason: 'Explicitly abandoned by the user', avoidRepeat: 'Do not retry this exact direction', targets: [], manifestId: manifest.id, manifestHash: manifest.contentHash })
    const task = await persistRetirementMemory(f.projectDir, pending)
    const result = await executeCleanupTask(f.projectDir, task)
    assert.equal(result.task.state, 'blocked')
    assert.match(result.blocked.join(' '), /empty cleanup target|exclusive/i)
    assert.equal(await readFile(join(f.runDir, 'work', 'cycle-01', 'result.txt'), 'utf8'), 'direction output')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('empty target receipt completes only for a captured manifest with no exclusive payload', async () => {
  const f = await fixture()
  try {
    const relativePath = 'research/shared-source.txt'
    await mkdir(join(f.runDir, 'research'), { recursive: true })
    await writeFile(join(f.runDir, relativePath), 'shared')
    const opened = await openDirectionManifest(f.runDir, f.direction)
    await registerManagedArtifact(f.runDir, opened.id, { relativePath, sourceId: 'shared-source', kind: 'research-source', producer: 'research-store', ownership: 'shared' })
    const manifest = await markDirectionBoundaryCaptured(f.runDir, opened.id)
    const pending = await enqueueRetirement({ projectDir: f.projectDir, runDir: f.runDir, direction: f.direction, disposition: 'abandoned', idea: 'A bounded idea', reason: 'Explicitly abandoned by the user', avoidRepeat: 'Do not retry this exact direction', targets: [], manifestId: manifest.id, manifestHash: manifest.contentHash })
    const task = await persistRetirementMemory(f.projectDir, pending)
    const result = await executeCleanupTask(f.projectDir, task)
    assert.equal(result.task.state, 'completed')
    assert.equal(await readFile(join(f.runDir, relativePath), 'utf8'), 'shared')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('source tombstone failure leaves a retired partial task and retry restores the historical ref', async () => {
  const f = await fixture()
  try {
    const { manifest, artifact } = await target(f, 'source.bin')
    const task = await taskFor(f, manifest, artifact)
    const tombstoneDir = join(f.runDir, '.autoresearch', 'cleanup', 'tombstones')
    await mkdir(tombstoneDir, { recursive: true })
    // writeSourceTombstone checks the legacy hash filename after the exact
    // composite filename. Invalid JSON injects a post-unlink failure while
    // leaving the durable target progress at started.
    await writeFile(join(tombstoneDir, `${artifact.hash}.json`), '{broken')
    const blocked = await executeCleanupTask(f.projectDir, task)
    assert.equal(blocked.task.state, 'blocked')
    assert.equal(await isCleanupTaskRetired(f.projectDir, blocked.task), true)
    const snapshot = { branch_id: f.direction.branchId, active_claim: f.direction.claim, active_hypothesis: f.direction.hypothesis, protocol: { content_hash: f.direction.protocolHash } }
    assert.equal(await isDirectionRetired({ projectDir: f.projectDir, runDir: f.runDir, snapshot: snapshot as never }), true)
    const newFile = join(f.runDir, 'work', 'cycle-01', 'after-retirement.txt')
    await writeFile(newFile, 'new direction output')
    await assert.rejects(() => registerManagedArtifact(f.runDir, manifest.id, { relativePath: 'work/cycle-01/after-retirement.txt', sourceId: 'new-source', kind: 'experiment', producer: 'autoresearch-controller' }), /retired/i)
    await rm(join(tombstoneDir, `${artifact.hash}.json`), { force: true })
    const resumed = await executeCleanupTask(f.projectDir, blocked.task)
    assert.equal(resumed.task.state, 'completed')
    assert.equal(await isDirectionRetired({ projectDir: f.projectDir, runDir: f.runDir, snapshot: snapshot as never }), true)
    assert.equal((await loadSourceTombstones(f.runDir)).length, 1)
    assert.ok(await findSourceTombstone(f.runDir, { id: artifact.sourceId!, path: artifact.relativePath, hash: artifact.hash }))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
