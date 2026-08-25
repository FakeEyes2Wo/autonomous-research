import type { ResearchIdea } from './idea.js'
import {
  freezeRubric,
  readIdea,
  readPlan,
  readRubric,
  writeFailureReport,
  writePlan,
  writeRubric,
} from './files.js'

/**
 * Domain-local file accessor for a single run directory.
 *
 * This is an internal convenience object only; existing service/runner code
 * continues to use the free functions in `files.ts`.
 */
export class RunFiles {
  constructor(private readonly runDir: string) {}

  readIdea(): Promise<ResearchIdea> {
    return readIdea(this.runDir)
  }

  readRubric(): Promise<string> {
    return readRubric(this.runDir)
  }

  writeRubric(rubric: string): Promise<string> {
    return writeRubric(this.runDir, rubric)
  }

  freezeRubric(): Promise<void> {
    return freezeRubric(this.runDir)
  }

  readPlan(version: number): Promise<string> {
    return readPlan(this.runDir, version)
  }

  writePlan(version: number, plan: string): Promise<string> {
    return writePlan(this.runDir, version, plan)
  }

  writeFailureReport(content: string): Promise<string> {
    return writeFailureReport(this.runDir, content)
  }
}
