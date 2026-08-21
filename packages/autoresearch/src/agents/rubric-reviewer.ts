import { buildPrompt } from './factory.js'
import type { RoleInput } from './types.js'

export const roleName = 'rubric-reviewer' as const
export const buildRubricReviewerPrompt = (input: RoleInput) => buildPrompt(roleName, input)
