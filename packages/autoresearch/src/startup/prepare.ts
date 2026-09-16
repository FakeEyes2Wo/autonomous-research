import { createHash } from 'node:crypto'
import { lstat, readdir, realpath, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { artifactHash } from '../project/inventory.js'
import { RUN_PHASES, RUN_STATUSES, type RunPhase, type RunState, type RunStatus } from '../core/types.js'

export type StartupIntent = 'project-paper' | 'research' | 'experiment' | 'resume' | 'ambiguous'
export type StartupWorkflow = Exclude<StartupIntent, 'resume' | 'ambiguous'>

export interface StartupInput {
  intent: StartupIntent
  projectDir: string
  runDir?: string
  task?: string
}

export interface StartupContext {
  /** A host-provided hint. It is always revalidated against the project on disk. */
  sessionRunDir?: string
}

export interface StartupAction {
  tool: 'project_paper_run' | 'research_run' | 'experiment_run'
  args: Record<string, unknown>
}

export interface StartupCandidate {
  runDir: string
  workflow?: StartupWorkflow
  runStatus?: RunStatus
  phase?: RunPhase
  valid: boolean
  reason?: string
}

export interface StartupResult {
  status: 'ready' | 'needs-input' | 'blocked' | 'resumable' | 'terminal'
  reason: string
  workflow?: StartupWorkflow
  runDir?: string
  nextAction?: StartupAction
  candidates?: StartupCandidate[]
  runStatus?: RunStatus
  phase?: RunPhase
}

const ACTIVE_STATUSES = new Set<RunStatus>(['RUNNING', 'WAITING', 'PAUSED'])
const MAX_METADATA_BYTES = 1024 * 1024
const LOCAL_RUN_LIMIT = 64
const WINDOWS = process.platform === 'win32'

type Identity = {
  version: 1
  projectDir: string
  projectId: string
  workflow: StartupWorkflow
  [key: string]: unknown
}

type Inspection =
  | { kind: 'valid'; runDir: string; identity: Identity; state: RunState }
  | { kind: 'legacy'; runDir: string; reason: string; matching: boolean }
  | { kind: 'invalid'; runDir: string; reason: string; matching: boolean }
  | { kind: 'missing'; runDir: string }
  | { kind: 'foreign'; runDir: string; reason: string }

function samePath(a: string, b: string): boolean {
  return WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function ancestorOrSame(ancestor: string, candidate: string): boolean {
  return contained(ancestor, candidate)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function invalidInput(message: string): never {
  throw new TypeError(message)
}

function validateInput(input: StartupInput, context: StartupContext | undefined): { input: StartupInput; context: StartupContext } {
  if (!isRecord(input)) invalidInput('startup input must be an object')
  if (!['project-paper', 'research', 'experiment', 'resume', 'ambiguous'].includes(input.intent as string)) invalidInput('invalid startup intent')
  if (typeof input.projectDir !== 'string' || input.projectDir.trim().length === 0 || !isAbsolute(input.projectDir)) invalidInput('projectDir must be an absolute path')
  if (input.runDir !== undefined && (typeof input.runDir !== 'string' || input.runDir.trim().length === 0 || !isAbsolute(input.runDir))) invalidInput('runDir must be an absolute path')
  if (input.task !== undefined && (typeof input.task !== 'string' || input.task.trim().length === 0)) invalidInput('task must be a non-empty string')
  if (context !== undefined && !isRecord(context)) invalidInput('startup context must be an object')
  if (context?.sessionRunDir !== undefined && (typeof context.sessionRunDir !== 'string' || context.sessionRunDir.trim().length === 0 || !isAbsolute(context.sessionRunDir))) invalidInput('sessionRunDir must be an absolute path')
  return { input: { ...input, projectDir: resolve(input.projectDir), ...(input.runDir ? { runDir: resolve(input.runDir) } : {}) }, context: context ?? {} }
}

async function existingProject(projectDir: string): Promise<string> {
  let info
  try { info = await lstat(projectDir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TypeError(`projectDir does not exist: ${projectDir}`)
    throw new TypeError(`projectDir cannot be read: ${projectDir}`)
  }
  if (!info.isDirectory()) throw new TypeError(`projectDir must be a directory: ${projectDir}`)
  return realpath(projectDir)
}

async function readMetadata(file: string): Promise<{ value?: unknown; error?: string }> {
  let info
  try { info = await lstat(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return { error: `cannot read metadata: ${file}` }
  }
  if (info.isSymbolicLink() || !info.isFile()) return { error: `metadata must be a regular file: ${file}` }
  if (info.size > MAX_METADATA_BYTES) return { error: `metadata is too large: ${file}` }
  try { return { value: JSON.parse(await readFile(file, 'utf8')) } }
  catch { return { error: `corrupt metadata: ${file}` } }
}

function matchingIdentity(value: unknown, projectDir: string): { identity?: Identity; matching: boolean; reason?: string } {
  if (!isRecord(value)) return { matching: false, reason: 'invalid project identity' }
  const recorded = typeof value.projectDir === 'string' ? resolve(value.projectDir) : undefined
  const matching = recorded !== undefined && samePath(recorded, projectDir)
  if (value.version !== 1 || typeof value.projectDir !== 'string' || !isAbsolute(value.projectDir) || typeof value.projectId !== 'string' || !['research', 'project-paper', 'experiment'].includes(value.workflow as string)) {
    return { matching, reason: 'invalid project identity' }
  }
  if (!matching) return { matching: false, reason: 'project identity mismatch' }
  if (value.projectId !== artifactHash({ projectDir }) || resolve(value.projectDir) !== projectDir) return { matching: true, reason: 'project identity mismatch' }
  return { identity: value as Identity, matching: true }
}

function wellFormedIdentity(value: unknown): value is Identity {
  if (!isRecord(value) || value.version !== 1 || typeof value.projectDir !== 'string' || !isAbsolute(value.projectDir) || typeof value.projectId !== 'string' || !['research', 'project-paper', 'experiment'].includes(value.workflow as string)) return false
  return value.projectId === artifactHash({ projectDir: resolve(value.projectDir) })
}

function validState(value: unknown, runDir: string): value is RunState {
  if (!isRecord(value) || value.schema !== 'autoresearch/run-state/v1' || typeof value.runId !== 'string' || value.runId.length === 0 || typeof value.runDir !== 'string' || !isAbsolute(value.runDir) || !samePath(resolve(value.runDir), runDir)) return false
  if (!RUN_STATUSES.includes(value.status as RunStatus) || !RUN_PHASES.includes(value.phase as RunPhase)) return false
  if (!Number.isSafeInteger(value.cycle) || (value.cycle as number) < 0 || !Number.isSafeInteger(value.planVersion) || (value.planVersion as number) < 0 || typeof value.stepId !== 'string' || typeof value.updatedAt !== 'string' || value.updatedAt.length === 0) return false
  return true
}

async function inspectRun(runDir: string, projectDir: string): Promise<Inspection> {
  const path = resolve(runDir)
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', runDir: path }
    return { kind: 'invalid', runDir: path, reason: 'run directory cannot be read', matching: contained(projectDir, path) }
  }
  if (info.isSymbolicLink()) return { kind: 'invalid', runDir: path, reason: 'run directory must not be a symlink', matching: contained(projectDir, path) }
  if (!info.isDirectory()) return { kind: 'invalid', runDir: path, reason: 'run directory is not a directory', matching: contained(projectDir, path) }
  let canonical: string
  try { canonical = await realpath(path) } catch { return { kind: 'invalid', runDir: path, reason: 'run directory cannot be resolved', matching: contained(projectDir, path) } }
  const identityDir = join(canonical, '.autoresearch')
  try {
    const metadataDir = await lstat(identityDir)
    if (metadataDir.isSymbolicLink() || !metadataDir.isDirectory()) return { kind: 'invalid', runDir: canonical, reason: 'metadata directory is invalid', matching: contained(projectDir, canonical) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'invalid', runDir: canonical, reason: 'metadata directory cannot be read', matching: contained(projectDir, canonical) }
  }
  const identityRead = await readMetadata(join(identityDir, 'project-identity.json'))
  if (identityRead.error) return { kind: 'invalid', runDir: canonical, reason: identityRead.error, matching: contained(projectDir, canonical) }
  if (identityRead.value === undefined) return { kind: 'legacy', runDir: canonical, reason: 'legacy run has no verified project identity; provide explicit recovery inputs', matching: contained(projectDir, canonical) }
  const checked = matchingIdentity(identityRead.value, projectDir)
  if (checked.reason) {
    // A malformed identity in a project-local run cannot be treated as a
    // foreign run: doing so could make discovery silently pick another run.
    const matching = checked.matching || !wellFormedIdentity(identityRead.value)
    return matching ? { kind: 'invalid', runDir: canonical, reason: checked.reason, matching: true } : { kind: 'foreign', runDir: canonical, reason: checked.reason }
  }
  const stateRead = await readMetadata(join(canonical, 'state.json'))
  if (stateRead.error || stateRead.value === undefined || !validState(stateRead.value, canonical)) return { kind: 'invalid', runDir: canonical, reason: stateRead.error ?? 'corrupt run state', matching: true }
  return { kind: 'valid', runDir: canonical, identity: checked.identity!, state: stateRead.value }
}

function toolFor(workflow: StartupWorkflow): StartupAction['tool'] {
  return workflow === 'project-paper' ? 'project_paper_run' : workflow === 'experiment' ? 'experiment_run' : 'research_run'
}

function actionFor(workflow: StartupWorkflow, runDir: string, projectDir: string, task?: string, frozen?: { profile: string; maxRounds: number }): StartupAction {
  const args: Record<string, unknown> = { runDir, projectDir }
  if (workflow === 'experiment') Object.assign(args, { task: task ?? '', ...(frozen ? { profile: frozen.profile, maxRounds: frozen.maxRounds } : {}) })
  return { tool: toolFor(workflow), args }
}

function resultForRun(inspection: Extract<Inspection, { kind: 'valid' }>, projectDir: string, task?: string): StartupResult {
  const { identity, state, runDir } = inspection
  if (state.status === 'COMPLETED' || state.status === 'FAILED') return { status: 'terminal', reason: `run is terminal (${state.status})${state.lastError ? `: ${state.lastError}` : ''}`, workflow: identity.workflow, runDir, runStatus: state.status, phase: state.phase }
  if (state.status === 'PAUSED') return { status: 'blocked', reason: `run is PAUSED${state.lastError ? `: ${state.lastError}` : '; explicit recovery or user action is required'}`, workflow: identity.workflow, runDir, runStatus: state.status, phase: state.phase }
  return { status: 'resumable', reason: `resume ${identity.workflow} run (${state.status})`, workflow: identity.workflow, runDir, runStatus: state.status, phase: state.phase, nextAction: actionFor(identity.workflow, runDir, projectDir, task) }
}

function localRunsRoot(projectDir: string): string { return join(projectDir, '.autoresearch', 'runs') }

async function localCandidates(projectDir: string): Promise<{ entries: StartupCandidate[]; inspections: Inspection[]; truncated: boolean }> {
  const entries: StartupCandidate[] = [], inspections: Inspection[] = []
  const autoresearchDir = join(projectDir, '.autoresearch'), runsDir = localRunsRoot(projectDir)
  let settingsInfo
  try { settingsInfo = await lstat(autoresearchDir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries, inspections, truncated: false }
    return { entries, inspections: [{ kind: 'invalid', runDir: runsDir, reason: 'local run directory cannot be read', matching: true }], truncated: false }
  }
  if (settingsInfo.isSymbolicLink() || !settingsInfo.isDirectory()) return { entries, inspections: [{ kind: 'invalid', runDir: runsDir, reason: 'local metadata directory is invalid', matching: true }], truncated: false }
  let runsInfo
  try { runsInfo = await lstat(runsDir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries, inspections, truncated: false }
    return { entries, inspections: [{ kind: 'invalid', runDir: runsDir, reason: 'local run directory cannot be read', matching: true }], truncated: false }
  }
  if (runsInfo.isSymbolicLink() || !runsInfo.isDirectory()) return { entries, inspections: [{ kind: 'invalid', runDir: runsDir, reason: 'local run directory is invalid', matching: true }], truncated: false }
  let canonicalRuns: string
  try { canonicalRuns = await realpath(runsDir) } catch { return { entries, inspections: [{ kind: 'invalid', runDir: runsDir, reason: 'local run directory cannot be resolved', matching: true }], truncated: false } }
  if (!contained(projectDir, canonicalRuns)) return { entries, inspections: [{ kind: 'invalid', runDir: canonicalRuns, reason: 'local run directory escapes the project', matching: true }], truncated: false }
  let rootEntries
  try { rootEntries = await readdir(canonicalRuns, { withFileTypes: true }) }
  catch { return { entries, inspections: [{ kind: 'invalid', runDir: canonicalRuns, reason: 'local run directory cannot be read', matching: true }], truncated: false } }
  const directories = rootEntries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
  const truncated = directories.length > LOCAL_RUN_LIMIT
  const dirs = directories.sort((a, b) => a.name.localeCompare(b.name)).slice(0, LOCAL_RUN_LIMIT)
  for (const entry of dirs) {
    const inspection = await inspectRun(join(canonicalRuns, entry.name), projectDir)
    inspections.push(inspection)
    if (inspection.kind === 'valid') entries.push({ runDir: inspection.runDir, workflow: inspection.identity.workflow, runStatus: inspection.state.status, phase: inspection.state.phase, valid: true })
    else if (inspection.kind === 'legacy' || inspection.kind === 'invalid') entries.push({ runDir: inspection.runDir, valid: false, reason: inspection.reason })
  }
  return { entries, inspections, truncated }
}

function experimentHashes(task: string, profile: string): { taskHash: string; profileHash: string } {
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
  return { taskHash: hash(task), profileHash: hash(profile) }
}

async function frozenExperimentInput(runDir: string, task?: string): Promise<{ task: string; profile: string; maxRounds: number } | { error: string }> {
  const request = await readMetadata(join(runDir, '.autoresearch', 'experiment-request.json'))
  if (request.error || request.value === undefined) return { error: request.error ?? 'experiment recovery requires a frozen experiment request' }
  if (!isRecord(request.value) || request.value.version !== 1 || typeof request.value.task !== 'string' || request.value.task.trim().length === 0 || typeof request.value.profile !== 'string' || !Number.isSafeInteger(request.value.maxRounds) || (request.value.maxRounds as number) < 1) return { error: 'corrupt frozen experiment request' }
  const frozen = { task: request.value.task, profile: request.value.profile, maxRounds: request.value.maxRounds as number }
  if (task !== undefined && task !== frozen.task) return { error: 'experiment task does not match the frozen request' }
  const manifest = await readMetadata(join(runDir, '.autoresearch', 'experiment-manifest.json'))
  if (manifest.error || manifest.value === undefined || !isRecord(manifest.value)) return { error: manifest.error ?? 'experiment manifest is missing' }
  if (manifest.value.schema !== 'autoresearch/experiment-manifest/v1') return { error: 'invalid experiment manifest' }
  const hashes = experimentHashes(frozen.task, frozen.profile)
  if (manifest.value.taskHash !== hashes.taskHash || manifest.value.profileHash !== hashes.profileHash) return { error: 'experiment task/profile does not match the manifest' }
  return frozen
}

async function safeNewRun(runDir: string, projectDir: string): Promise<StartupResult | undefined> {
  const path = resolve(runDir)
  let occupied = false
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'blocked', reason: 'runDir cannot be read', runDir: path }
  }
  let canonical = path
  if (info) {
    if (info.isSymbolicLink()) return { status: 'blocked', reason: 'runDir must not be a symlink for a new task', runDir: path }
    if (!info.isDirectory()) return { status: 'blocked', reason: 'runDir must be a directory', runDir: path }
    canonical = await realpath(path)
    if (!samePath(canonical, path)) return { status: 'blocked', reason: 'runDir must not traverse a symlink for a new task', runDir: path }
    try { occupied = (await readdir(canonical)).length > 0 }
    catch { return { status: 'blocked', reason: 'runDir cannot be read', runDir: canonical } }
  } else {
    let cursor = path, suffix: string[] = []
    while (true) {
      try {
        const existing = await lstat(cursor)
        if (existing.isSymbolicLink()) return { status: 'blocked', reason: 'runDir parent must not traverse a symlink', runDir: path }
        if (!existing.isDirectory()) return { status: 'blocked', reason: 'runDir parent is not a directory', runDir: path }
        canonical = join(await realpath(cursor), ...suffix)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'blocked', reason: 'runDir parent cannot be read', runDir: path }
        const parent = dirname(cursor)
        if (parent === cursor) return { status: 'blocked', reason: 'runDir parent cannot be resolved', runDir: path }
        suffix.unshift(cursor.slice(parent.length + 1)); cursor = parent
      }
    }
  }
  if (samePath(canonical, projectDir) || ancestorOrSame(canonical, projectDir)) return { status: 'blocked', reason: 'new runDir must be distinct from projectDir and cannot be its ancestor', runDir: canonical }
  if (occupied) return { status: 'blocked', reason: 'runDir is occupied; choose a fresh runDir', runDir: canonical }
  return undefined
}

async function resumeStartup(input: StartupInput, context: StartupContext, projectDir: string): Promise<StartupResult> {
  let local: Awaited<ReturnType<typeof localCandidates>> | undefined
  const discoverLocal = async () => local ??= await localCandidates(projectDir)
  if (input.runDir) {
    const inspected = await inspectRun(input.runDir, projectDir)
    if (inspected.kind === 'valid') {
      const result = resultForRun(inspected, projectDir, input.task)
      if (inspected.identity.workflow === 'experiment' && (inspected.state.status === 'RUNNING' || inspected.state.status === 'WAITING')) {
        const frozen = await frozenExperimentInput(inspected.runDir, input.task)
        if ('error' in frozen) return { status: 'blocked', reason: frozen.error, workflow: inspected.identity.workflow, runDir: inspected.runDir, runStatus: inspected.state.status, phase: inspected.state.phase }
        result.nextAction = actionFor('experiment', inspected.runDir, projectDir, frozen.task, frozen)
      }
      return result
    }
    if (inspected.kind === 'foreign') return { status: 'blocked', reason: 'project identity mismatch; choose a run belonging to this project', runDir: inspected.runDir }
    return { status: inspected.kind === 'missing' ? 'needs-input' : 'blocked', reason: inspected.kind === 'missing' ? 'resume runDir does not exist' : inspected.reason, runDir: inspected.runDir }
  }
  if (context.sessionRunDir) {
    const hinted = await inspectRun(context.sessionRunDir, projectDir)
    if (hinted.kind === 'valid') {
      const result = resultForRun(hinted, projectDir, input.task)
      if (hinted.identity.workflow === 'experiment' && (hinted.state.status === 'RUNNING' || hinted.state.status === 'WAITING')) {
        const frozen = await frozenExperimentInput(hinted.runDir, input.task)
        if ('error' in frozen) return { status: 'blocked', reason: frozen.error, workflow: hinted.identity.workflow, runDir: hinted.runDir, runStatus: hinted.state.status, phase: hinted.state.phase }
        result.nextAction = actionFor('experiment', hinted.runDir, projectDir, frozen.task, frozen)
      }
      return result
    }
    // A session hint is an explicit host binding. A valid foreign binding is
    // safely ignored, but malformed metadata cannot be disambiguated as
    // foreign and must never silently fall through to another run.
    if (hinted.kind === 'invalid' || hinted.kind === 'legacy') return { status: 'blocked', reason: hinted.reason, runDir: hinted.runDir }
  }
  local = await discoverLocal()
  const candidates = local.entries
  const localCorrupt = local.inspections.find(item => item.kind === 'invalid' && item.matching)
  if (localCorrupt && localCorrupt.kind === 'invalid') return { status: 'blocked', reason: localCorrupt.reason, candidates }
  if (local.truncated) return { status: 'needs-input', reason: 'local run discovery reached its bound; provide an explicit runDir', candidates }
  const inspected = local.inspections
  const active = inspected.filter((item): item is Extract<Inspection, { kind: 'valid' }> => item.kind === 'valid' && ACTIVE_STATUSES.has(item.state.status))
  if (active.length > 1) return { status: 'needs-input', reason: 'multiple verified active runs require an explicit runDir', candidates }
  if (active.length === 1) {
    const selected = active.at(0)
    if (!selected) return { status: 'needs-input', reason: 'no unique verified active run was found; provide an explicit runDir', candidates }
    const result = resultForRun(selected, projectDir, input.task)
    if (selected.identity.workflow === 'experiment' && (selected.state.status === 'RUNNING' || selected.state.status === 'WAITING')) {
      const frozen = await frozenExperimentInput(selected.runDir, input.task)
      if ('error' in frozen) return { status: 'blocked', reason: frozen.error, workflow: selected.identity.workflow, runDir: selected.runDir, runStatus: selected.state.status, phase: selected.state.phase, candidates }
      result.nextAction = actionFor('experiment', selected.runDir, projectDir, frozen.task, frozen)
    }
    return result
  }
  const terminal = inspected.filter((item): item is Extract<Inspection, { kind: 'valid' }> => item.kind === 'valid' && (item.state.status === 'COMPLETED' || item.state.status === 'FAILED'))
  if (terminal.length === 1) {
    const selected = terminal.at(0)
    if (selected) return resultForRun(selected, projectDir, input.task)
  }
  return { status: 'needs-input', reason: 'no unique verified active run was found; provide an explicit runDir', candidates: candidates.length > 0 ? candidates : undefined }
}

export async function prepareStartup(rawInput: StartupInput, rawContext?: StartupContext): Promise<StartupResult> {
  const { input, context } = validateInput(rawInput, rawContext)
  const projectDir = await existingProject(input.projectDir)
  if (input.intent === 'ambiguous') return { status: 'needs-input', reason: 'choose an explicit startup intent: research, project-paper, experiment, or resume' }
  if (input.intent === 'resume') return resumeStartup(input, context, projectDir)
  if (input.intent === 'experiment' && input.task === undefined) return { status: 'needs-input', reason: 'experiment requires an explicit task' }
  if (!input.runDir) return { status: 'needs-input', reason: `${input.intent} requires an explicit runDir` }
  const unsafe = await safeNewRun(input.runDir, projectDir)
  if (unsafe) return unsafe
  const runDir = resolve(input.runDir)
  const action = actionFor(input.intent, runDir, projectDir, input.task)
  return { status: 'ready', reason: `ready to start a new ${input.intent} run`, workflow: input.intent, runDir, nextAction: action }
}
