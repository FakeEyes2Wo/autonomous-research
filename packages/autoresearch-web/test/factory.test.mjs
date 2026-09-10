import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { Context } from '../../autoresearch/node_modules/@deepseek-ai/cordis/lib/index.js';
import { inject } from '../dist/index.js';

test('a project switch cancels a pending session before the next target lookup completes', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  let resolve; const opened = [];
  const bridge = createNativeSessionBridge({ get(name) { return name === 'remote.session' ? { create: () => new Promise(r => { resolve = r; }) } : name === 'sessions' ? { open: id => opened.push(id) } : undefined; } }, {});
  const previous = bridge.bind('previous', '/previous');
  bridge.cancel();
  resolve({ ok: true, value: { sessionId: 'stale-session' } });
  assert.equal(await previous, null);
  assert.deepEqual(opened, []);
});

test('native workspace resolution prefers session membership and falls back to canonical cwd', async () => {
  const { resolveNativeWorkspace } = await import('../src/native-workbench-client.js');
  const workspaces = {
    list: {
      getSnapshot() {
        return { items: [
          { workspaceId: 'ws-a', path: 'C:\\Projects\\a', sessionIds: ['session-a'] },
          { workspaceId: 'ws-b', path: 'C:\\Projects\\b', sessionIds: [] }
        ] };
      }
    }
  };
  const sessions = { list: { getSnapshot() { return { current: 'session-a', byId: {} }; } } };
  assert.equal(resolveNativeWorkspace(workspaces, sessions).workspaceId, 'ws-a');
  const fallbackSessions = { list: { getSnapshot() { return { current: 'session-b', byId: { 'session-b': { cwd: 'c:/projects/b/' } } }; } } };
  assert.equal(resolveNativeWorkspace(workspaces, fallbackSessions).workspaceId, 'ws-b');
});

test('native workspace selection never treats a cwd-only or normal session as a research conversation', async () => {
  const { selectNativeWorkspace } = await import('../src/native-workbench-client.js');
  const workspaces = { list: { getSnapshot() { return { items: [{ workspaceId: 'ws-a', path: 'C:\\Research', sessionIds: ['ordinary'] }] }; } } };
  const ordinary = { list: { getSnapshot() { return { current: 'ordinary', byId: { ordinary: { agentPreset: 'general', cwd: 'C:\\Research' } } }; } } };
  assert.deepEqual(selectNativeWorkspace(workspaces, ordinary, new Map([['ws-a', 'project-a']])), {
    workspaceId: 'ws-a', projectId: 'project-a', sessionId: null, sessionKind: 'ordinary', grouped: true,
  });
  const cwdOnly = { list: { getSnapshot() { return { current: 'legacy', byId: { legacy: { agentPreset: 'auto-research', cwd: 'c:/research/' } } }; } } };
  assert.deepEqual(selectNativeWorkspace(workspaces, cwdOnly, new Map([['ws-a', 'project-a']])), {
    workspaceId: 'ws-a', projectId: 'project-a', sessionId: null, sessionKind: 'legacy', grouped: false,
  });
  const projected = { list: { getSnapshot() { return { current: 'ordinary', byId: { ordinary: { projectionValues: { agentPreset: 'auto-research' }, cwd: 'C:\\Research' } } }; } } };
  assert.deepEqual(selectNativeWorkspace(workspaces, projected, new Map([['ws-a', 'project-a']])), {
    workspaceId: 'ws-a', projectId: 'project-a', sessionId: 'ordinary', sessionKind: 'research', grouped: true,
  });
});

test('native paper context rejects an old A selection after an A-to-B-to-A switch', async () => {
  const { acceptsNativePaperContext } = await import('../src/native-workbench-client.js');
  assert.equal(acceptsNativePaperContext({ projectId: 'project-a', selectionId: '3' }, { projectId: 'project-a', selectionId: '1' }), false);
  assert.equal(acceptsNativePaperContext({ projectId: 'project-a', selectionId: '3' }, { projectId: 'project-b', selectionId: '3' }), false);
  assert.equal(acceptsNativePaperContext({ projectId: 'project-a', selectionId: '3' }, { projectId: 'project-a', selectionId: '3' }), true);
});

