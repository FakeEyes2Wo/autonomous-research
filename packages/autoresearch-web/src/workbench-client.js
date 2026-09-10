import * as pdfjs from './vendor/pdfjs/pdf.mjs';
import { decideSync, samePdfLoadTarget } from './workbench-sync.js';
import { installChat } from './workbench-chat.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/autoresearch/vendor/pdfjs/pdf.worker.mjs';
const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['project', 'project-name', 'document', 'editor', 'new-document', 'save', 'compile', 'reload', 'notice', 'save-state', 'document-name', 'line-numbers', 'cursor-position', 'engine-state', 'preview-state', 'build-state', 'build-log', 'pdf-viewport', 'pdf-canvas', 'preview-empty', 'download', 'page-number', 'page-count', 'previous-page', 'next-page', 'zoom'].map((id) => [id, $(id)]));
const params = new URL(location.href).searchParams;
const workspaceManaged = params.get('workspaceManaged') === '1';
const state = { projects: [], projectId: '', documents: [], document: null, savedSource: '', csrf: '', engine: null, loading: true, saving: false, building: false, generation: 0, projectListGeneration: 0, managedReady: false, managedPendingProject: undefined, selectionId: null, pdf: null, pdfRevision: null, pdfTask: null, pdfPending: null, renderTask: null, renderGeneration: 0, pdfGeneration: 0, page: 1 };
const projectCache = new Map();
const currentDirty = () => Boolean(state.document && ui.editor.value !== state.savedSource);
const cachedDirty = () => [...projectCache.values()].some((item) => item.source !== item.savedSource);
const dirty = () => currentDirty() || cachedDirty();
const busy = () => state.loading || state.saving || state.building;
const message = (text = '', success = false) => { ui.notice.textContent = text; ui.notice.classList.toggle('success', success); ui.notice.hidden = !text; };
const query = (values) => new URLSearchParams(values).toString();
const embedded = window.parent !== window && params.get('embedded') === '1';
document.body.classList.toggle('embedded', embedded);
document.body.classList.toggle('workspace-managed', workspaceManaged);
let lastContext = '';
let pendingUpdate = null;
const chat = embedded ? null : installChat({ api, canLeave: discard, getContext: () => ({ projectId: state.projectId, document: state.document, dirty: dirty(), busy: busy() }) });
function publishContext(force = false) {
  if (!embedded) return;
  const data = { channel: 'autoresearch-workbench', type: 'context', projectId: state.projectId, selectionId: state.selectionId, document: state.document ? { id: state.document.id, relativePath: state.document.relativePath, revision: state.document.revision } : null, dirty: dirty(), busy: busy() };
  const serialized = JSON.stringify(data);
  if (force || serialized !== lastContext) { lastContext = serialized; window.parent.postMessage(data, location.origin); }
}
function updateNotice(text = '', documentId = null) {
  pendingUpdate = documentId;
  $('sync-message').textContent = text;
  $('sync-notice').hidden = !text;
}

