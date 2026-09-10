const AR_CHANNEL = 'autoresearch-workbench';
const AR_STORAGE = 'autoresearch.workbench.sessions.v1';
const AR_ID = /^[A-Za-z0-9_-]{1,256}$/;
const AR_THEME = ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-border-l1', '--dsw-alias-button-info-fill', '--dsw-alias-interactive-bg-hover', '--dsw-font-family'];

function arService(ctx, name) {
  // Cordis services are optional: a direct ctx.foo read can throw before injection.
  if (typeof ctx?.get !== 'function') return undefined;
  try { return ctx.get(name); } catch { return undefined; }
}
function arSnapshot(service) { try { return service?.list?.getSnapshot?.() || {}; } catch { return {}; } }
function arPath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}
function arSaved(win, id) { try { const saved = JSON.parse(win.localStorage?.getItem(AR_STORAGE) || '{}'); return AR_ID.test(saved?.[id] || '') ? saved[id] : undefined; } catch { return undefined; } }
function arRemember(win, id, sessionId) { try { const saved = JSON.parse(win.localStorage?.getItem(AR_STORAGE) || '{}'); win.localStorage?.setItem(AR_STORAGE, JSON.stringify({ ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}), [id]: sessionId })); } catch {} }
function arValue(result) {
  if (result?.ok === false) {
    const error = new Error(result.error?.message || '原生会话创建失败');
    if (typeof result.error?.code === 'string') error.code = result.error.code;
    throw error;
  }
  const value = result?.ok === true ? result.value : result;
  const sessionId = typeof value === 'string' ? value : value?.sessionId;
  if (!AR_ID.test(sessionId || '')) throw new Error('原生会话未返回有效标识');
  return sessionId;
}
function arSession(snapshot, id) { return snapshot?.byId?.[id] || snapshot?.items?.find?.((item) => item?.id === id); }
function arResearchSession(session) { return session?.projectionValues?.agentPreset === 'auto-research' || session?.agentPreset === 'auto-research' || session?.agent?.preset === 'auto-research'; }

