export type ActionStatus = 'running' | 'completed' | 'failed'

export function isActionStatus(value: string): value is ActionStatus {
  return value === 'running' || value === 'completed' || value === 'failed'
}
