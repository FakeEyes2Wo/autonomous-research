import { buildPrompt } from './factory.js'
import type { RoleInput } from './types.js'

export const roleName = 'supervisor' as const
export const buildSupervisorPrompt = (input: RoleInput) => buildPrompt(roleName, input)
