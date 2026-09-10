import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { lstat, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { parse, stringify } from 'yaml'
import { ensureDir } from '../core/utils.js'
import { projectSettingsPath } from './project-settings.js'
import { migrateProjectSettings, validateProjectSettingsCandidate } from './migration.js'
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings, type ValidationError, type ValidationWarning } from './schema.js'

export type SettingsSource = 'missing' | 'v1' | 'v2'
export interface ProjectSettingsDocument { path: string; source: SettingsSource; revision: string; settings: ProjectSettings; warnings: ValidationWarning[] }
export type SettingsPatchOperation = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }
export interface SettingsPatchRequest { expectedRevision: string; ops: SettingsPatchOperation[] }

const locks = new Map<string, Promise<void>>()

export async function readProjectSettingsDocument(projectDir: string): Promise<ProjectSettingsDocument> {
  const path = projectSettingsPath(projectDir)
  await assertSafeSettingsPath(projectDir, path)
  let text: string
  try { text = await readFile(path, 'utf8') } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { path, source: 'missing', revision: hash(''), settings: structuredClone(DEFAULT_PROJECT_SETTINGS), warnings: [] }
    throw settingsError(path, [{ path: '/', code: 'READ', message: String(cause) }])
  }
  let parsed: unknown
  try { parsed = parse(text) } catch (cause) { throw settingsError(path, [{ path: '/', code: 'YAML_PARSE', message: String(cause) }]) }
  const result = validateProjectSettingsCandidate(parsed)
  if (!result.valid || !result.settings) throw settingsError(path, result.errors)
  const source: SettingsSource = isV1(parsed) ? 'v1' : 'v2'
  return { path, source, revision: hash(text), settings: result.settings, warnings: result.warnings }
}

export function validateProjectSettings(candidate: unknown) { return validateProjectSettingsCandidate(candidate) }

export async function saveProjectSettingsDocument(projectDir: string, settings: ProjectSettings, expectedRevision?: string): Promise<ProjectSettingsDocument> {
  const path = projectSettingsPath(projectDir)
  await assertSafeSettingsPath(projectDir, path)
  return withLock(path, async () => {
    const current = await readProjectSettingsDocument(projectDir)
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw revisionConflict(current)
    const result = validateProjectSettingsCandidate({ ...settings, version: 2 })
    if (!result.valid || !result.settings) throw settingsError(current.path, result.errors)
    const text = `${stringify(result.settings)}\n`
    if (current.source !== 'missing') await assertUnchanged(current.path, current.revision)
    await atomicWrite(current.path, text)
    return { path: current.path, source: 'v2', revision: hash(text), settings: result.settings, warnings: result.warnings }
  })
}

export async function patchProjectSettingsDocument(projectDir: string, request: SettingsPatchRequest): Promise<ProjectSettingsDocument> {
  if (typeof request.expectedRevision !== 'string' || !request.expectedRevision) throw settingsError(projectSettingsPath(projectDir), [{ path: '/expectedRevision', code: 'REVISION', message: 'expectedRevision must be a file revision hash' }])
  if (!Array.isArray(request.ops)) throw settingsError(projectSettingsPath(projectDir), [{ path: '/ops', code: 'PATCH_OP', message: 'ops must be an array' }])
  const path = projectSettingsPath(projectDir)
  await assertSafeSettingsPath(projectDir, path)
  return withLock(path, async () => {
    const current = await readProjectSettingsDocument(projectDir)
    if (current.revision !== request.expectedRevision) throw revisionConflict(current)
    const candidate = structuredClone(current.settings) as unknown as Record<string, unknown>
    for (const op of request.ops) applyOperation(candidate, op)
    const result = validateProjectSettingsCandidate({ ...candidate, version: 2 })
    if (!result.valid || !result.settings) throw settingsError(current.path, result.errors)
    const settings = result.settings
    const text = `${stringify(settings)}\n`
    if (current.source !== 'missing') await assertUnchanged(current.path, current.revision)
    await atomicWrite(current.path, text)
    return { path: current.path, source: 'v2', revision: hash(text), settings, warnings: result.warnings }
  })
}

