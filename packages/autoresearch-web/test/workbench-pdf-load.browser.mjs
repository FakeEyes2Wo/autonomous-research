import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../dist/index.js';
import { launchBrowser } from './browser-harness.mjs';

const root = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-stalled-pdf-'));
await mkdir(join(root, 'paper'));
await writeFile(join(root, 'paper', 'main.tex'), '% source remains editable while PDF loads\n');
await writeFile(join(root, 'paper', 'main.pdf'), '%PDF-1.4\n%%EOF\n');
const routes = [];
let pdfRequests = 0;
const dispose = await apply({ webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } } }, { standaloneProjects: true, projects: [{ id: 'stalled', name: 'Stalled PDF project', root }], workbench: { compiler: join(root, 'missing-tectonic') } });
const server = createServer((req, res) => {
  const route = routes.find((item) => req.url?.startsWith(item.path));
  if (route) {
    if (req.url?.startsWith('/api/autoresearch/workbench/pdf')) {
      pdfRequests += 1;
      req.once('close', () => res.destroy());
      return;
    }
    return void Promise.resolve(route.handler(req, res)).catch(() => { res.statusCode = 500; res.end(); });
  }
  if (req.url === '/embedded') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end('<iframe id="paper" src="/autoresearch/?embedded=1&workspaceManaged=1"></iframe><script>window.messages=[];addEventListener("message",e=>{if(e.origin===location.origin&&e.source===document.querySelector("#paper").contentWindow)messages.push(e.data)})</script>');
  }
  res.statusCode = 404; res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await launchBrowser();
  const { page, evaluate, waitFor } = browser;
  await page('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/embedded` });
  await waitFor('messages.some(m=>m.type==="ready")');
  await evaluate('document.querySelector("#paper").contentWindow.postMessage({channel:"autoresearch-workbench",type:"select-project",projectId:"stalled",selectionId:"stalled-pdf"},location.origin)');
  await waitFor('document.querySelector("#paper").contentDocument.querySelector("#editor").value.includes("source remains editable")');
  await waitFor('!document.querySelector("#paper").contentDocument.querySelector("#new-document").disabled', 4000);
  await new Promise((resolve) => setTimeout(resolve, 6500));
  assert.equal(await evaluate('document.querySelector("#paper").contentDocument.querySelector("#save-state").textContent'), '已保存');
  assert.equal(pdfRequests, 1, 'the same pending PDF version must not be requested again by polling');
  assert.deepEqual(browser.exceptions, []);
  console.log(JSON.stringify({ status: 'passed', stalledPdfDoesNotBlockEditor: true }, null, 2));
} finally {
  await browser?.close();
  dispose();
  await new Promise((resolve) => server.close(resolve));
}