test('ordinary and cwd-only sessions remain selected until the user starts a research conversation', async () => {
  const { nativeResearchAvailability } = await import('../src/native-workbench-client.js');
  for (const sessionKind of ['ordinary', 'legacy']) {
    assert.deepEqual(nativeResearchAvailability({ workspaceId: 'ws-a', projectId: 'project-a', sessionId: null, sessionKind }), { compatible: false, canStart: true });
  }
  assert.deepEqual(nativeResearchAvailability({ workspaceId: 'ws-a', projectId: 'project-a', sessionId: 'research-1', sessionKind: 'research' }), { compatible: true, canStart: false });
});

test('native workbench collapses only a genuinely cramped phone sidebar', async () => {
  const { shouldCollapseNativeSidebar } = await import('../src/native-workbench-client.js');
  assert.equal(shouldCollapseNativeSidebar(390, 110), true);
  assert.equal(shouldCollapseNativeSidebar(390, 314), false);
  assert.equal(shouldCollapseNativeSidebar(1280, 110), false);
});

test('native sidebar ownership distinguishes external collapse, manual expansion, and cleanup', async () => {
  const { nextNativeSidebarState, nativeSidebarCleanupAction, nativeSidebarViewportMetrics } = await import('../src/native-workbench-client.js');
  assert.deepEqual(nativeSidebarViewportMetrics(1280, 282, 1140, 390), { frameWidth: 390, centerWidth: 108 });
  assert.deepEqual(nextNativeSidebarState('initial', { frameWidth: 390, centerWidth: 110, sidebarCollapsed: true }), { state: 'external', action: null });
  assert.deepEqual(nextNativeSidebarState('initial', { frameWidth: 390, centerWidth: 110, sidebarCollapsed: false }), { state: 'owned', action: 'collapse' });
  assert.deepEqual(nextNativeSidebarState('owned', { frameWidth: 390, centerWidth: 314, sidebarCollapsed: false }), { state: 'released', action: null });
  assert.deepEqual(nextNativeSidebarState('owned', { frameWidth: 1280, centerWidth: 314, sidebarCollapsed: true }), { state: 'idle', action: 'restore' });
  assert.equal(nativeSidebarCleanupAction('owned', true), 'restore');
  assert.equal(nativeSidebarCleanupAction('owned', false), null);
  assert.equal(nativeSidebarCleanupAction('external', true), null);
});

test('native bridge binds a workspace target and stores its session by workspace identity', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const values = new Map(); const requests = []; const opened = [];
  const ctx = { get(name) {
    if (name === 'sessions') return { open(id) { opened.push(id); } };
    if (name === 'remote.session') return { async create(request) { requests.push(request); return { ok: true, value: { sessionId: 'session-1' } }; } };
  } };
  const win = { localStorage: { getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); } } };
  const bridge = createNativeSessionBridge(ctx, win);
  assert.equal(await bridge.bind({ workspaceId: 'ws-a', cwd: 'C:\\Projects\\a' }), 'session-1');
  assert.deepEqual(requests, [{ workspaceId: 'ws-a', agentPreset: 'auto-research' }]);
  assert.deepEqual(opened, ['session-1']);
  assert.equal(values.get('autoresearch.workbench.sessions.v1'), JSON.stringify({ 'ws-a': 'session-1' }));
});

