export const TOKENIZER_VERSION = 'cjk12-en-v1' as const
export const MAX_QUERY_TOKENS = 64

const SEARCH_SEGMENT = /[\p{Script=Han}]|[\p{Script=Latin}\p{M}\p{N}]+/gu
const HAN = /^\p{Script=Han}$/u

/** Normalize only the derived retrieval representation; source evidence is never changed. */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US')
  const tokens: string[] = []
  let hanRun: string[] = []
  let previousEnd = -1

  const append = (token: string) => {
    if (token !== '') tokens.push(token)
  }
  const flushHan = () => {
    for (const character of hanRun) append(character)
    for (let index = 0; index + 1 < hanRun.length; index += 1) {
      append(hanRun[index]! + hanRun[index + 1]!)
    }
    hanRun = []
  }

  for (const match of normalized.matchAll(SEARCH_SEGMENT)) {
    const segment = match[0]
    if (HAN.test(segment)) {
      if (match.index !== previousEnd) flushHan()
      hanRun.push(segment)
    } else {
      flushHan()
      append(segment)
    }
    previousEnd = match.index + segment.length
  }
  flushHan()
  return tokens
}

export function toFtsQuery(text: string): string {
  const tokens = [...new Set(tokenize(text).slice(0, MAX_QUERY_TOKENS))]
  if (tokens.length === 0) throw codedError('query contains no searchable tokens', 'invalid_query')
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ')
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}
