import type { RoleSpec } from './types.js'
import { objectSchema } from '../schema.js'

/**
 * Brainstorm input section headings.
 */
export const brainstormSectionTitles = {
  perspective: 'Perspective',
} as const

/**
 * Brainstorm pre-phase roles: mine papers, write paper wikis, and generate/refine
 * research idea directions. These are intentionally decoupled from the
 * research loop and paper-writing pipeline.
 */
export const brainstormRoleSpecs = {
  'paper-survey': {
    sections: ['plan'],
    outputSchema: objectSchema({
      overview: { type: 'string', required: true },
      surveys: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
      },
      clusters: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
      },
      papers: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
      },
    }),
  },
  'direction-select': {
    sections: ['plan'],
    outputSchema: objectSchema({
      directions: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
      },
      selectedId: { type: 'string', required: true },
      backups: {
        type: 'array',
        required: true,
        items: { type: 'string' },
      },
    }),
  },
  'paper-frontier-miner': {
    sections: ['plan'],
    outputSchema: objectSchema({
      papers: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
      },
    }),
  },
  'paper-wiki-writer': {
    sections: ['plan'],
    outputSchema: objectSchema({
      wikis: { type: 'object', additionalProperties: true, required: true },
    }),
  },
  brainstorm: {
    sections: ['plan', 'perspective'],
    outputSchema: objectSchema({
      directions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      attack: { type: 'array', items: { type: 'string' } },
      support: { type: 'array', items: { type: 'string' } },
      revisedDirection: { type: 'string' },
      scores: { type: 'array', items: { type: 'object', additionalProperties: true } },
      selectedId: { type: 'string' },
      ideaMd: { type: 'string' },
    }),
  },
} satisfies Record<string, RoleSpec>