/** The workspace store is authoritative. CWD is only a legacy exact-match fallback. */
export function resolveNativeWorkspace(workspaces, sessions) {
  const workspaceItems = arSnapshot(workspaces).items;
  const snapshot = arSnapshot(sessions);
  const current = typeof snapshot.current === 'string' ? snapshot.current : '';
  if (!current || !Array.isArray(workspaceItems)) return undefined;
  const member = workspaceItems.find((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(current));
  if (member) return member;
  const cwd = arPath(arSession(snapshot, current)?.cwd);
  return cwd ? workspaceItems.find((workspace) => arPath(workspace?.path) === cwd) : undefined;
}

/** Do not treat a cwd-only legacy session as a workbench conversation. */
export function selectNativeWorkspace(workspaces, sessions, projects) {
  const snapshot = arSnapshot(sessions);
  const current = typeof snapshot.current === 'string' ? snapshot.current : null;
  const workspace = resolveNativeWorkspace(workspaces, sessions);
  const workspaceId = typeof workspace?.workspaceId === 'string' ? workspace.workspaceId : null;
  const projectId = workspaceId ? projects?.get?.(workspaceId) || null : null;
  const grouped = Boolean(workspaceId && current && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(current));
  const session = current ? arSession(snapshot, current) : null;
  const sessionKind = !current ? 'none' : !grouped ? 'legacy' : arResearchSession(session) ? 'research' : 'ordinary';
  return { workspaceId, projectId, sessionId: sessionKind === 'research' ? current : null, sessionKind, grouped };
}

export function nativeResearchAvailability(selection) {
  return { compatible: Boolean(selection?.projectId && selection?.sessionId), canStart: Boolean(selection?.workspaceId && selection?.projectId && !selection?.sessionId) };
}

/** Keep the DSH workspace rail available while protecting a usable paper pane on phones. */
export function shouldCollapseNativeSidebar(frameWidth, centerWidth) {
  return Number.isFinite(frameWidth) && Number.isFinite(centerWidth) && frameWidth <= 720 && centerWidth < 300;
}

export function nativeSidebarViewportMetrics(outerWidth, paneLeft, paneWidth, viewportWidth) {
  const frameWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? Math.min(outerWidth, viewportWidth) : outerWidth;
  const centerWidth = Math.min(paneWidth, Math.max(0, frameWidth - paneLeft));
  return { frameWidth, centerWidth };
}

export function nextNativeSidebarState(state, { frameWidth, centerWidth, sidebarCollapsed }) {
  if (state === 'initial') {
    if (sidebarCollapsed) return { state: 'external', action: null };
    if (shouldCollapseNativeSidebar(frameWidth, centerWidth)) return { state: 'owned', action: 'collapse' };
    return { state: 'idle', action: null };
  }
  if (state === 'idle' && !sidebarCollapsed && shouldCollapseNativeSidebar(frameWidth, centerWidth)) return { state: 'owned', action: 'collapse' };
  if (state === 'owned') {
    if (!sidebarCollapsed) return { state: 'released', action: null };
    if (frameWidth > 720) return { state: 'idle', action: 'restore' };
  }
  return { state, action: null };
}

export function nativeSidebarCleanupAction(state, sidebarCollapsed) {
  return state === 'owned' && sidebarCollapsed ? 'restore' : null;
}

export function acceptsNativePaperContext(selection, context) {
  return Boolean(selection?.projectId && selection.projectId === context?.projectId && typeof selection.selectionId === 'string' && selection.selectionId === context?.selectionId);
}

function arTarget(target, cwd, beforeOpen) {
  if (target && typeof target === 'object' && !Array.isArray(target)) return { workspaceId: target.workspaceId, cwd: target.cwd, beforeOpen: target.beforeOpen || beforeOpen, legacy: false };
  return { projectId: target, cwd, beforeOpen, legacy: true };
}

export function createNativeSessionBridge(ctx, win) {
  let generation = 0;
  let disposed = false;
  const sessions = () => arService(ctx, 'sessions');
  return {
    sessions,
    open(sessionId) { if (!AR_ID.test(sessionId || '')) throw new Error('会话标识无效'); sessions()?.open?.(sessionId); },
    async bind(target, cwd, beforeOpen) {
      const normalized = arTarget(target, cwd, beforeOpen);
      const identity = normalized.legacy ? normalized.projectId : normalized.workspaceId;
      if (!AR_ID.test(identity || '') || (normalized.legacy && (typeof normalized.cwd !== 'string' || !normalized.cwd || normalized.cwd.length > 4096 || normalized.cwd.includes('\0')))) throw new Error('项目会话位置无效');
      const own = ++generation;
      const remote = arService(ctx, 'remote.session') || arService(ctx, 'remote')?.session;
      if (!remote?.create || !sessions()?.open) throw new Error('DSH 会话服务尚未就绪，请重试');
      const saved = arSaved(win, identity);
      const location = normalized.legacy ? { cwd: normalized.cwd } : { workspaceId: identity };
      let sessionId;
      try { sessionId = arValue(await remote.create({ ...location, agentPreset: 'auto-research', ...(saved ? { sessionId: saved } : {}) })); }
      catch (error) {
        if (!saved || !/not.?found|conflict|不存在|不匹配/i.test(`${error?.code || ''} ${error?.message || ''}`)) throw error;
        sessionId = arValue(await remote.create({ ...location, agentPreset: 'auto-research' }));
      }
      if (disposed || own !== generation) return null;
      arRemember(win, identity, sessionId); normalized.beforeOpen?.(sessionId); sessions().open(sessionId); return sessionId;
    },
    async createFresh(workspaceId) {
      if (!AR_ID.test(workspaceId || '')) throw new Error('工作区标识无效');
      const own = ++generation;
      const remote = arService(ctx, 'remote.session') || arService(ctx, 'remote')?.session;
      if (!remote?.create || !sessions()?.open) throw new Error('DSH 会话服务尚未就绪，请重试');
      let result;
      try { result = await remote.create({ workspaceId, agentPreset: 'auto-research' }); }
      catch (error) { if (disposed || own !== generation) return null; throw error; }
      if (disposed || own !== generation) return null;
      const sessionId = arValue(result);
      if (disposed || own !== generation) return null;
      sessions().open(sessionId);
      return sessionId;
    },
    draft(sessionId, text) {
      if (!AR_ID.test(sessionId || '') || typeof text !== 'string' || text.length > 20000 || text.includes('\0')) return false;
      const scoped = sessions()?.scope?.(sessionId);
      const conversation = arService(scoped || {}, 'conversation') || arService(ctx, 'conversation');
      const input = conversation?.input?.for?.(scoped);
      if (!input?.setDraft) throw new Error('对话输入框尚未就绪');
      const current = input.state?.getSnapshot?.().draft || '';
      if (current && current !== text && !win.confirm?.('覆盖 DSH 对话框中尚未发送的内容吗？')) return false;
      input.setDraft(text); return true;
    },
    cancel() { ++generation; },
    dispose() { disposed = true; ++generation; },
  };
}

/** Scope native new-session actions to fresh AutoResearch sessions while the workbench is mounted. */
export function installNativeResearchSessionHook(uiWorkspace, bridge, resolveWorkspaceId, onStatus) {
  if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function' || typeof bridge?.createFresh !== 'function') return () => {};
  const hadOwn = Object.prototype.hasOwnProperty.call(uiWorkspace, 'startSession');
  const original = uiWorkspace.startSession;
  let disposed = false;
  const replacement = function startResearchSession(workspaceId) {
    const explicit = typeof workspaceId === 'string';
    const target = AR_ID.test(workspaceId || '') ? workspaceId : explicit ? null : resolveWorkspaceId?.();
    if (!AR_ID.test(target || '')) { onStatus?.('请先从左侧选择一个工作区'); return; }
    onStatus?.('正在创建科研会话');
    void bridge.createFresh(target).then((sessionId) => {
      if (!disposed && sessionId) onStatus?.('AutoResearch · 连续对话');
    }, (error) => {
      if (!disposed) onStatus?.(error?.message || '科研会话创建失败');
    });
  };
  uiWorkspace.startSession = replacement;
  return () => {
    disposed = true;
    if (uiWorkspace.startSession !== replacement) return;
    if (hadOwn) uiWorkspace.startSession = original;
    else delete uiWorkspace.startSession;
  };
}

function arPrompt(kind, document) {
  const file = document?.relativePath ? `当前论文源文件：${JSON.stringify(document.relativePath)}（相对于当前项目）。请先读取文件。\n` : '';
  if (kind === 'generate') return '请使用 AutoResearch 根据我们讨论的研究问题开展研究并生成论文。先与我确认研究问题和评价标准；正式运行时使用项目下独立的 .runs 目录，保存 main.tex、参考文献及可用的 PDF。不要编造实验结果或引用。\n我的研究想法：';
  if (kind === 'review') return `${file}请检查论文的论证、实验设计与结论是否得到证据支持，标出最需要改进的部分，并给出下一轮可以逐项讨论的建议。不要编造数据或参考文献。`;
  return `${file}请结合此前对话改进这篇论文，先说明计划再修改源文件，保留已验证的结论和引用。完成后总结修改，并按需编译 PDF。不要重新运行已完成的研究来替代论文修订。\n本轮修改要求：`;
}

function arNativeComponent(ctx, React, win, bridge) {
  const h = React.createElement;
  return function NativeResearchWorkbench() {
    const [layout, setLayout] = React.useState({ left: 0, top: 0, width: 0, height: win.innerHeight });
    const [chatHeight, setChatHeight] = React.useState(() => { try { return Number(win.localStorage?.getItem('autoresearch.chat-height')) || win.innerHeight * 0.34; } catch { return win.innerHeight * 0.34; } });
    const [collapsed, setCollapsed] = React.useState(false), [projects, setProjects] = React.useState(new Map()), [paper, setPaper] = React.useState(null), [status, setStatus] = React.useState('正在读取原生工作区'), [sessionId, setSessionId] = React.useState(null), [compatible, setCompatible] = React.useState(false);
    const frame = React.useRef(null), center = React.useRef(null), selected = React.useRef({ workspaceId: null, projectId: null, selectionId: '0' }), activeSession = React.useRef(null), sequence = React.useRef(0), bindGeneration = React.useRef(0), drag = React.useRef(null);
    const height = collapsed ? 58 : Math.max(220, Math.min(chatHeight, Math.max(240, layout.height * 0.64)));
    const send = (data) => frame.current?.contentWindow?.postMessage({ channel: AR_CHANNEL, ...data }, win.location.origin);
    const publish = (projectId) => send({ type: 'select-project', projectId: projectId || null, selectionId: selected.current.selectionId });
    const theme = () => { const styles = win.getComputedStyle(win.document.documentElement); send({ type: 'theme', values: Object.fromEntries(AR_THEME.map((name) => [name, styles.getPropertyValue(name).trim()])), scheme: styles.colorScheme?.includes('dark') && !styles.colorScheme.includes('light') ? 'dark' : 'light' }); };
    const chooseWorkspace = React.useCallback(() => {
      const sessionStore = bridge.sessions();
      let choice = selectNativeWorkspace(arService(ctx, 'workspaces'), sessionStore, projects);
      // A just-created session can be current one store tick before its preset
      // metadata is materialized. Its ID was produced by remote.session.create.
      if (!choice.sessionId && choice.workspaceId === selected.current.workspaceId && choice.projectId === selected.current.projectId && arSnapshot(sessionStore).current === activeSession.current) choice = { ...choice, sessionId: activeSession.current, sessionKind: 'research', grouped: true };
      const changed = choice.workspaceId !== selected.current.workspaceId || choice.projectId !== selected.current.projectId || choice.sessionId !== activeSession.current;
      if (!changed) { publish(choice.projectId); return; }
      ++sequence.current; ++bindGeneration.current; bridge.cancel(); selected.current = { ...choice, selectionId: String(sequence.current) }; activeSession.current = choice.sessionId; setPaper(null); setSessionId(choice.sessionId); setCompatible(nativeResearchAvailability(choice).compatible); publish(choice.projectId);
      if (!choice.workspaceId) { setStatus('请从左侧工作区进入会话'); return; }
      if (!choice.projectId) { setStatus('当前工作区尚未接入科研页面'); return; }
      if (choice.sessionId) { setStatus('AutoResearch · 连续对话'); return; }
      setStatus(choice.sessionKind === 'ordinary' ? '当前项目 · 普通会话' : choice.sessionKind === 'legacy' ? '旧 CWD 会话未归入工作区' : '当前工作区没有科研会话');
    }, [projects]);
    React.useEffect(() => { let alive = true; void win.fetch('/api/autoresearch/projects', { credentials: 'same-origin' }).then((response) => response.json()).then((data) => { if (alive) setProjects(new Map((Array.isArray(data?.projects) ? data.projects : []).filter((project) => AR_ID.test(project?.id || '') && typeof project?.workspaceId === 'string').map((project) => [project.workspaceId, project.id]))); }).catch(() => { if (alive) setStatus('科研项目清单不可用'); }); return () => { alive = false; }; }, []);
    React.useEffect(() => installNativeResearchSessionHook(arService(ctx, 'uiWorkspace'), bridge, () => selected.current.workspaceId, setStatus), []);
    React.useEffect(() => {
      const root = win.document.querySelector('[data-shell-overlay]')?.parentElement, pane = root?.querySelector(':scope > [data-rightbar-col]')?.previousElementSibling, layoutService = arService(ctx, 'layout'); let sidebarState = 'initial';
      if (!root || !pane) { setStatus('DSH 主栏尚未就绪，请刷新页面'); return; }
      center.current = pane; pane.dataset.arResearchCenter = '1';
      const measure = () => { const box = pane.getBoundingClientRect(), outer = root.getBoundingClientRect(), metrics = nativeSidebarViewportMetrics(outer.width, box.left - outer.left, box.width, win.innerWidth); setLayout((old) => old.left === box.left - outer.left && old.width === box.width && old.height === box.height ? old : { left: box.left - outer.left, top: box.top - outer.top, width: box.width, height: box.height }); const next = nextNativeSidebarState(sidebarState, { ...metrics, sidebarCollapsed: root.hasAttribute('data-sidebar-collapsed') }); sidebarState = next.state; if (next.action && typeof layoutService?.toggleSidebar === 'function') layoutService.toggleSidebar(); };
      measure(); const observer = new win.ResizeObserver(measure); observer.observe(pane); return () => { observer.disconnect(); if (nativeSidebarCleanupAction(sidebarState, root.hasAttribute('data-sidebar-collapsed'))) layoutService?.toggleSidebar?.(); delete pane.dataset.arResearchCenter; pane.style.removeProperty('--ar-native-top'); pane.style.removeProperty('--ar-native-hidden'); };
    }, []);
    React.useEffect(() => { const pane = center.current; if (pane) { pane.style.setProperty('--ar-native-top', `${Math.max(0, layout.height - height + 40)}px`); pane.style.setProperty('--ar-native-hidden', collapsed ? 'hidden' : 'visible'); } }, [layout.height, height, collapsed]);
    React.useEffect(() => {
      const onMessage = (event) => { if (event.origin !== win.location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== AR_CHANNEL) return; const data = event.data; if (data.type === 'exit') { const url = new URL(win.location.href); url.searchParams.delete('autoresearch'); win.location.assign(url.href); return; } if (data.type === 'native-ready' || data.type === 'request-context') { publish(selected.current.projectId); return; } if (data.type !== 'context' || !acceptsNativePaperContext(selected.current, data)) return; const document = data.document && typeof data.document.relativePath === 'string' && !data.document.relativePath.startsWith('/') && !data.document.relativePath.split(/[\\/]/).includes('..') ? data.document : null; setPaper({ projectId: data.projectId, dirty: data.dirty === true, busy: data.busy === true, document }); };
      win.addEventListener('message', onMessage); const workspaces = arService(ctx, 'workspaces'), sessions = bridge.sessions(), refresh = () => chooseWorkspace(); const stopWorkspaces = workspaces?.list?.subscribe?.(refresh), stopSessions = sessions?.list?.subscribe?.(refresh); refresh(); return () => { win.removeEventListener('message', onMessage); stopWorkspaces?.(); stopSessions?.(); ++sequence.current; bridge.cancel(); };
    }, [chooseWorkspace]);
    function resize(value) { setChatHeight(Math.max(220, Math.min(layout.height * 0.64, value))); }
    function endResize() { drag.current = null; win.document.body.classList.remove('ar-native-resizing'); try { win.localStorage?.setItem('autoresearch.chat-height', String(chatHeight)); } catch {} }
    function startResearch() {
      const choice = selected.current;
      if (!nativeResearchAvailability(choice).canStart) return;
      const own = ++bindGeneration.current;
      bridge.cancel(); setCompatible(false); setStatus('正在创建科研会话');
      void win.fetch(`/api/autoresearch/workbench/session-target?${new URLSearchParams({ projectId: choice.projectId })}`, { credentials: 'same-origin' }).then(async (response) => { const data = await response.json(); if (!response.ok || data?.projectId !== choice.projectId || data?.workspaceId !== choice.workspaceId || typeof data?.cwd !== 'string') throw new Error(data?.error?.message || '工作区没有有效科研目标'); return bridge.bind(data); }).then((opened) => { if (!opened || own !== bindGeneration.current || choice.selectionId !== selected.current.selectionId) return; activeSession.current = opened; setSessionId(opened); setCompatible(true); setStatus('AutoResearch · 连续对话'); }).catch((error) => { if (own === bindGeneration.current && choice.selectionId === selected.current.selectionId) setStatus(error?.message || '科研会话创建失败'); });
    }
    function draft(kind) { if (!compatible || !sessionId || paper?.busy || (kind !== 'generate' && (paper?.dirty || !paper?.document))) return; try { if (bridge.draft(sessionId, arPrompt(kind, paper?.document))) setStatus('指令已填入，请补充要求后发送'); } catch (error) { setStatus(error.message); } }
    return h('section', { className: 'ar-native-workbench', 'data-autoresearch-native-overlay': '1', style: { left: layout.left, top: layout.top, width: layout.width, height: layout.height, '--ar-chat-size': `${height}px` } }, h('header', { className: 'ar-native-header' }, h('div', null, h('strong', null, '科研工作台'), h('span', null, '论文与对话')), h('button', { onClick: () => { const url = new URL(win.location.href); url.searchParams.delete('autoresearch'); win.location.assign(url.href); }, className: 'ar-native-back' }, '返回工具区 →')), h('iframe', { ref: frame, 'data-autoresearch-paper-frame': '1', title: '论文编辑与 PDF 预览', src: '/autoresearch/?embedded=1&workspaceManaged=1', className: 'ar-native-paper', onLoad: () => { theme(); publish(selected.current.projectId); } }), h('div', { className: 'ar-native-chat-border', 'data-collapsed': collapsed || undefined }, h('div', { className: 'ar-native-grip', role: 'separator', tabIndex: 0, 'aria-label': '调整科研对话高度', 'aria-orientation': 'horizontal', 'aria-valuemin': 220, 'aria-valuemax': Math.floor(layout.height * 0.64), 'aria-valuenow': Math.round(height), onPointerDown: (event) => { if (collapsed) return; drag.current = { y: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId); win.document.body.classList.add('ar-native-resizing'); event.preventDefault(); }, onPointerMove: (event) => { if (drag.current) resize(drag.current.height + drag.current.y - event.clientY); }, onPointerUp: endResize, onPointerCancel: endResize, onLostPointerCapture: endResize, onKeyDown: (event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resize(chatHeight + (event.key === 'ArrowUp' ? 24 : -24)); } } }, h('span')), h('div', { className: 'ar-native-chat-heading' }, h('strong', null, '科研对话'), h('div', { className: 'ar-native-prompts' }, h('button', { 'data-ar-prompt': 'generate', disabled: !compatible || paper?.busy, onClick: () => draft('generate') }, '＋ 生成论文'), h('button', { 'data-ar-prompt': 'refine', disabled: !compatible || !paper?.document || paper?.dirty || paper?.busy, onClick: () => draft('refine') }, '改进论文'), h('button', { 'data-ar-prompt': 'review', disabled: !compatible || !paper?.document || paper?.dirty || paper?.busy, onClick: () => draft('review') }, '检查论证')), !compatible && nativeResearchAvailability(selected.current).canStart ? h('button', { className: 'ar-native-connect', 'data-ar-start-research': '1', onClick: startResearch }, '启动科研会话') : null, h('span', { className: 'ar-native-status', role: 'status', title: status }, status), h('button', { className: 'ar-native-collapse', 'aria-expanded': !collapsed, onClick: () => setCollapsed(!collapsed) }, collapsed ? '展开 ⌃' : '收起 ⌄'))));
  };
}

