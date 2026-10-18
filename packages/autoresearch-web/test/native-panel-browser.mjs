// Real React, built client and document API; native services are deterministic
// fixtures. The separate live-host check verifies the actual DSH main slot.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../dist/index.js';
import { launchBrowser } from './browser-harness.mjs';

const root = await mkdtemp(join(tmpdir(), 'autoresearch-native-panel-'));
await mkdir(join(root, 'paper'));
const sourcePath = join(root, 'paper/main.tex');
await writeFile(sourcePath, String.raw`\documentclass{article}
\begin{document}Research paper\end{document}`);
const routes = [];
const registry = { list: () => [{ id: 'ws-a', path: root, title: 'Test research project' }] };
const dispose = await apply({
  get: name => name === 'workspaceRegistry' ? registry : undefined,
  webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } },
}, { workbench: { compiler: join(root, 'missing-compiler') } });
const [react, reactDom, client] = await Promise.all([
  readFile(new URL('../node_modules/react/umd/react.development.js', import.meta.url), 'utf8'),
  readFile(new URL('../node_modules/react-dom/umd/react-dom.development.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/client.js', import.meta.url), 'utf8'),
]);
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font-family:Arial}body{display:flex}nav{width:180px;padding:12px;box-sizing:border-box;flex-shrink:0}nav button{display:block;margin-bottom:12px}#root{flex:1;min-width:0;height:100%;overflow:hidden}
</style><nav><button id="entry">科研工作台</button><button id="plugins">插件</button><button id="session">其他会话</button><button id="new-session">新会话</button></nav><main id="root"></main>
<script>window.__ModuleLoader__={load(spec){window.bundle=spec}}</script><script>${react}</script><script>${reactDom}</script><script>${client}</script><script>
const h=React.createElement, root=ReactDOM.createRoot(document.querySelector('#root')), panels=new Map(), listeners=new Set();
window.testState={current:'research-a',draft:'',created:0,ordinaryCreated:0,active:null};
const records={'research-a':{agentPreset:'auto-research'},other:{agentPreset:'general'}};
function render(){root.render(testState.active==='autoresearch'?h(panels.get('autoresearch')):h('section',{'data-native-page':testState.active||'conversation'},testState.active||'Native conversation',h('textarea',{readOnly:true,value:testState.draft})))}
const layout={selectPanel(id){testState.active=id;render()}};
const sessions={list:{getSnapshot:()=>({phase:'ready',current:testState.current,byId:records}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}},scope:()=>ctx,refresh:async()=>{},open(id){testState.current=id;for(const fn of listeners)fn()}};
const workspaces={list:{getSnapshot:()=>({phase:'ready',items:[{workspaceId:'ws-a',sessionIds:Object.keys(records)}]}),subscribe(){return()=>{}}}};
const workspace={openSession(id){sessions.open(id);layout.selectPanel(null)},startSession(){testState.ordinaryCreated++}};
const services={layout,sessions,workspaces,uiWorkspace:workspace,'remote.session':{async create(){const sessionId='fresh-'+(++testState.created);records[sessionId]={agentPreset:'auto-research'};return{ok:true,value:{sessionId}}}},conversation:{input:{for:()=>({state:{getSnapshot:()=>({draft:testState.draft})},setDraft(value){testState.draft=value}})}}};
const ctx={get:name=>services[name],locale:{register(){}},slots:{inject(_name,fn){return fn()},register(options,component){if(options.name==='main')panels.set(options.key,component);return()=>{}}}};
window.navigate=layout;window.workspace=workspace;
window.bundle.factory(()=>React).apply(ctx);
document.querySelector('#entry').onclick=()=>layout.selectPanel('autoresearch');
document.querySelector('#plugins').onclick=()=>layout.selectPanel('plugins');
document.querySelector('#session').onclick=()=>workspace.openSession('other');
document.querySelector('#new-session').onclick=()=>workspace.startSession();
render();
</script>`;
const server = createServer((req, res) => {
  const route = routes.find(item => req.url?.startsWith(item.path));
  if (route) return void Promise.resolve(route.handler(req, res)).catch(() => { res.statusCode = 500; res.end(); });
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await launchBrowser();
  const { evaluate, waitFor, page } = browser;
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await waitFor(`Boolean(document.querySelector('[data-native-page="conversation"]'))`);
  const frame = `document.querySelector('[data-autoresearch-paper-frame]')`;
  const enter = async () => {
    await evaluate(`document.querySelector('#entry').click()`);
    await waitFor(`${frame}?.contentDocument?.querySelector('#editor')?.value.includes('Research paper')`);
    await waitFor(`!${frame}.contentDocument.querySelector('#editor').disabled`);
  };
  await enter();
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-native-page],.ar-native-grip,.ar-native-chat-border'))`), false);
  await evaluate(`window.savedFrame=${frame};document.querySelector('#entry').click()`);
  assert.equal(await evaluate(`savedFrame===${frame}`), true);
  // Edit and leave in one task, before the iframe's context message can arrive.
  const cancel = await evaluate(`(()=>{const w=${frame}.contentWindow,e=w.document.querySelector('#editor');w.confirmCalls=0;w.confirm=()=>{w.confirmCalls++;return false};e.value+=String.fromCharCode(10)+'% unsaved draft';e.dispatchEvent(new w.Event('input',{bubbles:true}));document.querySelector('.ar-native-back').click();return {calls:w.confirmCalls,value:e.value}})()`);
  assert.equal(cancel.calls, 1); assert.match(cancel.value, /unsaved draft/);
  await evaluate(`document.querySelector('#plugins').click();document.querySelector('#session').click();document.querySelector('#new-session').click()`);
  assert.equal(await evaluate('testState.active'), 'autoresearch');
  assert.equal(await evaluate('testState.current'), 'research-a');
  assert.equal(await evaluate('testState.created'), 0);
  assert.equal(await evaluate(`${frame}.contentWindow.confirmCalls`), 4);
  await evaluate(`${frame}.contentDocument.querySelector('#save').click()`);
  await waitFor(`${frame}.contentDocument.querySelector('#save-state').textContent==='已保存'`);
  assert.match(await readFile(sourcePath, 'utf8'), /unsaved draft/);
  const screenshot = await browser.screenshot('native-panel-with-paper.png');
  await evaluate(`document.querySelector('.ar-native-back').click()`);
  await waitFor(`!${frame} && Boolean(document.querySelector('[data-native-page="conversation"]'))`);
  await enter();
  await evaluate(`(()=>{const w=${frame}.contentWindow,e=w.document.querySelector('#editor');e.value+=String.fromCharCode(10)+'% discarded draft';e.dispatchEvent(new w.Event('input',{bubbles:true}));w.confirm=()=>true;document.querySelector('#plugins').click()})()`);
  await waitFor(`!${frame} && Boolean(document.querySelector('[data-native-page="plugins"]'))`);
  assert.doesNotMatch(await readFile(sourcePath, 'utf8'), /discarded draft/);
  await enter();
  await waitFor(`!document.querySelector('[data-ar-prompt=review]').disabled`);
  await evaluate(`document.querySelector('[data-ar-prompt=review]').click()`);
  await waitFor(`!${frame} && testState.draft.includes('证据')`);
  assert.equal(await evaluate('testState.current'), 'research-a');
  assert.equal(await evaluate(`document.querySelector('textarea').value===testState.draft`), true);
  await enter();
  await evaluate(`document.querySelector('#new-session').click()`);
  await waitFor(`!${frame} && testState.current==='fresh-1'`);
  assert.equal(await evaluate('testState.created'), 1);
  await evaluate(`document.querySelector('#new-session').click()`);
  assert.equal(await evaluate('testState.ordinaryCreated'), 1, 'Unmount restores the normal native new-session action');
  assert.deepEqual(browser.exceptions, []);
  console.log(JSON.stringify({ status: 'passed', fullPage: true, repeatedEntry: true, cancelBeforeContext: true, saveAndLeave: true, discardAndLeave: true, draftThenChat: true, sessionGuardAndCleanup: true, screenshot }));
} catch (error) {
  if (browser) console.log(JSON.stringify({ screenshot: await browser.screenshot('native-panel-failure.png'), exceptions: browser.exceptions, text: (await browser.evaluate('document.body.innerText')).slice(0, 1200) }));
  throw error;
} finally {
  await browser?.close();
  await dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
