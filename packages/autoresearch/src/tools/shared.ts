import type { ResearchTree } from '../core/research-tree.js'
import { ResearchTree as ResearchTreeImpl } from '../core/research-tree.js'
import type { ToolDefinitionLike } from './types.js'

export function requireRunDir(args: Record<string, unknown>): string {
  const value = args.runDir
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('runDir is required')
  }
  return value
}

export async function loadTree(runDir: string): Promise<ResearchTree> {
  return ResearchTreeImpl.load(runDir)
}

export function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function defineTool(def: ToolDefinitionLike): ToolDefinitionLike {
  return def
}
