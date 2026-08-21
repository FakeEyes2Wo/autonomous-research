import type { EvidenceVerdict } from '../core/types.js'

export function isEvidenceVerdict(value: string): value is EvidenceVerdict {
  return value === 'supports' || value === 'refutes' || value === 'inconclusive'
}
