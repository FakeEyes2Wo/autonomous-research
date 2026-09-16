import type { CapabilityTier, ModelRouteSettings, ProjectSettings } from '../settings/schema.js'
import { validateProjectSettingsCandidate } from '../settings/migration.js'

export interface RoutingSignals { quality_low?: boolean; fatal_flaw?: boolean; evidence_conflict?: boolean; high_stakes_decision?: boolean; context_truncated?: boolean; [key: string]: boolean | undefined }
export interface RoleTask { role: string; task: string; signals?: RoutingSignals; upgradesUsed?: number }
export interface ResolvedModelRoute extends Partial<ModelRouteSettings> { tier: CapabilityTier; source: 'role' | 'default' | 'legacy' | 'inherit'; escalated: boolean; routingReason?: string }

const semanticUpgradeSignals = new Set(['quality_low', 'fatal_flaw', 'evidence_conflict', 'high_stakes_decision'])

export function resolveRoleTier(settings: ProjectSettings, role: string, signals: RoutingSignals = {}, upgradesUsed = 0): { tier: CapabilityTier; escalated: boolean; routingReason?: string } {
  const roleConfig = settings.modelRouting.roles[role]
  const initial = roleConfig?.tier ?? settings.modelRouting.defaultTier
  if (!settings.modelRouting.enabled) return { tier: initial, escalated: false }
  if (!roleConfig?.escalateTo || upgradesUsed >= settings.budget.maxUpgradesPerTask) return { tier: initial, escalated: false }
  const reason = (roleConfig.escalateOn ?? []).find((signal) => semanticUpgradeSignals.has(signal) && signals[signal] === true)
  if (!reason) return { tier: initial, escalated: false }
  const tier = roleConfig.escalateTo
  return { tier, escalated: tier !== initial, routingReason: reason }
}

export function resolveModelRoute(settings: ProjectSettings, request: RoleTask): ResolvedModelRoute {
  const selected = resolveRoleTier(settings, request.role, request.signals, request.upgradesUsed ?? 0)
  const roleConfig = settings.modelRouting.roles[request.role]
  const tierConfig = settings.modelRouting.tiers[selected.tier]
  if (!settings.modelRouting.enabled) {
    const legacy = settings.model.useGlobal ? { tier: selected.tier, escalated: false, source: 'inherit' as const } : { provider: settings.model.overrides?.provider, model: settings.model.overrides?.model, tier: selected.tier, escalated: false, source: 'legacy' as const }
    return legacy
  }
  const roleOverride = selected.escalated ? undefined : roleConfig
  const inputCap = Math.min(tierConfig.maxInputTokens ?? Number.POSITIVE_INFINITY, roleConfig?.maxInputTokens ?? Number.POSITIVE_INFINITY)
  const outputCap = Math.min(tierConfig.maxOutputTokens ?? Number.POSITIVE_INFINITY, roleConfig?.maxOutputTokens ?? Number.POSITIVE_INFINITY)
  return { provider: roleOverride?.provider ?? tierConfig.provider, model: roleOverride?.model ?? tierConfig.model, ...(inputCap < Number.POSITIVE_INFINITY ? { maxInputTokens: inputCap } : {}), ...(outputCap < Number.POSITIVE_INFINITY ? { maxOutputTokens: outputCap } : {}), tier: selected.tier, escalated: selected.escalated, ...(selected.routingReason ? { routingReason: selected.routingReason } : {}), source: roleOverride ? 'role' : 'default' }
}

export function isSemanticUpgradeSignal(signal: string): boolean { return semanticUpgradeSignals.has(signal) }

export function createPolicySnapshot(settings: ProjectSettings): Pick<ProjectSettings, 'version'|'modelRouting'|'workflow'|'budget'|'literature'> {
  return structuredClone({ version: settings.version, modelRouting: settings.modelRouting, workflow: settings.workflow, budget: settings.budget, literature: settings.literature })
}

/** Missing legacy fields remain off, independent of current project settings. */
export function frozenLiteratureSettings(value: unknown): ProjectSettings['literature'] {
  const validated = validateProjectSettingsCandidate({ version: 2, ...(value === undefined ? {} : { literature: value }) })
  if (!validated.valid) throw new Error('invalid frozen literature policy')
  return validated.settings!.literature
}
