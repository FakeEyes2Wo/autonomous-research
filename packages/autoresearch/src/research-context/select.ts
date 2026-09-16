import { estimateTokens } from '../policy/context.js'
import { canonicalContextJson, verifyContextRecord } from './seal.js'
import {
  ContextInsufficientError,
  StaleContextDependencyError,
  type ContextExclusionReason,
  type ContextRecord,
  type ContextRecordBudget,
  type ContextSelection,
  type ContextSelectionQuery,
  type ContextSelectionReason,
  type ResearchContextScope,
} from './types.js'

export function contextScopeMatches(record: Pick<ContextRecord, 'scope'>, request: ResearchContextScope): boolean {
  if (record.scope.projectId !== request.projectId) return false
  if (record.scope.visibility === 'project') return true
  if (record.scope.branchId !== request.branchId) return false
  if (record.scope.visibility === 'branch') return true
  if (record.scope.visibility === 'run') return record.scope.runId === request.runId
  return record.scope.split === request.split && (record.scope.runId === undefined || record.scope.runId === request.runId)
}

function exclusion(record: ContextRecord, reason: ContextExclusionReason) {
  return { id: record.id, version: record.version, contentHash: record.contentHash, reason } as const
}

function latestById(records: readonly ContextRecord[]): Map<string, ContextRecord> {
  const latest = new Map<string, ContextRecord>()
  for (const record of records) {
    const current = latest.get(record.id)
    if (!current || current.version < record.version) latest.set(record.id, record)
  }
  return latest
}

function staleDependencies(record: ContextRecord, current: ReadonlyMap<string, ContextRecord>): boolean {
  return (record.dependencies ?? []).some((dependency) => {
    const actual = current.get(dependency.id)
    return !actual || actual.version !== dependency.version || actual.contentHash !== dependency.contentHash || actual.lifecycle === 'invalidated'
  })
}

function intersects(left: readonly string[] | undefined, right: ReadonlySet<string>): boolean {
  return Boolean(left?.some((value) => right.has(value)))
}

function score(record: ContextRecord, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0
  const haystack = canonicalContextJson({ topicIds: record.topicIds, payload: record.payload }).toLowerCase()
  return queryTerms.reduce((total, term) => total + (term && haystack.includes(term.toLowerCase()) ? 1 : 0), 0)
}

function compareRecords(left: ContextRecord, right: ContextRecord, queryTerms: readonly string[]): number {
  return left.layer - right.layer
    || score(right, queryTerms) - score(left, queryTerms)
    || Number(right.polarity === 'opposing') - Number(left.polarity === 'opposing')
    || left.id.localeCompare(right.id)
    || right.version - left.version
}

