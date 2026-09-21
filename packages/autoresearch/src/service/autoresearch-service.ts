import { existsSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createLogger, DEFAULT_MAX_CYCLES, readOptionalText, writeText } from '../core/utils.js'
import { ResearchTree } from '../core/research-tree.js'
import { createInitialState, loadState, saveState } from '../core/state.js'
import type { RunState } from '../core/types.js'
import { ensureDir } from '../core/utils.js'
import type { RoleAgentProvider, RoleExecutionContext } from '../agents/types.js'
import type { HumanReviewer, ReviewGateId } from '../core/human-review.js'
import type { HumanReviewMode } from '../session/auto-mode.js'
import { writeFailureReport } from '../domain/files.js'
import { writeLastRun } from '../session/last-run.js'
import { ResearchRunner } from './runner.js'
import type { PaperOptions } from '../paper/pipeline.js'
import { loadProjectSecrets, loadProjectSettings } from '../settings/project-settings.js'
import { isRecord } from '../settings/schema.js'
import { createPolicySnapshot, frozenLiteratureSettings } from '../policy/model-routing.js'
import { openRequestLedger, isBudgetExhaustedError } from '../policy/request-ledger.js'
import { isExperimentPauseError } from '../experiment/errors.js'
import { assertFailureImportTarget, importResearchFailure, type FailureReportImport } from './failure-import.js'
import { bindResearchOutputs } from './research-outputs.js'
import { bindRunProject } from './project-paper.js'
import { discoverProject, validateCompletedDiscovery } from '../project/discovery.js'
import { advanceCleanupQueue, finalizeDirectionRetirement, isDirectionRetired } from '../cleanup/index.js'
import { ResearchStore } from '../research/store.js'
import { readContinuation, validateRecovery, consumeRecovery, recordContinuationPause } from './continuation.js'
import { parseAcceptance, parseRecovery, type AcceptanceInput, type RecoveryInput } from '../research/continuation.js'
import { hashContent } from '../research/records.js'
import type { DiscoveryRuntimeOptions } from './types.js'

export interface ResearchRunOptions {
  acceptance?: AcceptanceInput
  recovery?: RecoveryInput
  failureReport?: FailureReportImport
  runDir: string
  projectDir?: string
  candidatePath?: string
  profilePath?: string
  maxCycles?: number
  paper?: PaperOptions
  humanReview?: HumanReviewMode
  brainstorm?: HumanReviewMode
}

export type ResearchRunContext = RoleExecutionContext

async function copyExternalIdea(runDir: string, candidatePath: string): Promise<void> {
  const runRelative = resolve(runDir, candidatePath)
  const source = existsSync(runRelative) ? runRelative : resolve(candidatePath)
  if (!existsSync(source)) throw new Error(`candidate idea not found: ${source}`)
  const inputDir = join(runDir, 'input')
  await ensureDir(inputDir)
  await copyFile(source, join(inputDir, 'idea.md'))
  await copyFile(source, join(inputDir, 'candidate.md'))
}

export interface AutoResearchServiceOptions {
  reviewer?: HumanReviewer
  reviewGates?: ReviewGateId[]
  /** Trusted host injection; never accepted from model-facing tool arguments. */
  experimentRuntimeForProject?: (projectDir: string) => Promise<NonNullable<RoleExecutionContext['experimentRuntime']>>
  discovery?: DiscoveryRuntimeOptions
}

const POLICY_SNAPSHOT_FILE = join('.autoresearch', 'policy-snapshot.json')
type FrozenPolicySnapshot = NonNullable<RoleExecutionContext['policySnapshot']>

