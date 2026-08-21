import { buildPrompt } from './factory.js'
import type { RoleInput } from './types.js'

export const roleName = 'writer' as const
export const buildWriterPrompt = (input: RoleInput) => buildPrompt(roleName, input)
