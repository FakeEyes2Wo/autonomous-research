export const SUPPORTED_PROTOCOLS = Object.freeze(['openai-responses', 'openai-completions'])
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8317/v1'

export const DEFAULT_CONFIG = Object.freeze({
  routes: [
    {
      id: 'cpa-gpt',
      displayName: 'CPA GPT',
      api: 'openai-responses',
      baseURL: DEFAULT_BASE_URL,
      credentialRef: 'CPA_API_KEY',
      models: [{ id: 'gpt-self', contextWindow: 32768, maxTokens: 8192, input: ['text'] }]
    },
    {
      id: 'cpa-gpt-deep',
      displayName: 'CPA GPT Deep',
      api: 'openai-responses',
      baseURL: DEFAULT_BASE_URL,
      credentialRef: 'CPA_API_KEY',
      reasoning: 'high',
      models: [{ id: 'gpt-self', contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: { high: 'high' } }]
    }
  ]
})

const ROUTE_RE = /^[a-z][a-z0-9-]{0,63}$/
const ENV_RE = /^[A-Z][A-Z0-9_]{0,127}$/
const MODALITIES = new Set(['text', 'image'])
const REASONING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'max'])
const ROUTE_OPTION_KEYS = ['reasoning', 'retryPolicy', 'timeoutMs', 'streamIdleTimeoutMs', 'defaultContextWindow', 'defaultMaxTokens', 'defaultInput']
const ROUTE_KEYS = new Set(['id', 'displayName', 'api', 'baseURL', 'credentialRef', 'models', ...ROUTE_OPTION_KEYS])
const MODEL_KEYS = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'])
const SENSITIVE_KEYS = /(?:key|token|secret|password|authorization|cookie|header)/i

function issue(path, code, message) { return { path, code, message } }
function clone(value) { return structuredClone(value) }

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function nativeConfigToConfig(input) {
  if (!isRecord(input) || input.routes !== undefined) return input
  const providers = input['llm-pi-ai']?.providers
  if (!isRecord(providers)) return input
  return {
    routes: Object.entries(providers).map(([id, provider]) => {
      const native = isRecord(provider) ? provider : {}
      const { apiKeyEnv, ...rest } = native
      return { ...rest, id, ...(apiKeyEnv === undefined ? {} : { credentialRef: apiKeyEnv }) }
    })
  }
}

function rejectUnknown(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(issue(path + '.' + key, SENSITIVE_KEYS.test(key) ? 'secret_field' : 'unknown_field', SENSITIVE_KEYS.test(key) ? 'secret values are not accepted; use credentialRef' : 'unknown field'))
  }
}

function validateRetryPolicy(policy, path, errors) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    errors.push(issue(path, 'retry_policy', 'retryPolicy must be an object'))
    return
  }
  const allowed = new Set(['mode', 'maxRetries', 'retryableCodes', 'backoff'])
  rejectUnknown(policy, allowed, path, errors)
  if (!['normal', 'always'].includes(policy.mode)) errors.push(issue(path + '.mode', 'retry_mode', 'retryPolicy.mode must be normal or always'))
  if (policy.maxRetries !== undefined && (!Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > 10)) errors.push(issue(path + '.maxRetries', 'retry_count', 'maxRetries must be an integer from 0 to 10'))
  if (policy.retryableCodes !== undefined && (!Array.isArray(policy.retryableCodes) || policy.retryableCodes.some((x) => typeof x !== 'string' || !x.trim()))) errors.push(issue(path + '.retryableCodes', 'retry_codes', 'retryableCodes must be a list of non-empty strings'))
  if (policy.backoff !== undefined) {
    const backoff = policy.backoff
    if (!backoff || typeof backoff !== 'object' || Array.isArray(backoff)) errors.push(issue(path + '.backoff', 'backoff', 'backoff must be an object'))
    else {
      rejectUnknown(backoff, new Set(['initialDelayMs', 'maxDelayMs', 'factor', 'jitterRatio']), path + '.backoff', errors)
      for (const key of ['initialDelayMs', 'maxDelayMs']) if (backoff[key] !== undefined && (!Number.isFinite(backoff[key]) || backoff[key] < 0 || backoff[key] > 600000)) errors.push(issue(path + '.backoff.' + key, 'delay', key + ' must be between 0 and 600000'))
      if (backoff.factor !== undefined && (!Number.isFinite(backoff.factor) || backoff.factor < 1 || backoff.factor > 10)) errors.push(issue(path + '.backoff.factor', 'factor', 'factor must be between 1 and 10'))
      if (backoff.jitterRatio !== undefined && (!Number.isFinite(backoff.jitterRatio) || backoff.jitterRatio < 0 || backoff.jitterRatio > 1)) errors.push(issue(path + '.backoff.jitterRatio', 'jitter', 'jitterRatio must be between 0 and 1'))
    }
  }
}

