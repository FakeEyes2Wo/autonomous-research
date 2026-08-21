import { FAILURE_REPORT_FILE, FINAL_REPORT_FILE, PAPER_DRAFT_FILE } from '../core/constants.js'
import { safeResolve, writeText } from '../core/utils.js'

export function paperDraftPath(runDir: string): string {
  return safeResolve(runDir, PAPER_DRAFT_FILE)
}

export function finalReportPath(runDir: string): string {
  return safeResolve(runDir, FINAL_REPORT_FILE)
}

export function failureReportPath(runDir: string): string {
  return safeResolve(runDir, FAILURE_REPORT_FILE)
}

export async function writePaperDraft(runDir: string, content: string): Promise<string> {
  const file = paperDraftPath(runDir)
  await writeText(file, content)
  return file
}

export async function writeFinalReport(runDir: string, content: string): Promise<string> {
  const file = finalReportPath(runDir)
  await writeText(file, content)
  return file
}

export async function writeFailureReport(runDir: string, content: string): Promise<string> {
  const file = failureReportPath(runDir)
  await writeText(file, content)
  return file
}
