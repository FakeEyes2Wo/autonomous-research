import {
  CAPABILITY_TIERS,
  DEFAULT_PROJECT_SETTINGS,
  WORKFLOW_TOGGLES,
  isRecord,
  type CapabilityTier,
  type ProjectSettings,
  type RoleRouteSettings,
  type ValidationError,
  type ValidationResult,
  type ValidationWarning,
  type WorkflowMode,
} from './schema.js'

const CORE_KEYS = new Set(['version', 'revision', 'paperExploration', 'figureApi', 'model', 'experiment', 'modelRouting', 'workflow', 'budget', 'literature', 'extensions'])

function clone<T>(value: T): T { return structuredClone(value) }
function num(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback }
function bool(value: unknown, fallback: boolean): boolean { return typeof value === 'boolean' ? value : fallback }
function str(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback }
function tier(value: unknown, fallback: CapabilityTier): CapabilityTier { return CAPABILITY_TIERS.includes(value as CapabilityTier) ? value as CapabilityTier : fallback }
function toggle(value: unknown, fallback: 'enabled'|'auto'|'never'): 'enabled'|'auto'|'never' { return WORKFLOW_TOGGLES.includes(value as never) ? value as never : fallback }
function migrateRole(raw: Record<string, unknown>): RoleRouteSettings {
  return {
    ...(CAPABILITY_TIERS.includes(raw.tier as CapabilityTier) ? { tier: raw.tier as CapabilityTier } : {}),
    ...(typeof raw.provider === 'string' && raw.provider ? { provider: raw.provider } : {}),
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    ...(raw.maxInputTokens !== undefined ? { maxInputTokens: num(raw.maxInputTokens, 0) } : {}),
    ...(raw.maxOutputTokens !== undefined ? { maxOutputTokens: num(raw.maxOutputTokens, 0) } : {}),
    ...(typeof raw.escalateTo === 'string' && CAPABILITY_TIERS.includes(raw.escalateTo as CapabilityTier) ? { escalateTo: raw.escalateTo as CapabilityTier } : {}),
    ...(Array.isArray(raw.escalateOn) ? { escalateOn: raw.escalateOn.filter((value: unknown): value is string => typeof value === 'string') } : {}),
  }
}

