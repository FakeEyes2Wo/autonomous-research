import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../dist/index.js';
import { launchBrowser } from './browser-harness.mjs';

async function waitForFileContains(path, expected, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await readFile(path, 'utf8')).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expected} in ${path}`);
}

const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-project-'));
await mkdir(join(root, 'paper'));
const secondRoot = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-project-second-'));
await mkdir(join(secondRoot, 'paper'));
const source = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\title{A Research Workspace}
\author{AutoResearch}
\date{}
\begin{document}
\maketitle
\begin{abstract}
A local workspace for turning research ideas into reproducible papers.
\end{abstract}
\section{Introduction}
Edit the source, compile the paper, and return to your research tools.
\section{Method}
We keep the source and the compiled result together in the project.
\[ E = mc^2 \]
\end{document}
`;
const sourcePath = join(root, 'paper/main.tex');
await writeFile(sourcePath, source);
const secondSource = source.replace('A Research Workspace', 'A Second Research Workspace').replace('local workspace', 'second local workspace');
const secondSourcePath = join(secondRoot, 'paper/main.tex');
await writeFile(secondSourcePath, secondSource);
const routes = [];
const dispose = await apply({ webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } } }, { standaloneProjects: true, projects: [{ id: 'smoke', name: 'Research project', root }, { id: 'second', name: 'Second project', root: secondRoot }], workbench: { ...(process.env.TECTONIC_PATH ? { compiler: process.env.TECTONIC_PATH } : {}) } });
let holdNextSave = false;
let saveRequestStarted;
let releaseHeldSave;
let projectListRequests = 0;
let holdPdf = false;
const server = createServer((req, res) => {
  const route = routes.find((item) => req.url?.startsWith(item.path));
  if (route) {
    if (req.url?.startsWith('/api/autoresearch/projects')) projectListRequests += 1;
    if (holdPdf && req.url?.startsWith('/api/autoresearch/workbench/pdf')) return;
    const holdThisSave = holdNextSave && req.method === 'PUT' && req.url?.startsWith('/api/autoresearch/workbench/document');
    if (holdThisSave) {
      holdNextSave = false;
      saveRequestStarted?.();
      return void new Promise((resolve) => { releaseHeldSave = resolve; }).then(() => route.handler(req, res)).catch(() => { res.statusCode = 500; res.end(); });
    }
    return void Promise.resolve(route.handler(req, res)).catch(() => { res.statusCode = 500; res.end(); });
  }
  if (req.url === '/embedded-paper-test') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(`<iframe id="paper-frame" style="width:95vw;height:90vh" src="/autoresearch/?embedded=1&workspaceManaged=1"></iframe><script>window.paperMessages=[];addEventListener('message',e=>{const frame=document.querySelector('iframe');if(e.origin!==location.origin||!frame||e.source!==frame.contentWindow)return;paperMessages.push(e.data);if(e.data?.type==='exit')frame.remove()})</script>`);
  }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<title>DSH</title><main>DSH native tools</main><script>
    window.drafts=[]; window.binds=[];
    addEventListener('message',e=>{
      if(e.origin!==location.origin||e.source!==parent||e.data?.channel!=='autoresearch-workbench')return;
      const d=e.data;const send=data=>parent.postMessage({channel:d.channel,...data},location.origin);
      if(d.type==='request-ready')send({type:'native-ready'});
      if(d.type==='bind-session'){window.binds.push(d);send({type:'session-ready',projectId:d.projectId,sessionId:'test_native_session',bindId:d.bindId});}
      if(d.type==='draft'){window.drafts.push(d.text);send({type:'draft-ready',projectId:d.projectId});}
    });
    parent.postMessage({channel:'autoresearch-workbench',type:'native-ready'},location.origin);
  </script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser; let relocatedServer; let disposeRelocated;
try {
  browser = await launchBrowser();
  const { page, evaluate, waitFor } = browser;
  const url = `http://127.0.0.1:${server.address().port}/autoresearch/?projectId=smoke`;
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url });
  await waitFor('document.querySelector("#editor")?.value.includes("A Research Workspace")');
  await waitFor('!document.querySelector("#chat-generate").disabled');
  assert.equal(await evaluate('document.querySelector("#research-chat").getBoundingClientRect().bottom <= innerHeight - 12'), true);
  assert.equal(await evaluate('document.querySelector("#research-chat").getBoundingClientRect().left >= 12'), true);
  await evaluate('document.querySelector("#chat-refine").click()');
  await waitFor('document.querySelector("#native-chat").contentWindow.drafts.length === 1');
  assert.match(await evaluate('document.querySelector("#native-chat").contentWindow.drafts[0]'), /paper\/main.tex/);
  assert.equal(await evaluate('document.querySelector("#native-chat").contentWindow.binds.length'), 1);
  await evaluate('document.querySelector("#chat-collapse").click()');
  assert.equal(await evaluate('document.querySelector("#chat-content").hidden'), true);
  await evaluate('document.querySelector("#chat-collapse").click();document.querySelector("#chat-resize").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true}))');
  assert.equal(await evaluate('document.querySelector("#compile").disabled'), false, 'Install Tectonic in PATH or set TECTONIC_PATH for real compile verification.');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await evaluate(`document.querySelector('#editor').value += ${JSON.stringify('\n% saved by browser smoke\n')}; document.querySelector('#editor').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#save').click();`);
  await waitFor('document.querySelector("#save-state").textContent === "已保存"');
  assert.match(await readFile(sourcePath, 'utf8'), /saved by browser smoke/);
  await evaluate('document.querySelector("#compile").click()');
  await waitFor('document.querySelector("#pdf-canvas").dataset.renderedPage === "1" || document.querySelector("#build-state").textContent.includes("失败")', 180000);
  assert.equal(await evaluate('document.querySelector("#pdf-canvas").dataset.renderedPage'), '1', await evaluate('document.querySelector("#build-log").textContent'));
  await waitFor('document.querySelector("#pdf-text").textContent.includes("A Research Workspace")');
  assert.equal(await evaluate('document.querySelector("#preview-state").textContent'), '与已保存内容一致');
  const screenshot = await browser.screenshot('workbench-desktop.png');
  // PDF reads and zoom/navigation do not compile again or mutate the source.
  const pdfBytes = await evaluate(`(async()=>{const r=await fetch(document.querySelector('#download').href,{headers:{Range:'bytes=0-4'}});return {status:r.status,text:await r.text()}})()`);
  assert.equal(pdfBytes.status, 206); assert.equal(pdfBytes.text, '%PDF-');
  const invalidSource = source.replace(String.raw`\end{document}`, String.raw`\undefinedResearchCommand` + '\n' + String.raw`\end{document}`);
  await evaluate(`document.querySelector('#editor').value = ${JSON.stringify(invalidSource)}; document.querySelector('#editor').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#compile').click();`);
  await waitFor('document.querySelector("#build-state").textContent.includes("失败")', 180000);
  assert.equal(await evaluate('document.querySelector("#pdf-canvas").hidden'), false, 'Failed compile keeps previous PDF visible');
  assert.match(await evaluate('document.querySelector("#preview-state").textContent'), /较旧/);
  await evaluate(`document.querySelector('#editor').value = ${JSON.stringify(source)}; document.querySelector('#editor').dispatchEvent(new Event('input',{bubbles:true}));`);
  await writeFile(sourcePath, source + '\n% external DSH edit\n');
  await evaluate('document.querySelector("#save").click()');
  await waitFor('document.querySelector("#notice").textContent.includes("其他窗口")');
  assert.equal(await evaluate('document.querySelector("#editor").value'), source);
  assert.match(await readFile(sourcePath, 'utf8'), /external DSH edit/);
  await evaluate('window.confirm=()=>true; document.querySelector("#reload").click()');
  await waitFor('document.querySelector("#editor").value.includes("external DSH edit") && !document.querySelector("#reload").disabled');
  // Two successive tool-style edits synchronize through the real file API.
  await writeFile(sourcePath, source + '\n% discussion revision one\n');
  await waitFor('document.querySelector("#editor").value.includes("discussion revision one")');
  await evaluate('document.querySelector("#editor").value += "% unsaved local thought";document.querySelector("#editor").dispatchEvent(new Event("input",{bubbles:true}))');
  await writeFile(sourcePath, source + '\n% discussion revision two\n');
  await waitFor('!document.querySelector("#sync-notice").hidden && document.querySelector("#sync-message").textContent.includes("未保存草稿")');
  assert.match(await evaluate('document.querySelector("#editor").value'), /unsaved local thought/);
  assert.equal(await evaluate('document.querySelector("#chat-refine").disabled'), true);
  await evaluate('document.querySelector("#load-update").click()');
  await waitFor('document.querySelector("#editor").value.includes("discussion revision two") && !document.querySelector("#reload").disabled');
  await mkdir(join(root, '.runs/run-discussion/paper'), { recursive: true });
  await writeFile(join(root, '.runs/run-discussion/paper/main.tex'), source);
  await waitFor('document.querySelector("#sync-message").textContent.includes(".runs/run-discussion/paper/main.tex")');
  assert.match(await evaluate('document.querySelector("#editor").value'), /discussion revision two/, 'Discovery must preserve the selected paper');
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('document.querySelector("#preview-tab").click()');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const mobileScreenshot = await browser.screenshot('workbench-mobile.png');
  await evaluate('document.querySelector("#back-dsh").click()');
  await waitFor('document.body.textContent.includes("DSH native tools")');
  holdPdf = true;
  await page('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/embedded-paper-test` });
  await waitFor('document.querySelector("#paper-frame").contentDocument?.querySelector("#editor") && document.querySelector("#paper-frame").contentDocument.querySelector("#editor").disabled');
  assert.equal(await evaluate('document.querySelector("#paper-frame").contentWindow.location.search.includes("workspaceManaged=1")'), true);
  await waitFor('paperMessages.some(m=>m.type==="ready")');
  assert.equal(await evaluate('document.querySelector("#paper-frame").contentDocument.querySelector("#project").hidden'), true);
  projectListRequests = 0;
  await evaluate(`document.querySelector('#paper-frame').contentWindow.postMessage({channel:'autoresearch-workbench',type:'select-project',projectId:'smoke',selectionId:'managed-smoke-1'},location.origin)`);
  await waitFor('[...document.querySelector("#paper-frame").contentDocument.querySelector("#document").options].some(option=>option.textContent==="paper/main.tex")');
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;const select=w.document.querySelector('#document');select.value=[...select.options].find(option=>option.textContent==='paper/main.tex').value;select.dispatchEvent(new w.Event('change',{bubbles:true}))})()`);
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#document-name").textContent === "paper/main.tex" && document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("A Research Workspace")');
  await waitFor('!document.querySelector("#paper-frame").contentDocument.querySelector("#new-document").disabled');
  assert.ok(projectListRequests >= 1, 'A parent workspace selection refreshes the authoritative project list before loading.');
  await waitFor('paperMessages.some(m=>m.type==="context" && m.selectionId==="managed-smoke-1")');
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;const e=w.document.querySelector('#editor');e.value+=String.fromCharCode(10)+'% managed cached draft';e.dispatchEvent(new w.Event('input',{bubbles:true}));w.postMessage({channel:'autoresearch-workbench',type:'select-project',projectId:'second',selectionId:'managed-second-2'},location.origin)})()`);
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("A Second Research Workspace")');
  await evaluate(`document.querySelector('#paper-frame').contentWindow.postMessage({channel:'autoresearch-workbench',type:'select-project',projectId:'smoke',selectionId:'managed-smoke-3'},location.origin)`);
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("managed cached draft")');
  await waitFor('paperMessages.some(m=>m.type==="context" && m.selectionId==="managed-smoke-3" && m.document?.relativePath)');
  // A save that returns after a workspace switch must update the cached base
  // revision without discarding typing that happened after the save started.
  holdNextSave = true;
  const saveStarted = new Promise((resolve) => { saveRequestStarted = resolve; });
  await evaluate(`document.querySelector('#paper-frame').contentDocument.querySelector('#save').click()`);
  await saveStarted;
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;const e=w.document.querySelector('#editor');e.value+=String.fromCharCode(10)+'% newer than delayed save';e.dispatchEvent(new w.Event('input',{bubbles:true}));w.postMessage({channel:'autoresearch-workbench',type:'select-project',projectId:'second',selectionId:'managed-second-4'},location.origin)})()`);
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("A Second Research Workspace")');
  await evaluate(`document.querySelector('#paper-frame').contentWindow.postMessage({channel:'autoresearch-workbench',type:'select-project',projectId:'smoke',selectionId:'managed-smoke-5'},location.origin)`);
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("newer than delayed save") && document.querySelector("#paper-frame").contentDocument.querySelector("#save-state").textContent === "未保存"');
  releaseHeldSave();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await evaluate(`document.querySelector('#paper-frame').contentDocument.querySelector('#save').click()`);
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#save-state").textContent === "已保存"');
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;const e=w.document.querySelector('#editor');e.value+=String.fromCharCode(10)+'% managed local conflict draft';e.dispatchEvent(new w.Event('input',{bubbles:true}))})()`);
  assert.equal(await evaluate('document.querySelector("#paper-frame").contentDocument.querySelector("#save-state").textContent'), '未保存', 'The managed conflict driver must establish a local dirty draft before the external edit.');
  await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}\n% external while managed draft was away\n`);
  await evaluate(`document.querySelector('#paper-frame').contentDocument.querySelector('#save').click()`);
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#notice").textContent.includes("其他窗口")');
  assert.equal(await evaluate('document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("managed local conflict draft")'), true);
  await evaluate(`document.querySelector('#paper-frame').contentWindow.postMessage({channel:'autoresearch-workbench',type:'select-project',projectId:null,selectionId:'managed-none-6'},location.origin)`);
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#editor").disabled && document.querySelector("#paper-frame").contentDocument.querySelector("#notice").textContent.includes("DSH")');
  const managedProjectAfterNull = await evaluate('document.querySelector("#paper-frame").contentDocument.querySelector("#project-name").textContent');
  assert.match(managedProjectAfterNull, /DSH/);
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;w.dispatchEvent(new w.MessageEvent('message',{origin:location.origin,source:w,data:{channel:'autoresearch-workbench',type:'select-project',projectId:'second'}}))})()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate('document.querySelector("#paper-frame").contentDocument.querySelector("#project-name").textContent'), managedProjectAfterNull);
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;const data={channel:'autoresearch-workbench',type:'theme',values:{'--dsw-alias-button-info-fill':'red'}};w.dispatchEvent(new w.MessageEvent('message',{origin:location.origin,source:w,data}));w.dispatchEvent(new w.MessageEvent('message',{origin:'https://untrusted.example',source:window,data}))})()`);
  assert.equal(await evaluate('document.querySelector("#paper-frame").contentDocument.documentElement.style.getPropertyValue("--dsw-alias-button-info-fill")'), '');
  await evaluate(`document.querySelector('#paper-frame').contentWindow.postMessage({channel:'autoresearch-workbench',type:'theme',values:{'--dsw-alias-button-info-fill':'rgb(10, 20, 220)','--dsw-alias-bg-base':'rgb(22, 24, 28)'},scheme:'dark'},location.origin)`);
  await waitFor('document.querySelector("#paper-frame").contentDocument.documentElement.style.colorScheme === "dark"');
  await waitFor('document.querySelector("#paper-frame").contentWindow.getComputedStyle(document.querySelector("#paper-frame").contentDocument.querySelector("#compile")).backgroundColor === "rgb(10, 20, 220)"');
  assert.equal(await evaluate('document.querySelector("#paper-frame").contentWindow.getComputedStyle(document.querySelector("#paper-frame").contentDocument.querySelector("#research-chat")).display'), 'none');
  await evaluate(`document.querySelector('#paper-frame').contentWindow.postMessage({channel:'autoresearch-workbench',type:'select-project',projectId:'second',selectionId:'managed-second-exit-7'},location.origin)`);
  await waitFor('paperMessages.some(m=>m.type==="context" && m.selectionId==="managed-second-exit-7" && m.document?.relativePath==="paper/main.tex") && document.querySelector("#paper-frame").contentDocument.querySelector("#document-name").textContent === "paper/main.tex" && !document.querySelector("#paper-frame").contentDocument.querySelector("#save").disabled');
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;const e=w.document.querySelector('#editor');e.value+=String.fromCharCode(10)+'% embedded draft';e.dispatchEvent(new w.Event('input',{bubbles:true}));w.confirm=()=>false;w.postMessage({channel:'autoresearch-workbench',type:'request-exit'},location.origin)})()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate('paperMessages.some(m=>m.type==="exit")'), false);
  await evaluate(`document.querySelector('#paper-frame').contentDocument.querySelector('#save').click()`);
  await waitForFileContains(secondSourcePath, '% embedded draft');
  assert.equal(await evaluate(`(async()=>{const w=document.querySelector('#paper-frame').contentWindow,d=w.document,projectId=d.querySelector('#project').value,documentId=d.querySelector('#document').value,response=await w.fetch('/api/autoresearch/workbench/document?'+new URLSearchParams({projectId,documentId}));return response.ok&&(await response.json()).source===d.querySelector('#editor').value})()`), true, 'The managed second-project save must reach the selected document.');
  assert.equal(await evaluate('document.querySelector("#paper-frame").contentDocument.querySelector("#save-state").textContent'), '未保存', 'The preserved smoke-project draft keeps the global dirty indicator active.');
  await evaluate(`document.querySelector('#paper-frame').contentWindow.postMessage({channel:'autoresearch-workbench',type:'select-project',projectId:'smoke',selectionId:'managed-smoke-exit-8'},location.origin)`);
  await waitFor('paperMessages.some(m=>m.type==="context" && m.selectionId==="managed-smoke-exit-8" && m.document?.relativePath==="paper/main.tex" && m.dirty===true) && document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("managed local conflict draft")');
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;w.confirm=()=>true;w.postMessage({channel:'autoresearch-workbench',type:'request-exit'},location.origin)})()`);
  await waitFor('paperMessages.some(m=>m.type==="exit") && !document.querySelector("#paper-frame")');

  // Move both the built plugin and the project. No original node_modules,
  // process-local registry or compiler is available to the relocated host.
  const relocation = await mkdtemp(join(tmpdir(), 'autoresearch-portable-'));
  await cp(new URL('../dist/', import.meta.url), join(relocation, 'plugin'), { recursive: true });
  await cp(root, join(relocation, 'project'), { recursive: true });
  const relocatedApply = (await import(pathToFileURL(join(relocation, 'plugin/index.js')).href)).apply;
  const relocatedRoutes = [];
  disposeRelocated = await relocatedApply({ webServer: { register(route) { relocatedRoutes.push(route); return () => {}; } } }, { standaloneProjects: true, projects: [{ id: 'moved', name: 'Moved project', root: join(relocation, 'project') }], workbench: { compiler: join(relocation, 'not-installed-tectonic') } });
  relocatedServer = createServer((req, res) => {
    const route = relocatedRoutes.find((item) => req.url?.startsWith(item.path));
    if (route) return void Promise.resolve(route.handler(req, res)).catch(() => { res.statusCode = 500; res.end(); });
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => relocatedServer.listen(0, '127.0.0.1', resolve));
  await page('Page.navigate', { url: `http://127.0.0.1:${relocatedServer.address().port}/autoresearch/` });
  await waitFor('document.querySelector("#editor") && !document.querySelector("#editor").disabled');
  await evaluate(`(()=>{const s=document.querySelector('#document');s.value=[...s.options].find(o=>o.text==='paper/main.tex').value;s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await waitFor('document.querySelector("#editor")?.value.includes("discussion revision two") && !document.querySelector("#editor").disabled');
  assert.equal(await evaluate('document.querySelector("#compile").disabled'), true);
  await evaluate('document.querySelector("#preview-tab").click()');
  await waitFor('document.querySelector("#pdf-canvas").dataset.renderedPage === "1"');
  assert.match(await evaluate('document.querySelector("#engine-state").textContent'), /未找到/);
  await evaluate('document.querySelector("#source-tab").click(); document.querySelector("#editor").value += "% moved and saved"; document.querySelector("#editor").dispatchEvent(new Event("input", {bubbles:true})); document.querySelector("#save").click()');
  await waitFor('document.querySelector("#save-state").textContent === "已保存"');
  assert.match(await readFile(join(relocation, 'project/paper/main.tex'), 'utf8'), /moved and saved/);
  // A polled deletion must leave a dirty document visible as a non-writable
  // orphan. Reload explicitly discards it instead of mapping the draft to a
  // new file in the same workspace.
  await page('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/embedded-paper-test` });
  await waitFor('paperMessages.some(m=>m.type==="ready")');
  await evaluate(`document.querySelector('#paper-frame').contentWindow.postMessage({channel:'autoresearch-workbench',type:'select-project',projectId:'smoke',selectionId:'orphan-1'},location.origin)`);
  await waitFor('[...document.querySelector("#paper-frame").contentDocument.querySelector("#document").options].some(option=>option.textContent==="paper/main.tex")');
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;const select=w.document.querySelector('#document');select.value=[...select.options].find(option=>option.textContent==='paper/main.tex').value;select.dispatchEvent(new w.Event('change',{bubbles:true}))})()`);
  await waitFor('paperMessages.some(m=>m.type==="context" && m.selectionId==="orphan-1" && m.document?.relativePath==="paper/main.tex") && document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("external while managed draft")');
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;const e=w.document.querySelector('#editor');e.value+=String.fromCharCode(10)+'% orphan draft';e.dispatchEvent(new w.Event('input',{bubbles:true}))})()`);
  await mkdir(join(root, 'replacement'));
  await writeFile(join(root, 'replacement', 'main.tex'), '% replacement document\n');
  await rm(sourcePath);
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#notice").textContent.includes("不再属于当前工作区") && document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("orphan draft")', 10000);
  assert.equal(await evaluate('document.querySelector("#paper-frame").contentDocument.querySelector("#save").disabled'), true);
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;w.confirm=()=>true;w.document.querySelector('#reload').click()})()`);
  await waitFor('!document.querySelector("#paper-frame").contentDocument.querySelector("#editor").disabled && !document.querySelector("#paper-frame").contentDocument.querySelector("#notice").textContent.includes("不再属于当前工作区") && [...document.querySelector("#paper-frame").contentDocument.querySelector("#document").options].some(option=>option.textContent==="replacement/main.tex")');
  await evaluate(`(()=>{const w=document.querySelector('#paper-frame').contentWindow;const select=w.document.querySelector('#document');select.value=[...select.options].find(option=>option.textContent==='replacement/main.tex').value;select.dispatchEvent(new w.Event('change',{bubbles:true}))})()`);
  await waitFor('paperMessages.some(m=>m.type==="context" && m.selectionId==="orphan-1" && m.document?.relativePath==="replacement/main.tex") && document.querySelector("#paper-frame").contentDocument.querySelector("#editor").value.includes("replacement document")');
  await rm(join(root, 'replacement', 'main.tex'));
  await waitFor('document.querySelector("#paper-frame").contentDocument.querySelector("#editor").disabled && document.querySelector("#paper-frame").contentDocument.querySelector("#notice").textContent.includes("当前论文已移除")', 10000);
  assert.deepEqual(browser.exceptions, []);
  console.log(JSON.stringify({ status: 'passed', realLatexCompilation: true, pdfRendered: true, failedBuildKeepsPreview: true, conflictPreservesDraft: true, livePaperSync: true, generatedPaperDiscovery: true, nativeChatBridgeMock: true, returnToHost: true, relocatedPackageAndProject: true, missingCompilerStillEditsAndPreviews: true, screenshot, mobileScreenshot, projectRoot: root }, null, 2));
} finally { await browser?.close(); dispose(); disposeRelocated?.(); if (relocatedServer) await new Promise((resolve) => relocatedServer.close(resolve)); await new Promise((resolve) => server.close(resolve)); }
