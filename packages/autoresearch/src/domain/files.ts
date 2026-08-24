import { AutoResearchError, FAILURE_REPORT_FILE, FINAL_REPORT_FILE, IDEA_FILE, INPUT_DIR, PAPER_DRAFT_FILE, PLAN_PREFIX, RUBRIC_FILE } from '../core/utils.js'
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

export interface Candidate {
  direction: string
  aPrioriIdeas: string[]
  raw: string
}

export async function readCandidate(runDir: string, candidatePath?: string): Promise<Candidate> {
  const file = candidatePath ? safeResolve(runDir, candidatePath) : safeResolve(runDir, INPUT_DIR, IDEA_FILE)
  const raw = await readText(file)
  const directionMatch = raw.match(/^##\s+Direction\s*$/mi)
  if (!directionMatch) {
    throw new AutoResearchError('idea.md is missing a Direction section', 'INVALID_ARGUMENT')
  }
  const after = raw.slice((directionMatch.index ?? 0) + directionMatch[0].length)
  const ideasMatch = raw.match(/^##\s+A-priori ideas.*$/mi)
  const direction = after.split(/^##\s+/m)[0]?.trim() ?? ''
  if (!direction) throw new AutoResearchError('candidate direction is empty', 'INVALID_ARGUMENT')
  let aPrioriIdeas: string[] = []
  if (ideasMatch && ideasMatch.index !== undefined) {
    const ideasBlock = raw.slice(ideasMatch.index + ideasMatch[0].length)
    const nextHeading = ideasBlock.search(/^##\s+/m)
    const block = nextHeading >= 0 ? ideasBlock.slice(0, nextHeading) : ideasBlock
    aPrioriIdeas = block
      .split('\n')
      .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
      .filter(Boolean)
  }
  return { direction, aPrioriIdeas, raw }
}
