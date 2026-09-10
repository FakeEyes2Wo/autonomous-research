import YAML from 'yaml'

export function parseSettings(text) {
  const value = YAML.parse(text || '') ?? {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH settings document must be a mapping')
  return value
}

export function parseSettingsDocument(text) {
  const document = YAML.parseDocument(text || '{}\n')
  if (document.errors.length > 0) {
    const error = new Error('invalid YAML settings document')
    error.code = 'CPA_SETTINGS_YAML_INVALID'
    error.errors = document.errors.map((item) => item.message)
    throw error
  }
  const value = document.toJSON() ?? {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH settings document must be a mapping')
  return { document, value }
}

export function stringifySettings(value) {
  return YAML.stringify(value, { indent: 2, lineWidth: 0 })
}

export function patchSettingsDocument(document, operations) {
  const next = document.clone()
  for (const operation of operations) {
    if (operation.type === 'set') next.setIn(operation.path, operation.value)
    else if (operation.type === 'delete') next.deleteIn(operation.path)
  }
  return next
}

export function cloneSettings(value) {
  return structuredClone(value ?? {})
}

export function canonical(value) {
  return JSON.stringify(value, (_, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    }
    return item
  })
}

export function redactedSettings(value) {
  const copy = cloneSettings(value)
  const providers = copy?.['llm-pi-ai']?.providers
  if (providers && typeof providers === 'object') {
    for (const provider of Object.values(providers)) {
      if (provider && typeof provider === 'object' && 'apiKey' in provider) provider.apiKey = '<redacted>'
    }
  }
  return copy
}
