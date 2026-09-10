import { parse, stringify } from 'yaml'
import { safeResolve, writeText, readOptionalText } from '../core/utils.js'
import { DEFAULT_PROJECT_SETTINGS, type ProjectSecrets, type ProjectSettings } from './schema.js'
import { migrateProjectSettings, validateProjectSettingsCandidate } from './migration.js'

export * from './schema.js'
export { migrateProjectSettings, validateProjectSettingsCandidate } from './migration.js'

export function projectSettingsPath(projectDir: string): string { return safeResolve(projectDir, '.autoresearch', 'project-settings.yaml') }
export function projectSecretsPath(projectDir: string): string { return safeResolve(projectDir, '.autoresearch', 'project-secrets.yaml') }

export async function loadProjectSettings(projectDir: string): Promise<ProjectSettings> {
  const file = projectSettingsPath(projectDir)
  const text = await readOptionalText(file)
  if (!text) return structuredClone(DEFAULT_PROJECT_SETTINGS)
  let parsed: unknown
  try { parsed = parse(text) } catch (cause) { throw settingsCorrupt(file, [{ path: '/', code: 'YAML_PARSE', message: String(cause) }]) }
  const result = validateProjectSettingsCandidate(parsed)
  if (!result.valid || !result.settings) throw settingsCorrupt(file, result.errors)
  return result.settings
}

export async function saveProjectSettings(projectDir: string, settings: ProjectSettings): Promise<ProjectSettings> {
  const { readProjectSettingsDocument, saveProjectSettingsDocument } = await import('./service.js')
  const current = await readProjectSettingsDocument(projectDir)
  return (await saveProjectSettingsDocument(projectDir, settings, current.revision)).settings
}

export async function loadProjectSecrets(projectDir: string): Promise<ProjectSecrets> {
  const text = await readOptionalText(projectSecretsPath(projectDir))
  if (!text) return {}
  try { return (parse(text) as ProjectSecrets) ?? {} } catch (cause) { throw settingsCorrupt(projectSecretsPath(projectDir), [{ path: '/', code: 'YAML_PARSE', message: String(cause) }]) }
}

export async function saveProjectSecrets(projectDir: string, secrets: ProjectSecrets): Promise<ProjectSecrets> {
  await writeText(projectSecretsPath(projectDir), `${stringify(secrets)}\n`)
  return secrets
}

export function normalizeProjectSettings(settings: Partial<ProjectSettings>): ProjectSettings { return migrateProjectSettings(settings) }

export function maskProjectSettings(settings: ProjectSettings, secrets: ProjectSecrets = {}): ProjectSettings & { figureApiKeyMasked?: string } {
  const masked: ProjectSettings & { figureApiKeyMasked?: string } = structuredClone(settings)
  if (secrets.figureApiKey) masked.figureApiKeyMasked = `${secrets.figureApiKey.slice(0, 4)}****`
  if (masked.figureApi && 'apiKey' in masked.figureApi) delete masked.figureApi.apiKey
  return masked
}

export function settingsCorrupt(file: string, errors: Array<{ path: string; code: string; message: string }>): Error & { code: string; file: string; errors: typeof errors } {
  const error = new Error(`invalid project settings at ${file}`) as Error & { code: string; file: string; errors: typeof errors }
  error.name = 'ProjectSettingsCorruptError'; error.code = 'SETTINGS_CORRUPT'; error.file = file; error.errors = errors
  return error
}
