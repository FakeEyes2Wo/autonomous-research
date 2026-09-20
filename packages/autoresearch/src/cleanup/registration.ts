import { lstat, mkdir, readFile, readdir, realpath, open } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { atomicWriteJson, readOptionalText, safeResolve } from '../core/utils.js'
import { loadDirectionManifest, markDirectionBoundaryCaptured, registerManagedArtifact } from './manifest.js'
import type { DirectionRef, ManagedArtifact } from './direction-id.js'
import { directionId, validateManagedRelativePath } from './direction-id.js'
import type { ResearchSnapshot, SourceRef, VersionRef } from '../research/contracts.js'
import { hashBytes } from '../research/records.js'
import { loadTaskGraph, type FrozenTaskGraph } from '../experiment/task-graph.js'
import { ExperimentPauseError } from '../experiment/errors.js'
import { canonicalRelativePath, validateWorkerResult } from '../experiment/validation.js'
import type { ActionResult } from '../core/types.js'

export interface DirectionGenerationArtifact {
  relativePath: string
  hash: string
  bytes?: number
  sourceId?: string
  kind: string
  producer: string
  ownership?: ManagedArtifact['ownership']
}

/** A controller-generated receipt is the only authority for mixed-root direction ownership. */
export interface DirectionGenerationReceipt {
  schema?: 'autoresearch/direction-generation/v1'
  protocolHash: string
  claim: VersionRef
  hypothesis: VersionRef
  artifacts: DirectionGenerationArtifact[]
}

export interface RegisterDirectionCycleInput {
  runDir: string
  cycle: number
  manifestId?: string
  direction?: DirectionRef
  snapshot?: ResearchSnapshot
  generationReceipt?: DirectionGenerationReceipt
}

const CYCLE_ROOTS = (runDir: string, cycle: number): string[] => [
  join(runDir, 'cycles', `cycle-${cycle}`),
  join(runDir, 'work', `cycle-${String(cycle).padStart(2, '0')}`),
  join(runDir, 'work', `experiment-cycle-${String(cycle).padStart(2, '0')}`),
  join(runDir, 'runtime', 'graphs', `cycle-${cycle}`),
]
const MIXED_ROOTS = (runDir: string): string[] => [
  join(runDir, 'work'), join(runDir, 'logs'), join(runDir, 'cache'), join(runDir, 'caches'),
  join(runDir, 'artifacts'), join(runDir, 'outputs'), join(runDir, 'results'),
  join(runDir, 'original'), join(runDir, 'originals'),
  join(runDir, 'research', 'original'), join(runDir, 'research', 'originals'),
  join(runDir, 'runtime', 'jobs'), join(runDir, 'runtime', 'jobs', 'jobs'),
]
const JOB_ROOT = 'runtime/jobs/jobs'
const SOURCE_ROOT = 'research/sources'
const MIXED_RELATIVE_ROOTS = ['work', 'logs', 'cache', 'caches', 'artifacts', 'outputs', 'results', 'original', 'originals', 'research/original', 'research/originals', 'runtime/jobs', 'runtime/jobs/jobs']
const boundaryLocks = new Map<string, Promise<void>>()

function sameRef(left: VersionRef, right: VersionRef): boolean { return left.id === right.id && left.version === right.version }
function under(relativePath: string, root: string): boolean { return relativePath === root || relativePath.startsWith(`${root}/`) }
function asRelative(runDir: string, file: string): string {
  const value = relative(resolve(runDir), resolve(file)).replaceAll('\\', '/')
  validateManagedRelativePath(value)
  return value
}

function rejectManagedSymlink(path: string): never {
  throw new ExperimentPauseError(`managed output resolves outside the run directory (symlink is not allowed): ${path}`)
}

function hasBoundaryInventory(relativePath: string): boolean {
  if (!relativePath.includes('/')) return true
  if (MIXED_RELATIVE_ROOTS.some(root => under(relativePath, root))) return true
  return /^cycles\/cycle-\d+(?:\/|$)/u.test(relativePath) || /^runtime\/graphs\/cycle-\d+(?:\/|$)/u.test(relativePath)
}

async function filesUnder(root: string): Promise<string[]> {
  let rootInfo
  try { rootInfo = await lstat(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (rootInfo.isSymbolicLink()) rejectManagedSymlink(root)
  if (rootInfo.isFile()) return [root]
  if (!rootInfo.isDirectory()) return []
  const output: string[] = []
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), info = await lstat(path)
      if (info.isSymbolicLink()) rejectManagedSymlink(path)
      if (info.isDirectory()) await walk(path)
      else if (info.isFile()) output.push(path)
    }
  }
  await walk(root)
  return output
}

