import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { Context } from '../../autoresearch/node_modules/@deepseek-ai/cordis/lib/index.js';
import { inject } from '../dist/index.js';

function listedSessions(opened, ...ids) {
  const byId = Object.fromEntries(ids.map((id) => [id, { sessionId: id }]));
  return { list: { getSnapshot: () => ({ byId }) }, refresh: async () => {}, open(id) { assert.ok(byId[id], 'unknown session'); opened.push(id); } };
}

function nativeComponentHarness(remoteCreate) {
  const state = [], refs = [], callbacks = [], effects = [], listeners = { workspaces: new Set(), sessions: new Set() }, byId = { ordinary: { agentPreset: 'general' } }, opened = [];
  let Component, stateIndex, refIndex, callbackIndex, effectIndex;
  const same = (left, right) => left?.length === right?.length && left.every((value, index) => Object.is(value, right[index]));
  const workspaces = { list: { getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'ws-a', sessionIds: ['ordinary'] }] }), subscribe(listener) { listeners.workspaces.add(listener); return () => listeners.workspaces.delete(listener); } } };
  const sessions = { list: { getSnapshot: () => ({ phase: 'ready', current: 'ordinary', byId }), subscribe(listener) { listeners.sessions.add(listener); return () => listeners.sessions.delete(listener); } }, refresh: async () => {}, open(id) { opened.push(id); } };
  const React = {
    createElement: (...args) => args,
    useState(initial) { const index = stateIndex++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] ||= { current: initial }; },
    useCallback(callback, deps) { const index = callbackIndex++; if (!callbacks[index] || !same(callbacks[index].deps, deps)) callbacks[index] = { callback, deps }; return callbacks[index].callback; },
    useEffect(callback, deps) { const index = effectIndex++; const effect = effects[index] ||= {}; if (!same(effect.deps, deps)) effect.next = { callback, deps }; },
  };
  const render = () => { stateIndex = refIndex = callbackIndex = effectIndex = 0; Component(); };
  const applyEffects = (indices) => { for (const index of indices) { const effect = effects[index]; if (!effect?.next) continue; effect.cleanup?.(); const next = effect.next; delete effect.next; effect.deps = next.deps; effect.cleanup = next.callback(); } };
  const uiWorkspace = { startSession() {} };
  const ctx = { get(name) { return ({ workspaces, sessions, uiWorkspace, 'remote.session': { create: remoteCreate } })[name]; }, slots: { inject(_name, callback) { return callback(); }, register(_options, component) { Component = component; return () => {}; } }, effect() {} };
  const win = { innerHeight: 800, localStorage: { getItem() { return null; }, setItem() {} }, location: { search: '?autoresearch=1', origin: 'http://localhost' }, document: { createElement() { return { remove() {} }; }, head: { appendChild() {} }, querySelector() { return null; }, body: { classList: { add() {}, remove() {} } } }, addEventListener() {}, removeEventListener() {}, getComputedStyle() { return { getPropertyValue() { return ''; }, colorScheme: 'light' }; }, ResizeObserver: class { observe() {} disconnect() {} } };
  return {
    async mount() { const { installNativeWorkbench } = await import('../src/native-workbench-client.js'); installNativeWorkbench(ctx, React, win); state[3] = new Map([['ws-a', 'project-a']]); render(); applyEffects([1, 4]); },
    render, applyEffects, state, refs, listeners, byId, opened, uiWorkspace,
    async flush() { await new Promise((resolve) => setImmediate(resolve)); },
  };
}

test('an unchanged native selection preserves a fresh-session error status', async () => {
  const harness = nativeComponentHarness(async () => ({ ok: false, error: { message: 'missing workflow package' } }));
  await harness.mount();
  harness.uiWorkspace.startSession('ws-a');
  await harness.flush();
  assert.equal(harness.state[5], 'missing workflow package');
  for (const listener of [...harness.listeners.workspaces, ...harness.listeners.sessions]) listener();
  assert.equal(harness.state[5], 'missing workflow package');
});

