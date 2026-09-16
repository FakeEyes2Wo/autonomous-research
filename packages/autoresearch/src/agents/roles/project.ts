import type { RoleSpec } from './types.js'
import { objectSchema } from '../schema.js'

const text = { type: 'string', required: true }
const strings = { type: 'array', items: { type: 'string' }, required: true }
export const projectRoleSpecs = {
  'project-explorer': {
    sections: ['projectInventory'],
    outputSchema: objectSchema({
      contributions: { type: 'array', minItems: 1, maxItems: 5, required: true, items: { type: 'object', additionalProperties: false, properties: {
        id: text, claim: text, status: { type: 'string', enum: ['observed-implementation', 'proposed'], required: true },
        sourceIds: strings, limitations: strings, validation: strings, researchQuestion: text,
      } } },
      historicalResults: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        statement: text, sourceIds: strings, status: { type: 'string', enum: ['unverified'], required: true },
      } } },
      selectedId: text, selectionReason: text,
    }),
  },
} satisfies Record<string, RoleSpec>