async function rootFiles(runDir: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of (await readdir(runDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.autoresearch') continue
    const path = join(runDir, entry.name), info = await lstat(path)
    if (info.isSymbolicLink()) rejectManagedSymlink(path)
    if (info.isFile()) output.push(path)
  }
  return output
}

/**
 * Model event paths are discovery hints only. Without a separately verified
 * controller receipt they are registered as unknown, never as ownership proof.
 */
async function recordedCycleArtifacts(runDir: string, cycle: number): Promise<string[]> {
  const text = await readOptionalText(join(runDir, 'events.jsonl'))
  if (text === undefined) return []
  const paths = new Set<string>()
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const record = event as Record<string, unknown>
    if (record.type !== 'result' || record.stepId !== `work-${cycle}` && record.stepId !== `minimal-work-${cycle}`) continue
    const data = record.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const artifacts = (data as Record<string, unknown>).artifacts
    if (!Array.isArray(artifacts)) continue
    for (const artifact of artifacts) if (typeof artifact === 'string' && artifact.trim()) paths.add(resolve(runDir, artifact))
  }
  return [...paths].sort()
}

function manifestIdFor(input: { manifestId?: string; direction?: DirectionRef }): string | undefined { return input.manifestId ?? (input.direction ? directionId(input.direction) : undefined) }

function assertSnapshotBinding(manifest: Awaited<ReturnType<typeof loadDirectionManifest>>, snapshot?: ResearchSnapshot): void {
  if (!snapshot) return
  const direction = manifest.direction
  if (!direction.protocolHash || direction.protocolHash !== snapshot.protocol.content_hash || direction.claim.id !== snapshot.active_claim.id || snapshot.active_claim.version < direction.claim.version || !sameRef(direction.hypothesis, snapshot.active_hypothesis)) throw new Error('direction registration snapshot is not the frozen protocol/claim/hypothesis lineage')
}

async function currentManifest(runDir: string, manifestId: string, direction?: DirectionRef, snapshot?: ResearchSnapshot) {
  const manifest = await loadDirectionManifest(runDir, manifestId)
  if (direction && directionId(direction) !== manifest.id) throw new Error('direction registration identity mismatch')
  assertSnapshotBinding(manifest, snapshot)
  return manifest
}

async function registerFile(runDir: string, manifestId: string, file: string, input: { kind: string; producer: string; ownership: ManagedArtifact['ownership']; sourceId?: string; expectedHash?: string; expectedBytes?: number; requireBoundaryInventory?: boolean }): Promise<void> {
  const relativePath = asRelative(runDir, file)
  if (input.expectedHash !== undefined) {
    const bytes = await readFile(file)
    if (hashBytes(bytes) !== input.expectedHash || (input.expectedBytes !== undefined && bytes.byteLength !== input.expectedBytes)) throw new Error(`direction generation receipt hash mismatch: ${relativePath}`)
  }
  const manifest = await loadDirectionManifest(runDir, manifestId)
  if (manifest.artifacts.some(artifact => artifact.relativePath === relativePath)) return
  const ownership = input.requireBoundaryInventory && !hasBoundaryInventory(relativePath) ? 'unknown' : input.ownership
  await registerManagedArtifact(runDir, manifestId, { relativePath, ...(input.sourceId ? { sourceId: input.sourceId } : {}), kind: input.kind, producer: input.producer, ownership })
}

async function registerFiles(runDir: string, manifestId: string, files: string[], input: { kind: string; producer: string; ownership: ManagedArtifact['ownership']; requireBoundaryInventory?: boolean }): Promise<void> {
  for (const file of files) await registerFile(runDir, manifestId, file, input)
}

function validateReceipt(receipt: DirectionGenerationReceipt, manifest: Awaited<ReturnType<typeof loadDirectionManifest>>): void {
  if (receipt.schema !== undefined && receipt.schema !== 'autoresearch/direction-generation/v1') throw new Error('invalid direction generation receipt schema')
  if (!manifest.direction.protocolHash || receipt.protocolHash !== manifest.direction.protocolHash || !sameRef(receipt.claim, manifest.direction.claim) || !sameRef(receipt.hypothesis, manifest.direction.hypothesis) || !Array.isArray(receipt.artifacts)) throw new Error('direction generation receipt binding mismatch')
  for (const artifact of receipt.artifacts) {
    validateManagedRelativePath(artifact.relativePath)
    if (!/^[a-f0-9]{64}$/u.test(artifact.hash) || !artifact.kind.trim() || !artifact.producer.trim() || (artifact.bytes !== undefined && (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)) || (artifact.ownership !== undefined && !['direction', 'shared', 'unknown'].includes(artifact.ownership))) throw new Error(`invalid direction generation receipt artifact: ${artifact.relativePath}`)
  }
}