export function migrateProjectSettings(input: unknown): ProjectSettings {
  const value = isRecord(input) ? input : {}
  const base = clone(DEFAULT_PROJECT_SETTINGS)
  const literature = isRecord(value.literature) ? value.literature : {}
  const paper = isRecord(value.paperExploration) ? value.paperExploration : {}
  const figure = isRecord(value.figureApi) ? value.figureApi : {}
  const model = isRecord(value.model) ? value.model : {}
  const experiment = isRecord(value.experiment) ? value.experiment : {}
  const routing = isRecord(value.modelRouting) ? value.modelRouting : {}
  const sourceTiers = isRecord(routing.tiers) ? routing.tiers : {}
  const roles = isRecord(routing.roles) ? routing.roles : {}
  const workflow = isRecord(value.workflow) ? value.workflow : {}
  const budget = isRecord(value.budget) ? value.budget : {}
  const context = isRecord(budget.context) ? budget.context : {}

  const next: ProjectSettings = {
    ...base,
    literature: { mode: literature.mode === 'lexical' ? 'lexical' : 'off', maxResults: num(literature.maxResults, base.literature.maxResults), maxContextChars: num(literature.maxContextChars, base.literature.maxContextChars) },
    paperExploration: {
      maxPapers: num(paper.maxPapers, base.paperExploration.maxPapers), minSurveys: num(paper.minSurveys, base.paperExploration.minSurveys), minClusters: num(paper.minClusters, base.paperExploration.minClusters),
      latestWindowYears: num(paper.latestWindowYears, base.paperExploration.latestWindowYears), latestPerDirection: num(paper.latestPerDirection, base.paperExploration.latestPerDirection), maxSelectedDirections: num(paper.maxSelectedDirections, base.paperExploration.maxSelectedDirections),
    },
    figureApi: { enabled: bool(figure.enabled, base.figureApi.enabled), apiUrl: str(figure.apiUrl, base.figureApi.apiUrl), ...(typeof figure.model === 'string' ? { model: figure.model } : {}), ...(figure.timeoutMs !== undefined ? { timeoutMs: num(figure.timeoutMs, base.figureApi.timeoutMs ?? 60_000) } : {}) },
    model: { useGlobal: bool(model.useGlobal, base.model.useGlobal), ...(isRecord(model.overrides) ? { overrides: { ...(typeof model.overrides.provider === 'string' ? { provider: model.overrides.provider } : {}), ...(typeof model.overrides.model === 'string' ? { model: model.overrides.model } : {}), ...(typeof model.overrides.reasoningEffort === 'string' ? { reasoningEffort: model.overrides.reasoningEffort } : {}) } } : {}), ...(typeof model.supportsImageInput === 'boolean' ? { supportsImageInput: model.supportsImageInput } : {}) },
    experiment: { maxRounds: num(experiment.maxRounds, base.experiment.maxRounds ?? 1), profile: str(experiment.profile, base.experiment.profile ?? '') },
    modelRouting: {
      enabled: bool(routing.enabled, base.modelRouting.enabled), defaultTier: tier(routing.defaultTier, base.modelRouting.defaultTier),
      tiers: Object.fromEntries(CAPABILITY_TIERS.map((name) => { const raw = isRecord(sourceTiers[name]) ? sourceTiers[name] : {}; const fallback = base.modelRouting.tiers[name]; return [name, { provider: str(raw.provider, fallback.provider), model: str(raw.model, fallback.model), ...(raw.maxInputTokens !== undefined ? { maxInputTokens: num(raw.maxInputTokens, 0) } : {}), ...(raw.maxOutputTokens !== undefined ? { maxOutputTokens: num(raw.maxOutputTokens, 0) } : {}) }] })) as ProjectSettings['modelRouting']['tiers'],
      roles: Object.fromEntries(Object.entries(roles).filter(([, raw]) => isRecord(raw)).map(([name, raw]) => [name, migrateRole(raw as Record<string, unknown>)])) as ProjectSettings['modelRouting']['roles'],
    },
    workflow: { mode: value.version === 2 && workflow.mode === 'minimal' ? 'minimal' : 'legacy' as WorkflowMode, brainstorm: toggle(workflow.brainstorm, base.workflow.brainstorm), deepDive: toggle(workflow.deepDive, base.workflow.deepDive), modelScout: toggle(workflow.modelScout, base.workflow.modelScout), experimentReview: toggle(workflow.experimentReview, base.workflow.experimentReview), paper: toggle(workflow.paper, base.workflow.paper), postResultSynthesis: toggle(workflow.postResultSynthesis, base.workflow.postResultSynthesis), paperImprovementRounds: num(workflow.paperImprovementRounds, base.workflow.paperImprovementRounds), candidateLimit: num(workflow.candidateLimit, base.workflow.candidateLimit), reflexionRounds: num(workflow.reflexionRounds, base.workflow.reflexionRounds) },
    budget: { maxInputTokens: num(budget.maxInputTokens, base.budget.maxInputTokens), maxOutputTokens: num(budget.maxOutputTokens, base.budget.maxOutputTokens), maxRunTokens: num(budget.maxRunTokens, base.budget.maxRunTokens), maxRoleCalls: num(budget.maxRoleCalls, base.budget.maxRoleCalls), maxRetriesPerCall: num(budget.maxRetriesPerCall, base.budget.maxRetriesPerCall), jsonRepairAttempts: num(budget.jsonRepairAttempts, base.budget.jsonRepairAttempts), maxUpgradesPerTask: num(budget.maxUpgradesPerTask, base.budget.maxUpgradesPerTask), context: { treeSummaryTokens: num(context.treeSummaryTokens, base.budget.context.treeSummaryTokens), evidenceTokens: num(context.evidenceTokens, base.budget.context.evidenceTokens), paperTokens: num(context.paperTokens, base.budget.context.paperTokens), failureTokens: num(context.failureTokens, base.budget.context.failureTokens) } },
    ...(isRecord(value.extensions) ? { extensions: clone(value.extensions) } : {}),
  }
  return next
}

