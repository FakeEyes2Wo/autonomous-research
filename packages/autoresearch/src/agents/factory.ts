import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { RoleInput, RoleName } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
const promptsRoot = join(here, '..', '..', 'prompts', 'system')

export async function loadSystemPrompt(role: RoleName): Promise<string> {
  const file = join(promptsRoot, `${role}.md`)
  return readFile(file, 'utf8')
}

export async function buildPrompt(role: RoleName, input: RoleInput): Promise<string> {
  const system = await loadSystemPrompt(role)
  const sections = [`# Role: ${role}`, '', system, '', '## Input', '']
  if (input.candidate) sections.push('### Candidate', '', input.candidate, '')
  if (input.profile) sections.push('### PROFILE', '', input.profile, '')
  if (input.rubric) sections.push('### RUBRIC', '', input.rubric, '')
  if (input.plan) sections.push('### Plan', '', input.plan, '')
  if (input.treeSummary) sections.push('### ResearchTree', '', input.treeSummary, '')
  if (input.evidenceChainPath) sections.push('### evidence_chain.json', '', input.evidenceChainPath, '')
  if (input.ideaPackage) sections.push('### Idea Package', '', input.ideaPackage, '')
  if (input.paperPlan) sections.push('### PAPER_PLAN', '', input.paperPlan, '')
  if (input.paperMatrix) sections.push('### Claims-Evidence Matrix', '', input.paperMatrix, '')
  if (input.paperTemplate) sections.push('### ICLR Template', '', input.paperTemplate, '')
  if (input.paperContract) sections.push('### PAPER_ACCEPTANCE_CONTRACT', '', input.paperContract, '')
  if (input.paperFigures) sections.push('### FIGURES / latex_includes.tex', '', input.paperFigures, '')
  if (input.styleProfile) sections.push('### Style Profile', '', input.styleProfile, '')
  if (input.venue) sections.push('### Venue', '', input.venue, '')
  if (input.assurance) sections.push('### Assurance', '', input.assurance, '')
  if (input.paperPath) sections.push('### Paper Directory', '', input.paperPath, '')
  if (input.minimalVerification) sections.push('### Minimal Verification', '', input.minimalVerification, '')
  if (input.experimentDesign) sections.push('### Experiment Design', '', input.experimentDesign, '')
  if (input.reflexion) sections.push('### Reflexion', '', input.reflexion, '')
  if (input.failureDirections) sections.push('### Failure Directions', '', input.failureDirections, '')
  if (input.insight) sections.push('### Insight', '', input.insight, '')
  if (input.modelScout) sections.push('### Model Scout', '', input.modelScout, '')
  sections.push('## Run directory', '', input.runDir, '')
  if (input.cycle !== undefined) sections.push('## Cycle', '', String(input.cycle), '')
  return sections.join('\n')
}

