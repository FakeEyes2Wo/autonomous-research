export const RESEARCH_NODE_KINDS = ['hypothesis', 'action', 'evidence'] as const
export type ResearchNodeKind = typeof RESEARCH_NODE_KINDS[number]
export type ResearchNodeStatus = string

export interface ResearchNode {
  id: string
  kind: ResearchNodeKind
  status: ResearchNodeStatus
  parent?: string
  content: string
  artifacts?: string[]
  /** Derived candidate projection; canonical records live in ResearchStore. */
  candidate?: { id: string; batchId: string; snapshotHash: string; parentVersion: number; reasons: string[] }
  /** Rebuilt from the frozen task graph, job receipt and admitted collection. */
  runtimeTask?: { graphId: string; graphHash: string; taskId: string; jobId: string; attemptId: string; dependsOn: string[]; candidateIds: string[]; snapshotHash: string; admissionKey?: string }
}

export const RUN_STATUSES = ['RUNNING', 'WAITING', 'PAUSED', 'FAILED', 'COMPLETED'] as const
export type RunStatus = typeof RUN_STATUSES[number]

export const RUN_PHASES = [
  'intake',
  'brainstorm',
  'rubric',
  'ideation',
  'hypothesis_revision',
  'plan',
  'minimal_verification',
  'experiment_design',
  'experiment_reflexion',
  'work',
  'evidence',
  'result_reflexion',
  'decide',
  'paper',
  'failed',
] as const
export type RunPhase = typeof RUN_PHASES[number]

export interface RunState {
  continuationStop?: import('../research/continuation.js').ContinuationStop
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

export const RUN_EVENT_TYPES = ['state', 'result', 'decision', 'error'] as const
export type RunEventType = typeof RUN_EVENT_TYPES[number]

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

export const RESEARCH_DECISION_ACTIONS = ['continue', 'revise', 'finish', 'fail'] as const
export type ResearchDecisionAction = typeof RESEARCH_DECISION_ACTIONS[number]

export interface ResearchDecision {
  action: ResearchDecisionAction
  reason: string
}

export const EVIDENCE_VERDICTS = ['supports', 'refutes', 'inconclusive'] as const
export type EvidenceVerdict = typeof EVIDENCE_VERDICTS[number]

export function isEvidenceVerdict(value: string): value is EvidenceVerdict {
  return (EVIDENCE_VERDICTS as readonly string[]).includes(value)
}

export function parseDecision(value: unknown): ResearchDecision {
  if (typeof value !== 'object' || value === null) throw new TypeError('decision must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.action !== 'string' || !(RESEARCH_DECISION_ACTIONS as readonly string[]).includes(record.action)) {
    throw new TypeError(`invalid decision action: ${String(record.action)}`)
  }
  if (typeof record.reason !== 'string') throw new TypeError('decision reason must be a string')
  return { action: record.action as ResearchDecisionAction, reason: record.reason }
}