async function registerReceiptArtifacts(runDir: string, manifestId: string, receipt: DirectionGenerationReceipt, allowCapturedSources = false): Promise<void> {
  const manifest = await loadDirectionManifest(runDir, manifestId)
  validateReceipt(receipt, manifest)
  for (const artifact of receipt.artifacts) await registerFile(runDir, manifestId, join(runDir, artifact.relativePath), { kind: artifact.kind, producer: artifact.producer, ownership: artifact.ownership ?? 'direction', ...(artifact.sourceId ? { sourceId: artifact.sourceId } : {}), expectedHash: artifact.hash, ...(artifact.bytes !== undefined ? { expectedBytes: artifact.bytes } : {}), requireBoundaryInventory: !(allowCapturedSources && under(artifact.relativePath, SOURCE_ROOT)) })
}

/** Register an explicit controller receipt, including outputs in mixed roots. */
export async function registerDirectionGeneration(input: { runDir: string; manifestId: string; direction?: DirectionRef; snapshot?: ResearchSnapshot; receipt: DirectionGenerationReceipt }): Promise<Awaited<ReturnType<typeof loadDirectionManifest>>> {
  const manifest = await currentManifest(input.runDir, input.manifestId, input.direction, input.snapshot)
  validateReceipt(input.receipt, manifest)
  await registerReceiptArtifacts(input.runDir, input.manifestId, input.receipt)
  return loadDirectionManifest(input.runDir, input.manifestId)
}

/** Compatibility name for cleanup callers that already call the receipt API explicitly. */
export const registerDirectionGenerationReceipt = registerDirectionGeneration

/** The controller binds one exact dedicated root before publishing worker intent. */
export async function issueWorkerRoot(runDir: string, cycle: number, workDir: string): Promise<void> {
  const relativePath = asRelative(runDir, workDir)
  if (![`work/cycle-${String(cycle).padStart(2, '0')}`, `work/experiment-cycle-${String(cycle).padStart(2, '0')}`].includes(relativePath)) throw new ExperimentPauseError('invalid issued worker root')
  await mkdir(workDir, { recursive: true })
  if (await realpath(workDir) !== join(await realpath(runDir), ...relativePath.split('/'))) throw new ExperimentPauseError('issued worker root must not redirect through symlinks')
  const file = join(runDir, 'cycles', `cycle-${cycle}`, 'worker-root.json')
  const value = { schema: 'autoresearch/worker-root/v1', cycle, workDir: relativePath }
  await mkdir(dirname(file), { recursive: true })
  try {
    const handle = await open(file, 'wx')
    try { await handle.writeFile(JSON.stringify(value)) } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (JSON.stringify(JSON.parse(await readFile(file, 'utf8'))) !== JSON.stringify(value)) throw new ExperimentPauseError('issued worker root changed')
  }
}

