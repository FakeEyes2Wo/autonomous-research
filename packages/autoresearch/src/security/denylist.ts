export interface PaperMetaLike {
  arxiv_id?: string
  title?: string
  authors?: string[]
  source_urls?: Record<string, string>
}

export function denylistTokens(meta: PaperMetaLike): string[] {
  const tokens = new Set<string>()
  if (meta.arxiv_id) tokens.add(meta.arxiv_id)
  if (meta.title) tokens.add(meta.title)
  for (const author of meta.authors ?? []) tokens.add(author)
  for (const url of Object.values(meta.source_urls ?? {})) tokens.add(url)
  return [...tokens].filter((token) => token.length > 0)
}

export function filterDenylist(text: string, meta: PaperMetaLike): string {
  let result = text
  for (const token of denylistTokens(meta)) {
    result = result.split(token).join('[REDACTED]')
  }
  return result
}

export function containsDenylistedToken(text: string, meta: PaperMetaLike): boolean {
  return denylistTokens(meta).some((token) => text.includes(token))
}