function error(path: string, code: string, message: string): ValidationError { return { path, code, message } }
function warning(path: string, code: string, message: string): ValidationWarning { return { path, code, message } }

const ESCALATION_SIGNALS = new Set(['quality_low', 'fatal_flaw', 'evidence_conflict', 'high_stakes_decision'])
function checkKeys(value: Record<string, unknown>, path: string, allowed: readonly string[], errors: ValidationError[]): void {
  const accepted = new Set(allowed)
  for (const key of Object.keys(value)) if (!accepted.has(key)) errors.push(error(`${path}/${key}`, 'UNKNOWN_FIELD', 'unknown field'))
}
function nested(value: unknown, path: string, errors: ValidationError[]): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) { errors.push(error(path, 'TYPE', 'expected an object')); return undefined }
  return value
}
function numberField(value: Record<string, unknown>, key: string, path: string, errors: ValidationError[], positive = false): void {
  const item = value[key]
  if (item === undefined) return
  if (typeof item !== 'number' || !Number.isFinite(item) || !Number.isInteger(item) || (positive ? item <= 0 : item < 0)) errors.push(error(`${path}/${key}`, positive ? 'POSITIVE_INTEGER' : 'NON_NEGATIVE_INTEGER', positive ? 'must be a finite positive integer' : 'must be a finite non-negative integer'))
}
function stringField(value: Record<string, unknown>, key: string, path: string, errors: ValidationError[]): void {
  if (value[key] !== undefined && typeof value[key] !== 'string') errors.push(error(`${path}/${key}`, 'TYPE', 'expected a string'))
}
function boolField(value: Record<string, unknown>, key: string, path: string, errors: ValidationError[]): void {
  if (value[key] !== undefined && typeof value[key] !== 'boolean') errors.push(error(`${path}/${key}`, 'TYPE', 'expected a boolean'))
}
function enumField(value: Record<string, unknown>, key: string, path: string, allowed: readonly string[], errors: ValidationError[]): void {
  if (value[key] !== undefined && (typeof value[key] !== 'string' || !allowed.includes(value[key]))) errors.push(error(`${path}/${key}`, 'ENUM', `must be one of ${allowed.join(', ')}`))
}
function validateRawShape(candidate: Record<string, unknown>, errors: ValidationError[]): void {
  const literature = nested(candidate.literature, '/literature', errors)
  if (literature) {
    checkKeys(literature, '/literature', ['mode', 'maxResults', 'maxContextChars'], errors)
    enumField(literature, 'mode', '/literature', ['off', 'lexical'], errors)
    for (const [key, min, max] of [['maxResults', 1, 40], ['maxContextChars', 1000, 100000]] as const) {
      const value = literature[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)) errors.push(error(`/literature/${key}`, 'RANGE', `must be an integer from ${min} to ${max}`))
    }
  }
  if (candidate.version !== undefined && (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version))) errors.push(error('/version', 'VERSION', 'version must be an integer'))
  stringField(candidate, 'revision', '/', errors)

  const paper = nested(candidate.paperExploration, '/paperExploration', errors)
  if (paper) { checkKeys(paper, '/paperExploration', ['maxPapers', 'minSurveys', 'minClusters', 'latestWindowYears', 'latestPerDirection', 'maxSelectedDirections'], errors); for (const key of ['maxPapers', 'minSurveys', 'minClusters', 'latestWindowYears', 'latestPerDirection', 'maxSelectedDirections']) numberField(paper, key, '/paperExploration', errors) }
  const figure = nested(candidate.figureApi, '/figureApi', errors)
  if (figure) { checkKeys(figure, '/figureApi', ['enabled', 'apiUrl', 'model', 'timeoutMs'], errors); boolField(figure, 'enabled', '/figureApi', errors); stringField(figure, 'apiUrl', '/figureApi', errors); stringField(figure, 'model', '/figureApi', errors); numberField(figure, 'timeoutMs', '/figureApi', errors, true) }
  const model = nested(candidate.model, '/model', errors)
  if (model) {
    checkKeys(model, '/model', ['useGlobal', 'overrides', 'supportsImageInput'], errors); boolField(model, 'useGlobal', '/model', errors); boolField(model, 'supportsImageInput', '/model', errors)
    const overrides = nested(model.overrides, '/model/overrides', errors)
    if (overrides) { checkKeys(overrides, '/model/overrides', ['provider', 'model', 'reasoningEffort'], errors); stringField(overrides, 'provider', '/model/overrides', errors); stringField(overrides, 'model', '/model/overrides', errors); stringField(overrides, 'reasoningEffort', '/model/overrides', errors) }
  }
  const experiment = nested(candidate.experiment, '/experiment', errors)
  if (experiment) { checkKeys(experiment, '/experiment', ['maxRounds', 'profile'], errors); numberField(experiment, 'maxRounds', '/experiment', errors); stringField(experiment, 'profile', '/experiment', errors) }

  const routing = nested(candidate.modelRouting, '/modelRouting', errors)
  if (routing) {
    checkKeys(routing, '/modelRouting', ['enabled', 'defaultTier', 'tiers', 'roles'], errors); boolField(routing, 'enabled', '/modelRouting', errors); enumField(routing, 'defaultTier', '/modelRouting', CAPABILITY_TIERS, errors)
    const tiers = nested(routing.tiers, '/modelRouting/tiers', errors)
    if (tiers) {
      checkKeys(tiers, '/modelRouting/tiers', CAPABILITY_TIERS, errors)
      for (const name of CAPABILITY_TIERS) { const route = nested(tiers[name], `/modelRouting/tiers/${name}`, errors); if (!route) continue; checkKeys(route, `/modelRouting/tiers/${name}`, ['provider', 'model', 'maxInputTokens', 'maxOutputTokens'], errors); stringField(route, 'provider', `/modelRouting/tiers/${name}`, errors); stringField(route, 'model', `/modelRouting/tiers/${name}`, errors); numberField(route, 'maxInputTokens', `/modelRouting/tiers/${name}`, errors); numberField(route, 'maxOutputTokens', `/modelRouting/tiers/${name}`, errors); if ((route.provider === undefined) !== (route.model === undefined)) errors.push(error(`/modelRouting/tiers/${name}`, 'ROUTE_PAIR', 'provider and model must be provided together')) }
    }
    const roles = nested(routing.roles, '/modelRouting/roles', errors)
    if (roles) for (const [name, raw] of Object.entries(roles)) { const path = `/modelRouting/roles/${name}`; if (name === '__proto__' || name === 'prototype' || name === 'constructor') { errors.push(error(path, 'UNSAFE_KEY', 'unsafe role key')); continue } const role = nested(raw, path, errors); if (!role) continue; checkKeys(role, path, ['tier', 'provider', 'model', 'maxInputTokens', 'maxOutputTokens', 'escalateTo', 'escalateOn'], errors); enumField(role, 'tier', path, CAPABILITY_TIERS, errors); enumField(role, 'escalateTo', path, CAPABILITY_TIERS, errors); stringField(role, 'provider', path, errors); stringField(role, 'model', path, errors); numberField(role, 'maxInputTokens', path, errors); numberField(role, 'maxOutputTokens', path, errors); if ((role.provider === undefined) !== (role.model === undefined)) errors.push(error(path, 'ROUTE_PAIR', 'provider and model overrides must be provided together')); if (role.escalateOn !== undefined && (!Array.isArray(role.escalateOn) || role.escalateOn.some((signal) => typeof signal !== 'string' || !ESCALATION_SIGNALS.has(signal)))) errors.push(error(`${path}/escalateOn`, 'ESCALATION_SIGNAL', 'only approved semantic escalation signals are allowed')) }
  }

  const workflow = nested(candidate.workflow, '/workflow', errors)
  if (workflow) { checkKeys(workflow, '/workflow', ['mode', 'brainstorm', 'deepDive', 'modelScout', 'experimentReview', 'paper', 'postResultSynthesis', 'paperImprovementRounds', 'candidateLimit', 'reflexionRounds'], errors); enumField(workflow, 'mode', '/workflow', ['minimal', 'legacy'], errors); for (const key of ['brainstorm', 'deepDive', 'modelScout', 'experimentReview', 'paper', 'postResultSynthesis']) enumField(workflow, key, '/workflow', WORKFLOW_TOGGLES, errors); for (const key of ['paperImprovementRounds', 'candidateLimit', 'reflexionRounds']) numberField(workflow, key, '/workflow', errors) }
  const budget = nested(candidate.budget, '/budget', errors)
  if (budget) {
    checkKeys(budget, '/budget', ['maxInputTokens', 'maxOutputTokens', 'maxRunTokens', 'maxRoleCalls', 'maxRetriesPerCall', 'jsonRepairAttempts', 'maxUpgradesPerTask', 'context'], errors)
    for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxRunTokens', 'maxRoleCalls']) numberField(budget, key, '/budget', errors, true)
    for (const key of ['maxRetriesPerCall', 'jsonRepairAttempts', 'maxUpgradesPerTask']) numberField(budget, key, '/budget', errors)
    const context = nested(budget.context, '/budget/context', errors)
    if (context) { checkKeys(context, '/budget/context', ['treeSummaryTokens', 'evidenceTokens', 'paperTokens', 'failureTokens'], errors); for (const key of ['treeSummaryTokens', 'evidenceTokens', 'paperTokens', 'failureTokens']) numberField(context, key, '/budget/context', errors, true) }
  }
  if (candidate.extensions !== undefined && !isRecord(candidate.extensions)) errors.push(error('/extensions', 'TYPE', 'extensions must be an object'))
}

