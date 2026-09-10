export class ExperimentPauseError extends Error {
  readonly code = 'EXPERIMENT_PAUSED'

  constructor(message: string) {
    super(message)
    this.name = 'ExperimentPauseError'
  }
}

export function isExperimentPauseError(error: unknown): error is ExperimentPauseError {
  return error instanceof ExperimentPauseError || Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === 'EXPERIMENT_PAUSED',
  )
}
