import type { ToolDefinitionLike, ToolExecutionContextLike } from '../tools/index.js'
import { abandonDirection, advanceCleanupQueue } from './index.js'
import { loadDirectionManifest } from './manifest.js'
import { directionId, type DirectionRef } from './direction-id.js'
import { listCleanupTasks } from './queue.js'

const output = { schema: { type: 'object' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const required = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${key} is required`)
  return value
}

/** Harness registration seam; the service remains the automatic caller. */
export function createCleanupTools(): { status: ToolDefinitionLike; abandon: ToolDefinitionLike } {
  const status: ToolDefinitionLike = {
    name: 'research_cleanup_status',
    description: 'Show compact resumable direction cleanup task status.',
    parameters: { type: 'object', properties: { projectDir: { type: 'string' } }, required: ['projectDir'], additionalProperties: false },
    output,
    async execute(args: Record<string, unknown>, _exec: ToolExecutionContextLike) {
      const tasks = await listCleanupTasks(required(args, 'projectDir'))
      return { tasks: tasks.map(task => ({ id: task.id, directionId: task.directionId, state: task.state, attempts: task.attempts ?? 0, lastError: task.lastError })) }
    },
  }
  const abandon: ToolDefinitionLike = {
    name: 'research_direction_abandon',
    description: 'Explicitly abandon a direction and enqueue its registered exclusive artifacts for cleanup.',
    parameters: { type: 'object', properties: { projectDir: { type: 'string' }, runDir: { type: 'string' }, direction: { type: 'object', properties: { projectId: { type: 'string' }, branchId: { type: 'string' }, claim: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer', minimum: 1 } }, required: ['id', 'version'], additionalProperties: false }, hypothesis: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer', minimum: 1 } }, required: ['id', 'version'], additionalProperties: false }, protocolHash: { type: 'string' } }, required: ['projectId', 'branchId', 'claim', 'hypothesis'], additionalProperties: false }, idea: { type: 'string' }, reason: { type: 'string' }, avoidRepeat: { type: 'string' } }, required: ['projectDir', 'runDir', 'direction', 'idea', 'reason', 'avoidRepeat'], additionalProperties: false },
    output,
    async execute(args: Record<string, unknown>, _exec: ToolExecutionContextLike) {
      const direction = args.direction as DirectionRef
      const id = directionId(direction)
      let manifest
      try { manifest = await loadDirectionManifest(required(args, 'runDir'), id) } catch { manifest = undefined }
      const task = await abandonDirection({ projectDir: required(args, 'projectDir'), runDir: required(args, 'runDir'), direction, idea: required(args, 'idea'), reason: required(args, 'reason'), avoidRepeat: required(args, 'avoidRepeat'), ...(manifest ? { manifestId: manifest.id, manifestHash: manifest.contentHash, targets: manifest.artifacts.filter(artifact => artifact.ownership === 'direction') } : {}) })
      await advanceCleanupQueue(required(args, 'projectDir'))
      return { id: task.id, state: (await listCleanupTasks(required(args, 'projectDir'))).find(item => item.id === task.id)?.state ?? task.state }
    },
  }
  return { status, abandon }
}
