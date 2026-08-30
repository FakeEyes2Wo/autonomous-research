import type { RoleSpec } from './types.js'
import { objectSchema } from '../schema.js'

/**
 * Research-loop input section headings.
 */
export const researchSectionTitles = {
  idea: 'Idea',
  profile: 'PROFILE',
  rubric: 'RUBRIC',
  treeSummary: 'ResearchTree',
  ideaPackage: 'Idea Package',
  minimalVerification: 'Minimal Verification',
  experimentDesign: 'Experiment Design',
  reflexion: 'Reflexion',
  failureDirections: 'Failure Directions',
  insight: 'Insight',
  modelScout: 'Model Scout',
  relatedPapers: 'Related Papers',
  baselines: 'Baselines',
  revisedIdeaPackage: 'Revised Idea Package',
} as const

/**
 * Research-loop roles: idea/rubric/experiment/reflect.
 */
export const researchRoleSpecs = {
  'rubric-generator': {
    sections: ['idea', 'profile', 'plan', 'treeSummary'],
    outputSchema: objectSchema({ rubric: { type: 'string', required: true } }),
  },
  'idea-generator': {
    sections: ['idea', 'profile', 'plan', 'treeSummary', 'relatedPapers', 'baselines', 'failureDirections', 'insight'],
    outputSchema: objectSchema({
      hypotheses: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            statement: { type: 'string', required: true },
            intervention: { type: 'string', required: true },
            expected_effect: { type: 'string', required: true },
            supported_premises: { type: 'array', items: { type: 'object', additionalProperties: true } },
            inference_chain: { type: 'array', items: { type: 'object', additionalProperties: true } },
            predicted_observations: { type: 'array', items: { type: 'string' }, required: true },
            disconfirming_observations: { type: 'array', items: { type: 'string' }, required: true },
            sources: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      eda_request: { type: 'string' },
    }),
  },
  'idea-reflexion': {
    sections: ['ideaPackage', 'revisedIdeaPackage', 'plan'],
    outputSchema: objectSchema({
      is_falsifiable: { type: 'boolean', required: true },
      testable_implication: { type: 'string', required: true },
      unobservable_variables: { type: 'array', items: { type: 'string' }, required: true },
      critique: { type: 'string', required: true },
      unaddressed_risks: { type: 'array', items: { type: 'string' }, required: true },
      fatal_flaw_found: { type: 'boolean', required: true },
      revised: { type: 'object', additionalProperties: true },
    }),
  },
  'experiment-designer': {
    sections: ['plan', 'treeSummary', 'minimalVerification', 'modelScout', 'reflexion'],
    outputSchema: objectSchema({
      datasets: { type: 'array', items: { type: 'string' }, required: true },
      conflictConstruction: { type: 'string', required: true },
      splitProtocol: { type: 'string', required: true },
      backbones: { type: 'array', items: { type: 'string' }, required: true },
      metrics: { type: 'array', items: { type: 'string' }, required: true },
      rootCauseValidation: { type: 'string', required: true },
      limitations: { type: 'array', items: { type: 'string' }, required: true },
    }),
  },
  'experiment-reflexion': {
    sections: ['plan', 'treeSummary', 'minimalVerification', 'modelScout', 'experimentDesign'],
    outputSchema: objectSchema({
      feasibility: { type: 'string', enum: ['high', 'medium', 'low'], required: true },
      generalizability: { type: 'string', enum: ['high', 'medium', 'low'], required: true },
      risks: { type: 'array', items: { type: 'string' }, required: true },
      failureDirections: { type: 'array', items: { type: 'string' }, required: true },
      verdict: { type: 'string', enum: ['proceed', 'revise'], required: true },
    }),
  },
  'model-scout': {
    sections: ['plan', 'treeSummary'],
    outputSchema: objectSchema({
      models: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            family: { type: 'string', required: true },
            paper: { type: 'string' },
            venue: { type: 'string' },
            year: { type: 'string' },
            why: { type: 'string', required: true },
          },
        },
      },
      sources: { type: 'array', items: { type: 'string' }, required: true },
    }),
  },
  'result-reflexion': {
    sections: ['plan', 'treeSummary', 'experimentDesign'],
    outputSchema: objectSchema({
      summary: { type: 'string', required: true },
      failureAnalysis: { type: 'string', required: true },
      explorationDirections: { type: 'array', items: { type: 'string' }, required: true },
    }),
  },
  'insight-abstractor': {
    sections: ['plan', 'treeSummary', 'experimentDesign', 'failureDirections'],
    outputSchema: objectSchema({
      insights: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            wrongAssumption: { type: 'string', required: true },
            researchQuestion: { type: 'string', required: true },
            methodFamilies: { type: 'array', items: { type: 'string' }, required: true },
            divergencePoint: { type: 'string', required: true },
          },
        },
      },
    }),
  },
} satisfies Record<string, RoleSpec>
