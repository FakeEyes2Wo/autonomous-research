import * as pdfjs from './vendor/pdfjs/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/autoresearch/vendor/pdfjs/pdf.worker.mjs';
const fields = { paperId: '论文 ID', title: '标题', authors: '作者', yearVersion: '年份 / 版本', publicationStatus: '发表状态', researchQuestion: '研究问题', methods: '方法', experimentTaskData: '实验 / 任务 / 数据', coreResults: '核心结果', limitationsCounterevidence: '局限 / 反证', currentResearchRelationship: '与当前研究关系', baselineFit: '基线适配', readingCoverage: '读取范围', sourceLocation: '来源位置', ingestionStatus: '入库状态' };
const statuses = { unread: '未读', unknown: '未知', unverified: '待核对', verified: '已核对' };
const origins = { system: '系统', source_metadata: '来源元数据', author_reported: '作者报告', agent_analysis: '分析', mixed: '混合来源' };
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function cell(value) { return value?.values?.length ? value.display : statuses[value?.status] || '未知'; }
function button(text, handler, className) { const el = node('button', text, className); el.type = 'button'; el.addEventListener('click', handler); return el; }

/** Browser only sends opaque IDs; all source text is inserted as textContent. */
export function installLiterature({ getCsrf }) {
  const dialog = document.querySelector('#literature-dialog');
  const $ = id => dialog.querySelector(`#literature-${id}`);
  let projectId = '', epoch = 0, generationId = null, nextId = null, rows = [], active = false;
  let pdfTask = null, pdf = null, renderTask = null, renderSequence = 0, currentPage = 1;
  let operationTimer;
  const controllers = new Map();
  function cancel(channel) { controllers.get(channel)?.abort(); controllers.delete(channel); }
  function begin(channel) {
    cancel(channel); const controller = new AbortController(), token = { epoch, projectId, generationId, controller };
    controllers.set(channel, controller);
    token.current = () => token.epoch === epoch && token.projectId === projectId && controllers.get(channel) === controller && !controller.signal.aborted;
    return token;
  }
  async function request(route, values, token, method = 'GET') {
    const query = method === 'GET' ? `?${new URLSearchParams({ projectId: token.projectId, ...values })}` : '';
    const response = await fetch(`/api/autoresearch/literature/${route}${query}`, { method, credentials: 'same-origin', signal: token.controller.signal,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json', 'x-autoresearch-csrf': getCsrf() } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ projectId: token.projectId, ...values }) } : {}) });
    if (!token.current()) throw new DOMException('Stale request', 'AbortError');
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(response.status === 404 ? '原文或项目不可用（404）；请刷新目录。' : response.status === 503 ? '文献服务暂不可用。' : `文献请求失败（${response.status} / ${problem.error?.code || 'request_failed'}）`);
    }
    return response;
  }
  function report(error, target = $('status'), token) { if (error.name !== 'AbortError' && (!token || token.current())) target.textContent = error.message; }
  function clearPdf() {
    ++renderSequence; renderTask?.cancel(); renderTask = null; pdfTask?.destroy().catch(() => {}); pdfTask = null; pdf = null;
    $('canvas').hidden = true; delete $('canvas').dataset.renderedPage; $('pdf-text').textContent = '';
    $('page-controls').hidden = true;
  }
  function clearSource() {
    cancel('source'); clearPdf(); $('source-text').textContent = ''; $('excerpt').textContent = ''; $('source-caption').textContent = ''; $('citation').value = '';
  }
  function clearSearch() { cancel('search'); $('results').replaceChildren(); }
  function reset() {
    ++epoch; for (const key of [...controllers.keys()]) cancel(key); clearTimeout(operationTimer);
    rows = []; generationId = null; nextId = null; clearSource(); clearSearch();
    $('list').replaceChildren(); $('operation').textContent = ''; $('status').textContent = ''; $('generation').textContent = '';
    $('query').value = ''; $('manifest').value = ''; $('more').hidden = true;
    for (const id of ['import', 'index', 'refresh']) $(id).disabled = !projectId;
  }
  function renderRows() {
    $('list').replaceChildren();
    for (const row of rows) {
      const article = node('article', undefined, 'literature-paper');
      article.append(node('h3', cell(row.header?.title)));
      for (const key of ['authors', 'yearVersion', 'readingCoverage', 'currentResearchRelationship', 'ingestionStatus']) article.append(node('p', `${fields[key]}：${cell(row.header?.[key])}`));
      const warnings = [row.acquisition === 'abstract_only' ? '只有摘要 · 全文不可用' : ['unavailable', 'metadata_only'].includes(row.acquisition) ? '全文不可用' : '', row.parse === 'partial' ? '部分解析失败 · 摘录可能不完整' : row.parse === 'failed' ? '解析失败' : row.parse === 'pending' ? '等待解析' : ''].filter(Boolean);
      if (warnings.length) article.append(node('p', warnings.join('；'), 'literature-warning'));
      const details = node('details'), summary = node('summary', '查看全部 15 项详情'), dl = node('dl');
      for (const [key, label] of Object.entries(fields)) {
        const value = row.header?.[key]; dl.append(node('dt', label), node('dd', `${cell(value)} · ${statuses[value?.status] || '未知'} · ${origins[value?.origin] || '系统'}`));
      }
      details.append(summary, dl); article.append(details);
      const select = node('select'); select.setAttribute('aria-label', `${cell(row.header?.title)} 原文版本`);
      for (const version of row.versions || []) { const option = node('option', version.versionLabel || version.id); option.value = version.id; select.append(option); }
      const open = button('阅读原文', () => void openSource(select.value), 'literature-read'); open.disabled = !select.options.length;
      select.addEventListener('change', () => { if (select.value) void openSource(select.value); });
      article.append(select, open); $('list').append(article);
    }
    $('more').hidden = !nextId;
  }
  async function loadPapers(more = false) {
    if (!projectId) return;
    const token = begin('list'); $('status').textContent = '正在读取目录…'; $('more').disabled = true;
    try {
      const result = await (await request('papers', { limit: 25, ...(more && nextId ? { afterId: nextId } : {}) }, token)).json();
      if (!token.current()) return;
      if (generationId !== result.generationId) { clearSearch(); clearSource(); }
      generationId = result.generationId; nextId = result.nextId; rows = more ? [...rows, ...result.rows] : result.rows;
      $('generation').textContent = generationId ? `索引版本：${generationId}` : '尚未建索引 · 可显式构建索引';
      renderRows(); $('status').textContent = rows.length ? `已显示 ${rows.length} 篇文献。目录中的“未读”不会因打开原文而变为已读。` : '暂无文献。可显式导入来源清单。';
    } catch (error) { report(error, $('status'), token); }
    finally { if (token.current()) $('more').disabled = false; }
  }
  async function search(event) {
    event.preventDefault(); if (!projectId) return;
    clearSearch(); clearSource(); const token = begin('search'); $('status').textContent = '正在检索…';
    try {
      const result = await (await request('search', { q: $('query').value, ...(generationId ? { generationId } : {}) }, token)).json();
      if (!token.current() || token.generationId !== generationId) return;
      for (const hit of result.hits || []) {
        const span = hit.span, article = node('article', undefined, 'literature-hit');
        article.append(node('blockquote', span.evidenceText), node('p', `${span.sectionPath?.join(' / ') || '原文'} · ${span.locator?.kind === 'pdf' ? `第 ${span.locator.page} 页` : '文本摘录'} · 版本 ${span.documentId} · ${span.sourceKind === 'abstract' ? '只有摘要' : '原文'}${span.quality === 'needs_review' ? ' · 引用待核对' : ''}`));
        article.append(button('查看原文位置', () => void openSource(span.documentId, span.id), 'literature-hit-open'));
        article.append(button('引用摘录', () => { $('citation').value = `${span.evidenceText}\n[document:${span.documentId}; span:${span.id}; generation:${generationId}]`; $('citation').focus(); $('citation').select(); }));
        $('results').append(article);
      }
      $('status').textContent = result.status === 'not_indexed' ? '尚未建索引；请点击“构建索引”。' : result.hits?.length ? `找到 ${result.hits.length} 条原文摘录。` : '没有找到匹配的原文摘录。';
    } catch (error) { report(error, $('status'), token); }
  }
  async function renderPdf(token) {
    if (!pdf || !token.current()) return;
    const sequence = ++renderSequence, previous = renderTask; previous?.cancel();
    if (previous) await previous.promise.catch(() => {});
    try {
      const page = await pdf.getPage(currentPage);
      if (!token.current() || sequence !== renderSequence) return;
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.max(0.2, Math.min(1.5, ($('source').clientWidth - 32) / original.width)) });
      const canvas = $('canvas'), ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`; canvas.hidden = false;
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      renderTask = task; await task.promise;
      if (!token.current() || sequence !== renderSequence) return;
      canvas.dataset.renderedPage = String(currentPage); $('page').value = String(currentPage); $('page').max = String(pdf.numPages); $('pages').textContent = `/ ${pdf.numPages}`;
      const text = await page.getTextContent();
      if (token.current() && sequence === renderSequence) $('pdf-text').textContent = text.items.map(item => item.str).join(' ');
    } catch (error) { if (error.name !== 'RenderingCancelledException') report(error, $('source-caption'), token); }
  }
  async function openSource(documentId, spanId) {
    if (!projectId || !documentId) return;
    clearSource(); const token = begin('source'); token.documentId = documentId; $('source-caption').textContent = '正在加载原文…';
    try {
      let span;
      if (spanId) span = await (await request('span', { spanId, generationId }, token)).json();
      if (!token.current() || token.generationId !== generationId) return;
      if (span && span.documentId !== documentId) throw new Error('引用与原文版本不匹配。');
      const response = await request('source', { documentId }, token);
      if (!token.current()) return;
      if (span) $('excerpt').textContent = span.evidenceText;
      if (response.headers.get('content-type')?.startsWith('application/pdf')) {
        const bytes = new Uint8Array(await response.arrayBuffer()); if (!token.current()) return;
        // Reuse the workbench's local PDF.js resources, cancellation and destruction lifecycle.
        pdfTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false, cMapUrl: '/autoresearch/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/autoresearch/vendor/pdfjs/standard_fonts/', wasmUrl: '/autoresearch/vendor/pdfjs/wasm/' });
        const loaded = await pdfTask.promise; if (!token.current()) return;
        pdf = loaded; currentPage = Math.max(1, Math.min(pdf.numPages, span?.locator?.kind === 'pdf' ? span.locator.page : 1));
        $('source-caption').textContent = `版本 ${documentId} · 第 ${currentPage} 页 · 无可靠坐标时仅定位页码与摘录`;
        $('page-controls').hidden = false; await renderPdf(token);
      } else {
        const text = await response.text(); if (!token.current()) return;
        $('source-text').textContent = text; $('source-caption').textContent = `版本 ${documentId} · 安全文本原文`;
      }
    } catch (error) { report(error, $('source-caption'), token); }
  }
  async function operate(kind) {
    if (!projectId) return;
    const token = begin('operation'); clearTimeout(operationTimer);
    $('import').disabled = true; $('index').disabled = true; $('operation').textContent = '正在提交…';
    try {
      const values = kind === 'import' ? { manifest: JSON.parse($('manifest').value) } : {};
      const operation = await (await request(kind, values, token, 'POST')).json();
      if (!token.current()) return;
      const poll = async () => {
        try {
          const result = await (await request('operations', { operationId: operation.operationId }, token)).json();
          if (!token.current()) return;
          $('operation').textContent = result.interrupted ? '操作已中断；请检查结果后重新显式提交。' : ({ queued: '排队中', running: '进行中', completed: '操作完成', failed: '操作失败' }[result.status] || result.status);
          if (result.error) $('operation').textContent += ` · ${result.error}`;
          if (!result.interrupted && ['queued', 'running'].includes(result.status)) operationTimer = setTimeout(poll, 700);
          else { $('import').disabled = false; $('index').disabled = false; if (result.status === 'completed') await loadPapers(); }
        } catch (error) { report(error, $('operation'), token); if (token.current()) { $('import').disabled = false; $('index').disabled = false; } }
      };
      await poll();
    } catch (error) { report(error instanceof SyntaxError ? new Error('请输入有效的来源清单 JSON。') : error, $('operation'), token); if (token.current()) { $('import').disabled = false; $('index').disabled = false; } }
  }
  document.querySelector('#literature-open').addEventListener('click', () => { active = true; dialog.showModal(); void loadPapers(); });
  $('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (!dialog.open) { active = false; reset(); } });
  $('refresh').addEventListener('click', () => void loadPapers()); $('more').addEventListener('click', () => void loadPapers(true));
  $('search').addEventListener('submit', search); $('index').addEventListener('click', () => void operate('index')); $('import').addEventListener('click', () => void operate('import'));
  $('page').addEventListener('change', () => {
    if (!pdf) return; currentPage = Math.max(1, Math.min(pdf.numPages, Number.parseInt($('page').value, 10) || 1));
    const controller = controllers.get('source'); if (controller) void renderPdf({ current: () => controllers.get('source') === controller && !controller.signal.aborted });
  });
  return { setProject(id) { if (id === projectId) return; projectId = id || ''; reset(); document.querySelector('#literature-open').disabled = !projectId; if (active) void loadPapers(); } };
}
