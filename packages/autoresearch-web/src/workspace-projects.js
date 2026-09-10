import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const PROJECT_ID = /^[a-z][a-z0-9_-]{0,63}$/

function service(ctx) {
  if (typeof ctx?.get !== 'function') return undefined
  try { return ctx.get('workspaceRegistry') } catch { return undefined }
}

function projectId(workspaceId) {
  return `workspace-${createHash('sha256').update(workspaceId, 'utf8').digest('hex').slice(0, 24)}`
}

function configured(config) {
  const seen = new Set()
  return (Array.isArray(config?.projects) ? config.projects : []).filter((item) => {
    if (!item || typeof item !== 'object' || !PROJECT_ID.test(item.id) || typeof item.root !== 'string' || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  }).map((item) => ({
    id: item.id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id,
    root: resolve(item.root),
    workspaceId: typeof item.workspaceId === 'string' && item.workspaceId ? item.workspaceId : item.id
  }))
}

async function canonical(project) {
  if (!project || typeof project.root !== 'string') return undefined
  try {
    const root = await realpath(project.root)
    if (root !== project.root) return undefined
    return { ...project, root }
  } catch { return undefined }
}

async function nativeProject(workspace) {
  if (!workspace || typeof workspace.id !== 'string' || !workspace.id || typeof workspace.path !== 'string' || !workspace.path) return undefined
  return canonical({ id: projectId(workspace.id), name: typeof workspace.title === 'string' && workspace.title.trim() ? workspace.title.trim() : workspace.id, root: workspace.path, workspaceId: workspace.id })
}

/**
 * Resolve workbench projects from DSH's durable workspace registry. A config
 * allowlist is used only when that native service is unavailable; once the
 * registry is present it is the sole source of projects.
 */
export function createProjectRegistry(ctx, config = {}) {
  let native = service(ctx)
  let hasNative = Boolean(native && (typeof native.list === 'function' || typeof native.get === 'function'))
  const fallback = config?.standaloneProjects === true ? configured(config) : []
  const list = async () => {
    // Cordis may attach optional services after this plugin is constructed.
    // Probe on each request, then latch the first valid native registry so a
    // transient service lookup cannot expose the legacy config again.
    if (!hasNative) {
      const candidate = service(ctx)
      if (candidate && (typeof candidate.list === 'function' || typeof candidate.get === 'function')) {
        native = candidate
        hasNative = true
      }
    }
    if (hasNative) {
      let values
      try { values = typeof native.list === 'function' ? await native.list() : [] } catch { return [] }
      const result = []; const seen = new Set()
      for (const value of Array.isArray(values) ? values : []) {
        const project = await nativeProject(value)
        if (!project || seen.has(project.workspaceId) || result.some((item) => item.root === project.root)) continue
        seen.add(project.workspaceId); result.push(project)
      }
      return result
    }
    const result = []
    for (const value of fallback) {
      const project = await canonical(value)
      if (project) result.push(project)
    }
    return result
  }
  const find = async (id) => {
    if (!PROJECT_ID.test(String(id ?? ''))) return undefined
    return (await list()).find((project) => project.id === id)
  }
  return { list, find, hasNative, projectId }
}

export { PROJECT_ID }
