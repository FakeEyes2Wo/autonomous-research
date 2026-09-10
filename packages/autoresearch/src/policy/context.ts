export interface ContextBudget { maxInputTokens: number; treeSummaryTokens?: number; evidenceTokens?: number; paperTokens?: number; failureTokens?: number }
export interface ContextSection { name: string; text: string; priority?: number; required?: boolean }
export interface ClippedContext { sections: Record<string, string>; inputTokens: number; truncated: string[]; insufficientSections: string[]; estimated: true }

/** Heuristic, non-binding estimate; it is not a tokenizer upper bound. */
export function estimateTokens(text: string): number {
  let ascii = 0; let nonAscii = 0
  for (const char of text) { if (char.codePointAt(0)! > 0x7f) nonAscii++; else ascii++ }
  return Math.ceil(ascii / 4 + nonAscii)
}

function sectionCap(name: string, budget: ContextBudget): number | undefined {
  const key = name.replace(/[^a-zA-Z]/g, '').toLowerCase()
  const aliases: Record<string, keyof ContextBudget> = { treesummary: 'treeSummaryTokens', evidence: 'evidenceTokens', paper: 'paperTokens', failure: 'failureTokens' }
  const field = aliases[key]
  return field ? budget[field] : undefined
}

function takeRecords(text: string, tokenLimit: number): { text: string; truncated: boolean } {
  if (!text || tokenLimit <= 0) return { text: '', truncated: Boolean(text) }
  const records = text.split(/(?<=\n)/)
  const kept: string[] = []; let used = 0
  for (const record of records) {
    const tokens = estimateTokens(record)
    if (used + tokens > tokenLimit) return { text: kept.join(''), truncated: true }
    kept.push(record); used += tokens
  }
  return { text: kept.join(''), truncated: false }
}

export function clipContext(sections: readonly ContextSection[], budget: ContextBudget): ClippedContext {
  const limit = Math.max(0, Math.floor(budget.maxInputTokens))
  const sorted = sections.map((section, index) => ({ section, index })).sort((a, b) => (b.section.priority ?? 0) - (a.section.priority ?? 0) || a.index - b.index)
  const output: Record<string, string> = {}; const truncated: string[] = []; const insufficientSections: string[] = []; let used = 0
  for (const { section } of sorted) {
    const available = Math.max(0, limit - used)
    const localLimit = Math.min(available, Math.max(0, Math.floor(sectionCap(section.name, budget) ?? Number.POSITIVE_INFINITY)))
    const taken = takeRecords(section.text, localLimit)
    let text = taken.text
    if (taken.truncated) {
      truncated.push(section.name)
      const marker = `\n[truncated:${section.name}]`
      const markerTokens = estimateTokens(marker)
      // A marker is optional metadata; never let it exceed either budget.
      if (text && estimateTokens(text) + markerTokens <= localLimit && estimateTokens(text) + markerTokens <= available) text += marker
      if (!text || estimateTokens(text) === 0) insufficientSections.push(section.name)
      if (section.required) insufficientSections.push(section.name)
    }
    if (text) { output[section.name] = text; used += estimateTokens(text) }
    else if (section.text && !truncated.includes(section.name)) { truncated.push(section.name); if (section.required) insufficientSections.push(section.name) }
  }
  return { sections: output, inputTokens: used, truncated: [...new Set(truncated)], insufficientSections: [...new Set(insufficientSections)], estimated: true }
}