function normalizeModel(model, path, errors) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    errors.push(issue(path, 'model_object', 'model must be an object'))
    return undefined
  }
  rejectUnknown(model, MODEL_KEYS, path, errors)
  const id = typeof model.id === 'string' ? model.id.trim() : ''
  if (!id) errors.push(issue(path + '.id', 'required', 'model id is required'))
  const result = { id }
  if (typeof model.name === 'string' && model.name.trim()) result.name = model.name.trim()
  for (const key of ['contextWindow', 'maxTokens']) {
    if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || model[key] < 1)) {
      errors.push(issue(path + '.' + key, 'positive_integer', key + ' must be a positive integer'))
    } else if (model[key] !== undefined) result[key] = model[key]
  }
  if (model.input !== undefined) {
    if (!Array.isArray(model.input) || model.input.length === 0 || model.input.some((x) => typeof x !== 'string' || !MODALITIES.has(x))) {
      errors.push(issue(path + '.input', 'modality', 'input must contain text and/or image'))
    } else result.input = [...new Set(model.input)]
  }
  if (model.reasoningEfforts !== undefined) {
    if (model.reasoningEfforts !== false && (!model.reasoningEfforts || typeof model.reasoningEfforts !== 'object' || Array.isArray(model.reasoningEfforts))) {
      errors.push(issue(path + '.reasoningEfforts', 'reasoning_efforts', 'reasoningEfforts must be false or a mapping'))
    } else if (model.reasoningEfforts !== false) {
      result.reasoningEfforts = {}
      for (const [level, wire] of Object.entries(model.reasoningEfforts)) {
        if (!REASONING.has(level) || (wire !== null && (typeof wire !== 'string' || !wire.trim()))) {
          errors.push(issue(path + '.reasoningEfforts.' + level, 'reasoning_value', 'reasoning level or wire value is invalid'))
        } else result.reasoningEfforts[level] = wire
      }
    } else result.reasoningEfforts = false
  }
  if (model.compat !== undefined) {
    if (!model.compat || typeof model.compat !== 'object' || Array.isArray(model.compat)) errors.push(issue(path + '.compat', 'compat_object', 'compat must be an object'))
    else {
      result.compat = {}
      if (model.compat.thinkingFormat !== undefined) result.compat.thinkingFormat = String(model.compat.thinkingFormat)
      if (model.compat.supportsReasoningEffort !== undefined) {
        if (typeof model.compat.supportsReasoningEffort !== 'boolean') errors.push(issue(path + '.compat.supportsReasoningEffort', 'boolean', 'supportsReasoningEffort must be boolean'))
        else result.compat.supportsReasoningEffort = model.compat.supportsReasoningEffort
      }
    }
  }
  return result
}

