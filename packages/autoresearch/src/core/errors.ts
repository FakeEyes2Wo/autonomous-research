export type ErrorKind = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'STATE_CORRUPT' | 'AGENT_FAILED' | 'LEAKAGE' | 'UNKNOWN'

export class AutoResearchError extends Error {
  readonly kind: ErrorKind
  constructor(message: string, kind: ErrorKind = 'UNKNOWN') {
    super(message)
    this.name = 'AutoResearchError'
    this.kind = kind
  }
}
