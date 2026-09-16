import type { ContextDependency, ContextRecordScope } from '../research-context/types.js'

export type MemoryKind = 'observation' | 'interpretation' | 'procedure' | 'decision'
export type MemoryStatus = 'candidate' | 'validated_in_scope' | 'disputed' | 'invalidated'

export interface MemoryContent {
  readonly observation?: string
  readonly interpretation?: string
  readonly procedure?: { readonly artifactPath: string; readonly artifactHash: string; readonly acceptance: string }
  readonly decision?: string
  readonly rationale?: string
  readonly recommendedAction?: string
}

export interface MemoryProvenance {
  readonly sourceIds: readonly string[]
  readonly sourceHashes: Readonly<Record<string, string>>
  readonly protocolHash?: string
  readonly snapshotId?: string
  readonly createdAt: string
  readonly derivedFromIds?: readonly string[]
}

export interface MemoryApplicability {
  readonly appliesWhen: readonly string[]
  readonly doesNotApplyWhen: readonly string[]
  readonly domain?: string
  readonly task?: string
  readonly model?: string
  readonly tool?: string
  readonly dataVersion?: string
}

export interface MemoryAssessment {
  readonly status: MemoryStatus
  readonly method: string
  readonly supportingSourceIds: readonly string[]
  readonly opposingSourceIds: readonly string[]
}

export interface MemoryRecordInput {
  readonly id: string
  readonly version: number
  readonly kind: MemoryKind
  readonly scope: ContextRecordScope
  readonly content: MemoryContent
  readonly provenance: MemoryProvenance
  readonly applicability: MemoryApplicability
  readonly assessment: MemoryAssessment
  readonly dependencies: readonly ContextDependency[]
  readonly topicIds: readonly string[]
  readonly accessRoles?: readonly string[]
  readonly polarity?: 'supporting' | 'opposing' | 'neutral'
  readonly conflictIds?: readonly string[]
  readonly unresolvedConflict?: boolean
  readonly summary?: boolean
}

export interface MemoryRecord extends MemoryRecordInput {
  readonly contentHash: string
}

export interface MemoryQuery {
  readonly scope: { readonly projectId: string; readonly branchId: string; readonly runId?: string; readonly split?: string }
  readonly role: string
  readonly statuses?: readonly MemoryStatus[]
  readonly topicIds?: readonly string[]
}

export interface MemoryTransitionAssessment {
  readonly method: string
  readonly supportingSourceIds?: readonly string[]
  readonly opposingSourceIds?: readonly string[]
}

