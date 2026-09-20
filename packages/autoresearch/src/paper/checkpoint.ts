import { join } from 'node:path'
import { atomicWriteJson, readJson } from '../core/utils.js'
import type { CompileResult, PreparedPaperLayout } from './index.js'
import type { PaperArtifactBinding, PaperFinalGate, PaperReviewBudget, PaperReviewResult } from './review-protocol.js'

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
    layout?: PreparedPaperLayout
    layoutOptionsHash?: string
    reviewOptionsHash?: string
    binding?: PaperArtifactBinding
    auditBinding?: PaperArtifactBinding
    compile?: CompileResult
    reviews?: Record<string, PaperReviewResult>
    reviewBudget?: PaperReviewBudget
    gate?: PaperFinalGate
    invalidatedReason?: string
    progressMarker?: string
  }
}

export function invalidatePaperCheckpoint(cp: PaperCheckpoint, reason: string): void {
  for (const phase of ['compile', 'audits', 'improvement', 'final']) cp.phases[phase] = 'pending'
  cp.data.submissionReady = false
  cp.data.compileOk = false
  cp.data.invalidatedReason = reason
  delete cp.data.auditBinding
  delete cp.data.reviews
  delete cp.data.gate
  delete cp.data.finalReport
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
