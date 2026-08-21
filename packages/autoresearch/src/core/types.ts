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
  | 'plan'
  | 'work'
  | 'evidence'
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