const POLICY_TIERS = ['cheap', 'standard', 'deep'] as const
const WORKFLOW_TOGGLES = ['enabled', 'auto', 'never'] as const

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFrozenPolicySnapshot(value: unknown): value is FrozenPolicySnapshot {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.model) || typeof value.model.useGlobal !== 'boolean' || !isRecord(value.modelRouting) || typeof value.modelRouting.enabled !== 'boolean' || !POLICY_TIERS.includes(value.modelRouting.defaultTier as typeof POLICY_TIERS[number]) || !isRecord(value.modelRouting.tiers) || !isRecord(value.modelRouting.roles) || !isRecord(value.workflow) || (value.workflow.mode !== 'minimal' && value.workflow.mode !== 'legacy') || !isRecord(value.budget) || !isRecord(value.budget.context)) return false
  const overrides = value.model.overrides
  if (overrides !== undefined && (!isRecord(overrides) || (overrides.provider !== undefined && typeof overrides.provider !== 'string') || (overrides.model !== undefined && typeof overrides.model !== 'string') || (overrides.reasoningEffort !== undefined && typeof overrides.reasoningEffort !== 'string'))) return false
  for (const tier of POLICY_TIERS) {
    const config = value.modelRouting.tiers[tier]
    if (!isRecord(config) || typeof config.provider !== 'string' || typeof config.model !== 'string' || (config.maxInputTokens !== undefined && !nonNegativeInteger(config.maxInputTokens)) || (config.maxOutputTokens !== undefined && !nonNegativeInteger(config.maxOutputTokens))) return false
  }
  for (const config of Object.values(value.modelRouting.roles)) {
    if (!isRecord(config) || (config.tier !== undefined && !POLICY_TIERS.includes(config.tier as typeof POLICY_TIERS[number])) || (config.provider !== undefined && typeof config.provider !== 'string') || (config.model !== undefined && typeof config.model !== 'string') || (config.maxInputTokens !== undefined && !nonNegativeInteger(config.maxInputTokens)) || (config.maxOutputTokens !== undefined && !nonNegativeInteger(config.maxOutputTokens)) || (config.escalateTo !== undefined && !POLICY_TIERS.includes(config.escalateTo as typeof POLICY_TIERS[number])) || (config.escalateOn !== undefined && (!Array.isArray(config.escalateOn) || config.escalateOn.some((entry) => typeof entry !== 'string')))) return false
  }
  const workflow = value.workflow
  if (workflow.currentIdeaSearch !== undefined && workflow.currentIdeaSearch !== 'enabled' && workflow.currentIdeaSearch !== 'never') return false
  for (const key of ['brainstorm', 'deepDive', 'modelScout', 'experimentReview', 'paper', 'postResultSynthesis']) if (!WORKFLOW_TOGGLES.includes(workflow[key] as typeof WORKFLOW_TOGGLES[number])) return false
  for (const key of ['paperImprovementRounds', 'candidateLimit', 'reflexionRounds']) if (!nonNegativeInteger(workflow[key])) return false
  const budget = value.budget
  for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxRunTokens', 'maxRoleCalls', 'maxRetriesPerCall', 'jsonRepairAttempts', 'maxUpgradesPerTask']) if (!nonNegativeInteger(budget[key])) return false
  const contextBudget = budget.context
  if (!isRecord(contextBudget)) return false
  for (const key of ['treeSummaryTokens', 'evidenceTokens', 'paperTokens', 'failureTokens']) if (!nonNegativeInteger(contextBudget[key])) return false
  return true
}

function freezePolicy<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezePolicy(child)
    Object.freeze(value)
  }
  return value
}

async function loadFrozenPolicy(runDir: string, projectSettings: Awaited<ReturnType<typeof loadProjectSettings>>, existing: boolean) {
  const path = join(runDir, POLICY_SNAPSHOT_FILE)
  const text = await readOptionalText(path)
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isFrozenPolicySnapshot(parsed)) {
        throw new Error('invalid policy snapshot shape')
      }
      const workflow = parsed.workflow as unknown as Record<string, unknown>
      const historical = existing && workflow.currentIdeaSearch === undefined
      return freezePolicy({ ...parsed, workflow: { ...workflow, ...(historical ? { currentIdeaSearch: 'never' } : {}) }, literature: frozenLiteratureSettings(parsed.literature) } as FrozenPolicySnapshot)
    } catch {
      throw new Error('invalid frozen policy snapshot at ' + path)
    }
  }
  const snapshot = { ...createPolicySnapshot(projectSettings), model: structuredClone(projectSettings.model) }
  if (existing) { snapshot.workflow.mode = 'legacy'; snapshot.workflow.currentIdeaSearch = 'never'; snapshot.literature = frozenLiteratureSettings(undefined) }
  await writeText(path, JSON.stringify(snapshot, null, 2) + '\n')
  return freezePolicy(snapshot)
}

