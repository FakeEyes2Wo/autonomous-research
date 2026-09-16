import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../src/index.js';
import { createProjectRegistry } from '../src/workspace-projects.js';

function fakeServer() {
  const routes = [];
  return { routes, register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } };
}
function response() {
  const chunks = []; return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; }, get statusCode() { return this._status; }, set statusCode(value) { this._status = value; } };
}
function req(method, url, body, headers = { host: '127.0.0.1' }) {
  return { method, url, headers, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
}
async function routeCall(server, method, url, body, headers = { host: '127.0.0.1' }) {
  const result = response(); const route = server.routes.find((item) => url.startsWith(item.path));
  assert.ok(route); await route.handler(req(method, url, body, headers), result);
  return { result, data: result.body ? JSON.parse(result.body) : undefined };
}

test('API uses the installed core settings fallback and never accepts a request path as a project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-')); await mkdir(join(root, 'project'));
  const server = fakeServer();
  await apply({ webServer: server }, { standaloneProjects: true, projects: [{ id: 'demo', name: 'Demo', root: join(root, 'project') }, { id: 'bad path', root }] });
  const route = server.routes[0]; const res = response();
  await route.handler(req('GET', '/api/autoresearch/projects', undefined), res);
  assert.equal(res.statusCode, 200); const data = JSON.parse(res.body); assert.deepEqual(data.projects, [{ id: 'demo', name: 'Demo', workspaceId: 'demo' }]); assert.equal(data.serviceAttached, true);
  const settings = response(); await route.handler(req('GET', '/api/autoresearch/settings?projectId=demo', undefined), settings); assert.equal(settings.statusCode, 200); assert.equal(JSON.parse(settings.body).document.version, 2);
});

test('native workspace registry is the sole dynamic project source', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'autoresearch-web-native-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'autoresearch-web-native-b-'));
  await mkdir(join(rootA, 'paper')); await writeFile(join(rootA, 'paper', 'main.tex'), '% native a\n');
  await mkdir(join(rootB, 'paper')); await writeFile(join(rootB, 'paper', 'main.tex'), '% native b\n');
  let records = [{ id: 'workspace-native-a', path: rootA, title: 'Native A' }];
  const native = { list() { return records; }, get(id) { return records.find((item) => item.id === id); } };
  const ctx = { get(name) { return name === 'workspaceRegistry' ? native : undefined; } };
  const registry = createProjectRegistry(ctx, { projects: [{ id: 'legacy', root: rootB }] });
  const first = await registry.list();
  assert.equal(first.length, 1); assert.equal(first[0].name, 'Native A'); assert.equal(first[0].root, rootA); assert.equal(first[0].workspaceId, 'workspace-native-a');
  assert.equal(first[0].id, registry.projectId('workspace-native-a'));
  records = [{ id: 'workspace-native-a', path: rootB, title: 'Moved Native' }];
  const moved = await registry.find(first[0].id);
  assert.equal(moved.root, rootB); assert.equal(moved.name, 'Moved Native');
  records = [];
  assert.equal(await registry.find(first[0].id), undefined);
});

test('a registry that becomes available after plugin setup never exposes legacy config by default', async () => {
  const fallbackRoot = await mkdtemp(join(tmpdir(), 'autoresearch-web-late-fallback-'));
  const nativeRoot = await mkdtemp(join(tmpdir(), 'autoresearch-web-late-native-'));
  let native;
  let records = [];
  const ctx = { get(name) { return name === 'workspaceRegistry' ? native : undefined; } };
  const registry = createProjectRegistry(ctx, { projects: [{ id: 'legacy', root: fallbackRoot }] });

  assert.deepEqual(await registry.list(), []);
  native = { list() { return records; } };
  records = [{ id: 'late-native', path: nativeRoot, title: 'Late Native' }];
  const projects = await registry.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].workspaceId, 'late-native');
  assert.equal(projects[0].root, nativeRoot);

  records = [];
  assert.deepEqual(await registry.list(), []);
});

