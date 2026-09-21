import type { RoleSpec } from './types.js'
import { objectSchema } from '../schema.js'

/**
 * General/cross-cutting roles that don't belong to a single domain.
 * Put any hard-to-classify future role here instead of forcing it into
 * brainstorm/research/paper.
 */
export const generalRoleSpecs = {
  'idea-query-planner': {
    sections: ['idea', 'profile', 'plan'],
    outputSchema: objectSchema({
      queries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        text: { type: 'string', required: true },
        dimensions: { type: 'array', required: true, items: { type: 'string', enum: ['problem', 'mechanism', 'assumption', 'terminology', 'cross-domain'] } },
      } } },
    }),
  },
  'idea-similarity-reviewer': {
    sections: ['idea', 'profile', 'plan'],
    outputSchema: objectSchema({
      assessments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        candidateId: { type: 'string', required: true },
        overlap: { type: 'array', required: true, items: { type: 'string' } },
        differences: { type: 'array', required: true, items: { type: 'string' } },
        uncertainty: { type: 'array', required: true, items: { type: 'string' } },
        relevance: { type: 'string', required: true, enum: ['nearest', 'related', 'weak', 'uncertain'] },
        excerptProofs: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        followupQueries: { type: 'array', required: true, items: { type: 'string' } },
        citationSeeds: { type: 'array', required: true, items: { type: 'string' } },
      } } },
    }),
  },
  planner: {
    sections: ['idea', 'profile', 'rubric', 'plan', 'runtimeConstraints', 'treeSummary'],
    outputSchema: objectSchema({
      plan: { type: 'string', required: true },
      riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
      hypothesis: { type: 'object', additionalProperties: true },
      protocol: { type: 'object', additionalProperties: true },
      taskGraph: { type: 'object', additionalProperties: true },
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
