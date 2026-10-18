// Focused browser verification for the two workbench behaviours added on top of
// the existing suite (it is intentionally not part of `npm test`, which stays
// headless-free):
//   1. the editor auto-opens the final manuscript as soon as the pipeline write
//      shows up in the documents listing, and never discards an unsaved draft;
//   2. the toolbar button drives DSH open-in-app with the canonical project root
//      and degrades with explicit Chinese copy when nothing is available.
//
// Run with: node test/final-paper.browser.mjs   (set BROWSER_PATH if needed)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../dist/index.js';
import { launchBrowser } from './browser-harness.mjs';

const root = await mkdtemp(join(tmpdir(), 'autoresearch-final-paper-'));
const growRoot = join(root, 'grow');
const runsRoot = join(root, 'runs-project');
await mkdir(growRoot, { recursive: true });
await mkdir(join(runsRoot, '.runs', 'run-1', 'paper'), { recursive: true });
await writeFile(join(runsRoot, '.runs', 'run-1', 'paper', 'main.tex'), '% run one manuscript\n');

// The host route is stubbed here: this file proves the browser side of the
// contract (app choice, absolute directory, degradation). The real
// /open-in-app/apps|open routes are verified against the live host separately.
let apps = ['vscode', 'cursor'];
let failOpen = false;
const opens = [];
const routes = [];
const dispose = await apply(
  { webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } } },
  { standaloneProjects: true, projects: [{ id: 'grow', name: 'Growing project', root: growRoot }, { id: 'runs', name: 'Run project', root: runsRoot }] },
);
const server = createServer((req, res) => {
  const send = (status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); };
  if (req.url?.startsWith('/open-in-app/apps')) return send(200, { apps });
  if (req.url?.startsWith('/open-in-app/open')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    return void req.on('end', async () => {
      let value = {};
      try { value = JSON.parse(body); } catch { value = {}; }
      opens.push(value);
      let directory = false;
      try { directory = (await stat(String(value.path))).isDirectory(); } catch { directory = false; }
      if (failOpen || !apps.includes(value.app) || !directory) return send(400, { error: { message: 'application is unavailable' } });
      send(200, { ok: true });
    });
  }
  const route = routes.find((item) => req.url?.startsWith(item.path));
  if (route) return void Promise.resolve(route.handler(req, res)).catch(() => { res.statusCode = 500; res.end(); });
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<title>DSH</title>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await launchBrowser();
  const { page, evaluate, waitFor } = browser;
  // "正在检查编译器…" is the HTML default; the listing has settled once it changes.
  const waitForLoaded = () => waitFor('document.querySelector("#engine-state") && !document.querySelector("#engine-state").textContent.includes("正在检查")');
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

  // 1. The pipeline writes the final manuscript into an empty project.
  await page('Page.navigate', { url: `${origin}/autoresearch/?projectId=grow` });
  await waitForLoaded();
  assert.equal(await evaluate('document.querySelector("#editor").disabled'), true, 'An empty project has nothing to open yet.');
  await mkdir(join(growRoot, 'paper'), { recursive: true });
  await writeFile(join(growRoot, 'paper', 'main.tex'), '\\documentclass{article}\n% final manuscript\n\\begin{document}\\end{document}\n');
  await waitFor('document.querySelector("#editor").value.includes("final manuscript")', 15000);
  assert.equal(await evaluate('document.querySelector("#document-name").textContent'), 'paper/main.tex');
  assert.match(await evaluate('document.querySelector("#notice").textContent'), /已自动打开最终论文：paper\/main\.tex/);
  const autoOpenShot = await browser.screenshot('final-paper-auto-open.png');

  // 2. The toolbar button asks for VS Code and hands over the canonical root.
  assert.equal(await evaluate('document.querySelector("#open-in-app").textContent'), '在 VS Code 中打开');
  await evaluate('document.querySelector("#open-in-app").click()');
  await waitFor('document.querySelector("#notice").textContent.includes("已在 VS Code 中打开项目目录")');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].app, 'vscode');
  assert.equal(String(opens[0].path).toLowerCase(), growRoot.toLowerCase());

  // 3. A run-scoped final paper is adopted, but a dirty draft blocks the switch.
  await page('Page.navigate', { url: `${origin}/autoresearch/?projectId=runs` });
  await waitFor('document.querySelector("#editor").value.includes("run one manuscript")', 15000);
  assert.equal(await evaluate('document.querySelector("#document-name").textContent'), '.runs/run-1/paper/main.tex');
  await evaluate('(()=>{const e=document.querySelector("#editor");e.value+="% unsaved local edit\\n";e.dispatchEvent(new Event("input",{bubbles:true}))})()');
  assert.equal(await evaluate('document.querySelector("#save-state").textContent'), '未保存');
  await mkdir(join(runsRoot, '.runs', 'run-2', 'paper'), { recursive: true });
  await writeFile(join(runsRoot, '.runs', 'run-2', 'paper', 'main.tex'), '% run two manuscript\n');
  await waitFor('document.querySelector("#sync-message").textContent.includes("最终论文已生成：.runs/run-2/paper/main.tex")', 15000);
  assert.equal(await evaluate('document.querySelector("#editor").value.includes("unsaved local edit")'), true, 'An unsaved draft must survive the auto-open.');
  assert.equal(await evaluate('document.querySelector("#document-name").textContent'), '.runs/run-1/paper/main.tex');
  // The sync notice is the explicit, opt-in way to adopt the new manuscript.
  await evaluate('window.confirm=()=>true; document.querySelector("#load-update").click()');
  await waitFor('document.querySelector("#document-name").textContent === ".runs/run-2/paper/main.tex"', 15000);
  assert.match(await evaluate('document.querySelector("#editor").value'), /run two manuscript/);

  // 4. Mobile width still fits after the extra toolbar button.
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page('Page.navigate', { url: `${origin}/autoresearch/?projectId=runs` });
  await waitFor('document.querySelector("#editor")?.value.includes("run two manuscript")', 15000);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  const mobileShot = await browser.screenshot('final-paper-mobile.png');

  // 5. Degradation: fall back to the first available app, then explain clearly.
  apps = ['cursor'];
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: `${origin}/autoresearch/?projectId=grow` });
  await waitForLoaded();
  await waitFor('document.querySelector("#open-in-app").textContent === "在 Cursor 中打开"');
  apps = [];
  await page('Page.navigate', { url: `${origin}/autoresearch/?projectId=grow` });
  await waitForLoaded();
  await waitFor('document.querySelector("#open-in-app").textContent === "在编辑器中打开"');
  await evaluate('document.querySelector("#open-in-app").click()');
  await waitFor('document.querySelector("#notice").textContent.includes("本机没有检测到可用编辑器")');
  failOpen = true;
  apps = ['cursor'];
  await page('Page.navigate', { url: `${origin}/autoresearch/?projectId=grow` });
  await waitForLoaded();
  await waitFor('document.querySelector("#open-in-app").textContent === "在 Cursor 中打开"');
  await evaluate('document.querySelector("#open-in-app").click()');
  await waitFor('document.querySelector("#notice").textContent.includes("无法在 Cursor 中打开项目目录")');

  assert.deepEqual(browser.exceptions, []);
  console.log(JSON.stringify({
    status: 'passed',
    autoOpenedFinalPaper: 'paper/main.tex',
    dirtyDraftProtected: true,
    explicitSwitchWorks: true,
    openInAppPayload: opens[0],
    fallbackLabel: '在 Cursor 中打开',
    unavailableMessage: '本机没有检测到可用编辑器',
    failureMessage: '无法在 Cursor 中打开项目目录',
    mobileNoOverflow: true,
    screenshots: [autoOpenShot, mobileShot],
    projectRoots: { growRoot, runsRoot },
  }, null, 2));
} finally {
  await browser?.close();
  dispose();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
