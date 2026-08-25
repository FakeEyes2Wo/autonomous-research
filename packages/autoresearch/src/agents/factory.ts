import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { RoleInput, RoleName } from './types.js'
import type { JsonSchema } from './schema.js'
import { roleSpecs } from './roles/index.js'
import { researchSectionTitles } from './roles/research.js'
import { brainstormSectionTitles } from './roles/brainstorm.js'
import { paperSectionTitles } from './roles/paper.js'

const here = dirname(fileURLToPath(import.meta.url))
const promptsRoot = join(here, '..', '..', 'prompts', 'system')

export async function loadSystemPrompt(role: RoleName): Promise<string> {
  const file = join(promptsRoot, `${role}.md`)
  return readFile(file, 'utf8')
}

const COMMON_SECTION_TITLES = {
  plan: 'Plan',
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
  if (input.cycle !== undefined) {
    sections.push('## Cycle', '', String(input.cycle))
  }
  return sections.join('\n')
}

export function outputSchemaFor(role: RoleName): JsonSchema | undefined {
  return roleSpecs[role]?.outputSchema
}