test('an unrelated project map update does not cancel an in-flight A session creation', async () => {
  let resolveCreate;
  const harness = nativeComponentHarness(() => new Promise((resolve) => { resolveCreate = resolve; }));
  await harness.mount();
  harness.uiWorkspace.startSession('ws-a');
  await harness.flush();
  harness.state[3] = new Map([['ws-a', 'project-a'], ['ws-b', 'project-b']]);
  harness.render(); harness.applyEffects([4]);
  harness.byId.created = { agentPreset: 'auto-research' };
  resolveCreate({ ok: true, value: { sessionId: 'created' } });
  await harness.flush();
  assert.deepEqual(harness.opened, ['created']);
  assert.deepEqual(harness.refs[2].current, { workspaceId: 'ws-a', projectId: 'project-a', sessionId: null, sessionKind: 'ordinary', grouped: true, selectionId: '1' });
});

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
    if (name === 'sessions') return listedSessions(opened, 'session-1');
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
    if (name === 'sessions') return listedSessions(opened, 'fresh-1');
    if (name === 'remote.session') return { async create(request) { requests.push(request); return { ok: true, value: { sessionId: 'fresh-1' } }; } };
  } };
  const bridge = createNativeSessionBridge(ctx, { localStorage: { getItem() { storageReads += 1; return JSON.stringify({ 'ws-test': 'old' }); }, setItem() { storageWrites += 1; } } });
  assert.equal(await bridge.createFresh('ws-test'), 'fresh-1');
  assert.deepEqual(requests, [{ workspaceId: 'ws-test', agentPreset: 'auto-research' }]);
  assert.deepEqual(opened, ['fresh-1']);
  assert.equal(storageReads, 0); assert.equal(storageWrites, 0);
});

test('native workspace resolution uses DSH recent workspace only after both stores are ready', async () => {
  const { resolveNativeWorkspace } = await import('../src/native-workbench-client.js');
  const workspaces = { list: { getSnapshot: () => ({ phase: 'ready', items: [
    { workspaceId: 'older', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['old-session'] },
    { workspaceId: 'recent', createdAt: '2026-01-02T00:00:00.000Z', sessionIds: ['recent-session'] },
  ] }) } };
  const sessions = { list: { getSnapshot: () => ({ phase: 'ready', byId: { 'old-session': { updatedAt: 10 }, 'recent-session': { updatedAt: 20 } } }) } };
  assert.equal(resolveNativeWorkspace(workspaces, sessions).workspaceId, 'recent');
  assert.equal(resolveNativeWorkspace({ list: { getSnapshot: () => ({ phase: 'pending', items: workspaces.list.getSnapshot().items }) } }, sessions), undefined);
});

test('native bridge refreshes the local session list before opening a newly-created session', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const byId = {}; const opened = []; const subscribers = new Set(); let refreshes = 0;
  const notify = () => { for (const subscriber of subscribers) subscriber(); };
  const sessions = {
    list: {
      getSnapshot: () => ({ byId }),
      subscribe(subscriber) { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
    },
    refresh: async () => { refreshes += 1; byId.created = { sessionId: 'created' }; notify(); },
    open(id) { assert.ok(byId[id], 'unknown session'); opened.push(id); },
  };
  const bridge = createNativeSessionBridge({ get(name) {
    if (name === 'sessions') return sessions;
    if (name === 'remote.session') return { async create() { return { ok: true, value: { sessionId: 'created' } }; } };
  } }, {});
  assert.equal(await bridge.createFresh('ws-a'), 'created');
  assert.deepEqual(opened, ['created']);
  assert.equal(refreshes, 1);
  assert.equal(subscribers.size, 0);
});

