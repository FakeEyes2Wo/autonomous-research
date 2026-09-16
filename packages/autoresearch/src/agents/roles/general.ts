import type { RoleSpec } from './types.js'
import { objectSchema } from '../schema.js'

/**
 * General/cross-cutting roles that don't belong to a single domain.
 * Put any hard-to-classify future role here instead of forcing it into
 * brainstorm/research/paper.
 */
export const generalRoleSpecs = {
  planner: {
    sections: ['idea', 'profile', 'rubric', 'plan', 'runtimeConstraints', 'treeSummary'],
    outputSchema: objectSchema({
      plan: { type: 'string', required: true },
      riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
      hypothesis: { type: 'object', additionalProperties: true },
      protocol: { type: 'object', additionalProperties: true },
    }),
  },
  'minimal-verifier': {
    sections: ['plan', 'treeSummary'],
    outputSchema: objectSchema({
      feasibility: { type: 'string', enum: ['feasible', 'uncertain', 'infeasible'], required: true },
      minimalEvidence: { type: 'array', items: { type: 'string' }, required: true },
      artifacts: { type: 'array', items: { type: 'string' }, required: true },
      reason: { type: 'string', required: true },
    }),
  },
  'research-worker': {
    sections: ['plan', 'treeSummary', 'minimalVerification', 'experimentDesign'],
    outputSchema: objectSchema({
      status: { type: 'string', enum: ['completed', 'failed'], required: true },
      summary: { type: 'string', required: true },
      artifacts: { type: 'array', items: { type: 'string' }, required: true },
    }),
  },
  'evidence-agent': {
    sections: ['plan', 'treeSummary'],
    outputSchema: objectSchema({ summary: { type: 'string', required: true } }),
  },
  supervisor: {
    sections: ['rubric', 'plan', 'treeSummary', 'reflexion'],
    outputSchema: objectSchema({
      action: { type: 'string', enum: ['continue', 'revise', 'finish', 'fail'], required: true },
      reason: { type: 'string', required: true },
      candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }),
  },
} satisfies Record<string, RoleSpec>
