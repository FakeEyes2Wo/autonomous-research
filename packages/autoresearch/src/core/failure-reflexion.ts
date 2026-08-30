import { relative, sep } from 'node:path'
import { atomicWriteJson, FAILURE_REPORT_FILE, newId, nowIso, readJson, safeResolve, writeText } from './utils.js'

const DIR = 'failure_report_reflexions'
const INDEX_JSON = '_index.json'
const INDEX_MD = '_index.md'

export type FailureStopReason = 'fatal_flaw' | 'quality_low' | 'timeout' | 'agent_error' | 'max_rounds' | 'rejected' | 'invalid_output'

export interface FailureReflexionRecord {
  schema: 'autoresearch/failure-reflexion/v1'
  time: string
  role: string
  stage: string
  round: number
  stopReason: FailureStopReason
  error?: string
  context?: unknown
  result?: unknown
}

export interface FailureReflexionIndexEntry {
  file: string
  time: string
  role: string
  stopReason: FailureStopReason
}

export async function writeFailureReflexion(
  runDir: string,
  record: Omit<FailureReflexionRecord, 'schema' | 'time'> & { time?: string },
): Promise<string> {
  const time = record.time ?? nowIso()
  const file = safeResolve(runDir, DIR, `${newId('failure')}.json`)
  const full: FailureReflexionRecord = { schema: 'autoresearch/failure-reflexion/v1', ...record, time }
  await atomicWriteJson(file, full)
  await appendFailureReflexionIndex(runDir, {
    file: relative(runDir, file).split(sep).join('/'),
    time,
    role: record.role,
    stopReason: record.stopReason,
  })
  return file
}

export async function appendFailureReflexionIndex(
  runDir: string,
  entry: FailureReflexionIndexEntry,
): Promise<void> {
  const indexFile = safeResolve(runDir, DIR, INDEX_JSON)
  const existing = await readJson<{ entries?: FailureReflexionIndexEntry[] }>(indexFile).catch(() => ({ entries: [] }))
  const entries = [...(existing.entries ?? []), entry]
  await atomicWriteJson(indexFile, { schema: 'autoresearch/failure-reflexion-index/v1', entries })
  const rows = entries.map((e) => `| ${e.time} | ${e.role} | ${e.stopReason} | ${e.file} |`)
  await writeText(
    safeResolve(runDir, DIR, INDEX_MD),
    ['# Failure Reflexions', '', '| time | role | stopReason | file |', '|---|---|---|---|', ...rows].join('\n') + '\n',
  )
}

export async function loadFailureReflexionIndex(runDir: string): Promise<FailureReflexionIndexEntry[]> {
  const data = await readJson<{ entries?: FailureReflexionIndexEntry[] }>(
    safeResolve(runDir, DIR, INDEX_JSON),
  ).catch(() => ({ entries: [] }))
  return data.entries ?? []
}

export async function writeFailureReportWithReflexions(runDir: string, baseReport: string): Promise<void> {
  const entries = await loadFailureReflexionIndex(runDir)
  const report = entries.length === 0
    ? baseReport
    : `${baseReport}\n\n## Failure Reflexions\n\nSee the following files for detailed reflexion context:\n\n${entries.map((e) => `- ${e.file} (${e.role}, ${e.stopReason})`).join('\n')}\n`
  await writeText(safeResolve(runDir, FAILURE_REPORT_FILE), report)
}
