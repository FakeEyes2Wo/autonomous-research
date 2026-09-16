import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../dist/index.js';
import { launchBrowser } from './browser-harness.mjs';

const keys = ['paperId', 'title', 'authors', 'yearVersion', 'publicationStatus', 'researchQuestion', 'methods', 'experimentTaskData', 'coreResults', 'limitationsCounterevidence', 'currentResearchRelationship', 'baselineFit', 'readingCoverage', 'sourceLocation', 'ingestionStatus'];
const title = '中文文献与反证 '.repeat(35);
const row = (id, text, acquisition = 'acquired') => ({ work: { id, title: text }, acquisition, parse: 'partial', index: 'indexed',
  versions: [{ id: `${id}-v1`, versionLabel: 'v1', mediaType: 'text/html' }, { id: `${id}-v2`, versionLabel: 'v2', mediaType: 'application/pdf' }],
  header: Object.fromEntries(keys.map(key => [key, { values: key === 'title' ? [text] : [], display: key === 'title' ? text : key === 'readingCoverage' ? 'unread' : 'unknown', status: key === 'readingCoverage' ? 'unread' : 'unknown', origin: 'system' }])) });
const span = { id: 'span1', documentId: 'paper-v2', workId: 'paper', evidenceText: '中文反证：效果并不稳定。', sectionPath: ['结果'], locator: { kind: 'pdf', page: 2 }, quality: 'needs_review', sourceKind: 'full_text' };
// Two real PDF pages exercise PDF.js rendering and page targeting without a compiler.
function pdf() {
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', ...['First page', 'Evidence page two'].map(t => { const s = `BT /F1 16 Tf 20 200 Td (${t}) Tj ET`; return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`; })];
  let output = '%PDF-1.4\n'; const offsets = [0];
  bodies.forEach((body, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const start = output.length; output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(output + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
}
const root = await mkdtemp(join(tmpdir(), 'literature-browser-'));
const routes = [], calls = { import: 0, index: 0 }, queries = [];
let generation = 'g1', held = null, release = null, holdSource = false, operationResult = { id: 'op', status: 'completed' };
async function waitUntil(check) { const deadline = Date.now() + 10000; while (!check()) { assert.ok(Date.now() < deadline, 'Timed out waiting for service request'); await new Promise(resolve => setTimeout(resolve, 20)); } }
const service = {
  listPapers: async ({ projectId, afterId }) => ({ rows: projectId === 'p2' ? [row('second', '第二项目')] : afterId ? [row('missing', '只有摘要', 'abstract_only')] : [row('paper', title)], nextId: projectId === 'p1' && !afterId ? 'paper' : null, generationId: generation }),
  search: async request => { queries.push(request); if (request.query === '延迟') await new Promise(resolve => { release = resolve; held = 'search'; }); return { status: 'ok', hits: [{ span, rank: 1, score: 1 }], receiptId: 'receipt' }; },
  getSpan: async () => span,
  getSource: async ({ documentId }) => { if (holdSource && documentId.endsWith('v1')) { held = 'source'; await new Promise(resolve => { release = resolve; }); } return documentId.startsWith('missing') ? null : documentId.endsWith('v2') ? { mediaType: 'application/pdf', bytes: pdf() } : { mediaType: 'text/plain', bytes: Buffer.from('<script>window.pwned=true</script>安全原文') }; },
  importSources: async () => { calls.import++; return { operationId: 'op', status: 'queued' }; },
  buildIndex: async () => { calls.index++; generation = 'g2'; return { operationId: 'op', status: 'queued' }; },
  getOperation: async () => operationResult,
};
const dispose = await apply({ autoresearchLiterature: service, webServer: { register(route) { routes.push(route); return () => {}; } } }, { standaloneProjects: true, projects: [{ id: 'p1', name: '第一项目', root }, { id: 'p2', name: '第二项目', root }] });
const server = createServer((req, res) => {
  const route = routes.find(r => req.url?.startsWith(r.path));
  if (route) return void Promise.resolve(route.handler(req, res)).catch(() => { res.statusCode = 500; res.end(); });
  res.end('<title>DSH</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await launchBrowser(); const { page, evaluate, waitFor } = browser;
  await page('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/autoresearch/?projectId=p1` });
  await waitFor('document.querySelector("#project")?.value === "p1"');
  assert.equal(await evaluate('!!document.querySelector("#literature-open")'), true, 'workbench exposes literature entry');
  await evaluate('document.querySelector("#literature-open").click()');
  await waitFor('document.querySelector("#literature-list").textContent.includes("中文文献")');
  assert.match(await evaluate('document.querySelector("#literature-list").textContent'), /未读/);
  assert.match(await evaluate('document.querySelector("#literature-list").textContent'), /部分解析/);
  await evaluate('document.querySelector("#literature-list summary").click()');
  assert.equal(await evaluate('document.querySelectorAll("#literature-list dl dt").length'), 15);
  await evaluate('document.querySelector(".literature-read").click()');
  await waitFor('document.querySelector("#literature-source-text").textContent.includes("安全原文")');
  assert.equal(await evaluate('window.pwned === undefined'), true);
  await evaluate('document.querySelector("#literature-query").value="中文反证";document.querySelector("#literature-search").requestSubmit()');
  await waitFor('document.querySelector("#literature-results").textContent.includes("效果并不稳定")');
  assert.equal(queries.at(-1).query, '中文反证');
  await evaluate('document.querySelector(".literature-hit-open").focus()');
  assert.equal(await evaluate('document.activeElement.className'), 'literature-hit-open');
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor('document.querySelector("#literature-canvas").dataset.renderedPage === "2"');
  assert.match(await evaluate('document.querySelector("#literature-source-caption").textContent'), /第 2 页/);
  assert.match(await evaluate('document.querySelector("#literature-excerpt").textContent'), /效果并不稳定/);
  // Old document response cannot replace a newer PDF selection.
  holdSource = true;
  await evaluate('document.querySelector(".literature-read").click()');
  await waitFor('document.querySelector("#literature-source-caption").textContent.includes("加载")');
  await waitUntil(() => held === 'source');
  await evaluate('document.querySelector(".literature-hit-open").click()');
  await waitFor('document.querySelector("#literature-canvas").dataset.renderedPage === "2"');
  release(); holdSource = false; held = null;
  // Generation refresh cancels an old search, including its late response.
  await evaluate('document.querySelector("#literature-query").value="延迟";document.querySelector("#literature-search").requestSubmit()');
  await waitUntil(() => held === 'search');
  await evaluate('document.querySelector("#literature-index").click()');
  await waitFor('document.querySelector("#literature-generation").textContent.includes("g2")');
  release(); held = null;
  assert.equal(await evaluate('document.querySelectorAll("#literature-results article").length'), 0);
  await evaluate('document.querySelector("#literature-more").click()');
  await waitFor('document.querySelector("#literature-list").textContent.includes("只有摘要")');
  assert.match(await evaluate('document.querySelector("#literature-list").textContent'), /全文不可用/);
  await evaluate('document.querySelectorAll(".literature-read")[1].click()');
  await waitFor('document.querySelector("#literature-source-caption").textContent.includes("不可用")');
  await evaluate('document.querySelector("#literature-manifest").value=JSON.stringify({documents:[]});document.querySelector("#literature-import").click()');
  await waitFor('document.querySelector("#literature-operation").textContent.includes("完成")');
  assert.deepEqual(calls, { import: 1, index: 1 });
  generation = null;
  await evaluate('document.querySelector("#literature-refresh").click()');
  await waitFor('document.querySelector("#literature-generation").textContent.includes("尚未建索引")');
  const queriesBefore = queries.length;
  await evaluate('document.querySelector("#literature-query").value="反证";document.querySelector("#literature-search").requestSubmit()');
  await waitFor('document.querySelector("#literature-status").textContent.includes("尚未建索引")');
  assert.equal(queries.length, queriesBefore, 'missing generation does not retrieve or build implicitly');
  assert.equal(calls.index, 1);
  operationResult = { id: 'op', status: 'running', interrupted: true };
  await evaluate('document.querySelector("#literature-index").click()');
  await waitFor('document.querySelector("#literature-operation").textContent.includes("中断")');
  assert.equal(await evaluate('document.querySelector("#literature-index").disabled'), false);
  operationResult = { id: 'op', status: 'failed', error: 'LITERATURE_OPERATION_FAILED' };
  await evaluate('document.querySelector("#literature-index").click()');
  await waitFor('document.querySelector("#literature-operation").textContent.includes("失败")');
  generation = 'g2';
  await evaluate('document.querySelector("#literature-refresh").click()');
  await waitFor('document.querySelector("#literature-generation").textContent.includes("g2")');
  console.log('desktop screenshot:', await browser.screenshot('literature-desktop.png'));
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.querySelector("#literature-dialog").scrollWidth <= document.querySelector("#literature-dialog").clientWidth'), true, 'long titles fit mobile dialog');
  console.log('mobile screenshot:', await browser.screenshot('literature-mobile.png'));
  await evaluate('document.querySelector("#literature-query").value="延迟";document.querySelector("#literature-search").requestSubmit()');
  await waitUntil(() => held === 'search');
  await evaluate('document.querySelector("#literature-close").click();document.querySelector("#project").value="p2";document.querySelector("#project").dispatchEvent(new Event("change"));document.querySelector("#literature-open").click()');
  await waitFor('document.querySelector("#literature-list").textContent.includes("第二项目")');
  release(); held = null;
  assert.equal(await evaluate('document.querySelector("#literature-list").textContent.includes("中文文献")'), false);
  assert.equal(await evaluate('document.querySelector("#literature-excerpt").textContent'), '');
  assert.equal(await evaluate('document.querySelectorAll("#literature-results article").length'), 0);
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor('!document.querySelector("#literature-dialog").open');
  assert.deepEqual(browser.exceptions, []);
  console.log('Literature browser passed: 15 fields, safe text, PDF page 2, stale document/generation, Chinese search, pagination, missing source, explicit operations, keyboard and mobile layout.');
} finally { release?.(); await browser?.close(); dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