test('an explicit standalone host can use configured projects until a native registry appears', async () => {
  const fallbackRoot = await mkdtemp(join(tmpdir(), 'autoresearch-web-standalone-fallback-'));
  const nativeRoot = await mkdtemp(join(tmpdir(), 'autoresearch-web-standalone-native-'));
  let native;
  let records = [];
  const ctx = { get(name) { return name === 'workspaceRegistry' ? native : undefined; } };
  const registry = createProjectRegistry(ctx, { standaloneProjects: true, projects: [{ id: 'standalone', root: fallbackRoot }] });

  assert.deepEqual((await registry.list()).map((item) => item.id), ['standalone']);
  native = { list() { return records; } };
  records = [{ id: 'native', path: nativeRoot, title: 'Native' }];
  const projects = await registry.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].workspaceId, 'native');
  assert.equal(projects[0].root, nativeRoot);

  records = [];
  assert.deepEqual(await registry.list(), []);
});

test('native workspace identity reaches settings and session-target APIs and removal invalidates it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-native-api-'));
  await mkdir(join(root, 'paper')); await writeFile(join(root, 'paper', 'main.tex'), '% native api\n');
  let records = [{ id: 'native-workspace-1', path: root, title: 'Native API' }];
  const native = { list() { return records; }, get(id) { return records.find((item) => item.id === id); } };
  const settings = {
    async readProjectSettingsDocument() { return { revision: 'r1', document: {} }; },
    async validateProjectSettingsCandidate() { return { valid: true, errors: [] }; },
    async patchProjectSettingsDocument() { return { revision: 'r2', document: {} }; }
  };
  const server = fakeServer();
  const ctx = { webServer: server, get(name) { return name === 'workspaceRegistry' ? native : name === 'autoresearchSettings' ? settings : undefined; } };
  const dispose = await apply(ctx, { projects: [{ id: 'legacy', root }] });
  const projects = await routeCall(server, 'GET', '/api/autoresearch/projects');
  assert.deepEqual(projects.data.projects, [{ id: createProjectRegistry(ctx).projectId('native-workspace-1'), name: 'Native API', workspaceId: 'native-workspace-1' }]);
  const id = projects.data.projects[0].id;
  const target = await routeCall(server, 'GET', `/api/autoresearch/workbench/session-target?projectId=${id}`);
  assert.deepEqual(target.data, { projectId: id, workspaceId: 'native-workspace-1', cwd: root });
  const settingsResult = await routeCall(server, 'GET', `/api/autoresearch/settings?projectId=${id}`);
  assert.equal(settingsResult.result.statusCode, 200); assert.equal(settingsResult.data.project.workspaceId, 'native-workspace-1');
  records = [];
  const removed = await routeCall(server, 'GET', '/api/autoresearch/projects');
  assert.deepEqual(removed.data.projects, []);
  const stale = await routeCall(server, 'GET', `/api/autoresearch/settings?projectId=${id}`);
  assert.equal(stale.result.statusCode, 404);
  const staleTarget = await routeCall(server, 'GET', `/api/autoresearch/workbench/session-target?projectId=${id}`);
  assert.equal(staleTarget.result.statusCode, 404);
  dispose();
});

