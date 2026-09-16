import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { API_PREFIX } from './contract.js';
import { resolveSettingsService, resolveLiteratureService } from './core-bridge.js';
import { createLiterature } from './literature.js';
import { createWorkbench } from './workbench.js';
import { registerWorkbenchAssets } from './workbench-assets.js';
import { createProjectRegistry } from './workspace-projects.js';

const MAX_BODY_BYTES = 512 * 1024;
function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(body);
}

function error(res, status, code, message, details) {
  json(res, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
}

function serviceUnavailable(res) {
  error(res, 503, 'core_settings_service_unavailable',
    'The AutoResearch core settings service is not attached to this DSH process. No file was changed.');
}

function getSettingsService(ctx) {
  const service = typeof ctx.get === 'function' ? ctx.get('autoresearchSettings') : ctx.autoresearchSettings;
  if (!service || typeof service !== 'object') return undefined;
  for (const method of ['readProjectSettingsDocument', 'validateProjectSettingsCandidate', 'patchProjectSettingsDocument']) {
    if (typeof service[method] !== 'function') return undefined;
  }
  return service;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body is too large'), { code: 'body_too_large' });
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { code: 'invalid_json' });
  }
}

function loopback(req) {
  const address = req.socket?.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function localHostHeader(req) {
  const host = String(req.headers.host ?? '');
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function sameOrigin(req, csrfToken) {
  if (!loopback(req) || !localHostHeader(req)) return false;
  const origin = req.headers.origin;
  const write = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE';
  if (write && !origin) return false;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const host = String(req.headers.host ?? '');
      if (parsed.host !== host || parsed.protocol !== 'http:') return false;
    } catch {
      return false;
    }
  }
  if (write && req.headers['x-autoresearch-csrf'] !== csrfToken) return false;
  return true;
}

function publicProject(project) {
  return { id: project.id, name: project.name, workspaceId: project.workspaceId };
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(`${label} must be an object`), { code: 'invalid_request' });
}

/**
 * Install the optional local-only API and expose the browser settings section.
 * The core package owns project file reads/writes. If it is not attached this
 * route returns a visible 503 rather than falling back to an unreviewed file
 * writer or pretending that a save succeeded.
 */
export async function apply(ctx, config = {}) {
  if (!ctx?.webServer?.register) throw new Error('autoresearch-web requires the DSH webServer service');
  const registry = createProjectRegistry(ctx, config);
  const service = getSettingsService(ctx) ?? await resolveSettingsService(ctx);
  const literatureService = await resolveLiteratureService(ctx);
  const literature = literatureService ? createLiterature({ ...literatureService, getProject: registry.find }) : null;
  const csrfToken = randomBytes(24).toString('hex');
  const workbench = createWorkbench({ ...config, projects: [] }, { getProject: registry.find });

  const disposeApi = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!sameOrigin(req, csrfToken)) return error(res, 403, 'same_origin_or_csrf_required', 'Only loopback same-origin requests with a valid CSRF token are accepted.');
      let requestUrl;
      try {
        requestUrl = new URL(req.url ?? API_PREFIX, `http://${req.headers.host ?? '127.0.0.1'}`);
      } catch {
        return error(res, 400, 'invalid_url', 'The request URL or Host header is invalid.');
      }
      const pathname = requestUrl.pathname;
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('cache-control', 'no-store');
        return res.end();
      }
      if (pathname === `${API_PREFIX}/projects` && req.method === 'GET') {
        return json(res, 200, { projects: (await registry.list()).map(publicProject), serviceAttached: service !== undefined, csrfToken });
      }
      if (await workbench.handle(req, res)) return;
      if (pathname.startsWith(`${API_PREFIX}/literature/`)) {
        if (!literature) return error(res, 503, 'core_literature_service_unavailable', 'The core literature service is not attached.');
        if (await literature.handle(req, res)) return;
      }
      if (!service) return serviceUnavailable(res);
      try {
        if (pathname === `${API_PREFIX}/settings` && req.method === 'GET') {
          const project = await registry.find(requestUrl.searchParams.get('projectId'));
          if (!project) return error(res, 404, 'project_not_allowed', 'The project is not in the server allowlist.');
          const result = await service.readProjectSettingsDocument({ projectId: project.id, root: project.root });
          return json(res, 200, { project: publicProject(project), revision: result.revision, document: result.document ?? result.settings });
        }
        if (pathname === `${API_PREFIX}/settings/validate` && req.method === 'POST') {
          if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return error(res, 415, 'json_required', 'This endpoint accepts application/json only.');
          const body = await readBody(req);
          assertObject(body, 'request');
          const project = await registry.find(body.projectId);
          if (!project) return error(res, 404, 'project_not_allowed', 'The project is not in the server allowlist.');
          assertObject(body.candidate, 'candidate');
           const result = await service.validateProjectSettingsCandidate({ projectId: project.id, root: project.root, candidate: body.candidate });
           const response = Array.isArray(result?.errors) ? { ...result, errors: result.errors.map((item) => item?.path && item?.message && !item.message.startsWith(`${item.path}:`) ? { ...item, message: `${item.path}: ${item.message}` } : item) } : result;
           return json(res, 200, response);
        }
        if (pathname === `${API_PREFIX}/settings` && req.method === 'PATCH') {
          if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return error(res, 415, 'json_required', 'This endpoint accepts application/json only.');
          const body = await readBody(req);
          assertObject(body, 'request');
          const project = await registry.find(body.projectId);
          if (!project) return error(res, 404, 'project_not_allowed', 'The project is not in the server allowlist.');
          if ((typeof body.expectedRevision !== 'string' && typeof body.expectedRevision !== 'number') || !Array.isArray(body.operations)) {
            return error(res, 400, 'invalid_patch', 'expectedRevision and operations are required.');
          }
          const result = await service.patchProjectSettingsDocument({
            projectId: project.id,
            root: project.root,
            expectedRevision: body.expectedRevision,
            operations: body.operations
          });
          return json(res, 200, { project: publicProject(project), revision: result.revision, document: result.document ?? result.settings });
        }
        return error(res, 404, 'not_found', 'Unknown AutoResearch API route.');
      } catch (cause) {
        if (cause?.code === 'body_too_large') return error(res, 413, cause.code, cause.message);
        if (cause?.code === 'invalid_json') return error(res, 400, cause.code, cause.message);
        if (cause?.code === 'invalid_request') return error(res, 400, cause.code, cause.message);
        if (cause?.code === 'REVISION_CONFLICT' || cause?.code === 'STALE_REVISION') {
          return error(res, 409, 'revision_conflict', 'The project changed elsewhere. Reload before saving.', cause.details);
        }
        // Do not leak filesystem paths, keys, or stack traces to the browser.
        return error(res, 500, 'settings_service_error', 'The core settings service rejected the request.');
      }
    }
  });
  const disposeAssets = registerWorkbenchAssets(ctx);
  const dispose = () => { workbench.dispose(); disposeAssets?.(); disposeApi?.(); };
  ctx.effect?.(() => dispose, 'autoresearch-web: project settings and workbench API');
  return dispose;
}

export { API_PREFIX } from './contract.js';
// Cordis resolves this service only after the native web server is present.
// Settings remain optional: the handler reports a visible 503 until the core
// settings bridge is attached.
export const inject = ['webServer'];