export class AutoResearchService {
  private readonly deps: Readonly<{ provider: RoleAgentProvider; options: AutoResearchServiceOptions }>

  constructor(provider: RoleAgentProvider, options: AutoResearchServiceOptions = {}) {
    this.deps = { provider, options }
  }

  async run(options: ResearchRunOptions, context: ResearchRunContext): Promise<RunState> {
    return this.runInternal(options, context)
  }

  async runProjectPaper(options: ResearchRunOptions & { projectDir: string }, context: ResearchRunContext): Promise<RunState> {
    if (!options.projectDir?.trim()) throw new TypeError('projectDir is required for project-paper discovery')
    if (options.candidatePath || options.failureReport) throw new TypeError('project-paper discovery requires its own source-grounded candidate')
    return this.runInternal(options, context, 'project-paper')
  }

  private async runInternal(options: ResearchRunOptions, context: ResearchRunContext, requestedWorkflow?: 'project-paper'): Promise<RunState> {
    const runDir = options.runDir
    await assertFailureImportTarget(runDir, options.failureReport)
    if (options.maxCycles !== undefined && (!Number.isSafeInteger(options.maxCycles) || options.maxCycles < 1)) throw new TypeError('maxCycles must be a positive finite integer')
    // Admit the run's project/workflow before any state or input mutation.
    // Generic research may inherit project-paper identity on resume, while an
    // experiment identity is exclusively owned by the experiment runner.
    const existing = await loadState(runDir)
    if (options.acceptance) parseAcceptance(options.acceptance)
    if (options.recovery) parseRecovery(options.recovery)
    let continuation = await readContinuation(runDir)
    if (continuation && options.acceptance && hashContent(parseAcceptance(options.acceptance).criteria) !== hashContent(continuation.acceptance.criteria.map(({ origin: _origin, ...criterion }) => criterion))) throw new TypeError('acceptance is immutable; create a new run')
    if (continuation && options.maxCycles !== undefined && options.maxCycles !== continuation.control.maxCycles && !options.recovery) throw new TypeError('maxCycles change requires explicit recovery')
    if (continuation && options.candidatePath) {
      const local = resolve(runDir, options.candidatePath), source = existsSync(local) ? local : resolve(options.candidatePath)
      if (await readOptionalText(source) !== continuation.acceptance.goalProfileRubric.goal) throw new TypeError('frozen acceptance goal cannot be replaced on resume')
    }
    if (continuation && options.profilePath && await readOptionalText(resolve(runDir, options.profilePath)) !== continuation.acceptance.goalProfileRubric.profile) throw new TypeError('frozen acceptance profile cannot be replaced on resume')
    const continuationResume = Boolean(existing && (existing.status === 'PAUSED' || options.recovery || continuation?.recoveryTransaction?.status === 'pending' || continuation?.resumeReviewRequired || (!continuation && existing.phase !== 'intake')))
    const savedIdentity = await readOptionalText(join(runDir, '.autoresearch', 'project-identity.json'))
    const savedExperimentManifest = await readOptionalText(join(runDir, '.autoresearch', 'experiment-manifest.json'))
    const savedExperimentRequest = await readOptionalText(join(runDir, '.autoresearch', 'experiment-request.json'))
    if (existing && (existing.status === 'COMPLETED' || existing.status === 'FAILED') && savedIdentity) {
      const terminalIdentity = await bindRunProject(options, requestedWorkflow, true)
      if (terminalIdentity.workflow === 'project-paper') await validateCompletedDiscovery(runDir, terminalIdentity.projectDir)
      // Existing authorized cleanup remains independently resumable. No research
      // role, acceptance migration, state write or historical decision is replayed.
      try {
        const current = await new ResearchStore(runDir).loadCurrent()
        if (current) await finalizeDirectionRetirement({ projectDir: terminalIdentity.projectDir, runDir, cycle: existing.cycle, snapshot: current })
        else await advanceCleanupQueue(terminalIdentity.projectDir)
      } catch (error) { console.error(`[cleanup] terminal resume deferred: ${String(error)}`) }
      return existing
    }
    if (!requestedWorkflow && existing && (existing.status === 'COMPLETED' || existing.status === 'FAILED') && savedIdentity === undefined && savedExperimentManifest === undefined && savedExperimentRequest === undefined) {
      // Historical terminal runs predate identity metadata. Preserve their
      // status as a read-only compatibility view instead of rebinding them.
      return existing
    }
    const identity = await bindRunProject(options, requestedWorkflow, existing !== undefined)
    if (options.recovery) { await validateRecovery(runDir, options.recovery, options.maxCycles); continuation = await readContinuation(runDir) }
    if (existing?.status === 'PAUSED' && continuation && !options.recovery && continuation.recoveryTransaction?.status !== 'pending') return existing
    const logger = createLogger(runDir)
    logger.info(`AutoResearchService.run start runDir=${runDir}`)
    await ensureDir(runDir)
    const projectPaper = identity.workflow === 'project-paper'
    // Cleanup is a resumable project concern. A malformed/blocked cleanup
    // task must never turn into a scientific run failure.
    try { await advanceCleanupQueue(identity.projectDir) }
    catch (error) { logger.warn(`cleanup queue could not advance; will retry on resume: ${String(error)}`) }
    if (projectPaper && (options.candidatePath || options.failureReport)) throw new Error('project discovery candidate cannot be replaced on resume')
    if (options.candidatePath) {
      await copyExternalIdea(runDir, options.candidatePath)
    }
    const state = existing ?? await createInitialState(runDir)
    await importResearchFailure(runDir, state.runId, options.failureReport)
    if (state.status === 'COMPLETED' || state.status === 'FAILED') {
      if (projectPaper) await validateCompletedDiscovery(runDir, identity.projectDir)
      logger.info(`run already terminal status=${state.status}`)
      try {
        const current = await new ResearchStore(runDir).loadCurrent()
        if (current) await finalizeDirectionRetirement({ projectDir: identity.projectDir, runDir, cycle: state.cycle, snapshot: current })
        else await advanceCleanupQueue(identity.projectDir)
      } catch (error) { console.error(`[cleanup] terminal resume deferred: ${String(error)}`) }
      return state
    }
    const currentBeforeDispatch = await new ResearchStore(runDir).loadCurrent()
    if (currentBeforeDispatch && await isDirectionRetired({ projectDir: identity.projectDir, runDir, snapshot: currentBeforeDispatch })) {
      state.status = 'PAUSED'
      state.lastError = 'direction retired; cleanup completed and resume will not redispatch it'
      await saveState(runDir, state)
      return state
    }
    state.status = 'RUNNING'
    await saveState(runDir, state)
    await consumeRecovery(runDir)
    try {
      const tree = await ResearchTree.load(runDir)
      const projectDir = identity.projectDir
      const projectSettings = await loadProjectSettings(projectDir)
      if (projectPaper) {
        projectSettings.workflow.paper = 'enabled'
        projectSettings.workflow.brainstorm = 'never'
      }
      const policySnapshot = await loadFrozenPolicy(runDir, projectSettings, existing !== undefined && !projectPaper)
      if (projectPaper && (policySnapshot.workflow.paper !== 'enabled' || policySnapshot.workflow.brainstorm !== 'never')) throw new Error('project-paper frozen policy conflicts with workflow intent')
      const requestLedger = context.requestLedger ?? await openRequestLedger({
      runDir,
      runId: state.runId,
      config: {
        maxInputTokens: policySnapshot.budget.maxInputTokens,
        maxOutputTokens: policySnapshot.budget.maxOutputTokens,
        maxRunTokens: policySnapshot.budget.maxRunTokens,
        maxRoleCalls: policySnapshot.budget.maxRoleCalls,
        maxRetriesPerCall: policySnapshot.budget.maxRetriesPerCall,
        maxUpgradesPerTask: policySnapshot.budget.maxUpgradesPerTask,
      },
      })
      await requestLedger.recoverPending('interrupted')
      const projectSecrets = await loadProjectSecrets(projectDir)
      const paperOptions: PaperOptions = {
      ...(projectPaper ? { ...identity.options.paper, reviewBudget: undefined } : {}),
      ...(options.paper ?? {}),
      ...(projectSettings.model.supportsImageInput !== undefined && options.paper?.supportsImageInput === undefined && identity.options.paper?.supportsImageInput === undefined
        ? { supportsImageInput: projectSettings.model.supportsImageInput }
        : {}),
      ...(projectSettings.figureApi.enabled
        ? {
            figureApi: {
              ...projectSettings.figureApi,
              apiKey: projectSecrets.figureApiKey,
            },
          }
        : {}),
      }
      const runner = new ResearchRunner({
      provider: this.deps.provider,
      maxCycles: continuation?.control.maxCycles ?? options.maxCycles ?? (projectPaper ? identity.options.maxCycles : undefined) ?? DEFAULT_MAX_CYCLES,
      acceptance: options.acceptance,
      continuationResume,
      paperOptions,
      reviewer: this.deps.options.reviewer,
      reviewGates: this.deps.options.reviewGates,
      humanReviewOverride: options.humanReview,
      brainstorm: projectPaper ? 'off' : options.brainstorm,
      projectSettings,
      policySnapshot,
      discovery: this.deps.options.discovery,
      })
      const runContext: ResearchRunContext = {
      ...context,
      ...(this.deps.options.experimentRuntimeForProject ? { experimentRuntime: await this.deps.options.experimentRuntimeForProject(projectDir) } : {}),
      projectDir,
      runId: state.runId,
      policySnapshot,
      requestLedger,
      }
      if (projectPaper) await discoverProject(this.deps.provider, runDir, projectDir, runContext)
      const result = await runner.run(runDir, state, tree, runContext)
      await bindResearchOutputs(runDir, state.runId)
      await writeLastRun(runDir)
      logger.info(`AutoResearchService.run done status=${result.status}`)
      try {
        const current = await new ResearchStore(runDir).loadCurrent()
        if (current) await finalizeDirectionRetirement({ projectDir: identity.projectDir, runDir, cycle: state.cycle, snapshot: current })
        else await advanceCleanupQueue(identity.projectDir)
      } catch (error) { console.error(`[cleanup] hook deferred; will retry on resume: ${String(error)}`) }
      return result
    } catch (error) {
      logger.error('AutoResearchService.run failed', error)
      await writeLastRun(runDir)
      state.status = 'PAUSED'
      state.lastError = String(error)
      await recordContinuationPause(runDir, state, state.lastError, isBudgetExhaustedError(error))
      await saveState(runDir, state)
      await writeFailureReport(runDir, `# PAUSED\n\n${String(error)}\n`)
      await bindResearchOutputs(runDir, state.runId)
      // A pause can happen immediately after the refutation report is
      // materialized.  Finalize the cleanup only after that last checkpoint;
      // the persisted PAUSED state proves there is no live dispatch left.
      try {
        const current = await new ResearchStore(runDir).loadCurrent()
        if (current) await finalizeDirectionRetirement({ projectDir: identity.projectDir, runDir, cycle: state.cycle, snapshot: current })
        else await advanceCleanupQueue(identity.projectDir)
      } catch (cleanupError) { logger.warn(`paused refutation registration deferred: ${String(cleanupError)}`) }
      if (isExperimentPauseError(error) || isBudgetExhaustedError(error)) return state
      throw error
    }
  }

  async status(runDir: string): Promise<RunState | undefined> {
    return loadState(runDir)
  }

  async resume(options: ResearchRunOptions, context: ResearchRunContext): Promise<RunState> {
    return this.run(options, context)
  }
}
