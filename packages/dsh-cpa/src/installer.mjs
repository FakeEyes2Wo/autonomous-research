import { copyFile, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { compileSettings, assertValidConfig } from './config.mjs'
import { canonical, cloneSettings, parseSettingsDocument, patchSettingsDocument, stringifySettings } from './yaml.mjs'

export const INSTALL_STATE_VERSION = 1
export const STATE_FILENAME = '.athena-dsh-cpa.json'

function fingerprint(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function textFingerprint(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function dshHomePath(input) {
  return resolve(input || process.env.DSH_HOME || join(homedir(), '.dsh'))
}

export function settingsPathForHome(input) {
  return join(dshHomePath(input), 'settings.yaml')
}

export function statePathForHome(input) {
  return join(dshHomePath(input), STATE_FILENAME)
}

async function readOptional(path, fallback) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

function stateError(path, message) {
  const error = new Error('Invalid CPA install state: ' + path + (message ? ' (' + message + ')' : ''))
  error.code = 'CPA_INSTALL_STATE_INVALID'
  return error
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function samePath(left, right) {
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  return process.platform === 'win32' ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight
}

async function readState(path, settingsPath) {
  const text = await readOptional(path, '')
  if (!text) return { version: INSTALL_STATE_VERSION, managedBy: '@athena/dsh-cpa', settingsPath, routes: {} }
  let state
  try {
    state = JSON.parse(text)
  } catch {
    throw stateError(path, 'JSON is invalid')
  }
  if (!isRecord(state) || state.version !== INSTALL_STATE_VERSION || state.managedBy !== '@athena/dsh-cpa' || typeof state.settingsPath !== 'string' || !samePath(state.settingsPath, settingsPath) || !isRecord(state.routes)) {
    throw stateError(path, 'owner, settings path, version, or routes are invalid')
  }
  if (Object.values(state.routes).some((fingerprint) => typeof fingerprint !== 'string')) throw stateError(path, 'route fingerprints are invalid')
  return state
}

function routeMap(document) {
  const providers = document?.['llm-pi-ai']?.providers
  return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {}
}

function makePlan({ config, current, currentDocument, originalText, prior, settingsPath, statePath, operation }) {
  const compiled = operation === 'install' ? compileSettings(config) : { 'llm-pi-ai': { providers: {} } }
  const desired = compiled['llm-pi-ai'].providers
  const currentProviders = routeMap(current)
  const errors = []
  const changes = []
  const next = cloneSettings(current)
  next['llm-pi-ai'] ??= {}
  next['llm-pi-ai'].providers ??= {}
  if (operation === 'install') {
    for (const [id, provider] of Object.entries(desired)) {
      const old = currentProviders[id]
      const oldFingerprint = old === undefined ? undefined : canonical(old)
      const knownFingerprint = prior.routes[id]
      if (old !== undefined && knownFingerprint === undefined) {
        errors.push({ id, code: 'foreign_route', message: 'route exists but is not owned by this installer; refusing to overwrite' })
        continue
      }
      if (old !== undefined && knownFingerprint !== undefined && oldFingerprint !== knownFingerprint) {
        errors.push({ id, code: 'user_modified', message: 'managed route was modified after installation; refusing to overwrite' })
        continue
      }
      next['llm-pi-ai'].providers[id] = provider
      if (old === undefined) changes.push({ id, action: 'add' })
      else if (canonical(provider) !== oldFingerprint) changes.push({ id, action: 'update' })
    }
    for (const [id, knownFingerprint] of Object.entries(prior.routes)) {
      if (desired[id] !== undefined) continue
      const old = currentProviders[id]
      if (old === undefined) continue
      if (canonical(old) !== knownFingerprint) errors.push({ id, code: 'user_modified', message: 'stale managed route was modified; refusing to remove' })
      else {
        delete next['llm-pi-ai'].providers[id]
        changes.push({ id, action: 'remove' })
      }
    }
  } else {
    for (const [id, knownFingerprint] of Object.entries(prior.routes)) {
      const old = currentProviders[id]
      if (old === undefined) continue
      if (canonical(old) !== knownFingerprint) errors.push({ id, code: 'user_modified', message: 'managed route was modified; refusing to uninstall it' })
      else {
        delete next['llm-pi-ai'].providers[id]
        changes.push({ id, action: 'remove' })
      }
    }
    if (Object.keys(next['llm-pi-ai'].providers).length === 0 && Object.keys(next['llm-pi-ai']).length === 1) delete next['llm-pi-ai']
  }
  const state = {
    version: INSTALL_STATE_VERSION,
    managedBy: '@athena/dsh-cpa',
    settingsPath,
    routes: operation === 'install' ? Object.fromEntries(Object.entries(desired).map(([id, provider]) => [id, canonical(provider)])) : {}
  }
  const documentOperations = []
  if (operation === 'install') {
    for (const [id, provider] of Object.entries(desired)) documentOperations.push({ type: 'set', path: ['llm-pi-ai', 'providers', id], value: provider })
    for (const change of changes.filter((item) => item.action === 'remove')) documentOperations.push({ type: 'delete', path: ['llm-pi-ai', 'providers', change.id] })
  } else {
    for (const change of changes) documentOperations.push({ type: 'delete', path: ['llm-pi-ai', 'providers', change.id] })
  }
  if (operation === 'uninstall' && Object.keys(next['llm-pi-ai']?.providers ?? {}).length === 0 && Object.keys(next['llm-pi-ai'] ?? {}).length === 1) documentOperations.push({ type: 'delete', path: ['llm-pi-ai'] })
  const nextDocument = patchSettingsDocument(currentDocument, documentOperations)
  const plan = {
    operation,
    settingsPath,
    statePath,
    state,
    changes,
    errors,
    ok: errors.length === 0,
    currentFingerprint: textFingerprint(originalText),
    stateFingerprint: fingerprint(prior),
    diff: stringifySettings({
      managedRoutes: changes.map((change) => ({ id: change.id, action: change.action }))
    }),
    originalTextLength: originalText.length
  }
  Object.defineProperty(plan, 'nextText', { value: String(nextDocument), enumerable: false })
  return plan
}

export async function planInstall({ config, settingsPath, statePath, dshHome } = {}) {
  const resolvedSettings = resolve(settingsPath || settingsPathForHome(dshHome))
  const resolvedState = resolve(statePath || statePathForHome(dshHome))
  const text = await readOptional(resolvedSettings, '')
  const parsed = parseSettingsDocument(text)
  const current = parsed.value
  const prior = await readState(resolvedState, resolvedSettings)
  return makePlan({ config: assertValidConfig(config), current, currentDocument: parsed.document, originalText: text, prior, settingsPath: resolvedSettings, statePath: resolvedState, operation: 'install' })
}

export async function planUninstall({ settingsPath, statePath, dshHome } = {}) {
  const resolvedSettings = resolve(settingsPath || settingsPathForHome(dshHome))
  const resolvedState = resolve(statePath || statePathForHome(dshHome))
  const text = await readOptional(resolvedSettings, '')
  const parsed = parseSettingsDocument(text)
  const current = parsed.value
  const prior = await readState(resolvedState, resolvedSettings)
  return makePlan({ config: { routes: [] }, current, currentDocument: parsed.document, originalText: text, prior, settingsPath: resolvedSettings, statePath: resolvedState, operation: 'uninstall' })
}

async function atomicReplace(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2)
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
  const backup = path + '.bak-' + Date.now()
  try {
    if (existsSync(path)) await copyFile(path, backup)
    await rename(temp, path)
    return backup
  } catch (error) {
    try { if (existsSync(temp)) await unlink(temp) } catch { /* preserve the original target */ }
    throw error
  }
}

export async function applyPlan(plan, { dryRun = false } = {}) {
  if (!plan.ok) {
    const error = new Error('CPA install refused because the target contains conflicts')
    error.code = 'CPA_INSTALL_CONFLICT'
    error.conflicts = plan.errors
    throw error
  }
  if (dryRun || plan.changes.length === 0) return { ...plan, applied: false }
  const lockPath = plan.settingsPath + '.lock'
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') {
      const conflict = new Error('another CPA installer is currently writing this DSH home')
      conflict.code = 'CPA_INSTALL_LOCKED'
      throw conflict
    }
    throw error
  }
  let settingsBackup
  try {
    const currentNow = parseSettingsDocument(await readOptional(plan.settingsPath, '')).value
    const stateNow = await readState(plan.statePath, plan.settingsPath)
    const currentTextNow = await readOptional(plan.settingsPath, '')
    if (textFingerprint(currentTextNow) !== plan.currentFingerprint || fingerprint(stateNow) !== plan.stateFingerprint) {
      const conflict = new Error('target settings changed after the plan was created; re-run dry-run')
      conflict.code = 'CPA_INSTALL_STALE_PLAN'
      throw conflict
    }
    settingsBackup = await atomicReplace(plan.settingsPath, plan.nextText)
    try {
      await atomicReplace(plan.statePath, JSON.stringify(plan.state, null, 2) + '\n')
    } catch (error) {
      if (settingsBackup && existsSync(settingsBackup)) {
        if (existsSync(plan.settingsPath)) await unlink(plan.settingsPath)
        await rename(settingsBackup, plan.settingsPath)
      } else if (existsSync(plan.settingsPath)) await unlink(plan.settingsPath)
      throw error
    }
  } finally {
    try { await unlink(lockPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { ...plan, applied: true }
}

export async function install(options) {
  return applyPlan(await planInstall(options), { dryRun: options?.dryRun !== false })
}

export async function uninstall(options) {
  return applyPlan(await planUninstall(options), { dryRun: options?.dryRun !== false })
}
