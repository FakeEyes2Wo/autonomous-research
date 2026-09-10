import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { RoleInput } from './types.js'
import type { JsonSchema } from './schema.js'
import { roleSpecs } from './roles/index.js'
import type { RoleName } from './roles/index.js'
import { researchSectionTitles } from './roles/research.js'
import { brainstormSectionTitles } from './roles/brainstorm.js'
import { paperSectionTitles } from './roles/paper.js'

const here = dirname(fileURLToPath(import.meta.url))
const promptsRoot = join(here, '..', '..', 'prompts', 'system')
const sharedPromptsRoot = join(here, '..', '..', 'prompts', 'shared')
const pythonGuidanceFile = join(here, '..', '..', 'prompts', 'python_代码规范.md')

const EXPERIMENT_ENGINEERING_ROLES = new Set<RoleName>([
  'planner',
  'research-worker',
  'experiment-designer',
  'experiment-reflexion',
  'minimal-verifier',
  'evidence-agent',
  'supervisor',
])
const PYTHON_GUIDANCE_ROLES = new Set<RoleName>(['research-worker', 'minimal-verifier'])

export async function loadSystemPrompt(role: RoleName): Promise<string> {
  const file = join(promptsRoot, `${role}.md`)
  const files = [file]
  if (EXPERIMENT_ENGINEERING_ROLES.has(role)) files.push(join(sharedPromptsRoot, 'experiment-engineering.md'))
  if (PYTHON_GUIDANCE_ROLES.has(role)) files.push(pythonGuidanceFile)
  return (await Promise.all(files.map((promptFile) => readFile(promptFile, 'utf8')))).join('\n\n')
}

const COMMON_SECTION_TITLES = {
  plan: 'Plan',
  runtimeConstraints: 'Outer AutoResearch runtime constraints',
} as const

const INPUT_SECTION_TITLES: Partial<Record<keyof RoleInput, string>> = {
  ...COMMON_SECTION_TITLES,
  ...researchSectionTitles,
  ...brainstormSectionTitles,
  ...paperSectionTitles,
}

export async function buildPrompt(role: RoleName, input: RoleInput): Promise<string> {
  const spec = roleSpecs[role]
  const system = await loadSystemPrompt(role)
  const sections = [`# Role: ${role}`, '', system, '', '## Input', '']

  for (const key of spec.sections) {
    const value = input[key]
    if (value === undefined) continue
    sections.push(`### ${INPUT_SECTION_TITLES[key] ?? key}`, '', String(value), '')
  }

  sections.push('## Run directory', '', input.runDir)
  if (role === 'research-worker' && input.workDir !== undefined) {
    sections.push('## Work directory', '', input.workDir)
  }
  if (input.cycle !== undefined) {
    sections.push('## Cycle', '', String(input.cycle))
  }
  return sections.join('\n')
}

export function outputSchemaFor(role: RoleName): JsonSchema | undefined {
  return roleSpecs[role]?.outputSchema
}
