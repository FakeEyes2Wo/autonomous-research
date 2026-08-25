import type { RoleInput } from '../types.js'
import type { JsonSchema } from '../schema.js'

/**
 * All role-specific knowledge lives here as plain data.
 * `sections` controls prompt rendering order; `outputSchema` controls structured output.
 */
export interface RoleSpec {
  readonly sections: readonly (keyof RoleInput)[]
  readonly outputSchema?: JsonSchema
}
