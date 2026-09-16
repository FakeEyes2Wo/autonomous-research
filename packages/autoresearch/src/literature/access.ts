import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { assertDocumentVersion, assertHash, type Catalog, type DocumentVersion, type Visibility } from './contracts.js'

/** Shared project-owned location for CLI, context assembly, and Web services. */
export function resolveLiteratureRoot(projectRoot: string): string {
  return resolve(canonicalLiteratureProjectId(projectRoot), '.autoresearch', 'literature')
}

/** Use the trusted existing project directory, never a browser-supplied project ID or path. */
export function canonicalLiteratureProjectId(projectRoot: string): string {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) throw new TypeError('projectRoot is required')
  return realpathSync.native(resolve(projectRoot))
}

export interface AccessScope {
  projectId: string; runId: string; role: string; policyHash: string
  partitionIds: string[]; split?: string
}

export function validateScope(scope: AccessScope): void {
  for (const key of ['projectId', 'runId', 'role'] as const) {
    if (typeof scope[key] !== 'string' || !scope[key].trim()) throw new TypeError(`${key} is required`)
  }
  assertHash(scope.policyHash, 'policyHash')
  if (!Array.isArray(scope.partitionIds) || scope.partitionIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new TypeError('partitionIds must contain non-empty strings')
  }
  if (scope.split !== undefined && (typeof scope.split !== 'string' || !scope.split.trim())) throw new TypeError('invalid split')
}

export function visibilityAllows(visibility: Visibility, scope: AccessScope): boolean {
  return visibility.projectId === scope.projectId && visibility.policyHash === scope.policyHash &&
    scope.partitionIds.includes(visibility.partitionId) && visibility.roles.includes(scope.role) &&
    (visibility.runId === undefined || visibility.runId === scope.runId) &&
    (visibility.split === undefined || visibility.split === scope.split)
}

/** Current catalog access is checked independently from immutable index visibility. */
export async function authorizedDocuments(catalog: Catalog, scope: AccessScope): Promise<DocumentVersion[]> {
  validateScope(scope)
  const [documents = [], events = []] = await catalog.transact([
    { sql: 'SELECT body FROM documents ORDER BY id', params: [] },
    { sql: "SELECT document_id FROM source_events WHERE json_extract(body,'$.kind') = 'access_revoked'", params: [] },
  ])
  const revoked = new Set(events.map(row => String(row.document_id)))
  return documents.map(row => assertDocumentVersion(JSON.parse(String(row.body))))
    .filter(document => !revoked.has(document.id) && visibilityAllows(document.visibility, scope))
}