export function validateConfig(input) {
  const errors = []
  const normalizedInput = nativeConfigToConfig(input)
  const source = normalizedInput && typeof normalizedInput === 'object' && !Array.isArray(normalizedInput) ? normalizedInput : {}
  rejectUnknown(source, new Set(['routes']), 'config', errors)
  const routes = source.routes
  if (!Array.isArray(routes) || routes.length === 0) errors.push(issue('routes', 'required', 'at least one CPA route is required'))
  const normalized = { routes: [] }
  const seen = new Set()
  for (let index = 0; Array.isArray(routes) && index < routes.length; index += 1) {
    const raw = routes[index]
    const path = 'routes[' + index + ']'
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(issue(path, 'route_object', 'route must be an object'))
      continue
    }
    rejectUnknown(raw, ROUTE_KEYS, path, errors)
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!ROUTE_RE.test(id)) errors.push(issue(path + '.id', 'route_id', 'route id must start with a lowercase letter and contain only lowercase letters, digits, and hyphens'))
    if (seen.has(id)) errors.push(issue(path + '.id', 'duplicate', 'route "' + id + '" is duplicated'))
    seen.add(id)
    const api = raw.api
    if (!SUPPORTED_PROTOCOLS.includes(api)) errors.push(issue(path + '.api', 'protocol', 'api must be one of ' + SUPPORTED_PROTOCOLS.join(', ')))
    const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL.trim() : ''
    let parsedURL
    try { parsedURL = new URL(baseURL) } catch { /* reported below */ }
    if (!parsedURL || !['http:', 'https:'].includes(parsedURL.protocol) || parsedURL.username || parsedURL.password || parsedURL.search || parsedURL.hash) {
      errors.push(issue(path + '.baseURL', 'base_url', 'baseURL must be an http(s) URL without credentials, query, or fragment'))
    }
    const credentialRef = raw.credentialRef
    if (credentialRef !== undefined && (typeof credentialRef !== 'string' || !ENV_RE.test(credentialRef.trim()))) errors.push(issue(path + '.credentialRef', 'credential_ref', 'credentialRef must be an uppercase environment/credential reference'))
    if (raw.reasoning !== undefined && !REASONING.has(raw.reasoning)) errors.push(issue(path + '.reasoning', 'reasoning', 'reasoning must be off, minimal, low, medium, high, or max'))
    if (raw.retryPolicy !== undefined) validateRetryPolicy(raw.retryPolicy, path + '.retryPolicy', errors)
    for (const key of ['timeoutMs', 'streamIdleTimeoutMs', 'defaultContextWindow', 'defaultMaxTokens']) {
      if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || raw[key] < 1 || raw[key] > 1000000000)) errors.push(issue(path + '.' + key, 'positive_integer', key + ' must be a positive integer'))
    }
    if (raw.defaultInput !== undefined && (!Array.isArray(raw.defaultInput) || raw.defaultInput.length === 0 || raw.defaultInput.some((x) => typeof x !== 'string' || !MODALITIES.has(x)))) errors.push(issue(path + '.defaultInput', 'modality', 'defaultInput must contain text and/or image'))
    if (!Array.isArray(raw.models) || raw.models.length === 0) errors.push(issue(path + '.models', 'models_required', 'at least one model is required'))
    const models = []
    const modelIds = new Set()
    for (let mi = 0; Array.isArray(raw.models) && mi < raw.models.length; mi += 1) {
      const model = normalizeModel(raw.models[mi], path + '.models[' + mi + ']', errors)
      if (model) {
        if (modelIds.has(model.id)) errors.push(issue(path + '.models[' + mi + '].id', 'duplicate', 'model "' + model.id + '" is duplicated'))
        modelIds.add(model.id)
        models.push(model)
      }
    }
    if (api === 'openai-responses' && raw.compat !== undefined) errors.push(issue(path + '.compat', 'protocol_field', 'route compat is only supported for openai-completions'))
    const route = { id, displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : id, api, baseURL, models }
    if (credentialRef !== undefined) route.credentialRef = credentialRef.trim()
    for (const key of ROUTE_OPTION_KEYS) if (raw[key] !== undefined) route[key] = clone(raw[key])
    normalized.routes.push(route)
  }
  return { ok: errors.length === 0, errors, config: normalized }
}

export function assertValidConfig(input) {
  const result = validateConfig(input)
  if (!result.ok) {
    const error = new Error('Invalid CPA configuration:\n' + result.errors.map((x) => '- ' + x.path + ': ' + x.message).join('\n'))
    error.code = 'CPA_CONFIG_INVALID'
    error.issues = result.errors
    throw error
  }
  return result.config
}

export function routeToDshProfile(route) {
  const provider = { displayName: route.displayName, api: route.api, baseURL: route.baseURL, models: route.models }
  if (route.credentialRef) provider.apiKeyEnv = route.credentialRef
  for (const key of ROUTE_OPTION_KEYS) if (route[key] !== undefined) provider[key] = clone(route[key])
  return provider
}

export function compileSettings(input) {
  const config = assertValidConfig(input)
  return { 'llm-pi-ai': { providers: Object.fromEntries(config.routes.map((route) => [route.id, routeToDshProfile(route)])) } }
}

export function canonicalRoute(route) {
  return JSON.stringify(routeToDshProfile(route))
}
