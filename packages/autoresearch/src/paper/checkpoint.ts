import { join } from 'node:path'
import { atomicWriteJson, readJson } from '../core/utils.js'

export type PhaseStatus = 'pending' | 'running' | 'done' | 'failed'

export interface PaperCheckpoint {
  schema: 'autoresearch/paper-pipeline-checkpoint/v1'
  updated_at: string
  assurance: string
  phases: Record<string, PhaseStatus>
  data: {
    planFile?: string
    matrixFile?: string
    contractFile?: string
    compileOk?: boolean
    audits?: Record<string, unknown>
    auditStatus?: 'passed' | 'failed'
    submissionReady?: boolean
    improvementRounds?: number
    finalReport?: string
  }
}

const CHECKPOINT_FILE = 'pipeline_checkpoint.json'

export function checkpointPath(paperDir: string): string {
  return join(paperDir, CHECKPOINT_FILE)
}

export async function loadCheckpoint(paperDir: string): Promise<PaperCheckpoint | undefined> {
  try {
    return await readJson<PaperCheckpoint>(checkpointPath(paperDir))
  } catch {
    return undefined
  }
}

export async function saveCheckpoint(paperDir: string, checkpoint: PaperCheckpoint): Promise<void> {
  checkpoint.updated_at = new Date().toISOString()
  await atomicWriteJson(checkpointPath(paperDir), checkpoint)
}