export function selectContextRecords(
  records: readonly ContextRecord[],
  query: ContextSelectionQuery,
  budget: ContextRecordBudget,
): ContextSelection {
  const excluded = [] as Array<ReturnType<typeof exclusion>>
  for (const record of records) verifyContextRecord(record)
  const current = latestById(records)
  const visible: ContextRecord[] = []
  const invalidated = new Set<string>()
  for (const record of records) {
    if (current.get(record.id) !== record) continue
    if (!contextScopeMatches(record, query.scope)) { excluded.push(exclusion(record, 'scope')); continue }
    if (record.accessRoles?.length && !record.accessRoles.includes(query.role)) { excluded.push(exclusion(record, 'access')); continue }
    visible.push(record)
    if (record.lifecycle === 'invalidated') { invalidated.add(record.id); excluded.push(exclusion(record, 'invalidated')) }
  }
  const visibleCurrent = latestById(visible)
  const stale = new Set(visible.filter((record) => staleDependencies(record, visibleCurrent)).map((record) => record.id))
  let staleExpanded = true
  while (staleExpanded) {
    staleExpanded = false
    for (const record of visible) {
      if (stale.has(record.id)) continue
      if ((record.dependencies ?? []).some((dependency) => stale.has(dependency.id))) {
        stale.add(record.id)
        staleExpanded = true
      }
    }
  }
  const requiredIds = new Set([...(query.requiredRecordIds ?? []), ...visible.filter((record) => record.required).map((record) => record.id)])
  const focusIds = new Set(query.focusRecordIds ?? [])
  const requestedIds = new Set([...requiredIds, ...focusIds])
  const admissibleIds = new Set(visible.filter((record) => !invalidated.has(record.id)).map((record) => record.id))
  const missing = [...requestedIds].filter((id) => !admissibleIds.has(id))
  if (missing.length) throw new ContextInsufficientError(`required or focused context records are unavailable: ${missing.join(', ')}`)

  const focusTopics = new Set<string>()
  const seedRecords = visible.filter((record) => requestedIds.has(record.id))
  for (const record of seedRecords) for (const topic of record.topicIds ?? []) focusTopics.add(topic)
  const opposingIds = new Set(visible.filter((record) => record.polarity === 'opposing' && intersects(record.topicIds, focusTopics)).map((record) => record.id))
  const unresolvedConflictIds = new Set(
    visible.filter((record) => record.unresolvedConflict).flatMap((record) => record.conflictIds ?? []),
  )
  const conflictIds = new Set<string>()
  for (const record of visible) {
    if ((requiredIds.has(record.id) || focusIds.has(record.id) || opposingIds.has(record.id) || (record.unresolvedConflict && intersects(record.topicIds, focusTopics)))) {
      for (const id of record.conflictIds ?? []) if (unresolvedConflictIds.has(id)) conflictIds.add(id)
    }
  }
  const conflictRecordIds = new Set<string>()
  let expanded = true
  while (expanded) {
    expanded = false
    for (const record of visible) {
      if (!intersects(record.conflictIds, conflictIds)) continue
      if (!conflictRecordIds.has(record.id)) { conflictRecordIds.add(record.id); expanded = true }
      for (const conflictId of record.conflictIds ?? []) {
        if (unresolvedConflictIds.has(conflictId) && !conflictIds.has(conflictId)) { conflictIds.add(conflictId); expanded = true }
      }
    }
  }
  const invariantIds = new Set([...requiredIds, ...focusIds, ...opposingIds, ...conflictRecordIds])
  const invalidatedInvariant = [...invariantIds].filter((id) => invalidated.has(id))
  if (invalidatedInvariant.length) throw new ContextInsufficientError(`required context closure contains invalidated records: ${invalidatedInvariant.join(', ')}`)
  const staleInvariant = [...invariantIds].filter((id) => stale.has(id))
  if (staleInvariant.length) throw new StaleContextDependencyError(`required context closure has stale dependencies: ${staleInvariant.join(', ')}`)
  for (const conflictId of conflictIds) {
    const sides = visible.filter((record) => record.conflictIds?.includes(conflictId))
    if (sides.length < 2) throw new ContextInsufficientError(`unresolved conflict ${conflictId} has no eligible opposing side`)
  }
  const usable = visible.filter((record) => {
    if (invalidated.has(record.id)) return false
    if (!stale.has(record.id)) return true
    excluded.push(exclusion(record, 'stale-dependency'))
    return false
  })
  const reasonFor = (record: ContextRecord): ContextSelectionReason => {
    if (requiredIds.has(record.id) || focusIds.has(record.id)) return 'required'
    if (opposingIds.has(record.id)) return 'opposing-evidence'
    if (conflictRecordIds.has(record.id)) return 'unresolved-conflict'
    return 'ranked'
  }
  const terms = query.queryTerms ?? []
  const ordered = [...usable].sort((left, right) => {
    const invariant = Number(invariantIds.has(right.id)) - Number(invariantIds.has(left.id))
    return invariant || compareRecords(left, right, terms)
  })
  const max = Math.max(0, Math.floor(budget.maxInputTokens))
  const selected: Array<{ record: ContextRecord; reason: ContextSelectionReason; tokens: number }> = []
  let used = 0
  for (const record of ordered) {
    const tokens = estimateTokens(canonicalContextJson(record))
    if (used + tokens <= max) {
      selected.push({ record, reason: reasonFor(record), tokens })
      used += tokens
    } else if (invariantIds.has(record.id)) {
      throw new ContextInsufficientError(`required context record closure exceeds input budget at ${record.id}`)
    } else {
      excluded.push(exclusion(record, 'budget'))
    }
  }
  return {
    selected,
    excluded: excluded.sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version),
    inputTokens: used,
    estimated: true,
  }
}
