import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.js';

let core;
try { core = await import('../../../packages/autoresearch/dist/settings/index.js'); } catch { core = undefined; }

test('real autoresearch settings service read → validate → patch → conflict', { skip: !core }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-core-')); const routes = [];
  const webServer = { register(route) { routes.push(route); return () => undefined; } };
  const service = {
    readProjectSettingsDocument: async ({ root: projectDir }) => { const result = await core.readProjectSettingsDocument(projectDir); return { ...result, document: result.settings }; },
    validateProjectSettingsCandidate: async ({ candidate }) => core.validateProjectSettings(candidate),
    patchProjectSettingsDocument: async ({ root: projectDir, expectedRevision, operations }) => { const result = await core.patchProjectSettingsDocument(projectDir, { expectedRevision, ops: operations }); return { ...result, document: result.settings }; }
  };
  await apply({ webServer, autoresearchSettings: service }, { standaloneProjects: true, projects: [{ id: 'core', root }] }); const route = routes[0];
  const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; }, set statusCode(value) { this.code = value; }, get statusCode() { return this.code; } });
  const request = (method, url, body, headers = { host: '127.0.0.1' }) => ({ method, url, headers, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } });
  const projects = response(); await route.handler(request('GET', '/api/autoresearch/projects'), projects); const token = JSON.parse(projects.body).csrfToken;
  const initial = response(); await route.handler(request('GET', '/api/autoresearch/settings?projectId=core'), initial); const initialBody = JSON.parse(initial.body); assert.equal(initial.code, 200); assert.equal(typeof initialBody.revision, 'string');
  const valid = response(); await route.handler(request('POST', '/api/autoresearch/settings/validate', { projectId: 'core', candidate: initialBody.document }, { host: '127.0.0.1', origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-autoresearch-csrf': token }), valid); assert.equal(JSON.parse(valid.body).valid, true);
  const patch = response(); await route.handler(request('PATCH', '/api/autoresearch/settings', { projectId: 'core', expectedRevision: initialBody.revision, operations: [{ op: 'replace', path: '/workflow/mode', value: 'minimal' }] }, { host: '127.0.0.1', origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-autoresearch-csrf': token }), patch); assert.equal(patch.code, 200);
  const conflict = response(); await route.handler(request('PATCH', '/api/autoresearch/settings', { projectId: 'core', expectedRevision: initialBody.revision, operations: [{ op: 'replace', path: '/workflow/mode', value: 'legacy' }] }, { host: '127.0.0.1', origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-autoresearch-csrf': token }), conflict); assert.equal(conflict.code, 409);
});