test('native bridge cancellation while waiting for local publication neither opens nor leaves a subscription', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const byId = {}; const opened = []; const subscribers = new Set(); let resolveRefresh, refreshes = 0;
  const sessions = {
    list: {
      getSnapshot: () => ({ byId }),
      subscribe(subscriber) { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
    },
    refresh: () => { refreshes += 1; return new Promise((resolve) => { resolveRefresh = resolve; }); },
    open(id) { assert.ok(byId[id], 'unknown session'); opened.push(id); },
  };
  const bridge = createNativeSessionBridge({ get(name) {
    if (name === 'sessions') return sessions;
    if (name === 'remote.session') return { async create() { return { ok: true, value: { sessionId: 'late' } }; } };
  } }, {});
  const pending = bridge.createFresh('ws-a');
  await new Promise((resolve) => setImmediate(resolve));
  bridge.cancel(); resolveRefresh();
  assert.equal(await pending, null);
  assert.deepEqual(opened, []);
  assert.equal(subscribers.size, 0);
  assert.equal(refreshes, 1);
});

test('native bridge removes a subscription that publishes synchronously during subscribe', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const byId = {}; const subscribers = new Set();
  const sessions = {
    list: {
      getSnapshot: () => ({ byId }),
      subscribe(listener) { subscribers.add(listener); byId.created = { sessionId: 'created' }; listener(); return () => subscribers.delete(listener); },
    },
    refresh: async () => { throw new Error('refresh should not run after synchronous publication'); },
    open(id) { assert.ok(byId[id], 'unknown session'); },
  };
  const bridge = createNativeSessionBridge({ get(name) {
    if (name === 'sessions') return sessions;
    if (name === 'remote.session') return { async create() { return { ok: true, value: { sessionId: 'created' } }; } };
  } }, {});
  assert.equal(await bridge.createFresh('ws-a'), 'created');
  assert.equal(subscribers.size, 0);
});

test('native bridge cancellation during saved-session fallback suppresses its late rejection', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  let rejectFallback; const requests = [];
  const bridge = createNativeSessionBridge({ get(name) {
    if (name === 'sessions') return listedSessions([], 'unused');
    if (name === 'remote.session') return { create(request) {
      requests.push(request);
      if (requests.length === 1) return Promise.reject(Object.assign(new Error('conflict'), { code: 'conflict' }));
      return new Promise((_, reject) => { rejectFallback = reject; });
    } };
  } }, { localStorage: { getItem: () => JSON.stringify({ 'project-a': 'saved' }), setItem() {} } });
  const pending = bridge.bind('project-a', '/a');
  await new Promise((resolve) => setImmediate(resolve));
  bridge.cancel(); rejectFallback(new Error('network'));
  assert.equal(await pending, null);
  assert.equal(requests.length, 2);
});

test('native bridge retries one completed stale refresh before reporting visibility failure', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const byId = {}; const subscribers = new Set(); let refreshes = 0;
  const notify = () => { for (const listener of subscribers) listener(); };
  const sessions = {
    list: { getSnapshot: () => ({ byId }), subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } },
    refresh: async () => { refreshes += 1; if (refreshes === 2) { byId.created = { sessionId: 'created' }; notify(); } },
    open(id) { assert.ok(byId[id], 'unknown session'); },
  };
  const bridge = createNativeSessionBridge({ get(name) {
    if (name === 'sessions') return sessions;
    if (name === 'remote.session') return { async create() { return { ok: true, value: { sessionId: 'created' } }; } };
  } }, {});
  assert.equal(await bridge.createFresh('ws-a'), 'created');
  assert.equal(refreshes, 2);
  assert.equal(subscribers.size, 0);
});

test('native bridge reports visibility timeout and cleans its subscription', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const byId = {}; const subscribers = new Set();
  const sessions = {
    list: { getSnapshot: () => ({ byId }), subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } },
    refresh: async () => {}, open() { throw new Error('must not open an unseen session'); },
  };
  const bridge = createNativeSessionBridge({ get(name) {
    if (name === 'sessions') return sessions;
    if (name === 'remote.session') return { async create() { return { ok: true, value: { sessionId: 'missing' } }; } };
  } }, {});
  await assert.rejects(bridge.createFresh('ws-a'), /未及时出现在本地列表/);
  assert.equal(subscribers.size, 0);
});

