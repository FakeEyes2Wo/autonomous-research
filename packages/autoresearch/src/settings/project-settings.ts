import { parse, stringify } from 'yaml'
import { safeResolve, writeText, readOptionalText } from '../core/utils.js'

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
  apiKey?: string // runtime-only, not persisted in project-settings.yaml
}

export interface ModelSettings {
  useGlobal: boolean
  overrides?: {
    provider?: string
    model?: string
    reasoningEffort?: string
  }
}

export interface ExperimentSettings {
  maxRounds?: number
  profile?: string
}

export interface ProjectSettings {
  version: 1
  paperExploration: PaperExplorationSettings
  figureApi: FigureApiSettings
  model: ModelSettings
  experiment: ExperimentSettings
}

export interface ProjectSecrets {
  figureApiKey?: string
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  version: 1,
  paperExploration: {
    maxPapers: 60,
    minSurveys: 3,
    minClusters: 5,
    latestWindowYears: 1,
    latestPerDirection: 5,
    maxSelectedDirections: 3,
  },
  figureApi: {
    enabled: false,
    apiUrl: '',
    timeoutMs: 60_000,
  },
  model: {
    useGlobal: true,
  },
  experiment: {
    maxRounds: 1,
    profile: '',
  },
}

export function projectSettingsPath(projectDir: string): string {
  return safeResolve(projectDir, '.autoresearch', 'project-settings.yaml')
}

export function projectSecretsPath(projectDir: string): string {
  return safeResolve(projectDir, '.autoresearch', 'project-secrets.yaml')
}

export async function loadProjectSettings(projectDir: string): Promise<ProjectSettings> {
  const file = projectSettingsPath(projectDir)
  const text = await readOptionalText(file)
  if (!text) return structuredClone(DEFAULT_PROJECT_SETTINGS)
  try {
    const parsed = parse(text) as Partial<ProjectSettings> | null
    return normalizeProjectSettings(parsed ?? {})
  } catch {
    return structuredClone(DEFAULT_PROJECT_SETTINGS)
  }
}

export async function saveProjectSettings(projectDir: string, settings: ProjectSettings): Promise<ProjectSettings> {
  const normalized = normalizeProjectSettings(settings)
  await writeText(projectSettingsPath(projectDir), `${stringify(normalized)}\n`)
  return normalized
}

export async function loadProjectSecrets(projectDir: string): Promise<ProjectSecrets> {
  const file = projectSecretsPath(projectDir)
  const text = await readOptionalText(file)
  if (!text) return {}
  try {
    return (parse(text) as ProjectSecrets) ?? {}
  } catch {
    return {}
  }
}

export async function saveProjectSecrets(projectDir: string, secrets: ProjectSecrets): Promise<ProjectSecrets> {
  await writeText(projectSecretsPath(projectDir), `${stringify(secrets)}\n`)
  return secrets
}

export function normalizeProjectSettings(settings: Partial<ProjectSettings>): ProjectSettings {
  const base = JSON.parse(JSON.stringify(DEFAULT_PROJECT_SETTINGS)) as ProjectSettings
  const paper: Partial<PaperExplorationSettings> = settings.paperExploration ?? {}
  const figure: Partial<FigureApiSettings> = settings.figureApi ?? {}
  const model: Partial<ModelSettings> = settings.model ?? {}
  const experiment: Partial<ExperimentSettings> = settings.experiment ?? {}
  return {
    version: 1,
    paperExploration: {
      maxPapers: numOr(paper.maxPapers, base.paperExploration.maxPapers),
      minSurveys: numOr(paper.minSurveys, base.paperExploration.minSurveys),
      minClusters: numOr(paper.minClusters, base.paperExploration.minClusters),
      latestWindowYears: numOr(paper.latestWindowYears, base.paperExploration.latestWindowYears),
      latestPerDirection: numOr(paper.latestPerDirection, base.paperExploration.latestPerDirection),
      maxSelectedDirections: numOr(paper.maxSelectedDirections, base.paperExploration.maxSelectedDirections),
    },
    figureApi: {
      enabled: typeof figure.enabled === 'boolean' ? figure.enabled : base.figureApi.enabled,
      apiUrl: typeof figure.apiUrl === 'string' ? figure.apiUrl : base.figureApi.apiUrl,
      model: typeof figure.model === 'string' ? figure.model : undefined,
      timeoutMs: numOr(figure.timeoutMs, base.figureApi.timeoutMs ?? 60_000),
    },
    model: {
      useGlobal: typeof model.useGlobal === 'boolean' ? model.useGlobal : true,
      overrides: model.overrides ? {
        ...(typeof model.overrides.provider === 'string' ? { provider: model.overrides.provider } : {}),
        ...(typeof model.overrides.model === 'string' ? { model: model.overrides.model } : {}),
        ...(typeof model.overrides.reasoningEffort === 'string' ? { reasoningEffort: model.overrides.reasoningEffort } : {}),
      } : undefined,
    },
    experiment: {
      maxRounds: numOr(experiment.maxRounds, base.experiment.maxRounds ?? 1),
      profile: typeof experiment.profile === 'string' ? experiment.profile : base.experiment.profile,
    },
  }
}

export function maskProjectSettings(settings: ProjectSettings, secrets: ProjectSecrets = {}): ProjectSettings & { figureApiKeyMasked?: string } {
  const masked: ProjectSettings & { figureApiKeyMasked?: string } = structuredClone(settings)
  if (secrets.figureApiKey) {
    masked.figureApiKeyMasked = `${secrets.figureApiKey.slice(0, 4)}****`
  }
  return masked
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