test('API returns 503 when an isolated package has no core settings dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-missing-core-')); await mkdir(join(root, 'project'));
  await mkdir(join(root, 'project', 'paper')); await writeFile(join(root, 'project', 'paper', 'main.tex'), '% isolated workbench\n', 'utf8');
  const isolated = await mkdtemp(join(tmpdir(), 'autoresearch-web-isolated-package-'));
  for (const name of ['index.js', 'contract.js', 'core-bridge.js', 'workbench.js', 'workbench-assets.js', 'workspace-projects.js', 'literature.js']) await copyFile(new URL(`../src/${name}`, import.meta.url), join(isolated, name));
  const isolatedApply = (await import(pathToFileURL(join(isolated, 'index.js')).href)).apply;
  const server = fakeServer(); await isolatedApply({ webServer: server }, { standaloneProjects: true, projects: [{ id: 'demo', name: 'Demo', root: join(root, 'project') }] });
  const route = server.routes[0]; const projects = response(); await route.handler(req('GET', '/api/autoresearch/projects', undefined), projects);
  assert.equal(projects.statusCode, 200); const data = JSON.parse(projects.body); assert.equal(data.serviceAttached, false);
  const documents = response(); await route.handler(req('GET', '/api/autoresearch/workbench/documents?projectId=demo', undefined), documents);
  assert.equal(documents.statusCode, 200); assert.equal(JSON.parse(documents.body).documents.length, 1);
  const created = response(); await route.handler(req('POST', '/api/autoresearch/workbench/documents', { projectId: 'demo' }, { host: '127.0.0.1', origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-autoresearch-csrf': data.csrfToken }), created);
  assert.equal(created.statusCode, 201);
  const unavailable = response(); await route.handler(req('GET', '/api/autoresearch/settings?projectId=demo', undefined), unavailable); assert.equal(unavailable.statusCode, 503);
});

test('same-origin and allowlist checks happen before core writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-')); const server = fakeServer(); let called = false;
  const service = { readProjectSettingsDocument: async () => ({ revision: 1, document: {} }), validateProjectSettingsCandidate: async () => ({ valid: true }), patchProjectSettingsDocument: async () => { called = true; return { revision: 2 }; } };
  await apply({ webServer: server, autoresearchSettings: service }, { standaloneProjects: true, projects: [{ id: 'demo', root }] }); const route = server.routes[0];
  const cross = response(); await route.handler(req('PATCH', '/api/autoresearch/settings', { projectId: 'demo', expectedRevision: 1, operations: [] }, { host: '127.0.0.1', origin: 'https://evil.example' }), cross); assert.equal(cross.statusCode, 403); assert.equal(called, false);
  const missing = response(); await route.handler(req('PATCH', '/api/autoresearch/settings', { projectId: 'other', expectedRevision: 1, operations: [] }), missing); assert.equal(missing.statusCode, 403); assert.equal(called, false);
});

test('a valid loopback browser flow carries the CSRF token to the shared service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-')); const server = fakeServer(); let received;
  const service = { readProjectSettingsDocument: async () => ({ revision: 'hash-1', document: {} }), validateProjectSettingsCandidate: async () => ({ valid: true }), patchProjectSettingsDocument: async (input) => { received = input; return { revision: 'hash-2', document: {} }; } };
  await apply({ webServer: server, autoresearchSettings: service }, { standaloneProjects: true, projects: [{ id: 'demo', root }] }); const route = server.routes[0];
  const projects = response(); await route.handler(req('GET', '/api/autoresearch/projects'), projects); const token = JSON.parse(projects.body).csrfToken;
  const request = req('PATCH', '/api/autoresearch/settings', { projectId: 'demo', expectedRevision: 'hash-1', operations: [{ op: 'replace', path: 'workflow.mode', value: 'minimal' }] }, { host: '127.0.0.1', origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-autoresearch-csrf': token });
  const result = response(); await route.handler(request, result); assert.equal(result.statusCode, 200); assert.equal(received.root, root); assert.equal(received.expectedRevision, 'hash-1');
});

test('remote sockets are rejected even with an otherwise valid-looking host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-')); const server = fakeServer();
  await apply({ webServer: server }, { standaloneProjects: true, projects: [{ id: 'demo', root }] }); const route = server.routes[0]; const result = response();
  const remote = req('GET', '/api/autoresearch/projects', undefined, { host: '127.0.0.1' }); remote.socket = { remoteAddress: '203.0.113.5' }; await route.handler(remote, result); assert.equal(result.statusCode, 403);
});

