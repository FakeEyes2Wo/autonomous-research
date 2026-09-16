export interface ResearchContextScope {
  readonly projectId: string
  readonly branchId: string
  readonly runId?: string
  readonly split?: string
}

export type ContextRecordScope =
  | { readonly visibility: 'project'; readonly projectId: string }
  | { readonly visibility: 'branch'; readonly projectId: string; readonly branchId: string }
  | { readonly visibility: 'run'; readonly projectId: string; readonly branchId: string; readonly runId: string }
  | { readonly visibility: 'split'; readonly projectId: string; readonly branchId: string; readonly runId?: string; readonly split: string }

export interface ContextDependency {
  readonly id: string
  readonly version: number
  readonly contentHash: string
}

export type ContextLifecycle = 'candidate' | 'validated_in_scope' | 'disputed' | 'invalidated'

export interface ContextRecordInput {
  readonly id: string
  readonly version: number
  readonly layer: 0 | 1 | 2 | 3 | 4
  readonly kind: 'constraint' | 'state' | 'evidence' | 'memory' | 'summary' | 'artifact'
  readonly scope: ContextRecordScope
  readonly payload: unknown
  readonly required?: boolean
  readonly accessRoles?: readonly string[]
  readonly topicIds?: readonly string[]
  readonly polarity?: 'supporting' | 'opposing' | 'neutral'
  readonly conflictIds?: readonly string[]
  readonly unresolvedConflict?: boolean
  readonly dependencies?: readonly ContextDependency[]
  readonly lifecycle?: ContextLifecycle
  readonly source: { readonly recordType: string; readonly path?: string }
}

export interface ContextRecord extends ContextRecordInput {
  readonly contentHash: string
}

export interface ResearchContextRequest {
  readonly stage: string
  readonly scope: ResearchContextScope
  readonly snapshot?: { readonly id: string; readonly contentHash: string }
  readonly protocolHash?: string
  readonly requiredRecordIds?: readonly string[]
  readonly focusRecordIds?: readonly string[]
  readonly queryTerms?: readonly string[]
  readonly records: readonly ContextRecord[]
}

export interface ContextSelectionQuery {
  readonly role: string
  readonly stage: string
  readonly scope: ResearchContextScope
  readonly requiredRecordIds?: readonly string[]
  readonly focusRecordIds?: readonly string[]
  readonly queryTerms?: readonly string[]
}

export interface ContextRecordBudget {
  readonly maxInputTokens: number
}

export type ContextSelectionReason = 'required' | 'opposing-evidence' | 'unresolved-conflict' | 'ranked'
export type ContextExclusionReason = 'scope' | 'access' | 'invalidated' | 'stale-dependency' | 'budget'

export interface SelectedContextRecord {
  readonly record: ContextRecord
  readonly reason: ContextSelectionReason
  readonly tokens: number
}

export interface ExcludedContextRecord {
  readonly id: string
  readonly version: number
  readonly contentHash: string
  readonly reason: ContextExclusionReason
}

export interface ContextSelection {
  readonly selected: readonly SelectedContextRecord[]
  readonly excluded: readonly ExcludedContextRecord[]
  readonly inputTokens: number
  readonly estimated: true
}

export interface ContextManifestRecord {
  readonly id: string
  readonly version: number
  readonly contentHash: string
  readonly reason: ContextSelectionReason | ContextExclusionReason
  readonly tokens?: number
}

export interface ContextManifest {
  readonly schema: 'autoresearch/context-manifest/v1'
  readonly callId: string
  readonly role: string
  readonly taskId: string
  readonly stage: string
  readonly scope: ResearchContextScope
  readonly snapshot?: { readonly id: string; readonly contentHash: string }
  readonly protocolHash?: string
  readonly selected: readonly ContextManifestRecord[]
  readonly excluded: readonly ContextManifestRecord[]
  readonly dependencies: readonly ContextDependency[]
  readonly budget: { readonly maxInputTokens: number; readonly usedInputTokens: number; readonly estimated: true; readonly method: 'heuristic-v1' }
  readonly renderedHash: string
  readonly contentHash: string
  readonly createdAt: string
}

export interface ResearchContextPackage {
  readonly rendered: string
  readonly selection: ContextSelection
  readonly manifest: ContextManifest
}

export class ContextInsufficientError extends Error {
  readonly code = 'CONTEXT_INSUFFICIENT'
  constructor(message: string) { super(message); this.name = 'ContextInsufficientError' }
}

export class StaleContextDependencyError extends Error {
  readonly code = 'STALE_CONTEXT_DEPENDENCY'
  constructor(message: string) { super(message); this.name = 'StaleContextDependencyError' }
}

