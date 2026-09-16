import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { estimateTokens } from '../policy/context.js'
import { FileMemoryStore, memoryRecordsToContextRecords } from '../memory/store.js'
import { canonicalContextJson, contextHash } from './seal.js'
import { selectContextRecords } from './select.js'
import { ContextInsufficientError, type ContextManifest, type ContextRecordBudget, type ResearchContextPackage, type ResearchContextRequest } from './types.js'

const manifestLocks = new Map<string, Promise<void>>()

async function withManifestLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = manifestLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  manifestLocks.set(path, queued)
  await previous
  try { return await fn() } finally { release(); if (manifestLocks.get(path) === queued) manifestLocks.delete(path) }
}

async function persistManifest(runDir: string, manifest: ContextManifest): Promise<ContextManifest> {
  const directory = join(runDir, 'context')
  const target = join(directory, `${manifest.callId}.json`)
  return withManifestLock(target, async () => {
    try {
      const existing = JSON.parse(await readFile(target, 'utf8')) as ContextManifest
      if (existing.schema !== 'autoresearch/context-manifest/v1' || existing.contentHash !== manifest.contentHash) throw new Error(`context manifest conflict for ${manifest.callId}`)
      return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw new Error(`invalid context manifest for ${manifest.callId}`)
        throw error
      }
    }
    await mkdir(directory, { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    return manifest
  })
}

export async function assembleResearchContext(input: {
  readonly runDir: string
  readonly role: string
  readonly taskId: string
  readonly request: ResearchContextRequest
  readonly budget: ContextRecordBudget
}): Promise<ResearchContextPackage> {
  const identity = {
    role: input.role,
    taskId: input.taskId,
    stage: input.request.stage,
    scope: input.request.scope,
    snapshot: input.request.snapshot,
    protocolHash: input.request.protocolHash,
  }
  const header = `## Structured research context\n${canonicalContextJson(identity)}\n### Complete records\n`
  const available = Math.max(0, Math.floor(input.budget.maxInputTokens) - estimateTokens(header))
  const memory = await new FileMemoryStore(input.runDir).query({ scope: input.request.scope, role: input.role })
  const records = [...input.request.records, ...memoryRecordsToContextRecords(memory)]
  const selection = selectContextRecords(records, {
    role: input.role,
    stage: input.request.stage,
    scope: input.request.scope,
    requiredRecordIds: input.request.requiredRecordIds,
    focusRecordIds: input.request.focusRecordIds,
    queryTerms: input.request.queryTerms,
  }, { maxInputTokens: available })
  const rendered = header + selection.selected.map((entry) => canonicalContextJson(entry.record)).join('\n')
  const renderedTokens = estimateTokens(rendered)
  if (renderedTokens > Math.max(0, Math.floor(input.budget.maxInputTokens))) throw new ContextInsufficientError('complete research context package exceeds input budget')
  const renderedHash = contextHash(rendered)
  const callId = contextHash({ identity, selected: selection.selected.map(({ record }) => ({ id: record.id, version: record.version, contentHash: record.contentHash })), renderedHash }).slice(0, 32)
  const dependencies = [...new Map(selection.selected.flatMap(({ record }) => record.dependencies ?? []).map((dependency) => [`${dependency.id}@${dependency.version}:${dependency.contentHash}`, dependency])).values()]
    .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version)
  const base = {
    schema: 'autoresearch/context-manifest/v1' as const,
    callId,
    role: input.role,
    taskId: input.taskId,
    stage: input.request.stage,
    scope: input.request.scope,
    ...(input.request.snapshot ? { snapshot: input.request.snapshot } : {}),
    ...(input.request.protocolHash ? { protocolHash: input.request.protocolHash } : {}),
    selected: selection.selected.map(({ record, reason, tokens }) => ({ id: record.id, version: record.version, contentHash: record.contentHash, reason, tokens })),
    excluded: selection.excluded.map((record) => ({ ...record })),
    dependencies,
    budget: { maxInputTokens: Math.max(0, Math.floor(input.budget.maxInputTokens)), usedInputTokens: renderedTokens, estimated: true as const, method: 'heuristic-v1' as const },
    renderedHash,
  }
  const manifestCandidate: ContextManifest = { ...base, contentHash: contextHash(base), createdAt: new Date().toISOString() }
  const manifest = await persistManifest(input.runDir, manifestCandidate)
  return { rendered, selection, manifest }
}
