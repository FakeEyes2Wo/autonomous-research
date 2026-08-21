import { buildPrompt } from './factory.js'
import type { RoleInput } from './types.js'

export const roleName = 'planner' as const
export const buildPlannerPrompt = (input: RoleInput) => buildPrompt(roleName, input)
