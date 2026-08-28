/**
 * Deterministic JSON extraction and repair helpers.
 *
 * Priority: avoid re-running an expensive subagent just because its output
 * contains JSON mixed with prose, markdown fences, trailing commas, or small
 * formatting mistakes. These helpers only do text transformations; they never
 * call an LLM. If deterministic repair still fails, the caller should retry
 * with the reported parse error attached to the LLM prompt.
 */

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

function parseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function extractFencedJson(text: string): unknown | undefined {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of text.matchAll(fence)) {
    const parsed = tryParseJson((match[1] ?? '').trim())
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function extractFirstJsonScaffold(text: string): string | undefined {
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  const end = text.lastIndexOf(close)
  if (end <= start) return undefined
  return text.slice(start, end + 1)
}

/** Remove common non-JSON formatting that appears in LLM output. */
export function repairJsonText(text: string): string {
  let value = text.trim()
  value = value.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  value = value.replace(/,\s*([}\]])/g, '$1')
  value = value.replace(/[\u00a0\u200b]/g, ' ')
  return value
}

/**
 * Try direct parse, fenced blocks, then a repaired first JSON scaffold.
 * Returns the parsed value or a human-readable failure reason.
 */
export function parseJsonDetailed(text: string): JsonParseResult {
  if (!text || !text.trim()) {
    return { ok: false, error: 'empty subagent output' }
  }

  const direct = tryParseJson(text.trim())
  if (direct !== undefined) return { ok: true, value: direct }

  const fenced = extractFencedJson(text)
  if (fenced !== undefined) return { ok: true, value: fenced }

  const scaffold = extractFirstJsonScaffold(text)
  if (scaffold !== undefined) {
    const directScaffold = tryParseJson(scaffold)
    if (directScaffold !== undefined) return { ok: true, value: directScaffold }
    const repaired = tryParseJson(repairJsonText(scaffold))
    if (repaired !== undefined) return { ok: true, value: repaired }
  }

  const repairedWhole = tryParseJson(repairJsonText(text))
  if (repairedWhole !== undefined) return { ok: true, value: repairedWhole }

  let lastError = 'no JSON object or array found in output'
  try {
    JSON.parse(text)
  } catch (error) {
    lastError = parseError(error)
  }
  return { ok: false, error: lastError }
}

/** Convenience wrapper returning only the parsed value or undefined. */
export function extractJson(text: string): unknown | undefined {
  const result = parseJsonDetailed(text)
  return result.ok ? result.value : undefined
}