test('missing Origin and lookalike JSON MIME are rejected for writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-')); const server = fakeServer(); const service = { readProjectSettingsDocument: async () => ({ revision: 1, document: {} }), validateProjectSettingsCandidate: async () => ({ valid: true }), patchProjectSettingsDocument: async () => ({ revision: 2 }) };
  await apply({ webServer: server, autoresearchSettings: service }, { standaloneProjects: true, projects: [{ id: 'demo', root }] }); const route = server.routes[0];
  const noOrigin = response(); await route.handler(req('POST', '/api/autoresearch/settings/validate', { projectId: 'demo', candidate: {} }, { host: '127.0.0.1', 'content-type': 'application/json' }), noOrigin); assert.equal(noOrigin.statusCode, 403);
  const projects = response(); await route.handler(req('GET', '/api/autoresearch/projects'), projects); const token = JSON.parse(projects.body).csrfToken;
  const badMime = response(); await route.handler(req('POST', '/api/autoresearch/settings/validate', { projectId: 'demo', candidate: {} }, { host: '127.0.0.1', origin: 'http://127.0.0.1', 'content-type': 'application/json-evil', 'x-autoresearch-csrf': token }), badMime); assert.equal(badMime.statusCode, 415);
});

test('malformed JSON request shapes return a client error before service calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-')); const server = fakeServer(); let called = false;
  const service = { readProjectSettingsDocument: async () => ({ revision: 1, document: {} }), validateProjectSettingsCandidate: async () => { called = true; return { valid: true }; }, patchProjectSettingsDocument: async () => ({ revision: 2 }) };
  await apply({ webServer: server, autoresearchSettings: service }, { standaloneProjects: true, projects: [{ id: 'demo', root }] }); const route = server.routes[0];
  const projects = response(); await route.handler(req('GET', '/api/autoresearch/projects'), projects); const token = JSON.parse(projects.body).csrfToken;
  const malformed = response(); await route.handler(req('POST', '/api/autoresearch/settings/validate', null, { host: '127.0.0.1', origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-autoresearch-csrf': token }), malformed);
  assert.equal(malformed.statusCode, 400); assert.equal(called, false);
});

test('bracketed IPv6 loopback Host is accepted only with a real loopback socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-')); const server = fakeServer(); await apply({ webServer: server }, { standaloneProjects: true, projects: [{ id: 'demo', root }] }); const route = server.routes[0];
  const valid = response(); await route.handler(req('GET', '/api/autoresearch/projects', undefined, { host: '[::1]:8080' }), valid); assert.equal(valid.statusCode, 200);
  const remote = req('GET', '/api/autoresearch/projects', undefined, { host: '[::1]:8080' }); remote.socket.remoteAddress = '192.0.2.4'; const rejected = response(); await route.handler(remote, rejected); assert.equal(rejected.statusCode, 403);
});

test('malformed local Host or request URL returns a controlled client error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-')); const server = fakeServer(); await apply({ webServer: server }, { standaloneProjects: true, projects: [{ id: 'demo', root }] }); const route = server.routes[0];
  const badHost = response(); await route.handler(req('GET', '/api/autoresearch/projects', undefined, { host: 'localhost:bad' }), badHost); assert.equal(badHost.statusCode, 400);
  const badUrl = response(); await route.handler(req('GET', 'http://[invalid', undefined, { host: '127.0.0.1' }), badUrl); assert.equal(badUrl.statusCode, 400);
});

test('an allowlisted root is re-canonicalized before each read', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'autoresearch-web-')); const root = join(parent, 'project'); const moved = join(parent, 'project-moved'); await mkdir(root); const server = fakeServer();
  const service = { readProjectSettingsDocument: async () => ({ revision: 1, document: {} }), validateProjectSettingsCandidate: async () => ({ valid: true }), patchProjectSettingsDocument: async () => ({ revision: 2 }) };
  await apply({ webServer: server, autoresearchSettings: service }, { standaloneProjects: true, projects: [{ id: 'demo', root }] }); const route = server.routes[0]; await rename(root, moved);
  const result = response(); await route.handler(req('GET', '/api/autoresearch/settings?projectId=demo'), result); assert.equal(result.statusCode, 404);
});
