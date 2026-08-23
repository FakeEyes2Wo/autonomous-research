export type ResearchNodeKind = 'hypothesis' | 'action' | 'evidence'
export type ResearchNodeStatus = string

export interface ResearchNode {
  id: string
  kind: ResearchNodeKind
  status: ResearchNodeStatus
  parent?: string
  content: string
  artifacts?: string[]
}

export type RunStatus = 'RUNNING' | 'WAITING' | 'PAUSED' | 'FAILED' | 'COMPLETED'
export type RunPhase =
  | 'intake'
  | 'rubric'
  | 'ideation'
  | 'hypothesis_revision'
  | 'plan'
  | 'minimal_verification'
  | 'experiment_design'
  | 'experiment_reflexion'
  | 'work'
  | 'evidence'
  | 'result_reflexion'
  | 'decide'
  | 'paper'
  | 'failed'

export interface RunState {
  schema: 'autoresearch/run-state/v1'
  runId: string
  runDir: string
  status: RunStatus
  phase: RunPhase
  cycle: number
  stepId: string
  planVersion: number
  rubricPath?: string
  evidencePath?: string
  lastError?: string
  updatedAt: string
}

export type RunEventType = 'state' | 'result' | 'decision' | 'error'

export interface RunEvent {
  time: string
  type: RunEventType
  stepId: string
  data: Record<string, unknown>
}

export interface ActionResult {
  status: 'completed' | 'failed'
  summary: string
  artifacts: string[]
}

export type ResearchDecisionAction = 'continue' | 'revise' | 'finish' | 'fail'

export interface ResearchDecision {
  action: ResearchDecisionAction
  reason: string
}

export type EvidenceVerdict = 'supports' | 'refutes' | 'inconclusive'

export function isEvidenceVerdict(value: string): value is EvidenceVerdict {
  return value === 'supports' || value === 'refutes' || value === 'inconclusive'
}

export function parseDecision(value: unknown): ResearchDecision {
  if (typeof value !== 'object' || value === null) throw new TypeError('decision must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.action !== 'string' || !['continue', 'revise', 'finish', 'fail'].includes(record.action)) {
    throw new TypeError(`invalid decision action: ${String(record.action)}`)
  }
  if (typeof record.reason !== 'string') throw new TypeError('decision reason must be a string')
  return { action: record.action as ResearchDecisionAction, reason: record.reason }
}