test('native bridge creates fresh research sessions without reading or writing resume state', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const requests = []; const opened = []; let storageReads = 0; let storageWrites = 0;
  const ctx = { get(name) {
    if (name === 'sessions') return { open(id) { opened.push(id); } };
    if (name === 'remote.session') return { async create(request) { requests.push(request); return { ok: true, value: { sessionId: 'fresh-1' } }; } };
  } };
  const bridge = createNativeSessionBridge(ctx, { localStorage: { getItem() { storageReads += 1; return JSON.stringify({ 'ws-test': 'old' }); }, setItem() { storageWrites += 1; } } });
  assert.equal(await bridge.createFresh('ws-test'), 'fresh-1');
  assert.deepEqual(requests, [{ workspaceId: 'ws-test', agentPreset: 'auto-research' }]);
  assert.deepEqual(opened, ['fresh-1']);
  assert.equal(storageReads, 0); assert.equal(storageWrites, 0);
});

test('native research session hook scopes folder and global new-session actions and restores the service', async () => {
  const { installNativeResearchSessionHook } = await import('../src/native-workbench-client.js');
  const delegated = []; const created = []; const statuses = [];
  const prototype = { startSession(workspaceId) { delegated.push({ self: this, workspaceId }); } };
  const uiWorkspace = Object.create(prototype);
  const bridge = { async createFresh(workspaceId) { created.push(workspaceId); return `fresh-${created.length}`; } };
  let currentWorkspaceId = 'ws-current';
  const cleanup = installNativeResearchSessionHook(uiWorkspace, bridge, () => currentWorkspaceId, (value) => statuses.push(value));
  assert.equal(Object.hasOwn(uiWorkspace, 'startSession'), true);
  assert.equal(uiWorkspace.startSession('ws-test'), undefined);
  assert.equal(uiWorkspace.startSession(), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(created, ['ws-test', 'ws-current']);
  assert.deepEqual(delegated, []);
  assert.ok(statuses.includes('正在创建科研会话'));
  currentWorkspaceId = null;
  uiWorkspace.startSession();
  assert.deepEqual(delegated, []);
  assert.equal(statuses.at(-1), '请先从左侧选择一个工作区');
  cleanup();
  assert.equal(Object.hasOwn(uiWorkspace, 'startSession'), false);
  uiWorkspace.startSession('ws-general');
  assert.deepEqual(delegated, [{ self: uiWorkspace, workspaceId: 'ws-general' }]);
});

test('fresh research session creation opens only the newest parallel result and exposes remote errors', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const pending = []; const opened = [];
  const ctx = { get(name) {
    if (name === 'sessions') return { open(id) { opened.push(id); } };
    return { create(request) { return new Promise((resolve) => pending.push({ request, resolve })); } };
  } };
  const bridge = createNativeSessionBridge(ctx, {});
  const first = bridge.createFresh('ws-a'); const second = bridge.createFresh('ws-b');
  assert.deepEqual(pending.map((item) => item.request), [
    { workspaceId: 'ws-a', agentPreset: 'auto-research' },
    { workspaceId: 'ws-b', agentPreset: 'auto-research' },
  ]);
  pending[0].resolve({ ok: true, value: { sessionId: 'stale' } });
  assert.equal(await first, null); assert.deepEqual(opened, []);
  pending[1].resolve({ ok: true, value: { sessionId: 'current' } });
  assert.equal(await second, 'current'); assert.deepEqual(opened, ['current']);
  const failed = bridge.createFresh('ws-error');
  pending[2].resolve({ ok: false, error: { code: 'agent-preset/invalid', message: 'preset invalid' } });
  await assert.rejects(failed, /preset invalid/);
});

test('native bridge preserves the legacy standalone cwd binding shape', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const requests = [];
  const ctx = { get(name) {
    if (name === 'sessions') return { open() {} };
    return { async create(request) { requests.push(request); return { sessionId: 'legacy-session' }; } };
  } };
  const bridge = createNativeSessionBridge(ctx, { localStorage: { getItem() { return null; }, setItem() {} } });
  assert.equal(await bridge.bind('legacy-project', '/legacy'), 'legacy-session');
  assert.deepEqual(requests, [{ cwd: '/legacy', agentPreset: 'auto-research' }]);
});

