import { containsDenylistedToken, type PaperMetaLike } from './denylist.js'

export function detectLeakage(text: string, meta: PaperMetaLike): string[] {
  return containsDenylistedToken(text, meta) ? ['LEAKAGE_FAIL: target paper metadata leaked into research output'] : []
}

export function assertNoLeakage(text: string, meta: PaperMetaLike): void {
  const leaks = detectLeakage(text, meta)
  if (leaks.length > 0) {
    const error = new Error(`LEAKAGE_FAIL: ${leaks.join('; ')}`) as Error & { code?: string }
    error.code = 'LEAKAGE_FAIL'
    throw error
  }
}