export function installNativeWorkbench(ctx, React, browser = globalThis) {
  const win = browser.window || browser, params = new URLSearchParams(win.location?.search || '');
  const nativeMode = params.get('autoresearch') === '1', legacyMode = params.get('autoresearchChat') === '1' && win.parent !== win, returnId = params.get('autoresearchSession');
  if (!nativeMode && !legacyMode && !AR_ID.test(returnId || '')) return () => {};
  const bridge = createNativeSessionBridge(ctx, win); let unregister = () => {}, style, listener;
  if (nativeMode) { style = win.document.createElement('link'); style.rel = 'stylesheet'; style.href = '/autoresearch/native-workbench.css'; win.document.head.appendChild(style); unregister = ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'autoresearch-workbench', priority: -100 }, arNativeComponent(ctx, React, win, bridge))); }
  if (legacyMode) { let projectId, sessionId; const send = (data) => win.parent.postMessage({ channel: AR_CHANNEL, ...data }, win.location.origin); listener = async (event) => { if (event.origin !== win.location.origin || event.source !== win.parent || event.data?.channel !== AR_CHANNEL) return; const data = event.data; if (data.type === 'request-ready') send({ type: 'native-ready' }); if (data.type === 'bind-session') try { const bound = await bridge.bind(data.projectId, data.cwd); if (bound) { projectId = data.projectId; sessionId = bound; send({ type: 'session-ready', projectId, sessionId, bindId: data.bindId }); } } catch (error) { send({ type: 'session-error', projectId: data.projectId, bindId: data.bindId, message: error.message }); } if (data.type === 'draft' && data.projectId === projectId && data.sessionId === sessionId && bridge.draft(sessionId, data.text)) send({ type: 'draft-ready', projectId, sessionId }); }; win.addEventListener('message', listener); send({ type: 'native-ready' }); }
  if (AR_ID.test(returnId || '')) try { bridge.open(returnId); } catch {}
  const cleanup = () => { bridge.dispose(); unregister?.(); style?.remove(); if (listener) win.removeEventListener('message', listener); }; ctx.effect?.(() => cleanup); return cleanup;
}
