import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '../../../packages/autoresearch/node_modules/@deepseek-ai/cordis/lib/index.js';
import { apply, inject, API_PREFIX } from '../src/index.js';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; },
    set statusCode(value) { this.code = value; },
    get statusCode() { return this.code; }
  };
}

function request(method, url) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {}
  };
}

test('temporary Cordis host waits for webServer and disposes the Web API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-cordis-'));
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => routes.splice(routes.indexOf(route), 1);
    }
  };
  const settings = {
    async readProjectSettingsDocument() { return { revision: 'empty', document: {} }; },
    async validateProjectSettingsCandidate() { return { valid: true, errors: [] }; },
    async patchProjectSettingsDocument() { return { revision: 'patched', document: {} }; }
  };
  const ctx = new Context();
  const provideWebServer = ctx.provide('webServer', webServer);
  const provideSettings = ctx.provide('autoresearchSettings', settings);
  const fiber = ctx.plugin({ inject, apply: (pluginCtx) => apply(pluginCtx, { standaloneProjects: true, projects: [{ id: 'temp', root }] }) });
  await fiber;
  assert.equal(routes.length, 2);
  assert.equal(routes[0].path, API_PREFIX);
  assert.equal(routes[1].path, '/autoresearch');
  const result = response();
  await routes[0].handler(request('GET', `${API_PREFIX}/projects`), result);
  assert.equal(result.code, 200);
  assert.deepEqual(JSON.parse(result.body).projects, [{ id: 'temp', name: 'temp', workspaceId: 'temp' }]);
  await fiber.dispose();
  assert.equal(routes.length, 0);
  provideSettings();
  provideWebServer();
});

test('alpha.1 client metadata is a resolvable browser graph contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(packageJson.dsh?.client?.platform, 'web');
  assert.ok(packageJson.dsh.client.external.includes('react'));
  for (const dependency of packageJson.dsh.client.inject) {
    assert.ok(packageJson.peerDependencies[dependency], `${dependency} must be declared as a peer dependency`);
  }
  assert.equal(packageJson.engines.dsh, '>=0.1.5-alpha.1');
});

test('Cordis host starts when the optional settings service is not injected', async () => {
  const routes = [];
  const ctx = new Context();
  const disposeWeb = ctx.provide('webServer', {
    register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); }
  });
  const fiber = ctx.plugin({ inject, apply: (pluginCtx) => apply(pluginCtx) });
  try {
    await fiber;
    assert.equal(routes.length, 2);
    const result = response();
    await routes[0].handler(request('GET', `${API_PREFIX}/projects`), result);
    assert.equal(result.code, 200);
    assert.deepEqual(JSON.parse(result.body).projects, []);
  } finally {
    await fiber.dispose();
    disposeWeb();
  }
});

test('Cordis host derives projects from the native workspace registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-native-registry-'));
  const routes = [];
  const ctx = new Context();
  const disposeWeb = ctx.provide('webServer', {
    register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); }
  });
  const disposeRegistry = ctx.provide('workspaceRegistry', {
    list() { return [{ id: 'native-host-workspace', path: root, title: 'Native host project' }]; }
  });
  const fiber = ctx.plugin({ inject, apply: (pluginCtx) => apply(pluginCtx, { projects: [{ id: 'legacy', root }] }) });
  try {
    await fiber;
    const result = response();
    await routes[0].handler(request('GET', `${API_PREFIX}/projects`), result);
    assert.equal(result.code, 200);
    const project = JSON.parse(result.body).projects;
    assert.equal(project.length, 1);
    assert.equal(project[0].name, 'Native host project');
    assert.equal(project[0].workspaceId, 'native-host-workspace');
  } finally {
    await fiber.dispose();
    disposeRegistry();
    disposeWeb();
  }
});