test('browser factory loads with the real DSH SlotCore and unregisters its section', async () => {
  assert.deepEqual(inject, ['webServer']);
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  let handoff;
  const context = { window: { __ModuleLoader__: { load(value) { handoff = value; } } }, document: {}, console, URLSearchParams };
  vm.createContext(context); new vm.Script(source).runInContext(context);
  assert.equal(handoff.id, '@athena/autoresearch-web');
  const exports = handoff.factory((name) => {
    if (name === 'react') return { createElement: (...args) => args };
    throw new Error(`unexpected browser dependency ${name}`);
  });
  assert.equal(typeof exports.apply, 'function');
  assert.equal(Array.from(exports.inject).join(','), 'locale,slots');
  const core = new SlotCore(); core.record('settings.section').spec = { kind: 'list', scope: 'root' }; core.record('sidebar.brand.name').spec = { kind: 'single', scope: 'root' };
  core.register({ name: 'sidebar.brand.name', id: 'official-brand', priority: 0 }, () => {});
  let dispose; const injected = [];
  let serviceLookups = 0;
  const ctx = {
    get() { serviceLookups += 1; throw new Error('optional services must not be read in root mode off'); },
    locale: { register(namespace, dictionaries) { assert.equal(namespace, 'autoresearch'); assert.equal(dictionaries.en['autoresearch.nav'], 'AutoResearch'); } },
    slots: {
      inject(name, callback) { injected.push(name); const result = callback(); if (name === 'settings.section') dispose = result; return result; },
      register(options, component) { assert.equal(options.locale, 'autoresearch'); assert.equal(options.inject, undefined); return core.register(options, component); }
    }
  };
  exports.apply(ctx);
  assert.equal(serviceLookups, 0);
  assert.deepEqual(core.entriesOfSlot('settings.section').map((entry) => entry.options.id), ['autoresearch']);
  assert.deepEqual(injected, ['settings.section', 'sidebar.brand.name']);
  assert.equal(core.entriesOfSlot('sidebar.brand.name').length, 1);
  assert.equal(core.entriesOfSlot('sidebar.brand.name')[0].options.priority, -100);
  assert.equal(core.entriesOfSlot('sidebar.brand.name')[0].options.id, 'autoresearch-workbench');
  assert.equal(typeof dispose, 'function'); dispose(); assert.deepEqual(core.entriesOfSlot('settings.section'), []);
});

test('native bridge reuses a saved session id for the same project', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const values = new Map(); const created = []; const opened = [];
  const services = {
    sessions: { open(id) { opened.push(id); } },
    'remote.session': { async create(request) { created.push(request); return { ok: true, value: { sessionId: 'session-' + created.length } }; } }
  };
  const win = { localStorage: { getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); } } };
  const calls = []; const ctx = { get(name) { calls.push(name); return services[name]; }, sessions: { open() { throw new Error('ctx.foo must not be read'); } }, remote: { session: { create() { throw new Error('ctx.foo must not be read'); } } } };
  const bridge = createNativeSessionBridge(ctx, win);
  assert.equal(await bridge.bind('paper-a', '/a'), 'session-1');
  assert.equal(await bridge.bind('paper-a', '/a'), 'session-2');
  assert.deepEqual(created, [{ cwd: '/a', agentPreset: 'auto-research' }, { cwd: '/a', agentPreset: 'auto-research', sessionId: 'session-1' }]);
  assert.deepEqual(opened, ['session-1', 'session-2']);
  assert.deepEqual(calls, ['remote.session', 'sessions', 'sessions', 'remote.session', 'sessions', 'sessions']);
});