test('native bridge surfaces a thrown list subscription without scheduling a session open', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const sessions = { list: { getSnapshot: () => ({ byId: {} }), subscribe() { throw new Error('subscribe unavailable'); } }, refresh: async () => {}, open() { throw new Error('must not open'); } };
  const bridge = createNativeSessionBridge({ get(name) {
    if (name === 'sessions') return sessions;
    if (name === 'remote.session') return { async create() { return { ok: true, value: { sessionId: 'missing' } }; } };
  } }, {});
  await assert.rejects(bridge.createFresh('ws-a'), /subscribe unavailable/);
});

test('native project mapping accepts a workspace that appears after an initially empty map and rejects bad responses', async () => {
  const { selectNativeWorkspace, readNativeProjectMap } = await import('../src/native-workbench-client.js');
  const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-a', sessionIds: ['ordinary'] }] }) } };
  const sessions = { list: { getSnapshot: () => ({ current: 'ordinary', byId: { ordinary: { agentPreset: 'general' } } }) } };
  assert.equal(selectNativeWorkspace(workspaces, sessions, new Map()).projectId, null);
  const projects = await readNativeProjectMap({ ok: true, json: async () => ({ projects: [{ id: 'project-a', workspaceId: 'ws-a' }] }) });
  assert.equal(selectNativeWorkspace(workspaces, sessions, projects).projectId, 'project-a');
  await assert.rejects(readNativeProjectMap({ ok: false, json: async () => ({}) }), /项目映射请求失败/);
  await assert.rejects(readNativeProjectMap({ ok: true, json: async () => ({ projects: null }) }), /项目映射无效/);
});

test('workspace membership refreshes an initially empty project map and ignores a response after disposal', async () => {
  const { installNativeProjectMapRefresh } = await import('../src/native-workbench-client.js');
  const subscribers = new Set(); const maps = []; let resolveLate;
  const workspaces = { list: { subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } } };
  const responses = [
    Promise.resolve({ ok: true, json: async () => ({ projects: [] }) }),
    Promise.resolve({ ok: true, json: async () => ({ projects: [{ id: 'project-a', workspaceId: 'ws-a' }] }) }),
    new Promise((resolve) => { resolveLate = resolve; }),
  ];
  const stop = installNativeProjectMapRefresh({ get(name) { return name === 'workspaces' ? workspaces : undefined; } }, () => responses.shift(), (map) => maps.push(map), () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maps.length, 1); assert.equal(maps[0].size, 0);
  [...subscribers][0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maps.length, 2); assert.equal(maps[1].get('ws-a'), 'project-a');
  [...subscribers][0](); stop();
  resolveLate({ ok: true, json: async () => ({ projects: [{ id: 'stale', workspaceId: 'ws-stale' }] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maps.length, 2);
  assert.equal(subscribers.size, 0);
});

test('injected workspace hook replaces and restores each late uiWorkspace service', async () => {
  const { installInjectedNativeResearchSessionHook } = await import('../src/native-workbench-client.js');
  const first = { startSession() {} }, second = { startSession() {} }; const originalFirst = first.startSession, originalSecond = second.startSession;
  let callback, cleanup; let disposed = 0;
  const ctx = { inject(deps, next) { assert.deepEqual(deps, ['uiWorkspace']); callback = next; return { dispose() { disposed += 1; cleanup?.(); } }; } };
  const stop = installInjectedNativeResearchSessionHook(ctx, { async createFresh() { return null; } }, () => 'ws-a', () => {});
  cleanup = callback({ get(name) { return name === 'uiWorkspace' ? first : undefined; } });
  assert.notEqual(first.startSession, originalFirst);
  cleanup(); assert.equal(first.startSession, originalFirst);
  cleanup = callback({ get(name) { return name === 'uiWorkspace' ? second : undefined; } });
  assert.notEqual(second.startSession, originalSecond);
  stop();
  assert.equal(second.startSession, originalSecond);
  assert.equal(disposed, 1);
});

test('injected workspace hook waits for a late Cordis uiWorkspace service and restores it on disposal', async () => {
  const { installInjectedNativeResearchSessionHook } = await import('../src/native-workbench-client.js');
  const ctx = new Context(); const uiWorkspace = { startSession() {} }; const original = uiWorkspace.startSession; const created = [];
  const stop = installInjectedNativeResearchSessionHook(ctx, { async createFresh(workspaceId) { created.push(workspaceId); return null; } }, () => 'ws-a', () => {});
  const services = ctx.plugin((scope) => scope.provide('uiWorkspace', uiWorkspace));
  try {
    await services;
    assert.notEqual(uiWorkspace.startSession, original);
    uiWorkspace.startSession();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(created, ['ws-a']);
    stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(uiWorkspace.startSession, original);
  } finally {
    stop();
    await services.dispose();
  }
});

test('native bridge binds only after delayed list publication and reports refresh failure without leaks', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  const byId = {}; const opened = []; const subscribers = new Set(); let failRefresh = false;
  const notify = () => { for (const listener of subscribers) listener(); };
  const sessions = {
    list: { getSnapshot: () => ({ byId }), subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } },
    refresh: async () => {
      if (failRefresh) throw new Error('refresh unavailable');
      byId.bound = { sessionId: 'bound' }; notify();
    },
    open(id) { assert.ok(byId[id], 'unknown session'); opened.push(id); },
  };
  const bridge = createNativeSessionBridge({ get(name) {
    if (name === 'sessions') return sessions;
    if (name === 'remote.session') return { async create() { return { ok: true, value: { sessionId: failRefresh ? 'missing' : 'bound' } }; } };
  } }, { localStorage: { getItem: () => null, setItem() {} } });
  assert.equal(await bridge.bind('project-a', '/a'), 'bound');
  assert.deepEqual(opened, ['bound']); assert.equal(subscribers.size, 0);
  failRefresh = true;
  await assert.rejects(bridge.createFresh('ws-a'), /refresh unavailable/);
  assert.equal(subscribers.size, 0);
});

