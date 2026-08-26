import type { FigureApiSettings } from '../settings/project-settings.js'

export interface FigureApiResult {
  ok: boolean
  message: string
  imageUrl?: string
  imageBase64?: string
}

function headers(settings: FigureApiSettings): Record<string, string> {
  const result: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (settings.apiKey) {
    result.Authorization = `Bearer ${settings.apiKey}`
  }
  return result
}

function parseImage(json: unknown): { imageUrl?: string; imageBase64?: string } {
  if (typeof json !== 'object' || json === null) return {}
  const record = json as Record<string, unknown>
  for (const key of ['url', 'image_url', 'imageUrl', 'data', 'image']) {
    const value = record[key]
    if (typeof value === 'string' && value.startsWith('http')) return { imageUrl: value }
    if (typeof value === 'string' && (value.startsWith('data:image') || value.length > 100)) {
      return { imageBase64: value }
    }
  }
  return {}
}

export async function testFigureApi(settings: FigureApiSettings): Promise<FigureApiResult> {
  if (!settings.apiUrl) {
    return { ok: false, message: 'figure API URL is empty' }
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs ?? 60_000)
    try {
      const response = await fetch(settings.apiUrl, {
        method: 'POST',
        headers: headers(settings),
        body: JSON.stringify({ model: settings.model ?? '', prompt: '__connection_test__' }),
        signal: controller.signal,
      })
      if (!response.ok) {
        return { ok: false, message: `HTTP ${response.status}: ${await response.text().catch(() => '')}` }
      }
      return { ok: true, message: 'connection ok' }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

export async function generateExternalFigure(
  settings: FigureApiSettings,
  prompt: string,
): Promise<FigureApiResult> {
  if (!settings.apiUrl) {
    return { ok: false, message: 'figure API URL is empty' }
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs ?? 60_000)
    try {
      const response = await fetch(settings.apiUrl, {
        method: 'POST',
        headers: headers(settings),
        body: JSON.stringify({ model: settings.model ?? '', prompt }),
        signal: controller.signal,
      })
      if (!response.ok) {
        return { ok: false, message: `HTTP ${response.status}: ${await response.text().catch(() => '')}` }
      }
      const text = await response.text()
      let json: unknown = text
      try {
        json = JSON.parse(text)
      } catch {
        // Not JSON; treat the body as a URL for simple APIs.
      }
      if (typeof json === 'string' && json.startsWith('http')) return { ok: true, message: 'ok', imageUrl: json }
      const parsed = typeof json === 'string' ? {} : json
      const { imageUrl, imageBase64 } = parseImage(parsed)
      if (imageUrl || imageBase64) return { ok: true, message: 'ok', imageUrl, imageBase64 }
      return { ok: true, message: 'ok', imageBase64: text }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}
