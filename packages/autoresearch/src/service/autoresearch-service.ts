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
import { createPolicySnapshot } from '../policy/model-routing.js'
import { openRequestLedger } from '../policy/request-ledger.js'

export interface ResearchRunOptions {
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
      return freezePolicy(parsed as FrozenPolicySnapshot)
    } catch {
      throw new Error('invalid frozen policy snapshot at ' + path)
    }
  }
  const snapshot = { ...createPolicySnapshot(projectSettings), model: structuredClone(projectSettings.model) }
  if (existing) snapshot.workflow.mode = 'legacy'
  await writeText(path, JSON.stringify(snapshot, null, 2) + '\n')
  return freezePolicy(snapshot)
}

export class AutoResearchService {
  private readonly deps: Readonly<{ provider: RoleAgentProvider; options: AutoResearchServiceOptions }>

  constructor(provider: RoleAgentProvider, options: AutoResearchServiceOptions = {}) {
    this.deps = { provider, options }
  }

  async run(options: ResearchRunOptions, context: ResearchRunContext): Promise<RunState> {
    const runDir = options.runDir
    const logger = createLogger(runDir)
    logger.info(`AutoResearchService.run start runDir=${runDir}`)
    await ensureDir(runDir)
    if (options.candidatePath) {
      await copyExternalIdea(runDir, options.candidatePath)
    }
    const existing = await loadState(runDir)
    const state = existing ?? await createInitialState(runDir)
    if (state.status === 'COMPLETED' || state.status === 'FAILED') {
      logger.info(`run already terminal status=${state.status}`)
      return state
    }
    state.status = 'RUNNING'
    await saveState(runDir, state)
    try {
      const tree = await ResearchTree.load(runDir)
      const projectDir = options.projectDir ?? runDir
      const projectSettings = await loadProjectSettings(projectDir)
      const policySnapshot = await loadFrozenPolicy(runDir, projectSettings, existing !== undefined)
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
      ...(options.paper ?? {}),
      ...(projectSettings.model.supportsImageInput !== undefined
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
      maxCycles: options.maxCycles ?? DEFAULT_MAX_CYCLES,
      paperOptions,
      reviewer: this.deps.options.reviewer,
      reviewGates: this.deps.options.reviewGates,
      humanReviewOverride: options.humanReview,
      brainstorm: options.brainstorm,
      projectSettings,
      policySnapshot,
      })
      const runContext: ResearchRunContext = {
      ...context,
      projectDir,
      runId: state.runId,
      policySnapshot,
      requestLedger,
      }
      const result = await runner.run(runDir, state, tree, runContext)
      await writeLastRun(runDir)
      logger.info(`AutoResearchService.run done status=${result.status}`)
      return result
    } catch (error) {
      logger.error('AutoResearchService.run failed', error)
      await writeLastRun(runDir)
      state.status = 'PAUSED'
      state.lastError = String(error)
      await saveState(runDir, state)
      await writeFailureReport(runDir, `# PAUSED\n\n${String(error)}\n`)
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
