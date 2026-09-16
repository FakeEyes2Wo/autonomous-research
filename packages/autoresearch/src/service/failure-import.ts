import { resolve, dirname, relative, isAbsolute, sep } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { atomicWriteJson, readOptionalText } from '../core/utils.js'
import { importFailureReport, hashBytes } from '../research/index.js'

export interface FailureReportImport { sourceRunId: string; sourcePath: string }
export async function assertFailureImportTarget(runDir: string, input?: FailureReportImport): Promise<void> {
  if (!input) return
  const source = await realpath(input.sourcePath)
  let target = resolve(runDir)
  try { target = await realpath(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const rel = relative(dirname(source), target)
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('failure import requires a new run outside source history')
  if (await readOptionalText(resolve(target, 'state.json')) && !await readOptionalText(resolve(target, 'research', 'imported-failure.json'))) throw new Error('failure import requires a new run; existing history is immutable')
}
export async function importResearchFailure(runDir: string, branchId: string, input?: FailureReportImport): Promise<void> {
  if (!input) return
  if (!input.sourceRunId?.trim() || !input.sourcePath?.trim()) throw new TypeError('failureReport requires sourceRunId and sourcePath')
  const path = resolve(runDir, 'research', 'imported-failure.json')
  const prior = await readOptionalText(path)
  if (prior) {
    const previous = JSON.parse(prior)
    if (previous.source_run_id !== input.sourceRunId || previous.source_refs[0].hash !== hashBytes(await readFile(input.sourcePath))) throw new Error('failure import is already bound to different immutable source bytes')
    return
  }
  if (await readOptionalText(resolve(runDir, 'CURRENT.json'))) throw new Error('failure report import requires a new research branch/run directory')
  const imported = await importFailureReport({ ...input, sourcePath: resolve(input.sourcePath), targetRunDir: runDir, branchId })
  await atomicWriteJson(path, imported)
}
