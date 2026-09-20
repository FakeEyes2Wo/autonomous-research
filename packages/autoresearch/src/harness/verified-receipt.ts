import { createHash } from 'node:crypto'

export interface VerifiedReceiptInput { source: string; text: string; quotes: string[]; exitStatus?: number | string | null; expectedHash?: string; measure?: (receipt: Record<string, unknown>) => number }
export interface VerifiedReceipt { schema: 'autoresearch/verified-receipt/v1'; source: string; status: 'verified' | 'fallback'; scientificStatus: 'unverified'; contentHash: string; bytes: number; receiptBytes: number; exitStatus: number | string | 'unknown'; quotes: string[]; fallbackText?: string }

export async function createVerifiedReceipt(input: VerifiedReceiptInput): Promise<VerifiedReceipt> {
  if (typeof input.source !== 'string' || !input.source.trim()) throw new TypeError('receipt source is required')
  if (typeof input.text !== 'string') throw new TypeError('receipt text is required')
  if (!Array.isArray(input.quotes) || input.quotes.length === 0 || input.quotes.some((quote) => typeof quote !== 'string' || !quote)) throw new TypeError('receipt quotes must be non-empty strings')
  const bytes = Buffer.from(input.text, 'utf8')
  const text = bytes.toString('utf8')
  for (const quote of input.quotes) if (!text.includes(quote)) throw new Error(`quote not found: ${quote}`)
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  if (input.expectedHash !== undefined && input.expectedHash !== contentHash) throw new Error('receipt source hash mismatch')
  const base = { schema: 'autoresearch/verified-receipt/v1' as const, source: input.source, scientificStatus: 'unverified' as const, contentHash, bytes: bytes.byteLength, exitStatus: input.exitStatus ?? 'unknown' as const, quotes: [...input.quotes] }
  const measure = input.measure ?? ((receipt: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(receipt), 'utf8'))
  const sizeOf = (recordBase: Record<string, unknown>, extra: Record<string, unknown>): number => {
    let size = 0
    for (let attempt = 0; attempt < 4; attempt += 1) size = measure({ ...recordBase, ...extra, receiptBytes: size })
    return size
  }
  const verifiedSize = sizeOf(base, { status: 'verified' })
  if (verifiedSize >= bytes.byteLength) {
    const fallbackBase = { ...base, quotes: [] }
    const fallbackSize = sizeOf(fallbackBase, { status: 'fallback', fallbackText: text })
    return { ...fallbackBase, status: 'fallback', receiptBytes: fallbackSize, fallbackText: text }
  }
  return { ...base, status: 'verified', receiptBytes: verifiedSize }
}