test('canceling a saved-session conflict prevents its fallback creation request', async () => {
  const { createNativeSessionBridge } = await import('../src/native-workbench-client.js');
  let rejectFirst; const requests = [];
  const bridge = createNativeSessionBridge({ get(name) {
    if (name === 'sessions') return listedSessions([], 'unused');
    if (name === 'remote.session') return { create(request) { requests.push(request); return new Promise((_, reject) => { rejectFirst = reject; }); } };
  } }, { localStorage: { getItem: () => JSON.stringify({ 'project-a': 'saved' }), setItem() {} } });
  const pending = bridge.bind('project-a', '/a');
  bridge.cancel(); rejectFirst(Object.assign(new Error('conflict'), { code: 'conflict' }));
  assert.equal(await pending, null);
  assert.deepEqual(requests, [{ cwd: '/a', agentPreset: 'auto-research', sessionId: 'saved' }]);
});

test('a stale session-target response after a workspace switch never begins a bridge bind', async () => {
  const { bindNativeSessionTarget } = await import('../src/native-workbench-client.js');
  let resolveResponse; const bound = [];
  const response = new Promise((resolve) => { resolveResponse = resolve; });
  let current = true;
  const pending = bindNativeSessionTarget(() => response, { bind(target) { bound.push(target); } }, { projectId: 'project-a', workspaceId: 'ws-a' }, () => current);
  current = false;
  resolveResponse({ ok: true, json: async () => ({ projectId: 'project-a', workspaceId: 'ws-a', cwd: 'C:\\Projects\\a' }) });
  assert.equal(await pending, null);
  assert.deepEqual(bound, []);
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
    if (name === 'sessions') return listedSessions(opened, 'stale', 'current');
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
    if (name === 'sessions') return listedSessions([], 'legacy-session');
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
    sessions: listedSessions(opened, 'session-1', 'session-2'),
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
      ? listedSessions(opened, 'stale', 'current')
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
