import { writeFailureReport, writeFinalReport } from '../domain/paper.js'

export async function writeSuccessReport(runDir: string, summary: string): Promise<void> {
  await writeFinalReport(runDir, `# FINAL_REPORT\n\n${summary}\n`)
}

export async function writeFailure(runDir: string, reason: string): Promise<void> {
  await writeFailureReport(runDir, `# FAILURE_REPORT\n\n${reason}\n`)
}
