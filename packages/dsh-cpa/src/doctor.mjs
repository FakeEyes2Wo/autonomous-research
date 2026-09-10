import { assertValidConfig } from './config.mjs'

function result(id, status, message, details = {}) {
  return { id, status, message, ...details }
}

export function staticDoctor(input) {
  try {
    const config = assertValidConfig(input)
    const routeChecks = config.routes.map((route) => result('route:' + route.id, 'pass', 'route is valid', {
      route: route.id,
      protocol: route.api,
      endpoint: route.baseURL,
      credentialReferencePresent: Boolean(route.credentialRef),
      models: route.models.map((model) => model.id)
    }))
    return { ok: true, checks: [result('config', 'pass', 'CPA routes are valid'), ...routeChecks], config }
  } catch (error) {
    return { ok: false, checks: [result('config', 'fail', error.message, { code: error.code ?? 'CPA_CONFIG_INVALID', issues: error.issues ?? [] })] }
  }
}

function endpointForModels(baseURL) {
  return new URL('models', baseURL.endsWith('/') ? baseURL : baseURL + '/').toString()
}

export async function networkDoctor(input, options = {}) {
  const config = assertValidConfig(input)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable; use Node 20 or newer')
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000
  const checks = []
  for (const route of config.routes) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const endpoint = endpointForModels(route.baseURL)
    let response
    try {
      const headers = { accept: 'application/json' }
      const secret = route.credentialRef ? options.credentials?.[route.credentialRef] ?? process.env[route.credentialRef] : undefined
      if (secret) headers.authorization = 'Bearer ' + secret
      response = await fetchImpl(endpoint, { method: 'GET', headers, redirect: 'manual', signal: controller.signal })
      if (response.status >= 300 && response.status < 400) {
        checks.push(result('network:' + route.id, 'fail', 'endpoint returned a redirect; redirects are refused', { route: route.id, httpStatus: response.status, endpoint }))
      } else if (!response.ok) {
        checks.push(result('network:' + route.id, 'fail', 'endpoint returned HTTP ' + response.status, { route: route.id, httpStatus: response.status, endpoint }))
      } else {
        checks.push(result('network:' + route.id, 'pass', 'models endpoint is HTTP reachable; model capabilities were not inferred', { route: route.id, httpStatus: response.status, endpoint }))
      }
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'NETWORK_TIMEOUT' : error?.name === 'TypeError' ? 'NETWORK_UNREACHABLE' : 'NETWORK_FAILED'
      checks.push(result('network:' + route.id, 'fail', code === 'NETWORK_TIMEOUT' ? 'request timed out' : 'network request failed', { route: route.id, endpoint, code }))
    } finally {
      try { await response?.body?.cancel?.() } catch { /* release a streamed body when the test transport exposes one */ }
      clearTimeout(timer)
    }
  }
  return { ok: checks.every((check) => check.status === 'pass'), checks }
}

export async function runDoctor(input, options = {}) {
  const staticResult = staticDoctor(input)
  if (!staticResult.ok || options.network !== true) return { ...staticResult, network: false }
  const network = await networkDoctor(staticResult.config, options)
  return { ok: staticResult.ok && network.ok, checks: [...staticResult.checks, ...network.checks], network: true }
}
