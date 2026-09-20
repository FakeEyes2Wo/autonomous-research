import { estimateTokens } from '../policy/context.js'

export interface LabeledContextEntry { field: string; text: string }

export function estimateContextTokens(text: string): number {
  return estimateTokens(text)
}

/** Deduplicate exact repeated text while retaining every input field label. */
export function renderLabeledContextEntries(entries: readonly LabeledContextEntry[]): string {
  const seen = new Map<string, string>()
  return entries.map((entry) => {
    const previous = seen.get(entry.text)
    const marker = previous ? `[same content as ${previous}; field ${entry.field} remains in the contract]` : entry.text
    const content = previous && estimateTokens(marker) < estimateTokens(entry.text) ? marker : entry.text
    if (!previous) seen.set(entry.text, entry.field)
    return `### ${entry.field}\n${content}`
  }).join('\n\n')
}