/** Worker strings never confer the mixed-root authority of a trusted controller receipt. */
export async function registerWorkerDirectionArtifacts(input: { runDir: string; workDir: string; frozenManifest: Awaited<ReturnType<typeof loadDirectionManifest>>; action: ActionResult; replay?: boolean }): Promise<void> {
  try {
    const { runDir, workDir, frozenManifest } = input
    const match = /^work\/(?:experiment-)?cycle-(\d+)$/u.exec(asRelative(runDir, workDir))
    if (!match) throw new ExperimentPauseError('missing issued worker root proof')
    const cycle = Number(match[1])
    const issued = await readOptionalText(join(runDir, 'cycles', `cycle-${cycle}`, 'worker-root.json'))
    if (!issued || JSON.parse(issued).workDir !== asRelative(runDir, workDir) || JSON.parse(issued).cycle !== cycle || JSON.parse(issued).schema !== 'autoresearch/worker-root/v1') throw new ExperimentPauseError('missing or mismatched issued worker root proof')
    if (!(await boundaryMarkerExists(runDir, frozenManifest.id, cycle))) throw new ExperimentPauseError('missing frozen worker direction boundary')
    const action = await validateWorkerResult(runDir, workDir, input.action)
    const manifest = await currentManifest(runDir, frozenManifest.id, frozenManifest.direction)
    const identities = await Promise.all(manifest.artifacts.map(async entry => {
      try { return { entry, path: await canonicalRelativePath(runDir, entry.relativePath) } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    }))
    const entries: DirectionGenerationArtifact[] = []
    for (const path of action.artifacts) {
      const file = safeResolve(runDir, path), relativePath = await canonicalRelativePath(runDir, path)
      const bytes = await readFile(file), hash = hashBytes(bytes)
      const old = identities.filter(identity => identity?.path === relativePath).map(identity => identity!.entry)
      if (input.replay && !old.length) throw new ExperimentPauseError(`cached worker artifact lacks registered ownership proof: ${relativePath}`)
      if (old.some(entry => entry.ownership !== 'direction')) throw new ExperimentPauseError(`worker artifact ownership is preexisting/unknown/shared: ${relativePath}`)
      if (old.some(entry => entry.hash !== hash)) throw new ExperimentPauseError(`worker artifact bytes changed (hash mismatch): ${relativePath}`)
      entries.push({ relativePath: old[0]?.relativePath ?? relativePath, hash, bytes: bytes.length, kind: 'worker-output', producer: 'autoresearch-worker', ownership: 'direction' })
    }
    // Check every path before writing any receipt or promoting ownership.
    await registerDirectionGeneration({ runDir, manifestId: manifest.id, receipt: { schema: 'autoresearch/direction-generation/v1', protocolHash: manifest.direction.protocolHash!, claim: manifest.direction.claim, hypothesis: manifest.direction.hypothesis, artifacts: entries } })
  } catch (error) {
    if (error instanceof ExperimentPauseError) throw error
    throw new ExperimentPauseError(`worker ownership boundary rejected: ${String(error)}`)
  }
}

function expectedJobDirectories(graph: FrozenTaskGraph | undefined): Set<string> { return new Set((graph?.tasks ?? []).map(task => hashBytes(task.job.id))) }
function dedicated(relativePath: string, cycle: number): boolean {
  return [`cycles/cycle-${cycle}`, `work/cycle-${String(cycle).padStart(2, '0')}`, `work/experiment-cycle-${String(cycle).padStart(2, '0')}`, `runtime/graphs/cycle-${cycle}`].some(root => under(relativePath, root))
}
function ownershipForMixed(relativePath: string, cycle: number, jobs: Set<string>): ManagedArtifact['ownership'] {
  if (dedicated(relativePath, cycle)) return 'direction'
  if (under(relativePath, SOURCE_ROOT)) return 'shared'
  if (under(relativePath, JOB_ROOT)) {
    const [jobDirectory] = relativePath.slice(`${JOB_ROOT}/`.length).split('/')
    return jobDirectory && jobs.has(jobDirectory) ? 'direction' : 'unknown'
  }
  return 'unknown'
}

async function registerMixedRoots(input: { runDir: string; manifestId: string; cycle: number; jobs: Set<string>; includeDedicated: boolean }): Promise<void> {
  const roots = MIXED_ROOTS(input.runDir)
  const seen = new Set<string>()
  const files = [...(await rootFiles(input.runDir)), ...await Promise.all(roots.map(filesUnder)).then(values => values.flat())]
  for (const file of files) {
    const relativePath = asRelative(input.runDir, file)
    if (seen.has(relativePath) || (!input.includeDedicated && dedicated(relativePath, input.cycle))) continue
    seen.add(relativePath)
    const ownership = input.includeDedicated ? 'unknown' : ownershipForMixed(relativePath, input.cycle, input.jobs)
    await registerFile(input.runDir, input.manifestId, file, { ownership, kind: ownership === 'direction' ? 'generated-output' : 'run-support', producer: 'autoresearch-registration' })
  }
}

async function otherDirectionSourceKeys(runDir: string, manifestId: string): Promise<Set<string>> {
  const keys = new Set<string>()
  const directory = join(runDir, '.autoresearch', 'directions')
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return keys
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === `${manifestId}.json`) continue
    const other = await loadDirectionManifest(runDir, entry.name.slice(0, -5))
    for (const artifact of other.artifacts) keys.add(`${artifact.relativePath}:${artifact.hash}`)
  }
  return keys
}

