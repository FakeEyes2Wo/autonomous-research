import type { ProjectSettings } from '../settings/schema.js'
import type { CurrentIdeaIdentity } from '../literature/discovery/contracts.js'
import type { ResearchSnapshot, RevisionCandidate } from './contracts.js'

type IdeaSelectionInput = {
  intakeIdea: string
  profile: string
  snapshot?: Pick<ResearchSnapshot, 'active_hypothesis' | 'hypotheses' | 'decision'>
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : []

export function selectCurrentIdea(input: IdeaSelectionInput): CurrentIdeaIdentity {
  const active = input.snapshot?.active_hypothesis
  const hypothesis = active && input.snapshot?.hypotheses?.find(item => item.id === active.id && item.version === active.version)
  const candidate: RevisionCandidate | undefined = input.snapshot?.decision?.candidate
  const source = hypothesis ? 'current-hypothesis' : candidate ? 'revision' : 'given-idea'
  const selected = hypothesis ?? candidate
  return {
    statement: text(selected?.statement) || text(input.intakeIdea), profile: input.profile.trim(),
    scope: text(selected?.scope), mechanism: text(selected?.mechanism), prediction: text(selected?.prediction),
    falsification: text(selected?.falsification), measurement: text(selected?.measurement), decisionRule: text(selected?.decision_rule),
    alternatives: list(selected?.alternatives), assumptions: [], terminology: [], crossDomainAnalogs: [], source,
  }
}

function policyToggle(value: unknown): 'enabled' | 'never' | undefined {
  return value === 'enabled' || value === 'never' ? value : undefined
}

export function effectiveCurrentIdeaSearch(
  settings: ProjectSettings,
  policySnapshot?: unknown,
  existingRun = false,
): 'enabled' | 'never' {
  const workflow = policySnapshot && typeof policySnapshot === 'object' ? (policySnapshot as { workflow?: unknown }).workflow : undefined
  const field = workflow && typeof workflow === 'object' ? policyToggle((workflow as { currentIdeaSearch?: unknown }).currentIdeaSearch) : undefined
  if (workflow && typeof workflow === 'object' && field === undefined) return 'never'
  if (existingRun && field === undefined) return 'never'
  return field ?? settings.workflow.currentIdeaSearch
}
