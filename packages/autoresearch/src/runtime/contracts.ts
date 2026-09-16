export type JobStatus = 'queued' | 'submitting' | 'running' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'unknown'
export interface JobSpec {
  id: string; attemptId: string; taskId: string; protocolHash: string; inputHash: string
  executable: string; args: string[]; cwd: string; env: Record<string, string>
  budget: { wallMs: number; cpuSeconds: number | null; gpuSeconds: number | null; costMicros: number | null; maxLogBytes: number; maxArtifactBytes: number }
  checkpoint: { resumeArgs: string[]; path: string } | null
}
export interface JobReceipt {
  jobId: string; backendId: string; status: JobStatus; inputHash: string; protocolHash: string
  heartbeatAt: string | null; progressAt: string | null; exitCode: number | null; artifactManifestHash: string | null
}
export interface JobBackend {
  submit(spec: JobSpec, fence: number): Promise<JobReceipt>
  inspect(jobId: string): Promise<JobReceipt>
  collect(jobId: string): Promise<JobReceipt>
  cancel(jobId: string): Promise<JobReceipt>
}
export interface SupervisorIdentity { nonce: string; host: string; startupId: string; socket: string; pid: number | null }
export interface JobRecord {
  spec: JobSpec; specHash: string; receipt: JobReceipt; fence: number; owner: string | null; leaseUntil: number
  startedAt: number | null; deadlineAt: number | null; identity: SupervisorIdentity | null
  executionClaimed: boolean; cancellationReason: string | null; requestIds: string[]; logs: LogRecord[]
}
export interface LogRecord { stream: string; sequence: number; bytes: number; hash: string; retainedBytes: number }
export interface RuntimeLimits { maxReservedWallMs: number; maxConcurrentJobs: number }
export interface BudgetSnapshot { reservedWallMs: number; activeJobs: number; settledWallMs: number; cpuSeconds: null; gpuSeconds: null; costMicros: null }
export const terminal = (status: JobStatus): boolean => ['succeeded', 'failed', 'cancelled'].includes(status)
