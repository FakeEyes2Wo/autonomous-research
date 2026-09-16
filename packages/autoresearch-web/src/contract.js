/**
 * Public host/client contract for the optional AutoResearch settings section.
 * The host is the only owner of filesystem access. The browser sends opaque
 * project IDs and JSON candidates; it never sends a root path or a secret.
 */
export const API_PREFIX = '/api/autoresearch';
export const SETTINGS_NAMESPACE = 'autoresearch-project';

/**
 * A host service supplied by @athena/autoresearch. This package deliberately
 * does not import the core package, so the web surface remains optional.
 *
 * The core package exports direct projectDir functions from its `./settings`
 * entry point. The host adapter converts those calls to this transport shape;
 * `root` is supplied only by the server-side allowlist.
 *
 * @typedef {{
 *   readProjectSettingsDocument(projectDir: string): Promise<{ revision: string|number, settings|document: object }>,
 *   validateProjectSettingsCandidate(candidate: object): { valid: boolean, errors?: Array<object>, warnings?: Array<object> },
 *   patchProjectSettingsDocument(projectDir: string, request: { expectedRevision: string, ops: Array<object> }): Promise<{ revision: string|number, settings|document?: object }>
 * }} ProjectSettingsFunctions
 */

export const ROUTE_CONTRACT = Object.freeze({
  listProjects: `GET ${API_PREFIX}/projects`,
  read: `GET ${API_PREFIX}/settings?projectId=<opaque-id>`,
  validate: `POST ${API_PREFIX}/settings/validate`,
  patch: `PATCH ${API_PREFIX}/settings`,
  literaturePapers: `GET ${API_PREFIX}/literature/papers?projectId=<opaque-id>`,
  literatureSearch: `GET ${API_PREFIX}/literature/search?projectId=<opaque-id>&q=<query>&generationId=<generation-id>`,
  literatureSource: `GET ${API_PREFIX}/literature/source?projectId=<opaque-id>&documentId=<document-id>`,
  literatureSpan: `GET ${API_PREFIX}/literature/span?projectId=<opaque-id>&spanId=<span-id>&generationId=<generation-id>`,
  literatureImport: `POST ${API_PREFIX}/literature/import`,
  literatureIndex: `POST ${API_PREFIX}/literature/index`,
  literatureOperation: `GET ${API_PREFIX}/literature/operations?projectId=<opaque-id>&operationId=<operation-id>`
});