test('native bridge drops an old parallel bind result without opening it', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const pending = []; const opened = [];
  const ctx = { get(name) {
    return name === 'sessions'
      ? { open(id) { opened.push(id); } }
      : { create(request) { return new Promise((resolve) => pending.push({ request, resolve })); } };
  } };
  const bridge = createNativeSessionBridge(ctx, { localStorage: { getItem() { return null; }, setItem() {} } });
  const first = bridge.bind('paper-a', '/a'); const second = bridge.bind('paper-b', '/b');
  assert.equal(pending.length, 2);
  pending[0].resolve({ ok: true, value: { sessionId: 'stale' } });
  assert.equal(await first, null);
  assert.deepEqual(opened, []);
  pending[1].resolve({ ok: true, value: { sessionId: 'current' } });
  assert.equal(await second, 'current');
  assert.deepEqual(opened, ['current']);
});

test('native bridge does not open a result after dispose', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  let resolve; const opened = [];
  const ctx = { get(name) {
    return name === 'sessions'
      ? { open(id) { opened.push(id); } }
      : { create() { return new Promise((next) => { resolve = next; }); } };
  } };
  const bridge = createNativeSessionBridge(ctx, { localStorage: { getItem() { return null; }, setItem() {} } });
  const result = bridge.bind('paper-a', '/a'); bridge.dispose(); resolve({ ok: true, value: { sessionId: 'late' } });
  assert.equal(await result, null);
  assert.deepEqual(opened, []);
});

test('native bridge confirms replacement of a draft and never sends it', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  let draft = 'existing'; let setCalls = 0; let confirmCalls = 0;
  const input = { state: { getSnapshot() { return { draft }; } }, setDraft(value) { draft = value; setCalls += 1; } };
  const ctx = { get(name) {
    if (name === 'sessions') return { scope() { return {}; } };
    if (name === 'conversation') return { input: { for() { return input; } } };
    throw new Error('unexpected service ' + name);
  }, sessions: { scope() { throw new Error('ctx.foo must not be read'); } }, conversation: { input: { for() { throw new Error('ctx.foo must not be read'); } } } };
  const win = { confirm() { confirmCalls += 1; return false; } };
  const bridge = createNativeSessionBridge(ctx, win);
  assert.equal(bridge.draft('session-1', 'replacement'), false);
  assert.equal(draft, 'existing'); assert.equal(setCalls, 0); assert.equal(confirmCalls, 1);
  win.confirm = () => true;
  assert.equal(bridge.draft('session-1', 'replacement'), true);
  assert.equal(draft, 'replacement'); assert.equal(setCalls, 1);
});

test('native bridge skips optional service lookup when root mode is off', async () => {
  const { installNativeWorkbench } = await import('../src/native-workbench-client.js');
  const calls = []; const browser = { location: { search: '', origin: 'http://127.0.0.1:1234' }, parent: {} };
  const cleanup = installNativeWorkbench({ get(name) { calls.push(name); throw new Error('optional service must not be read'); } }, {}, browser);
  cleanup();
  assert.deepEqual(calls, []);
});

test('browser plugin declares services provided by sibling Cordis plugins', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  let handoff;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { handoff = value; } } }, URLSearchParams });
  const client = handoff.factory(() => ({ createElement() {} }));
  const registered = [];
  const dictionariesByNamespace = new Map([['settings', new Set(['zh', 'en'])]]);
  const ctx = new Context();
  const services = ctx.plugin((scope) => {
    scope.provide('locale', {
      register(namespace, dictionaries) {
        const locales = dictionariesByNamespace.get(namespace) ?? new Set();
        for (const language of Object.keys(dictionaries)) {
          if (locales.has(language)) throw new Error(`locale namespace "${namespace}" already has locale "${language}"`);
          locales.add(language);
        }
        dictionariesByNamespace.set(namespace, locales);
      }
    });
    scope.provide('slots', {
      inject(name, callback) { return callback(); },
      register(options) { registered.push(options.id); return () => {}; }
    });
    scope.provide('sessions', {});
    scope.provide('remote', {});
    scope.provide('conversation', {});
  });
  let fiber;
  try {
    await services;
    fiber = ctx.plugin(client);
    await fiber;
    assert.deepEqual(registered, ['autoresearch', 'autoresearch-workbench']);
  } finally {
    await fiber?.dispose();
    await services.dispose();
  }
});
