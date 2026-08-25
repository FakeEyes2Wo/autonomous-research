import type { RoleName } from '../types.js'
import type { RoleSpec } from './types.js'
import { generalRoleSpecs } from './general.js'
import { brainstormRoleSpecs } from './brainstorm.js'
import { researchRoleSpecs } from './research.js'
import { paperRoleSpecs } from './paper.js'

/**
 * Single flat registry. Adding/removing a role is a one-line change in the
 * matching domain module; TypeScript enforces that every RoleName is present.
 */
export const roleSpecs = {
  ...generalRoleSpecs,
  ...brainstormRoleSpecs,
  ...researchRoleSpecs,
  ...paperRoleSpecs,
} satisfies Record<RoleName, RoleSpec>
