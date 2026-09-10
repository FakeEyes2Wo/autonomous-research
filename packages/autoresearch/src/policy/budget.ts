import type { CapabilityTier, ProjectSettings } from '../settings/schema.js'
import type { ResolvedModelRoute } from './model-routing.js'

export interface ModelCaps { contextWindow?: number; maxInputTokens?: number; maxOutputTokens?: number }
export interface ResolvedBudget { maxInputTokens: number; maxOutputTokens: number; reservedOutputTokens: number; remainingRunTokens: number; maxRoleCalls: number; remainingRoleCalls: number }

function minPositive(values: number[]): number { return Math.max(0, Math.min(...values.filter((value) => Number.isFinite(value)))) }

export function resolveBudget(settings: ProjectSettings, route: ResolvedModelRoute, remainingRunTokens = settings.budget.maxRunTokens, remainingRoleCalls = settings.budget.maxRoleCalls, modelCaps: ModelCaps = {}): ResolvedBudget {
  const roleInput = route.maxInputTokens ?? settings.budget.maxInputTokens
  const roleOutput = route.maxOutputTokens ?? settings.budget.maxOutputTokens
  const maxOutputTokens = minPositive([settings.budget.maxOutputTokens, roleOutput, modelCaps.maxOutputTokens ?? Number.POSITIVE_INFINITY, modelCaps.contextWindow ?? Number.POSITIVE_INFINITY, remainingRunTokens])
  const maxInputTokens = minPositive([settings.budget.maxInputTokens, roleInput, modelCaps.maxInputTokens ?? Number.POSITIVE_INFINITY, modelCaps.contextWindow !== undefined ? Math.max(0, modelCaps.contextWindow - maxOutputTokens) : Number.POSITIVE_INFINITY, Math.max(0, remainingRunTokens - maxOutputTokens)])
  return { maxInputTokens, maxOutputTokens, reservedOutputTokens: maxOutputTokens, remainingRunTokens: Math.max(0, remainingRunTokens), maxRoleCalls: settings.budget.maxRoleCalls, remainingRoleCalls: Math.max(0, remainingRoleCalls) }
}

export function canSpend(budget: ResolvedBudget, estimatedInputTokens: number, estimatedOutputTokens: number): boolean { return estimatedInputTokens <= budget.maxInputTokens && estimatedOutputTokens <= budget.maxOutputTokens && budget.remainingRoleCalls > 0 && estimatedInputTokens + estimatedOutputTokens <= budget.remainingRunTokens }
export function isBudgetExhausted(remainingRunTokens: number, remainingRoleCalls: number): boolean { return remainingRunTokens <= 0 || remainingRoleCalls <= 0 }
export function tierBudget(settings: ProjectSettings, tier: CapabilityTier): { maxInputTokens: number; maxOutputTokens: number } { const route = settings.modelRouting.tiers[tier]; return { maxInputTokens: route.maxInputTokens ?? settings.budget.maxInputTokens, maxOutputTokens: route.maxOutputTokens ?? settings.budget.maxOutputTokens } }
