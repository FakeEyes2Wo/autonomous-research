import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { RoleInput, RoleName } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
const promptsRoot = join(here, '..', '..', 'prompts', 'system')

export async function loadSystemPrompt(role: RoleName): Promise<string> {
  const file = join(promptsRoot, `${role}.md`)
  return readFile(file, 'utf8')
}

export async function buildPrompt(role: RoleName, input: RoleInput): Promise<string> {
  const system = await loadSystemPrompt(role)
  const sections = [`# Role: ${role}`, '', system, '', '## Input', '']
  if (input.candidate) sections.push('### Candidate', '', input.candidate, '')
  if (input.profile) sections.push('### PROFILE', '', input.profile, '')
  if (input.rubric) sections.push('### RUBRIC', '', input.rubric, '')
  if (input.plan) sections.push('### Plan', '', input.plan, '')
  if (input.treeSummary) sections.push('### ResearchTree', '', input.treeSummary, '')
  if (input.evidenceChainPath) sections.push('### evidence_chain.json', '', input.evidenceChainPath, '')
  sections.push('## Run directory', '', input.runDir, '')
  if (input.cycle !== undefined) sections.push('## Cycle', '', String(input.cycle), '')
  return sections.join('\n')
}

export function outputSchemaFor(role: RoleName): Record<string, unknown> | undefined {
  switch (role) {
    case 'rubric-generator':
      return objectSchema({ rubric: { type: 'string', required: true } })
    case 'rubric-reviewer':
      return objectSchema({
        ok: { type: 'boolean', required: true },
        issues: { type: 'array', items: { type: 'string' }, required: true },
        revised: { type: 'string' },
      })
    case 'planner':
      return objectSchema({ plan: { type: 'string', required: true } })
    case 'research-worker':
      return objectSchema({
        status: { type: 'string', enum: ['completed', 'failed'], required: true },
        summary: { type: 'string', required: true },
        artifacts: { type: 'array', items: { type: 'string' }, required: true },
      })
    case 'evidence-agent':
      return objectSchema({ summary: { type: 'string', required: true } })
    case 'supervisor':
      return objectSchema({
        action: { type: 'string', enum: ['continue', 'revise', 'finish', 'fail'], required: true },
        reason: { type: 'string', required: true },
      })
    case 'writer':
      return objectSchema({ summary: { type: 'string', required: true } })
    default:
      return undefined
  }
}

function objectSchema(properties: Record<string, unknown>, required?: string[]): Record<string, unknown> {
  const requiredList = required ?? Object.entries(properties).filter(([, value]) => (value as { required?: boolean }).required).map(([key]) => key)
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    const { required: _omit, ...rest } = value as { required?: boolean } & Record<string, unknown>
    clean[key] = rest
  }
  return { type: 'object', properties: clean, required: requiredList, additionalProperties: false }
}