async function snapshotSourceReceipt(runDir: string, manifest: Awaited<ReturnType<typeof loadDirectionManifest>>, snapshot?: ResearchSnapshot): Promise<DirectionGenerationReceipt | undefined> {
  if (!snapshot) return undefined
  const refs: Array<{ ref: SourceRef; ownership: ManagedArtifact['ownership']; kind: string; producer: string }> = []
  refs.push(...snapshot.source_refs.map(ref => ({ ref, ownership: 'direction' as const, kind: 'research-source', producer: 'research-store' })))
  refs.push(...snapshot.claims.filter(record => sameRef(record, manifest.direction.claim)).flatMap(record => record.source_refs.map(ref => ({ ref, ownership: 'direction' as const, kind: 'research-source', producer: 'research-store' }))))
  refs.push(...snapshot.hypotheses.filter(record => sameRef(record, manifest.direction.hypothesis)).flatMap(record => record.source_refs.map(ref => ({ ref, ownership: 'direction' as const, kind: 'research-source', producer: 'research-store' }))))
  if (snapshot.protocol.content_hash === manifest.direction.protocolHash) refs.push(...snapshot.protocol.source_refs.map(ref => ({ ref, ownership: 'direction' as const, kind: 'research-source', producer: 'research-store' })))
  const activeClaim = snapshot.claims.find(claim => sameRef(claim, snapshot.active_claim))
  const supportedLineage = snapshot.assessment?.claim_status === 'supported' || activeClaim?.status === 'supported'
  const protectedEvidence = supportedLineage ? new Set(snapshot.assessment?.admissible_evidence_ids ?? []) : new Set<string>()
  for (const evidence of snapshot.evidence.filter(item => item.protocol_hash === manifest.direction.protocolHash && sameRef(item.target_claim, manifest.direction.claim))) {
    const ownership = protectedEvidence.has(evidence.id) ? 'shared' as const : 'direction' as const
    refs.push(...evidence.source_refs.map(ref => ({ ref, ownership, kind: 'research-source', producer: 'research-evidence' })))
    refs.push(...evidence.artifacts.map(ref => ({ ref, ownership, kind: 'research-source', producer: 'research-evidence' })))
    if (evidence.analysis) refs.push({ ref: evidence.analysis, ownership, kind: 'research-source', producer: 'research-evidence' })
  }
  const crossDirection = await otherDirectionSourceKeys(runDir, manifest.id)
  const unique = new Map<string, { ref: SourceRef; ownership: ManagedArtifact['ownership']; kind: string; producer: string }>()
  for (const entry of refs) {
    if (!entry.ref.path) continue
    if (!entry.ref.hash) throw new Error(`source registration requires hash: ${entry.ref.id}`)
    const key = `${entry.ref.path}:${entry.ref.hash}`
    const shared = entry.ownership === 'shared' || crossDirection.has(key)
    const prior = unique.get(key)
    unique.set(key, { ...entry, ownership: shared || prior?.ownership === 'shared' ? 'shared' : 'direction' })
  }
  const artifacts: DirectionGenerationArtifact[] = []
  for (const entry of unique.values()) {
    const path = entry.ref.path!
    const bytes = await readFile(join(runDir, path))
    const actualHash = hashBytes(bytes)
    if (actualHash !== entry.ref.hash) throw new Error(`source registration hash mismatch: ${entry.ref.id}`)
    artifacts.push({ relativePath: path, hash: actualHash, bytes: bytes.byteLength, sourceId: entry.ref.id, kind: entry.kind, producer: entry.producer, ownership: entry.ownership })
  }
  if (artifacts.length === 0) return undefined
  return { schema: 'autoresearch/direction-generation/v1', protocolHash: manifest.direction.protocolHash!, claim: manifest.direction.claim, hypothesis: manifest.direction.hypothesis, artifacts }
}

function boundaryMarkerPath(runDir: string, manifestId: string, cycle: number): string {
  if (!Number.isSafeInteger(cycle) || cycle < 1) throw new RangeError('cycle must be a positive safe integer')
  return safeResolve(runDir, '.autoresearch', 'directions', 'boundaries', manifestId, `cycle-${cycle}.json`)
}

