import type { RoleSpec } from './types.js'
import { generalRoleSpecs } from './general.js'
import { brainstormRoleSpecs } from './brainstorm.js'
import { researchRoleSpecs } from './research.js'
import { paperRoleSpecs } from './paper.js'
import { projectRoleSpecs } from './project.js'

/**
 * Single flat registry. Adding/removing a role is a one-line change in the
 * matching domain module.
 */
export const roleSpecs = {
  ...generalRoleSpecs,
  ...brainstormRoleSpecs,
  ...researchRoleSpecs,
  ...paperRoleSpecs,
  ...projectRoleSpecs,
} as const satisfies Record<string, RoleSpec>

export type RoleName = keyof typeof roleSpecs
export const roleNames = Object.freeze(Object.keys(roleSpecs) as RoleName[])
