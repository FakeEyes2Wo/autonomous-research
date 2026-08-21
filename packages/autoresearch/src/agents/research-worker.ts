import { buildPrompt } from './factory.js'
import type { RoleInput } from './types.js'

export const roleName = 'research-worker' as const
export const buildResearchWorkerPrompt = (input: RoleInput) => buildPrompt(roleName, input)
