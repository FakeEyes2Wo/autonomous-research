import { buildPrompt } from './factory.js'
import type { RoleInput } from './types.js'

export const roleName = 'evidence-agent' as const
export const buildEvidenceAgentPrompt = (input: RoleInput) => buildPrompt(roleName, input)