async function api(path, options = {}) {
  const response = await fetch(`/api/autoresearch${path}`, { ...options, credentials: 'same-origin', headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), 'x-autoresearch-csrf': state.csrf }, signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function update() {
  const hasDocument = Boolean(state.document);
  ui['project-name'].textContent = state.projectId ? (state.projects.find((item) => item.id === state.projectId)?.name || state.projectId) : 'DSH 左侧工作区';
  ui.project.hidden = workspaceManaged;
  ui.project.disabled = busy() || !state.projects.length;
  ui.document.disabled = busy() || !state.documents.length;
  ui['new-document'].disabled = busy() || !state.projectId;
  ui.editor.disabled = state.loading || state.saving || !hasDocument;
  ui.save.disabled = busy() || !dirty() || state.document?.orphaned;
  ui.compile.disabled = busy() || !hasDocument || state.document?.orphaned || !state.engine?.available;
  ui.reload.disabled = busy() || !state.projectId;
  ui.compile.textContent = state.building ? '正在编译…' : state.saving ? '正在保存…' : '▶ 保存并编译';
  ui['save-state'].textContent = state.loading ? '正在加载…' : state.saving ? '正在保存…' : !hasDocument ? '选择或新建论文' : state.document?.orphaned ? '草稿未关联文件' : dirty() ? '未保存' : '已保存';
  ui['save-state'].classList.toggle('dirty', dirty());
  ui['document-name'].textContent = state.document?.relativePath || state.document?.name || '尚未选择论文';
  ui['document-name'].title = ui['document-name'].textContent;
  ui['preview-state'].textContent = state.pdf ? (state.pdfRevision === null ? '已有 PDF · 编译可核对最新内容' : dirty() || state.pdfRevision !== state.document?.revision ? '预览较旧 · 请重新编译' : '与已保存内容一致') : '等待编译';
  const available = Boolean(state.pdf);
  ui['page-number'].disabled = !available;
  ui.zoom.disabled = !available;
  ui['previous-page'].disabled = !available || state.page <= 1;
  ui['next-page'].disabled = !available || state.page >= state.pdf.numPages;
  ui['page-number'].value = state.page;
  ui['page-number'].max = state.pdf?.numPages || 1;
  ui['page-count'].textContent = `/ ${state.pdf?.numPages || '—'}`;
  publishContext();
  chat?.update();
}

function cursor() {
  const before = ui.editor.value.slice(0, ui.editor.selectionStart);
  const lines = before.split('\n');
  ui['cursor-position'].textContent = `行 ${lines.length}，列 ${lines.at(-1).length + 1}`;
}
function editorChanged() {
  const lines = ui.editor.value.split('\n').length;
  ui['line-numbers'].textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  ui['line-numbers'].scrollTop = ui.editor.scrollTop;
  cursor();
  if (workspaceManaged && state.document) rememberCurrentDraft();
  update();
}

function options(select, items, selected, empty) {
  select.replaceChildren();
  if (!items.length) select.add(new Option(empty, ''));
  for (const item of items) select.add(new Option(item.relativePath || item.name, item.id));
  select.value = selected || '';
}
function discard() { return !dirty() || window.confirm('还有未保存的 LaTeX 修改，确定离开当前论文？'); }

function rememberCurrentDraft() {
  if (!workspaceManaged || !state.projectId || !state.document) return;
  const existing = projectCache.get(state.projectId) || {};
  projectCache.set(state.projectId, { ...existing, documentId: state.document.id, document: { ...state.document }, source: ui.editor.value, savedSource: state.savedSource, documents: state.documents, engine: state.engine });
}

function clearCurrentProject(text = '请从 DSH 左侧选择工作区会话。') {
  rememberCurrentDraft();
  ++state.generation;
  state.projectId = ''; state.document = null; state.savedSource = ''; state.documents = []; state.engine = null; state.loading = false; state.building = false;
  ui.project.value = ''; ui.document.replaceChildren(new Option('请先选择项目', '')); ui.editor.value = '';
  void clearPdf(); message(text); editorChanged();
}

function retainUnavailableDraft(text = '当前 DSH 工作区已移除。未保存草稿仍在此页面，可复制，但不能保存到其他工作区。') {
  const projectId = state.projectId;
  const document = state.document;
  rememberCurrentDraft();
  ++state.generation;
  if (projectId && document) {
    const cached = projectCache.get(projectId);
    if (cached) projectCache.set(projectId, { ...cached, document: { ...cached.document, orphaned: true } });
  }
  state.projectId = ''; state.documents = []; state.engine = null; state.loading = false; state.saving = false; state.building = false;
  state.document = document ? { ...document, orphaned: true } : null;
  ui.project.value = ''; ui.document.replaceChildren(new Option('工作区已移除', ''));
  void clearPdf(); message(text); update();
}

function updateSavedCache(projectId, documentId, source, document) {
  const cached = projectCache.get(projectId);
  if (!cached || cached.documentId !== documentId) return;
  const hasNewerDraft = cached.source !== source;
  projectCache.set(projectId, { ...cached, document: { ...document }, savedSource: source, source: hasNewerDraft ? cached.source : source });
}

function restoreOrphanedDraft(projectId, cached, text = '原论文不再属于当前工作区。未保存草稿已保留，不能写入新的文件；点击「重新加载」可放弃草稿并选择当前文件。') {
  const document = { ...cached.document, source: cached.source, orphaned: true };
  projectCache.set(projectId, { ...cached, document, documents: state.documents });
  state.document = document;
  state.savedSource = cached.savedSource;
  ui.editor.value = cached.source;
  ui.document.add(new Option('未保存草稿（原文件已移除）', ''), 0);
  ui.document.value = '';
  updateNotice();
  message(text);
  editorChanged();
}

async function clearPdf() {
  state.pdfGeneration += 1; state.renderGeneration += 1;
  state.renderTask?.cancel();
  const task = state.pdfTask;
  state.pdfPending = null; state.pdfTask = null;
  task?.destroy().catch(() => {});
  state.pdf = null; state.pdfRevision = null; state.loadedPdfVersion = null; state.page = 1;
  ui['pdf-canvas'].hidden = true; ui['preview-empty'].hidden = false; ui.download.hidden = true;
  $('pdf-text').textContent = '';
  update();
}

async function renderPdf() {
  if (!state.pdf) return;
  const sequence = ++state.renderGeneration;
  const current = state.pdf;
  const pending = state.renderTask;
  pending?.cancel();
  if (pending) await pending.promise.catch(() => {});
  try {
    const page = await current.getPage(state.page);
    if (sequence !== state.renderGeneration) return;
    const original = page.getViewport({ scale: 1 });
    const fit = Math.max(0.25, (ui['pdf-viewport'].clientWidth - 56) / original.width);
    const scale = ui.zoom.value === 'fit' ? fit : Number(ui.zoom.value);
    const viewport = page.getViewport({ scale });
    const canvas = ui['pdf-canvas'];
    delete canvas.dataset.renderedPage;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.hidden = false; ui['preview-empty'].hidden = true;
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
    state.renderTask = task;
    await task.promise;
    if (sequence !== state.renderGeneration) return;
    canvas.dataset.renderedPage = String(state.page);
    const content = await page.getTextContent();
    if (sequence === state.renderGeneration) $('pdf-text').textContent = content.items.map((item) => item.str).join(' ');
    update();
  } catch (error) {
    if (sequence !== state.renderGeneration || error.name === 'RenderingCancelledException') return;
    message(`PDF 显示失败：${error.message}`);
  }
}

async function showPdf(pdf, sourceRevision) {
  if (!pdf?.url) return;
  const identity = { generation: state.generation, projectId: state.projectId, documentId: state.document?.id ?? null, version: pdf.version ?? null };
  if (samePdfLoadTarget(state.pdfPending, identity)) return;
  await clearPdf();
  const pdfGeneration = state.pdfGeneration;
  const url = new URL(pdf.url, location.href);
  if (url.origin !== location.origin || url.pathname !== '/api/autoresearch/workbench/pdf') throw new Error('PDF 地址不属于当前项目服务。');
  const task = pdfjs.getDocument({ url: url.href, withCredentials: true, isEvalSupported: false, cMapUrl: '/autoresearch/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/autoresearch/vendor/pdfjs/standard_fonts/', wasmUrl: '/autoresearch/vendor/pdfjs/wasm/' });
  state.pdfTask = task;
  const pending = { ...identity, task };
  state.pdfPending = pending;
  const current = () => state.pdfPending === pending && state.generation === identity.generation && state.pdfGeneration === pdfGeneration && samePdfLoadTarget(state.pdfPending, identity);
  try {
    const document = await task.promise;
    if (!current()) { await task.destroy().catch(() => {}); return; }
    state.pdf = document; state.pdfRevision = sourceRevision ?? pdf.sourceRevision ?? null; state.loadedPdfVersion = pdf.version;
    ui.download.href = url.href; ui.download.hidden = false;
    await renderPdf();
  } catch (error) {
    if (!current()) return;
    message(`无法预览 PDF：${error.message}`);
  } finally {
    if (state.pdfPending === pending) state.pdfPending = null;
  }
}

async function readDocument(id, generation = state.generation) {
  const projectId = state.projectId;
  const remote = await api(`/workbench/document?${query({ projectId, documentId: id })}`);
  if (generation !== state.generation || projectId !== state.projectId) return;
  const cached = projectCache.get(projectId);
  const cachedDocument = cached?.documentId === id ? cached : null;
  const document = cachedDocument?.source !== cachedDocument?.savedSource ? { ...remote, revision: cachedDocument.document?.revision ?? remote.revision, source: cachedDocument.source } : remote;
  if (cachedDocument && cachedDocument.source === cachedDocument.savedSource && cachedDocument.source === remote.source) projectCache.delete(projectId);
  state.document = document;
  state.savedSource = cachedDocument && document.source !== remote.source ? cachedDocument.savedSource : document.source;
  updateNotice();
  ui.editor.value = document.source;
  ui.document.value = document.id;
  ui.editor.scrollTop = 0;
  editorChanged();
  // PDF.js may be waiting on a native pipeline PDF. Source editing must become
  // ready as soon as its document request completes; showPdf has its own
  // generation checks, so a late preview cannot update a newer project.
  if (document.pdf) void showPdf(document.pdf, document.pdf.sourceRevision).catch((error) => message(`无法预览 PDF：${error.message}`));
}

async function loadProject(projectId, preferredDocument, { discardOrphan = false } = {}) {
  if (!projectId || !state.projects.some((project) => project.id === projectId)) return;
  if (discardOrphan && projectId === state.projectId && state.document?.orphaned) projectCache.delete(projectId);
  else rememberCurrentDraft();
  const generation = ++state.generation;
  state.projectId = projectId; state.document = null; state.savedSource = ''; state.documents = []; state.loading = true; state.saving = false; state.building = false;
  updateNotice();
  ui.editor.value = ''; ui.project.value = projectId; message();
  ui['build-state'].textContent = '仅在点击编译时生成 PDF'; ui['build-log'].textContent = '尚未开始编译。';
  await clearPdf(); editorChanged();
  try {
    const data = await api(`/workbench/documents?${query({ projectId })}`);
    if (generation !== state.generation) return;
    state.documents = data.documents; state.engine = data.engine;
    ui['engine-state'].textContent = data.engine?.available ? `${data.engine.name || 'Tectonic'} · 可以编译` : '未找到 Tectonic：安装后加入 PATH，或设置插件的编译器路径。编辑与保存仍可使用。';
    options(ui.document, data.documents, '', '尚无论文');
    const cached = projectCache.get(projectId);
    const cachedDocumentExists = cached && data.documents.some((doc) => doc.id === cached.documentId);
    if (cached && !cachedDocumentExists && cached.source !== cached.savedSource) {
      restoreOrphanedDraft(projectId, cached);
    } else {
      if (cached && !cachedDocumentExists) projectCache.delete(projectId);
      const selected = data.documents.find((doc) => doc.id === preferredDocument) || data.documents.find((doc) => doc.id === cached?.documentId) || data.documents[0];
      if (selected) await readDocument(selected.id, generation);
    }
    if (generation !== state.generation) return;
    const pageUrl = new URL(location.href); pageUrl.searchParams.set('projectId', projectId); history.replaceState(null, '', pageUrl);
  } catch (error) { if (generation === state.generation) message(error.message); }
  finally { if (generation === state.generation) { state.loading = false; update(); } }
}

async function saveDocument() {
  if (!state.document || state.document.orphaned) return false;
  if (!currentDirty()) return true;
  const generation = state.generation;
  const projectId = state.projectId;
  const documentId = state.document.id;
  const expectedRevision = state.document.revision;
  const source = ui.editor.value;
  state.saving = true; message(); update();
  try {
    const document = await api('/workbench/document', { method: 'PUT', body: JSON.stringify({ projectId, documentId, expectedRevision, source }) });
    updateSavedCache(projectId, documentId, source, document);
    if (generation !== state.generation || projectId !== state.projectId || state.document?.id !== documentId) {
      // The user can return to this document before an older save resolves.
      // Adopt its revision only when this view still uses the saved request's
      // base revision, while keeping any newer editor text dirty.
      if (projectId === state.projectId && state.document?.id === documentId && state.document.revision === expectedRevision) {
        state.document = { ...document, source: ui.editor.value };
        state.savedSource = source;
        update();
      }
      return true;
    }
    state.document = document; state.savedSource = source; updateNotice();
    return true;
  } catch (error) {
    if (generation === state.generation && projectId === state.projectId) message(error.status === 409 ? '文件已在 DSH 或其他窗口中修改。你的编辑仍保留在这里；请先复制需要的内容，再点击「重新加载」。' : error.message);
    return false;
  } finally { if (generation === state.generation && projectId === state.projectId) { state.saving = false; update(); } }
}

async function compile() {
  if (busy() || !state.document || state.document.orphaned || !state.engine?.available) return;
  const generation = state.generation;
  const projectId = state.projectId;
  const documentId = state.document.id;
  if (!await saveDocument() || generation !== state.generation || projectId !== state.projectId || state.document?.id !== documentId) return;
  state.building = true; message(); update();
  try {
    const expectedRevision = state.document.revision;
    let build = await api('/workbench/build', { method: 'POST', body: JSON.stringify({ projectId, documentId, expectedRevision }) });
    if (generation !== state.generation) return;
    ui['build-state'].textContent = '正在编译论文…'; ui['build-log'].textContent = '正在编译，请稍候。首次使用可能需要下载 TeX 资源。';
    const deadline = Date.now() + 330000;
    while (['queued', 'running'].includes(build.status)) {
      if (Date.now() > deadline) throw new Error('等待编译结果超时。可以稍后重新加载论文。');
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (generation !== state.generation) return;
      build = await api(`/workbench/build?${query({ projectId, buildId: build.id })}`);
      if (generation !== state.generation) return;
    }
    const diagnostics = Array.isArray(build.diagnostics) ? build.diagnostics.join('\n') : build.diagnostics;
    const buildErrors = { compiler_unavailable: '未找到 Tectonic。请安装并加入 PATH，或设置插件的编译器路径。', compiler_timeout: '编译超时。首次使用时请检查 TeX 资源下载是否正常。', compiler_output_limit: '编译日志超过大小上限，任务已停止。', source_changed: '开始编译前源文档已变化，请重新加载后再试。' };
    const failure = buildErrors[build.error?.code] || build.error?.message;
    ui['build-log'].textContent = [failure, diagnostics].filter(Boolean).join('\n\n') || (build.status === 'succeeded' ? '编译成功。' : '编译未成功，请检查 LaTeX 源文档。');
    if (build.status !== 'succeeded' || !build.pdf) {
      ui['build-state'].textContent = '编译失败 · 原有预览保留';
      message('编译未成功，请查看下方日志并修改 LaTeX。');
      ui['build-log'].hidden = false; $('toggle-log').setAttribute('aria-expanded', 'true');
      return;
    }
    ui['build-state'].textContent = `编译成功 · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    state.document.pdf = build.pdf;
    await showPdf(build.pdf, build.sourceRevision);
  } catch (error) {
    message(error.status === 409 ? '源文件已变化，请重新加载后编译。当前编辑已保留。' : error.message);
    ui['build-state'].textContent = '编译未完成';
  } finally { if (generation === state.generation) { state.building = false; update(); } }
}

ui.editor.addEventListener('input', editorChanged);
ui.editor.addEventListener('click', cursor);
ui.editor.addEventListener('keyup', cursor);
ui.editor.addEventListener('scroll', () => { ui['line-numbers'].scrollTop = ui.editor.scrollTop; });
ui.editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') { event.preventDefault(); ui.editor.setRangeText('  ', ui.editor.selectionStart, ui.editor.selectionEnd, 'end'); editorChanged(); }
});
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 's') { event.preventDefault(); if (!busy()) void saveDocument(); }
  if (event.key === 'Enter') { event.preventDefault(); void compile(); }
});
let confirmedNavigation = false;
function permitConfirmedNavigation() {
  confirmedNavigation = true;
  setTimeout(() => { confirmedNavigation = false; }, 1000);
}
window.addEventListener('beforeunload', (event) => { if (dirty() && !confirmedNavigation) { event.preventDefault(); event.returnValue = ''; } });
for (const anchor of [$('back-dsh'), document.querySelector('.brand')]) anchor.addEventListener('click', (event) => {
  if (!discard()) { event.preventDefault(); return; }
  if (embedded) { event.preventDefault(); permitConfirmedNavigation(); window.parent.postMessage({ channel: 'autoresearch-workbench', type: 'exit' }, location.origin); return; }
  permitConfirmedNavigation();
});
function postManaged(type, extra = {}) {
  if (!embedded) return;
  window.parent.postMessage({ channel: 'autoresearch-workbench', type, ...extra }, location.origin);
}
function requestManagedProject(projectId, selectionId = state.selectionId, refreshProjects = true) {
  if (projectId !== null && typeof projectId !== 'string') return;
  if (selectionId !== null && typeof selectionId !== 'string') return;
  if (!workspaceManaged || !state.managedReady) { state.selectionId = selectionId; state.managedPendingProject = projectId; return; }
  state.selectionId = selectionId;
  state.managedPendingProject = projectId;
  if (refreshProjects) void syncProjects().catch(() => { /* the next poll retains this pending selection */ });
  if (projectId === null) { state.managedPendingProject = undefined; clearCurrentProject(); return; }
  // Known projects switch immediately even while a save or compile is in
  // flight. An unknown ID stays pending until the authoritative refresh finds
  // it, while a deleted current ID is cleared by syncProjects.
  if (!state.projects.some((project) => project.id === projectId)) return;
  state.managedPendingProject = undefined;
  if (projectId === state.projectId) { publishContext(true); return; }
  void loadProject(projectId, projectCache.get(projectId)?.documentId);
}
window.addEventListener('message', (event) => {
  if (!embedded || event.origin !== location.origin || event.source !== window.parent || event.data?.channel !== 'autoresearch-workbench') return;
  if (event.data.type === 'request-context') publishContext(true);
  if (event.data.type === 'select-project') {
    if (workspaceManaged) requestManagedProject(event.data.projectId === null ? null : event.data.projectId, typeof event.data.selectionId === 'string' ? event.data.selectionId : null);
    else if (typeof event.data.projectId === 'string' && state.projects.some((project) => project.id === event.data.projectId)) {
      if (event.data.projectId === state.projectId) publishContext(true);
      else if (!busy() && discard()) void loadProject(event.data.projectId);
      else publishContext(true);
    }
  }
  if (event.data.type === 'theme' && event.data.values && typeof event.data.values === 'object') {
    const tokens = ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-border-l1', '--dsw-alias-button-info-fill', '--dsw-alias-interactive-bg-hover', '--dsw-font-family'];
    for (const token of tokens) {
      const value = event.data.values[token];
      if (typeof value === 'string' && value.length <= 300 && CSS.supports(token === '--dsw-font-family' ? 'font-family' : 'color', value)) document.documentElement.style.setProperty(token, value);
    }
    if (['light', 'dark'].includes(event.data.scheme)) document.documentElement.style.colorScheme = event.data.scheme;
  }
  if (event.data.type === 'request-exit' && discard()) { permitConfirmedNavigation(); window.parent.postMessage({ channel: 'autoresearch-workbench', type: 'exit' }, location.origin); }
});
ui.project.addEventListener('change', () => { if (!discard()) { ui.project.value = state.projectId; return; } void loadProject(ui.project.value); });
ui.document.addEventListener('change', async () => {
  const id = ui.document.value;
  if (!discard()) { ui.document.value = state.document?.id || ''; return; }
  if (state.document?.orphaned) projectCache.delete(state.projectId);
  const generation = ++state.generation;
  const projectId = state.projectId;
  state.loading = true; state.document = null; state.savedSource = ''; ui.editor.value = ''; message(); await clearPdf();
  try { await readDocument(id, generation); } catch (error) { if (generation === state.generation && projectId === state.projectId) message(error.message); } finally { if (generation === state.generation && projectId === state.projectId) { state.loading = false; update(); } }
});
ui.reload.addEventListener('click', () => { if (discard()) void loadProject(state.projectId, state.document?.id, { discardOrphan: Boolean(state.document?.orphaned) }); });
$('load-update').addEventListener('click', () => { if (!busy() && discard()) void loadProject(state.projectId, pendingUpdate || state.document?.id, { discardOrphan: Boolean(state.document?.orphaned) }); });
ui['new-document'].addEventListener('click', async () => {
  if (!discard()) return;
  if (state.document?.orphaned) projectCache.delete(state.projectId);
  const generation = state.generation;
  const projectId = state.projectId;
  state.saving = true; update(); message();
  try {
    const document = await api('/workbench/documents', { method: 'POST', body: JSON.stringify({ projectId }) });
    if (generation !== state.generation || projectId !== state.projectId) return;
    await loadProject(projectId, document.id);
  } catch (error) { if (generation === state.generation && projectId === state.projectId) message(error.message); } finally { if (generation === state.generation && projectId === state.projectId) { state.saving = false; update(); } }
});
ui.save.addEventListener('click', () => void saveDocument());
ui.compile.addEventListener('click', () => void compile());
ui['previous-page'].addEventListener('click', () => { if (state.page > 1) { state.page -= 1; void renderPdf(); } });
ui['next-page'].addEventListener('click', () => { if (state.pdf && state.page < state.pdf.numPages) { state.page += 1; void renderPdf(); } });
ui['page-number'].addEventListener('change', () => { state.page = Math.max(1, Math.min(state.pdf?.numPages || 1, Math.floor(Number(ui['page-number'].value)) || 1)); void renderPdf(); });
ui.zoom.addEventListener('change', () => void renderPdf());
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.pdf && ui.zoom.value === 'fit' && ui['pdf-viewport'].clientWidth) void renderPdf(); }, 100); }).observe(ui['pdf-viewport']);
for (const [id, view] of [['source-tab', 'source'], ['preview-tab', 'preview']]) $(id).addEventListener('click', () => {
  $('workspace').dataset.view = view; $('source-tab').setAttribute('aria-selected', String(view === 'source')); $('preview-tab').setAttribute('aria-selected', String(view === 'preview'));
  if (view === 'preview') void renderPdf();
});
$('toggle-log').addEventListener('click', () => { ui['build-log'].hidden = !ui['build-log'].hidden; $('toggle-log').setAttribute('aria-expanded', String(!ui['build-log'].hidden)); });
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('save-shortcut').textContent = '⌘ S';

// Poll only while visible and idle. Revalidate after every await so typing,
// saving or project navigation during the request cannot overwrite a draft.
async function syncProjects() {
  const sequence = ++state.projectListGeneration;
  const result = await api('/projects');
  if (sequence !== state.projectListGeneration) return;
  state.projects = result.projects; state.csrf = result.csrfToken;
  options(ui.project, result.projects, state.projectId, '暂无项目');
  if (workspaceManaged && state.projectId && !result.projects.some((project) => project.id === state.projectId)) {
    if (currentDirty()) retainUnavailableDraft();
    else clearCurrentProject('当前 DSH 工作区已移除。');
  }
  if (workspaceManaged && (state.managedPendingProject === null || typeof state.managedPendingProject === 'string')) requestManagedProject(state.managedPendingProject, state.selectionId, false);
  update();
}
async function syncFiles() {
  if (document.hidden || busy()) return;
  if (workspaceManaged) { try { await syncProjects(); } catch { /* retain the last known DSH workspace list */ } }
  if (!state.projectId) return;
  const snapshot = { generation: state.generation, projectId: state.projectId, documentId: state.document?.id };
  try {
    const listing = await api(`/workbench/documents?${query({ projectId: snapshot.projectId })}`);
    if (busy() || snapshot.generation !== state.generation) return;
    const discovered = listing.documents.filter((item) => !state.documents.some((known) => known.id === item.id));
    state.documents = listing.documents;
    options(ui.document, listing.documents, state.document?.id, '尚无论文');
    if (snapshot.documentId && !listing.documents.some((item) => item.id === snapshot.documentId)) {
      ++state.generation;
      if (currentDirty() && state.document) {
        rememberCurrentDraft();
        const cached = projectCache.get(snapshot.projectId);
        if (cached) restoreOrphanedDraft(snapshot.projectId, cached);
      } else {
        projectCache.delete(snapshot.projectId);
        state.document = null; state.savedSource = ''; ui.editor.value = '';
        await clearPdf();
        message('当前论文已移除，请从列表选择另一篇论文。');
        editorChanged();
      }
      return;
    }
    if (!state.document && listing.documents.length) {
      state.loading = true; update();
      try { await readDocument(listing.documents[0].id, snapshot.generation); }
      finally { if (snapshot.generation === state.generation) { state.loading = false; update(); } }
      return;
    }
    if (discovered.length) updateNotice(`发现新论文：${discovered.at(-1).relativePath || discovered.at(-1).name}`, discovered.at(-1).id);
    if (!snapshot.documentId) return;
    const remote = await api(`/workbench/document?${query({ projectId: snapshot.projectId, documentId: snapshot.documentId })}`);
    const decision = decideSync(snapshot, { generation: state.generation, projectId: state.projectId, documentId: state.document?.id, revision: state.document?.revision, pdfVersion: state.loadedPdfVersion, pdfPending: state.pdfPending, dirty: dirty(), busy: busy() }, remote);
    if (decision === 'ignore') return;
    if (decision === 'conflict') {
      updateNotice('论文已在对话或其他窗口中更新。你的未保存草稿已保留。', remote.id);
      return;
    }
    if (decision === 'apply') {
      const scroll = ui.editor.scrollTop;
      const selection = [ui.editor.selectionStart, ui.editor.selectionEnd];
      state.document = remote; state.savedSource = remote.source; ui.editor.value = remote.source;
      ui.editor.setSelectionRange(...selection); ui.editor.scrollTop = scroll;
      if (pendingUpdate === remote.id) updateNotice();
      editorChanged();
      $('sync-state').textContent = `已同步论文 · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (decision === 'apply' || decision === 'preview') {
      state.document.pdf = remote.pdf;
      if (remote.pdf) void showPdf(remote.pdf, remote.pdf.sourceRevision);
      else await clearPdf();
      update();
    }
  } catch {
    if (snapshot.generation === state.generation) $('sync-state').textContent = '更新检查暂不可用 · 将自动重试';
  }
}
async function watchFiles() {
  await syncFiles();
  setTimeout(watchFiles, 3000);
}

try {
  const result = await api('/projects');
  state.projects = result.projects; state.csrf = result.csrfToken;
  options(ui.project, result.projects, '', '暂无项目');
  if (workspaceManaged) {
    state.managedReady = true;
    postManaged('ready', { projects: result.projects.map(({ id, name, workspaceId }) => ({ id, name, workspaceId })) });
    const pending = state.managedPendingProject;
    if (pending === null || typeof pending === 'string') requestManagedProject(pending, state.selectionId, false);
    else { state.loading = false; ui['engine-state'].textContent = '请从 DSH 左侧选择工作区会话。'; message('请从 DSH 左侧选择工作区会话。'); update(); }
  } else {
    const requested = params.get('projectId');
    const selected = result.projects.find((project) => project.id === requested) || result.projects[0];
    options(ui.project, result.projects, selected?.id, '暂无项目');
    if (selected) await loadProject(selected.id);
    else { state.loading = false; ui['engine-state'].textContent = '请先在 DSH 插件设置中登记项目目录。'; message('尚未登记项目，请返回 DSH 配置 AutoResearch 的项目目录。'); update(); }
  }
} catch (error) { state.loading = false; message(`工作台连接失败：${error.message}`); update(); }
setTimeout(watchFiles, 3000);
