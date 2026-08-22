import { FAILURE_REPORT_FILE, FINAL_REPORT_FILE, PAPER_DRAFT_FILE, PLAN_PREFIX, RUBRIC_FILE } from '../core/constants.js'
import { readText, safeResolve, writeText } from '../core/utils.js'

function mdPath(runDir: string, name: string): string {
  return safeResolve(runDir, name)
}

async function writeMd(runDir: string, name: string, content: string): Promise<string> {
  const file = mdPath(runDir, name)
  await writeText(file, content.endsWith('\n') ? content : `${content}\n`)
  return file
}

export const paperDraftPath = (runDir: string) => mdPath(runDir, PAPER_DRAFT_FILE)
export const finalReportPath = (runDir: string) => mdPath(runDir, FINAL_REPORT_FILE)
export const failureReportPath = (runDir: string) => mdPath(runDir, FAILURE_REPORT_FILE)
export const writePaperDraft = (runDir: string, content: string) => writeMd(runDir, PAPER_DRAFT_FILE, content)
export const writeFinalReport = (runDir: string, content: string) => writeMd(runDir, FINAL_REPORT_FILE, content)
export const writeFailureReport = (runDir: string, content: string) => writeMd(runDir, FAILURE_REPORT_FILE, content)

export const planPath = (runDir: string, version: number) => mdPath(runDir, `${PLAN_PREFIX}${version}.md`)
export const writePlan = (runDir: string, version: number, plan: string) => writeMd(runDir, `${PLAN_PREFIX}${version}.md`, plan)
export const readPlan = (runDir: string, version: number) => readText(planPath(runDir, version))

export const rubricPath = (runDir: string) => mdPath(runDir, RUBRIC_FILE)
export const writeRubric = (runDir: string, rubric: string) => writeMd(runDir, RUBRIC_FILE, rubric)
export const readRubric = (runDir: string) => readText(rubricPath(runDir))

export async function freezeRubric(runDir: string): Promise<void> {
  const file = rubricPath(runDir)
  const content = await readText(file)
  if (!content.includes('<!-- frozen -->')) await writeText(file, `${content}\n<!-- frozen -->\n`)
}
