import { PLAN_PREFIX } from '../core/constants.js'
import { readText, safeResolve, writeText } from '../core/utils.js'

export function planPath(runDir: string, version: number): string {
  return safeResolve(runDir, `${PLAN_PREFIX}${version}.md`)
}

export async function writePlan(runDir: string, version: number, plan: string): Promise<string> {
  const file = planPath(runDir, version)
  await writeText(file, plan.endsWith('\n') ? plan : `${plan}\n`)
  return file
}

export async function readPlan(runDir: string, version: number): Promise<string> {
  return readText(planPath(runDir, version))
}
