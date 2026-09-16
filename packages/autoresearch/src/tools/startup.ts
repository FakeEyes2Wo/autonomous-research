import { isAbsolute, resolve } from 'node:path'
import type { ToolDefinitionLike } from './index.js'
import type { SessionCwdResolver } from './workspace-paths.js'
import { jsonOutput, stringSchema } from './schemas.js'
import { prepareStartup, type StartupIntent } from '../startup/prepare.js'

const EXECUTION_TOOLS = new Set(['research_run', 'project_paper_run', 'experiment_run', 'paper_pipeline_resume'])

/** Session hints are private to this plugin instance and are always verified on disk. */
export function createStartupTools(sessionCwd: SessionCwdResolver): {
  prepare: ToolDefinitionLike
  track: (tool: ToolDefinitionLike) => ToolDefinitionLike
} {
  const sessionRuns = new Map<string, string>()
  const prepare: ToolDefinitionLike = {
    name: 'research_prepare',
    description: 'Read-only startup routing: verify the intended workflow and project/run identity, resolve resume in the current session or project, and return the next existing tool action. Never starts models, creates runs or changes budgets. Use before starting or continuing research.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['project-paper', 'research', 'experiment', 'resume', 'ambiguous'], description: 'Interpret the user request: paper from existing project, new research, standalone experiment, continue existing run, or unclear. Source files alone do not determine intent.' },
        projectDir: stringSchema('Project root; defaults to the calling session workspace. Relative paths resolve from that workspace.'),
        runDir: stringSchema('Explicit output directory for a new task, or selected existing run for resume. Choose a new directory once; never change it to bypass a pause.'),
        task: stringSchema('Exact user task for a new standalone experiment. Resume uses the saved experiment inputs.'),
      },
      required: ['intent'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(args, exec) {
      if (!exec.agent || typeof exec.agent.id !== 'string') throw new TypeError('research_prepare requires a calling DSH agent')
      const cwd = sessionCwd(exec.agent.id)
      function path(value: unknown, key: string, defaultToCwd = false): string | undefined {
        if (value === undefined && !defaultToCwd) return undefined
        if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new TypeError(`${key} must be a non-empty path`)
        if (typeof value === 'string' && isAbsolute(value)) return resolve(value)
        if (!cwd || !isAbsolute(cwd)) throw new TypeError(`calling session working directory is unavailable for ${key}`)
        return resolve(cwd, typeof value === 'string' ? value : '.')
      }
      const projectDir = path(args.projectDir, 'projectDir', true)!
      const runDir = path(args.runDir, 'runDir')
      if (args.task !== undefined && typeof args.task !== 'string') throw new TypeError('task must be a string')
      return prepareStartup({ intent: args.intent as StartupIntent, projectDir, runDir, task: args.task as string | undefined }, {
        sessionRunDir: sessionRuns.get(exec.agent.id),
      })
    },
  }
  return {
    prepare,
    track(tool) {
      if (!EXECUTION_TOOLS.has(tool.name)) return tool
      return {
        ...tool,
        async execute(args, exec) {
          const result = await tool.execute(args, exec)
          if (exec.agent && result && typeof result === 'object' && 'runDir' in result && typeof result.runDir === 'string' && isAbsolute(result.runDir)) {
            sessionRuns.set(exec.agent.id, result.runDir)
          }
          return result
        },
      }
    },
  }
}