export function validateProjectSettingsCandidate(candidate: unknown): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  if (!isRecord(candidate)) return { valid: false, errors: [error('/', 'TYPE', 'settings must be an object')], warnings }
  for (const key of Object.keys(candidate)) if (!CORE_KEYS.has(key)) errors.push(error(`/${key}`, 'UNKNOWN_FIELD', 'unknown core field; use extensions for namespaced fields'))
  if (candidate.version !== undefined && candidate.version !== 1 && candidate.version !== 2) errors.push(error('/version', 'VERSION', 'version must be 1 or 2'))
  validateRawShape(candidate, errors)
  if (errors.length > 0) return { valid: false, errors, warnings }
  const normalized = migrateProjectSettings(candidate)
  for (const name of normalized.modelRouting.enabled ? CAPABILITY_TIERS : []) {
    const route = normalized.modelRouting.tiers[name]
    if (!route.provider || !route.model) errors.push(error(`/modelRouting/tiers/${name}`, 'ROUTE', 'provider and model are required'))
  }
  for (const [role, config] of Object.entries(normalized.modelRouting.roles)) {
    if ((config.provider === undefined) !== (config.model === undefined)) errors.push(error(`/modelRouting/roles/${role}`, 'ROUTE_PAIR', 'role provider and model overrides must be provided together'))
    if (config.escalateOn && config.escalateOn.some((signal) => !ESCALATION_SIGNALS.has(signal))) errors.push(error(`/modelRouting/roles/${role}/escalateOn`, 'ESCALATION_SIGNAL', 'only approved semantic escalation signals are allowed'))
  }
  if (normalized.budget.maxInputTokens <= 0 || normalized.budget.maxOutputTokens <= 0 || normalized.budget.maxRunTokens <= 0) errors.push(error('/budget', 'BUDGET', 'token budgets must be positive'))
  if (normalized.budget.maxRunTokens < normalized.budget.maxOutputTokens) warnings.push(warning('/budget/maxRunTokens', 'SMALL_RUN_BUDGET', 'run budget is smaller than one output budget'))
  if (normalized.workflow.mode === 'legacy') warnings.push(warning('/workflow/mode', 'LEGACY_MODE', 'legacy mode is retained for migrated projects'))
  return errors.length > 0 ? { valid: false, errors, warnings } : { valid: true, errors, warnings, settings: normalized }
}
