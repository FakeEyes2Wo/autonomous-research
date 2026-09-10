import { isAbsolute, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinitionLike, ToolExecutionContextLike } from './index.js'

export type SessionCwdResolver = (agentId: Agent['id']) => string | undefined

const WORKSPACE_PATH_KEYS = ['runDir', 'projectDir'] as const

export function bindToolWorkspacePaths(tool: ToolDefinitionLike, sessionCwd: SessionCwdResolver): ToolDefinitionLike {
  return {
    ...tool,
    async execute(args, exec) {
      return tool.execute(resolveWorkspacePaths(args, exec, sessionCwd), exec)
    },
  }
}

function resolveWorkspacePaths(
  args: Record<string, unknown>,
  exec: ToolExecutionContextLike,
  sessionCwd: SessionCwdResolver,
): Record<string, unknown> {
  const relativeKeys = WORKSPACE_PATH_KEYS.filter((key) => typeof args[key] === 'string' && args[key].length > 0 && !isAbsolute(args[key]))
  if (relativeKeys.length === 0 || !exec.agent) return args

  const cwd = sessionCwd(exec.agent.id)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new TypeError(`calling session working directory is unavailable for relative ${relativeKeys.join('/')} path`)
  }

  const resolved = { ...args }
  for (const key of relativeKeys) resolved[key] = resolve(cwd, args[key] as string)
  return resolved
}
