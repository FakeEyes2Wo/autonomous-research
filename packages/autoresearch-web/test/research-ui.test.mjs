import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { RESEARCH_ACTIONS, RESEARCH_ROLES, researchActionDisabled, researchPrompt } from '../src/research-ui.js';
import { nativeWorkbenchHref, canLeaveNativePaper, installNativePanelGuard, installNativeResearchSessionHook } from '../src/native-workbench-client.js';
import { roleNames } from '../../autoresearch/dist/agents/roles/index.js';

test('role routing covers exactly the installed research and paper roles', () => {
  assert.deepEqual(RESEARCH_ROLES.map(([id]) => id).sort(), [...roleNames].sort());
});

test('research and evidence actions work before a paper exists; unsaved paper context is protected', () => {
  for (const action of RESEARCH_ACTIONS) {
    assert.equal(researchActionDisabled(action.id, { ready: true }), action.needsPaper);
    assert.equal(researchActionDisabled(action.id, { ready: false }), true);
    assert.equal(researchActionDisabled(action.id, { ready: true, busy: true }), true);
    assert.equal(researchActionDisabled(action.id, { ready: true, document: { relativePath: 'paper/main.tex' }, dirty: true }), true);
    assert.equal(researchActionDisabled(action.id, { ready: true, document: { relativePath: 'paper/main.tex' } }), false);
  }
  assert.equal(researchActionDisabled('unknown', { ready: true }), true);
  assert.equal(researchPrompt('unknown'), '');
  assert.ok(!researchPrompt('generate').includes('开展研究并生成论文'));
  assert.match(researchPrompt('design'), /覆盖矩阵/);
  assert.match(researchPrompt('review'), /如尚无论文/);
  assert.match(researchPrompt('refine', { relativePath: 'paper/main.tex' }), /paper\/main.tex/);
});

test('workbench links retain the native location and drop obsolete embedding flags', () => {
  assert.equal(nativeWorkbenchHref('http://localhost:8080/?session=abc&autoresearchChat=1&autoresearchSession=old#thread'), '/?session=abc&autoresearch=1#thread');
  assert.equal(nativeWorkbenchHref(), '/?autoresearch=1');
});

test('the sidebar targets an independent main panel without reloading the native app', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  let loaded; const assigned = [], selected = [], registered = [];
  const win = { document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } }, __ModuleLoader__: { load(value) { loaded = value; } }, location: { href: 'http://localhost/?session=abc#thread', search: '?session=abc', assign(href) { assigned.push(href); } } };
  vm.runInNewContext(source, { window: win, URL, URLSearchParams });
  const React = { createElement: (...args) => args, useEffect: (fn) => fn() };
  const client = loaded.factory(() => React);
  client.apply({
    get(name) { return name === 'layout' ? { selectPanel(id) { selected.push(id); } } : undefined; },
    locale: { register() {} },
    slots: { inject(_name, fn) { return fn(); }, register(options, component) { registered.push({ options, component }); return () => {}; } },
  });
  const entry = registered.find(({ options }) => options.name === 'main');
  const sidebar = registered.find(({ options }) => options.name === 'sidebar.panellist');
  assert.equal(entry.options.key, sidebar.options.id);
  assert.equal(entry.component.name, 'NativeResearchWorkbench');
  assert.deepEqual(assigned, []);
  assert.deepEqual(selected, [], 'Registration alone must not interrupt the current page');
  assert.equal(registered.some(({ options }) => options.name === 'shell.overlay'), false);
});

test('the live paper can cancel navigation before its posted context arrives', () => {
  const target = new EventTarget(); target.Event = Event;
  const listener = event => event.preventDefault();
  target.addEventListener('autoresearch-before-leave', listener);
  assert.equal(canLeaveNativePaper({ contentWindow: target }, {}), false);
  target.removeEventListener('autoresearch-before-leave', listener);
  assert.equal(canLeaveNativePaper({ contentWindow: target }, {}), true);
  assert.equal(canLeaveNativePaper(null, {}), true);
});

test('panel and session navigation preserves edits on cancel and checks nested navigation only once', () => {
  const calls = []; let allowed = false, checks = 0;
  const layout = { selectPanel(id) { calls.push(['panel', id, this === layout]); } };
  const prototype = { openSession(id) { calls.push(['session', id, this === workspace]); layout.selectPanel(null); }, startSession() { calls.push(['new']); } };
  const workspace = Object.create(prototype);
  const original = layout.selectPanel;
  const cleanup = installNativePanelGuard(layout, workspace, () => { checks++; return allowed; });
  layout.selectPanel(null); workspace.openSession('another'); workspace.startSession();
  assert.deepEqual(calls, []);
  assert.equal(checks, 3);
  layout.selectPanel('autoresearch');
  assert.deepEqual(calls, [['panel', 'autoresearch', true]]);
  allowed = true; workspace.openSession('another');
  assert.equal(checks, 4);
  assert.deepEqual(calls.slice(1), [['session', 'another', true], ['panel', null, true]]);
  cleanup();
  assert.equal(layout.selectPanel, original);
  assert.equal(Object.hasOwn(workspace, 'openSession'), false);
  assert.equal(Object.hasOwn(workspace, 'startSession'), false);
});

test('guard cleanup restores the research hook before restoring normal new-session behavior', async () => {
  let ordinary = 0, started = 0;
  const workspace = { startSession() { ordinary++; } };
  const original = workspace.startSession;
  const stopHook = installNativeResearchSessionHook(workspace, { async createFresh() { return 'research-session'; } }, () => 'ws-a', () => {}, () => started++);
  const stopGuard = installNativePanelGuard({}, workspace, () => true);
  workspace.startSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 1);
  stopGuard(); stopHook();
  assert.equal(workspace.startSession, original);
  workspace.startSession(); assert.equal(ordinary, 1);
});
