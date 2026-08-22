import type { EvidenceVerdict, ResearchDecision, ResearchDecisionAction } from '../core/types.js'

export function isEvidenceVerdict(value: string): value is EvidenceVerdict {
  return value === 'supports' || value === 'refutes' || value === 'inconclusive'
}

export function isActionStatus(value: string): value is 'running' | 'completed' | 'failed' {
  return value === 'running' || value === 'completed' || value === 'failed'
}

export function isDecisionAction(value: string): value is ResearchDecisionAction {
  return value === 'continue' || value === 'revise' || value === 'finish' || value === 'fail'
}

export function parseDecision(value: unknown): ResearchDecision {
  if (typeof value !== 'object' || value === null) throw new TypeError('decision must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.action !== 'string' || !isDecisionAction(record.action)) {
    throw new TypeError(`invalid decision action: ${String(record.action)}`)
  }
  if (typeof record.reason !== 'string') throw new TypeError('decision reason must be a string')
  return { action: record.action, reason: record.reason }
}