async function ensureExistingAncestorInside(runDir: string, target: string): Promise<void> {
  const root = await realpath(runDir)
  let current = target
  while (true) {
    try {
      const actual = await realpath(current)
      if (actual !== root && !actual.startsWith(root + sep)) throw new Error('direction boundary path escapes run dir')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

async function boundaryMarkerExists(runDir: string, manifestId: string, cycle: number): Promise<boolean> {
  const file = boundaryMarkerPath(runDir, manifestId, cycle)
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('direction boundary marker is not a regular file')
    await ensureExistingAncestorInside(runDir, file)
    const marker = JSON.parse((await readFile(file, 'utf8'))) as Record<string, unknown>
    if (marker.schema !== 'autoresearch/direction-boundary/v1' || marker.manifestId !== manifestId || marker.cycle !== cycle) throw new Error('direction boundary marker is malformed')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function markBoundaryMarker(runDir: string, manifestId: string, cycle: number, manifestHash: string): Promise<void> {
  const file = boundaryMarkerPath(runDir, manifestId, cycle)
  await ensureExistingAncestorInside(runDir, dirname(file))
  await mkdir(dirname(file), { recursive: true })
  await ensureExistingAncestorInside(runDir, dirname(file))
  await atomicWriteJson(file, { schema: 'autoresearch/direction-boundary/v1', manifestId, cycle, manifestHash })
}

async function withBoundaryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = boundaryLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolvePromise => { release = resolvePromise })
  const queued = previous.then(() => current)
  boundaryLocks.set(key, queued)
  await previous
  try { return await fn() } finally { release(); if (boundaryLocks.get(key) === queued) boundaryLocks.delete(key) }
}

/** Register all known outputs for one frozen cycle. */
export async function registerDirectionCycleArtifacts(input: RegisterDirectionCycleInput): Promise<void> {
  const manifestId = manifestIdFor(input)
  if (!manifestId) return
  const manifest = await currentManifest(input.runDir, manifestId, input.direction, input.snapshot)
  const graph = await loadTaskGraph(input.runDir, `cycle-${input.cycle}`)
  if (graph && manifest.direction.protocolHash !== graph.protocolHash) throw new Error('direction registration task graph protocol mismatch')
  const jobs = expectedJobDirectories(graph)
  if (input.generationReceipt) await registerReceiptArtifacts(input.runDir, manifestId, input.generationReceipt)
  const sourceReceipt = await snapshotSourceReceipt(input.runDir, manifest, input.snapshot)
  if (sourceReceipt) {
    await currentManifest(input.runDir, manifestId, input.direction, input.snapshot)
    await registerReceiptArtifacts(input.runDir, manifestId, sourceReceipt, true)
  }
  await registerFiles(input.runDir, manifestId, await recordedCycleArtifacts(input.runDir, input.cycle), { kind: 'unverified-worker-path', producer: 'autoresearch-worker', ownership: 'unknown', requireBoundaryInventory: true })
  for (const root of CYCLE_ROOTS(input.runDir, input.cycle)) {
    const files = await filesUnder(root)
    // The report is rewritten when a committed decision is materialized.  A
    // pre-decision registration must leave it out so that its final canonical
    // bytes can be registered after the decision is sealed.
    const stable = input.snapshot && !input.snapshot.decision
      ? files.filter(file => !file.toLowerCase().endsWith(`${sep}report.md`))
      : files
    await registerFiles(input.runDir, manifestId, stable, { kind: 'generated-output', producer: 'autoresearch-controller', ownership: 'direction' })
  }
  await registerMixedRoots({ runDir: input.runDir, manifestId, cycle: input.cycle, jobs, includeDedicated: false })
}

/** Freeze the pre-generation inventory. Existing files are never inferred to be deletable. */
export async function reserveDirectionCycleBoundary(input: { runDir: string; cycle: number; manifestId: string }): Promise<void> {
  const marker = boundaryMarkerPath(input.runDir, input.manifestId, input.cycle)
  await withBoundaryLock(marker, async () => {
    if (await boundaryMarkerExists(input.runDir, input.manifestId, input.cycle)) return
    const manifest = await loadDirectionManifest(input.runDir, input.manifestId)
    for (const root of CYCLE_ROOTS(input.runDir, input.cycle)) await registerFiles(input.runDir, input.manifestId, await filesUnder(root), { kind: 'preexisting', producer: 'autoresearch-boundary', ownership: 'unknown' })
    await registerMixedRoots({ runDir: input.runDir, manifestId: input.manifestId, cycle: input.cycle, jobs: new Set(), includeDedicated: true })
    const captured = await markDirectionBoundaryCaptured(input.runDir, input.manifestId)
    await markBoundaryMarker(input.runDir, input.manifestId, input.cycle, captured.contentHash || manifest.contentHash)
  })
}