export function outputSchemaFor(role: RoleName): Record<string, unknown> | undefined {
  switch (role) {
    case 'rubric-generator':
      return objectSchema({ rubric: { type: 'string', required: true } })
    case 'rubric-reviewer':
      return objectSchema({
        ok: { type: 'boolean', required: true },
        issues: { type: 'array', items: { type: 'string' }, required: true },
        revised: { type: 'string' },
      })
    case 'idea-generator':
      return objectSchema({
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
      })
    case 'idea-falsifiability':
      return objectSchema({
        testable_implication: { type: 'string', required: true },
        unobservable_variables: { type: 'array', items: { type: 'string' }, required: true },
        is_falsifiable: { type: 'boolean', required: true },
      })
    case 'idea-reviewer':
      return objectSchema({
        perspective: { type: 'string', enum: ['methodology', 'statistics'], required: true },
        critique: { type: 'string', required: true },
        unaddressed_risks: { type: 'array', items: { type: 'string' }, required: true },
        fatal_flaw_found: { type: 'boolean', required: true },
      })
    case 'hypothesis-reviser':
      return objectSchema({
        summary: { type: 'string', required: true },
        hypotheses: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              statement: { type: 'string', required: true },
              intervention: { type: 'string', required: true },
              expected_effect: { type: 'string', required: true },
              status: { type: 'string', required: true },
              predicted_observations: { type: 'array', items: { type: 'string' } },
              disconfirming_observations: { type: 'array', items: { type: 'string' } },
              sources: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      })
    case 'planner':
      return objectSchema({ plan: { type: 'string', required: true } })
    case 'minimal-verifier':
      return objectSchema({
        feasibility: { type: 'string', enum: ['feasible', 'uncertain', 'infeasible'], required: true },
        minimalEvidence: { type: 'array', items: { type: 'string' }, required: true },
        artifacts: { type: 'array', items: { type: 'string' }, required: true },
        reason: { type: 'string', required: true },
      })
    case 'experiment-designer':
      return objectSchema({
        datasets: { type: 'array', items: { type: 'string' }, required: true },
        conflictConstruction: { type: 'string', required: true },
        splitProtocol: { type: 'string', required: true },
        backbones: { type: 'array', items: { type: 'string' }, required: true },
        metrics: { type: 'array', items: { type: 'string' }, required: true },
        rootCauseValidation: { type: 'string', required: true },
        limitations: { type: 'array', items: { type: 'string' }, required: true },
      })
    case 'experiment-reflexion':
      return objectSchema({
        feasibility: { type: 'string', enum: ['high', 'medium', 'low'], required: true },
        generalizability: { type: 'string', enum: ['high', 'medium', 'low'], required: true },
        risks: { type: 'array', items: { type: 'string' }, required: true },
        failureDirections: { type: 'array', items: { type: 'string' }, required: true },
        verdict: { type: 'string', enum: ['proceed', 'revise'], required: true },
      })
    case 'model-scout':
      return objectSchema({
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
      })
    case 'result-reflexion':
      return objectSchema({
        summary: { type: 'string', required: true },
        failureAnalysis: { type: 'string', required: true },
        explorationDirections: { type: 'array', items: { type: 'string' }, required: true },
      })
    case 'insight-abstractor':
      return objectSchema({
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
      })
    case 'research-worker':
      return objectSchema({
        status: { type: 'string', enum: ['completed', 'failed'], required: true },
        summary: { type: 'string', required: true },
        artifacts: { type: 'array', items: { type: 'string' }, required: true },
      })
    case 'evidence-agent':
      return objectSchema({ summary: { type: 'string', required: true } })
    case 'supervisor':
      return objectSchema({
        action: { type: 'string', enum: ['continue', 'revise', 'finish', 'fail'], required: true },
        reason: { type: 'string', required: true },
      })
    case 'writer':
      return objectSchema({
        mainTex: { type: 'string', required: true },
        bib: { type: 'string' },
        sections: { type: 'object', additionalProperties: true },
        failureReport: { type: 'string', required: true },
      })
    case 'paper-planner':
      return objectSchema({
        plan: { type: 'string', required: true },
        figures: { type: 'array', items: { type: 'string' } },
        citations: { type: 'array', items: { type: 'string' } },
      })
    case 'contract-negotiator':
      return objectSchema({
        contract: { type: 'string', required: true },
      })
    case 'contract-reviewer':
      return objectSchema({
        accepted: { type: 'boolean', required: true },
        demands: { type: 'array', items: { type: 'string' }, required: true },
      })
    case 'figure-generator':
      return objectSchema({
        scripts: { type: 'object', additionalProperties: true, required: true },
        latexIncludes: { type: 'string' },
        notes: { type: 'string' },
      })
    case 'figure-reflexion':
      return objectSchema({
        verdict: { type: 'string', enum: ['pass', 'revise'], required: true },
        issues: { type: 'array', items: { type: 'string' }, required: true },
        textOverload: { type: 'boolean', required: true },
        elementOverload: { type: 'boolean', required: true },
        elementOverlap: { type: 'boolean', required: true },
      })
    case 'proof-checker':
      return objectSchema({
        verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
        issues: { type: 'array', items: { type: 'string' }, required: true },
        json: { type: 'string' },
      })
    case 'claim-auditor':
      return objectSchema({
        verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
        issues: { type: 'array', items: { type: 'string' }, required: true },
        json: { type: 'string' },
      })
    case 'citation-auditor':
      return objectSchema({
        verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
        entries: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        issues: { type: 'array', items: { type: 'string' }, required: true },
        json: { type: 'string' },
      })
    case 'kill-argument-reviewer':
      return objectSchema({
        verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR'], required: true },
        reason_code: { type: 'string' },
        memo: { type: 'string', required: true },
        json: { type: 'string' },
      })
    case 'paper-reviewer':
      return objectSchema({
        score: { type: 'number', required: true },
        critical: { type: 'array', items: { type: 'string' }, required: true },
        major: { type: 'array', items: { type: 'string' }, required: true },
        minor: { type: 'array', items: { type: 'string' }, required: true },
      })
    case 'paper-polisher':
      return objectSchema({
        mainTex: { type: 'string', required: true },
        sections: { type: 'object', additionalProperties: true },
        changes: { type: 'array', items: { type: 'string' }, required: true },
      })
    case 'final-report-writer':
      return objectSchema({
        report: { type: 'string', required: true },
      })
    default:
      return undefined
  }
}

function objectSchema(properties: Record<string, unknown>, required?: string[]): Record<string, unknown> {
  const requiredList = required ?? Object.entries(properties).filter(([, value]) => (value as { required?: boolean }).required).map(([key]) => key)
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    clean[key] = cleanSchemaNode(value)
  }
  return { type: 'object', properties: clean, required: requiredList, additionalProperties: false }
}

// Recursively strip boolean `required` shorthand flags from nested schema nodes
// (invalid JSON Schema: `required` is only a valid keyword on objects, as an
// array of property names) and promote them to a proper `required` array on the
// enclosing object that declares `properties`.
function cleanSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchemaNode)
  if (typeof node !== 'object' || node === null) return node
  const record = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'required') continue
    out[key] = cleanSchemaNode(value)
  }
  if (typeof record.properties === 'object' && record.properties !== null) {
    const requiredList = Object.entries(record.properties as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'object' && v !== null && (v as { required?: boolean }).required === true)
      .map(([k]) => k)
    if (requiredList.length > 0) out.required = requiredList
  }
  return out
}
