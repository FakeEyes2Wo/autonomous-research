export interface BaselineSpec {
  task: string
  datasetVersion: string
  split: string
  metric: string
  direction: 'min' | 'max'
  maxComputeSeconds: number
  allowedComponents: string[]
}

export interface BaselineCandidate {
  workId: string
  spanIds: string[]
  spec: Partial<BaselineSpec>
  implementation: string | null
  estimatedComputeSeconds: number | null
}

export interface BaselineFit {
  workId: string
  status: 'matched' | 'mismatch' | 'unknown'
  reasons: string[]
  spanIds: string[]
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const seconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const components = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const comparableFields = ['task', 'datasetVersion', 'split', 'metric', 'direction'] as const

/** Compatibility is conditional on the supplied, source-backed configuration; popularity carries no weight. */
export function matchBaseline(spec: BaselineSpec, candidate: BaselineCandidate): BaselineFit {
  if (!spec || !comparableFields.every(field => text(spec[field])) || !['min', 'max'].includes(spec.direction) ||
      !seconds(spec.maxComputeSeconds) || !components(spec.allowedComponents)) throw new Error('INVALID_BASELINE_SPEC')
  if (!candidate || !text(candidate.workId) || !candidate.spec || typeof candidate.spec !== 'object' || Array.isArray(candidate.spec)) {
    throw new Error('INVALID_BASELINE_CANDIDATE')
  }
  const conflicts: string[] = []
  const missing: string[] = []
  for (const field of comparableFields) {
    const actual = candidate.spec[field]
    if (!text(actual) || (field === 'direction' && !['min', 'max'].includes(actual))) missing.push(field)
    else if (actual !== spec[field]) conflicts.push(field)
  }
  if (!components(candidate.spec.allowedComponents)) missing.push('allowedComponents')
  else if (candidate.spec.allowedComponents.some(component => !spec.allowedComponents.includes(component))) conflicts.push('allowedComponents')
  if (!seconds(candidate.spec.maxComputeSeconds)) missing.push('maxComputeSeconds')
  else if (candidate.spec.maxComputeSeconds > spec.maxComputeSeconds) conflicts.push('maxComputeSeconds')
  if (!seconds(candidate.estimatedComputeSeconds)) missing.push('estimatedComputeSeconds')
  else if (candidate.estimatedComputeSeconds > spec.maxComputeSeconds) conflicts.push('estimatedComputeSeconds')
  if (!text(candidate.implementation)) missing.push('implementation')
  const spanIds = Array.isArray(candidate.spanIds) && candidate.spanIds.every(text) ? [...new Set(candidate.spanIds)] : []
  if (!spanIds.length) missing.push('spanIds')
  return { workId: candidate.workId, status: conflicts.length ? 'mismatch' : missing.length ? 'unknown' : 'matched',
    reasons: [...conflicts, ...missing], spanIds }
}