function applyOperation(root: Record<string, unknown>, op: SettingsPatchOperation): void {
  if (!op || typeof op !== 'object') throw settingsError('', [{ path: '/ops', code: 'PATCH_OP', message: 'each operation must be an object' }])
  if (!Object.prototype.hasOwnProperty.call(op, 'op') || !Object.prototype.hasOwnProperty.call(op, 'path')) throw settingsError('', [{ path: '/ops', code: 'PATCH_OP', message: 'operation op and path must be own properties' }])
  if (!['add', 'replace', 'remove'].includes(op.op)) throw settingsError('', [{ path: '/ops', code: 'PATCH_OP', message: 'unsupported patch operation' }])
  if (typeof op.path !== 'string' || !op.path.startsWith('/') || op.path === '/version' || op.path === '/revision' || /(^|\/)(__proto__|prototype|constructor)(\/|$)/.test(op.path) || /~(?![01])/.test(op.path)) throw settingsError('', [{ path: op.path ?? '/ops', code: 'PATCH_PATH', message: 'unsafe or immutable patch path' }])
  const parts = op.path.slice(1).split('/').map(unescapePointer)
  let parent: Record<string, unknown> = root
  for (const part of parts.slice(0, -1)) {
    if (!Object.prototype.hasOwnProperty.call(parent, part)) throw settingsError('', [{ path: op.path, code: 'PATCH_PATH', message: `missing object path ${part}` }])
    const next = parent[part]
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw settingsError('', [{ path: op.path, code: 'PATCH_PATH', message: `non-object path ${part}` }])
    parent = next as Record<string, unknown>
  }
  const key = parts.at(-1)
  if (!key) throw settingsError('', [{ path: op.path, code: 'PATCH_PATH', message: 'empty patch path' }])
  if (op.op === 'remove') { if (!Object.prototype.hasOwnProperty.call(parent, key)) throw settingsError('', [{ path: op.path, code: 'PATCH_PATH', message: 'cannot remove absent field' }]); delete parent[key] }
  else { if (!Object.prototype.hasOwnProperty.call(op, 'value')) throw settingsError('', [{ path: op.path, code: 'PATCH_VALUE', message: 'add/replace requires own value' }]); parent[key] = structuredClone(op.value) }
}

function unescapePointer(value: string): string { return value.replaceAll('~1', '/').replaceAll('~0', '~') }
function isV1(value: unknown): boolean { return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).version === 1) }
function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }
async function assertUnchanged(path: string, expected: string): Promise<void> { let text: string; try { text = await readFile(path, 'utf8') } catch (cause) { throw settingsError(path, [{ path: '/', code: 'EXTERNAL_EDIT', message: String(cause) }]) }; if (hash(text) !== expected) throw settingsError(path, [{ path: '/', code: 'REVISION_CONFLICT', message: 'settings changed during patch' }]) }
async function atomicWrite(path: string, text: string): Promise<void> { const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`; await ensureDir(dirname(path)); const parentStat = await lstat(dirname(path)); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('settings directory must be a real directory'); try { if ((await lstat(path)).isSymbolicLink()) throw new Error('settings file must not be a symlink') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; try { await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' }); await rename(temp, path) } catch (error) { await unlink(temp).catch(() => undefined); throw error } }
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> { const previous = locks.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>((resolve) => { release = resolve }); const queued = previous.then(() => current); locks.set(key, queued); await previous; let releaseFile: (() => Promise<void>) | undefined; try { releaseFile = await acquireFileLock(key); return await fn() } finally { try { await releaseFile?.() } finally { release(); if (locks.get(key) === queued) locks.delete(key) } } }
async function acquireFileLock(key: string): Promise<() => Promise<void>> {
  const lockPath = `${key}.lock`
  await ensureDir(dirname(key))
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const handle = await open(lockPath, 'wx')
      return async () => { await handle.close(); await unlink(lockPath).catch(() => undefined) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw settingsError(key, [{ path: '/', code: 'LOCK_TIMEOUT', message: 'settings lock remained held for too long' }])
}

async function assertSafeSettingsPath(projectDir: string, path: string): Promise<void> {
  const root = resolve(projectDir)
  let rootReal: string
  try { rootReal = await realpath(root) } catch (cause) { throw settingsError(path, [{ path: '/', code: 'PATH', message: String(cause) }]) }
  const parent = dirname(path)
  try {
    const parentStat = await lstat(parent)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('settings directory must be a real directory')
    const parentReal = await realpath(parent)
    const rel = relative(rootReal, parentReal)
    if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('settings directory escapes project root')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw settingsError(path, [{ path: '/', code: 'PATH', message: String(cause) }])
  }
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('settings file must not be a symlink') } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw settingsError(path, [{ path: '/', code: 'PATH', message: String(cause) }])
  }
}
function settingsError(file: string, errors: ValidationError[]): Error & { code: string; file: string; errors: ValidationError[] } { const error = new Error(`invalid project settings at ${file}`) as Error & { code: string; file: string; errors: ValidationError[] }; error.name = 'ProjectSettingsError'; error.code = errors.some((x) => x.code === 'REVISION_CONFLICT') ? 'REVISION_CONFLICT' : 'SETTINGS_CORRUPT'; error.file = file; error.errors = errors; return error }
function revisionConflict(current: ProjectSettingsDocument): Error & { code: string; status: number; revision: string } { const error = new Error(`settings revision conflict: expected ${current.revision}`) as Error & { code: string; status: number; revision: string }; error.name = 'RevisionConflictError'; error.code = 'REVISION_CONFLICT'; error.status = 409; error.revision = current.revision; return error }
