import { readFile, mkdir, writeFile, link, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import type { JobSpec } from '../runtime/contracts.js'
import { hashContent, freezeRecord } from '../research/records.js'
import type { ResearchSnapshot, SourceRef } from '../research/contracts.js'
import { ResearchStore } from '../research/store.js'

export interface ExperimentTask {
  id: string; dependsOn: string[]; protocolHash: string; inputHash: string
  stage: 'prepare' | 'baseline' | 'develop' | 'formal' | 'reproduce' | 'summarize'
  job: JobSpec; validatorId: string
  inputs?: SourceRef[]
  outputs?: { relativePath: string; kind: string; maxBytes: number }[]
  split?: string; exposure?: 'development' | 'heldout' | 'none'
}
export interface FrozenTaskGraph {
  schema: 'autoresearch/task-graph/v1'; id: string; goal: string; snapshotId: string; snapshotHash: string
  protocolHash: string; tasks: ExperimentTask[]; contentHashes: Record<string, string>; hash: string
  sourceRefs: SourceRef[]; budget: { maxConcurrentJobs: number; maxReservedWallMs: number; totalWallMs: number }
}
export interface CompletedTask { taskId: string; protocolHash: string; inputHash: string; contentHash?: string }
const identity = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/.test(id)
export function assertRelativePath(path: string): void {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes(':')) throw new Error('ARTIFACT_PATH_INVALID')
}
export function validateTaskGraph(tasks: ExperimentTask[]): void {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('TASK_GRAPH_EMPTY')
  const ids = new Map<string, ExperimentTask>(), jobs = new Set<string>(), attempts = new Set<string>()
  for (const task of tasks) {
    if (!identity(task.id) || ids.has(task.id)) throw new Error('TASK_GRAPH_DUPLICATE_OR_INVALID_ID')
    if (!Array.isArray(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error('TASK_GRAPH_DEPENDENCY_INVALID')
    if (!['prepare', 'baseline', 'develop', 'formal', 'reproduce', 'summarize'].includes(task.stage) || !task.protocolHash || !task.inputHash || !task.validatorId) throw new Error('TASK_GRAPH_CONTRACT_INVALID')
    const job = task.job
    if (!job || !identity(job.id) || !identity(job.attemptId) || jobs.has(job.id) || attempts.has(job.attemptId) || job.taskId !== task.id || job.protocolHash !== task.protocolHash || job.inputHash !== task.inputHash) throw new Error('TASK_GRAPH_JOB_IDENTITY_MISMATCH')
    if (typeof job.executable !== 'string' || !job.executable || !Array.isArray(job.args) || job.args.some(a => typeof a !== 'string' || a.includes('\0')) || typeof job.cwd !== 'string' || !job.cwd || !job.env || Object.entries(job.env).some(([k,v]) => !k || typeof v !== 'string' || k.includes('\0') || v.includes('\0'))) throw new Error('TASK_GRAPH_COMMAND_INVALID')
    if (!job.budget || ['wallMs', 'maxLogBytes', 'maxArtifactBytes'].some(k => !Number.isSafeInteger(job.budget[k as keyof typeof job.budget]) || Number(job.budget[k as keyof typeof job.budget]) < (k === 'wallMs' ? 1 : 0))) throw new Error('TASK_GRAPH_BUDGET_INVALID')
    for (const key of ['cpuSeconds', 'gpuSeconds', 'costMicros'] as const) if (job.budget[key] !== null && (!Number.isSafeInteger(job.budget[key]) || job.budget[key]! < 0)) throw new Error('TASK_GRAPH_BUDGET_INVALID')
    if (job.checkpoint !== null) throw new Error('TASK_GRAPH_CHECKPOINT_REQUIRES_EXPLICIT_RESUME_ADAPTER')
    for (const output of task.outputs ?? []) { assertRelativePath(output.relativePath); if (!output.kind || !Number.isSafeInteger(output.maxBytes) || output.maxBytes < 0) throw new Error('TASK_GRAPH_OUTPUT_INVALID') }
    if (new Set(task.outputs?.map(o => o.relativePath)).size !== (task.outputs?.length ?? 0)) throw new Error('TASK_GRAPH_OUTPUT_DUPLICATE')
    ids.set(task.id, task); jobs.add(job.id); attempts.add(job.attemptId)
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error('TASK_GRAPH_CYCLE')
    if (visited.has(id)) return
    const task = ids.get(id); if (!task) throw new Error('TASK_GRAPH_DEPENDENCY_MISSING')
    visiting.add(id); task.dependsOn.forEach(visit); visiting.delete(id); visited.add(id)
  }
  tasks.forEach(t => visit(t.id))
}
export function taskContentHashes(tasks: ExperimentTask[]): Record<string, string> {
  validateTaskGraph(tasks)
  const hashes: Record<string, string> = Object.create(null), byId = new Map(tasks.map(t => [t.id, t]))
  const hash = (id: string): string => hashes[id] ??= hashContent({ task: byId.get(id), dependencies: [...byId.get(id)!.dependsOn].sort().map(d => [d, hash(d)]) })
  tasks.forEach(t => hash(t.id)); return hashes
}
export function readyTasks(tasks: ExperimentTask[], completed: CompletedTask[]): ExperimentTask[] {
  const hashes = taskContentHashes(tasks), valid = new Set<string>()
  // A stale ancestor invalidates descendants even when a descendant has a matching own input label.
  const visit = (task: ExperimentTask): boolean => {
    if (valid.has(task.id)) return true
    const matching = completed.some(c => c.taskId === task.id && c.protocolHash === task.protocolHash && c.inputHash === task.inputHash && (!c.contentHash || c.contentHash === hashes[task.id]))
    if (!matching || !task.dependsOn.every(id => visit(tasks.find(t => t.id === id)!))) return false
    valid.add(task.id); return true
  }
  tasks.forEach(visit)
  return tasks.filter(t => !valid.has(t.id) && t.dependsOn.every(id => valid.has(id)))
}
/** Atomic installation; existing canonical records must match byte-for-byte. */
export async function immutableJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const bytes = JSON.stringify(value), temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx' })
  try { await link(temporary, file) }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (await readFile(file, 'utf8') !== bytes) throw new Error('IMMUTABLE_RUNTIME_RECORD_CONFLICT') }
  finally { await unlink(temporary) }
}
export function graphPath(runDir: string, id: string): string {
  if (!identity(id)) throw new Error('TASK_GRAPH_ID_INVALID')
  return join(runDir, 'runtime', 'graphs', id, 'graph.json')
}
export async function loadTaskGraph(runDir: string, id: string): Promise<FrozenTaskGraph | undefined> {
  let graph: FrozenTaskGraph
  try { graph = JSON.parse(await readFile(graphPath(runDir, id), 'utf8')) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  const { hash, ...body } = graph
  if (hashContent(body) !== hash || hashContent(taskContentHashes(graph.tasks)) !== hashContent(graph.contentHashes)) throw new Error('TASK_GRAPH_HASH_MISMATCH')
  return freezeRecord(graph)
}
export async function freezeTaskGraph(input: { runDir: string; id: string; goal: string; snapshot: ResearchSnapshot; tasks: ExperimentTask[]; maxConcurrentJobs?: number; maxReservedWallMs?: number }): Promise<FrozenTaskGraph> {
  const tasks = structuredClone(input.tasks); validateTaskGraph(tasks)
  const snapshot = await new ResearchStore(input.runDir).loadSnapshot(input.snapshot.id)
  if (snapshot.content_hash !== input.snapshot.content_hash) throw new Error('TASK_GRAPH_SNAPSHOT_MISMATCH')
  for (const task of tasks) {
    if (task.protocolHash !== snapshot.protocol.content_hash) throw new Error('TASK_GRAPH_PROTOCOL_MISMATCH')
    const rel = relative(resolve(input.runDir), resolve(task.job.cwd))
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('TASK_GRAPH_CWD_OUTSIDE_RUN')
    if (!task.outputs?.length || !task.split || !task.exposure || !Array.isArray(task.inputs)) throw new Error('TASK_GRAPH_MISSING_FROZEN_IO')
    if ((task.stage === 'formal' || task.stage === 'reproduce') && (task.split !== snapshot.protocol.split || task.exposure !== 'heldout')) throw new Error('TASK_GRAPH_FORMAL_SPLIT_MISMATCH')
    if (task.stage === 'develop' && (task.exposure !== 'development' || task.split === snapshot.protocol.split)) throw new Error('TASK_GRAPH_DEVELOPMENT_EXPOSURE')
    for (const source of task.inputs) {
      if (!source.path || !source.hash) throw new Error('TASK_GRAPH_INPUT_PROVENANCE_MISSING')
      assertRelativePath(source.path)
      const captured = await new ResearchStore(input.runDir).captureSource(source.path, source.id)
      if (captured.hash !== source.hash) throw new Error('TASK_GRAPH_INPUT_HASH_MISMATCH')
    }
    if (task.stage === 'formal') {
      const ancestors = new Set<string>(); const collect = (id: string) => { if (ancestors.has(id)) return; ancestors.add(id); tasks.find(t => t.id === id)!.dependsOn.forEach(collect) }
      task.dependsOn.forEach(collect)
      if (!tasks.some(t => ancestors.has(t.id) && t.stage === 'baseline')) throw new Error('TASK_GRAPH_BASELINE_MISSING')
    }
  }
  const maxConcurrentJobs = input.maxConcurrentJobs ?? 1
  const totalWallMs = tasks.reduce((sum,t) => sum + t.job.budget.wallMs, 0)
  const maxReservedWallMs = input.maxReservedWallMs ?? totalWallMs
  if (!Number.isSafeInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 || !Number.isSafeInteger(totalWallMs) || !Number.isSafeInteger(maxReservedWallMs) || maxReservedWallMs < Math.max(...tasks.map(t => t.job.budget.wallMs))) throw new Error('TASK_GRAPH_BUDGET_INVALID')
  const sourceRefs = [await new ResearchStore(input.runDir).captureBytes(JSON.stringify(tasks), `task-graph:${input.id}`)]
  const body = { schema: 'autoresearch/task-graph/v1' as const, id: input.id, goal: input.goal, snapshotId: snapshot.id, snapshotHash: snapshot.content_hash, protocolHash: snapshot.protocol.content_hash, tasks, contentHashes: taskContentHashes(tasks), sourceRefs, budget: { maxConcurrentJobs, maxReservedWallMs, totalWallMs } }
  const graph = { ...body, hash: hashContent(body) }
  await immutableJson(graphPath(input.runDir, input.id), graph)
  return freezeRecord(graph)
}

/** Planner proposes commands and argv; the controller supplies all run/attempt/protocol identities. */
export function tasksFromExecutionPlan(raw: unknown, runDir: string, graphId: string, snapshot: ResearchSnapshot): ExperimentTask[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { tasks?: unknown }).tasks)) throw new Error('TASK_GRAPH_PLAN_MALFORMED')
  return ((raw as { tasks: Record<string, unknown>[] }).tasks).map(proposal => {
    if (!proposal || typeof proposal !== 'object' || !identity(proposal.id) || typeof proposal.command !== 'string' || !Array.isArray(proposal.argv) || typeof proposal.cwd !== 'string') throw new Error('TASK_GRAPH_PLAN_COMMAND_INVALID')
    const id = String(proposal.id), inputHash = hashContent({ inputs: proposal.inputs, split: proposal.split, exposure: proposal.exposure })
    const job: JobSpec = { id: `${graphId}-${id}`, taskId: id, attemptId: `${graphId}-${id}-attempt-1`, protocolHash: snapshot.protocol.content_hash, inputHash, executable: proposal.command, args: proposal.argv as string[], cwd: resolve(runDir, proposal.cwd), env: (proposal.env ?? {}) as Record<string, string>, budget: proposal.budget as JobSpec['budget'], checkpoint: null }
    return { id, dependsOn: proposal.dependsOn as string[], stage: proposal.stage as ExperimentTask['stage'], protocolHash: snapshot.protocol.content_hash, inputHash, job, validatorId: proposal.validatorId as string, inputs: proposal.inputs as SourceRef[], outputs: proposal.outputs as ExperimentTask['outputs'], split: proposal.split as string, exposure: proposal.exposure as ExperimentTask['exposure'] }
  })
}
