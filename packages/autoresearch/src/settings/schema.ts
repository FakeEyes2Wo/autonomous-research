export type CapabilityTier = 'cheap' | 'standard' | 'deep'
export type WorkflowMode = 'minimal' | 'legacy'
export type WorkflowToggle = 'enabled' | 'auto' | 'never'

export interface PaperExplorationSettings {
  maxPapers: number
  minSurveys: number
  minClusters: number
  latestWindowYears: number
  latestPerDirection: number
  maxSelectedDirections: number
}

export interface FigureApiSettings {
  enabled: boolean
  apiUrl: string
  model?: string
  timeoutMs?: number
  apiKey?: string
}

export interface ModelSettings {
  useGlobal: boolean
  overrides?: { provider?: string; model?: string; reasoningEffort?: string }
  supportsImageInput?: boolean
}

export interface ExperimentSettings { maxRounds?: number; profile?: string }

export interface ModelRouteSettings {
  provider: string
  model: string
  maxInputTokens?: number
  maxOutputTokens?: number
}

export interface RoleRouteSettings {
  tier?: CapabilityTier
  provider?: string
  model?: string
  maxInputTokens?: number
  maxOutputTokens?: number
  escalateTo?: CapabilityTier
  escalateOn?: string[]
}

export interface ModelRoutingSettings {
  enabled: boolean
  defaultTier: CapabilityTier
  tiers: Record<CapabilityTier, ModelRouteSettings>
  roles: Record<string, RoleRouteSettings>
}

export interface WorkflowSettings {
  mode: WorkflowMode
  brainstorm: WorkflowToggle
  deepDive: WorkflowToggle
  modelScout: WorkflowToggle
  experimentReview: WorkflowToggle
  paper: WorkflowToggle
  postResultSynthesis: WorkflowToggle
  paperImprovementRounds: number
  candidateLimit: number
  reflexionRounds: number
}

export interface ContextBudgetSettings {
  treeSummaryTokens: number
  evidenceTokens: number
  paperTokens: number
  failureTokens: number
}

export interface BudgetSettings {
  maxInputTokens: number
  maxOutputTokens: number
  maxRunTokens: number
  maxRoleCalls: number
  maxRetriesPerCall: number
  jsonRepairAttempts: number
  maxUpgradesPerTask: number
  context: ContextBudgetSettings
}

export interface ProjectSettings {
  version: 2
  revision?: string
  paperExploration: PaperExplorationSettings
  figureApi: FigureApiSettings
  model: ModelSettings
  experiment: ExperimentSettings
  modelRouting: ModelRoutingSettings
  workflow: WorkflowSettings
  budget: BudgetSettings
  extensions?: Record<string, unknown>
}

export interface ProjectSecrets { figureApiKey?: string }

export interface ValidationError { path: string; code: string; message: string }
export interface ValidationWarning { path: string; code: string; message: string }
export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  settings?: ProjectSettings
}

const route = (provider: string, model: string): ModelRouteSettings => ({ provider, model })

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  version: 2,
  revision: undefined,
  paperExploration: { maxPapers: 60, minSurveys: 3, minClusters: 5, latestWindowYears: 1, latestPerDirection: 5, maxSelectedDirections: 3 },
  figureApi: { enabled: false, apiUrl: '', timeoutMs: 60_000 },
  model: { useGlobal: true },
  experiment: { maxRounds: 1, profile: '' },
  modelRouting: {
    enabled: false,
    defaultTier: 'standard',
    tiers: { cheap: route('', ''), standard: route('', ''), deep: route('', '') },
    roles: {},
  },
  workflow: { mode: 'legacy', brainstorm: 'auto', deepDive: 'auto', modelScout: 'auto', experimentReview: 'auto', paper: 'auto', postResultSynthesis: 'auto', paperImprovementRounds: 0, candidateLimit: 3, reflexionRounds: 1 },
  budget: { maxInputTokens: 24_000, maxOutputTokens: 8_000, maxRunTokens: 120_000, maxRoleCalls: 120, maxRetriesPerCall: 1, jsonRepairAttempts: 1, maxUpgradesPerTask: 1, context: { treeSummaryTokens: 2_500, evidenceTokens: 5_000, paperTokens: 8_000, failureTokens: 2_500 } },
}

export const WORKFLOW_TOGGLES: readonly WorkflowToggle[] = ['enabled', 'auto', 'never']
export const CAPABILITY_TIERS: readonly CapabilityTier[] = ['cheap', 'standard', 'deep']

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
