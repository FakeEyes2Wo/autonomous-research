import { RUBRIC_FILE } from '../core/constants.js'
import { readText, safeResolve, writeText } from '../core/utils.js'

export function rubricPath(runDir: string): string {
  return safeResolve(runDir, RUBRIC_FILE)
}

export async function writeRubric(runDir: string, rubric: string): Promise<string> {
  const file = rubricPath(runDir)
  await writeText(file, rubric.endsWith('\n') ? rubric : `${rubric}\n`)
  return file
}

export async function readRubric(runDir: string): Promise<string> {
  return readText(rubricPath(runDir))
}

export async function freezeRubric(runDir: string): Promise<void> {
  const file = rubricPath(runDir)
  const content = await readText(file)
  if (!content.includes('<!-- frozen -->')) {
    await writeText(file, `${content}\n<!-- frozen -->\n`)
  }
}
