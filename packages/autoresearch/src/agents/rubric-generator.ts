import { buildPrompt } from './factory.js'
import type { RoleInput } from './types.js'

export const roleName = 'rubric-generator' as const
export const buildRubricGeneratorPrompt = (input: RoleInput) => buildPrompt(roleName, input)
