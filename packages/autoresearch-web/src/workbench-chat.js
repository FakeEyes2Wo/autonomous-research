import { RESEARCH_ACTIONS, researchActionDisabled, researchPrompt } from './research-ui.js';

const CHANNEL = 'autoresearch-workbench';
const $ = (id) => document.getElementById(id);

export function installChat({ api, getContext, canLeave }) {
  const panel = $('research-chat');
  const frame = $('native-chat');
  const actions = document.querySelector('.chat-prompts');
  for (const action of RESEARCH_ACTIONS) {
    const button = document.createElement('button');
    button.id = `chat-${action.id}`; button.textContent = action.label; button.title = action.description; button.disabled = true;
    button.addEventListener('click', () => prompt(action.id));
    actions.insertBefore(button, $('chat-hint'));
  }
  let current = null;
  let target = null;
  let ready = false;
  let sessionId = null;
  let sequence = 0;
  let frameReady = false;
  let frameLoaded = false;
  let lastBinding = '';
  let bindingId = '';
  let height = 320;
  let collapsed = false;
  let bindTimer;
  const send = (data) => frame.contentWindow?.postMessage({ channel: CHANNEL, ...data }, location.origin);
  function setHeight(value) {
    const max = Math.max(180, Math.floor(innerHeight * .64));
    height = Math.min(max, Math.max(180, value));
    panel.style.setProperty('--chat-height', `${height}px`);
    $('chat-resize').setAttribute('aria-valuenow', String(Math.round(height)));
    $('chat-resize').setAttribute('aria-valuemax', String(max));
  }
  try { setHeight(Number(localStorage.getItem('autoresearch.chat-height')) || innerHeight * .34); }
  catch { setHeight(innerHeight * .34); }
  function persistHeight() { try { localStorage.setItem('autoresearch.chat-height', String(height)); } catch {} }
  $('chat-collapse').addEventListener('click', () => {
    collapsed = !collapsed;
    panel.classList.toggle('collapsed', collapsed);
    $('chat-collapse').setAttribute('aria-expanded', String(!collapsed));
    $('chat-collapse').textContent = collapsed ? '展开 ⌃' : '收起 ⌄';
    $('chat-content').hidden = collapsed;
  });
  const grip = $('chat-resize');
  let drag;
  grip.addEventListener('pointerdown', (event) => {
    if (collapsed) return;
    drag = { y: event.clientY, height }; grip.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-chat'); event.preventDefault();
  });
  grip.addEventListener('pointermove', (event) => { if (drag) setHeight(drag.height + drag.y - event.clientY); });
  const endDrag = () => { drag = null; document.body.classList.remove('resizing-chat'); persistHeight(); };
  grip.addEventListener('pointerup', endDrag); grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('lostpointercapture', endDrag);
  grip.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault(); setHeight(height + (event.key === 'ArrowUp' ? 24 : -24)); persistHeight();
  });
  window.addEventListener('resize', () => setHeight(height));
  function setReady(value, label) {
    ready = value;
    $('chat-state').textContent = label;
    $('chat-loading').hidden = value;
    $('chat-retry').hidden = value;
    refreshButtons();
  }
  function refreshButtons() {
    const context = getContext();
    for (const action of RESEARCH_ACTIONS) $('chat-' + action.id).disabled = researchActionDisabled(action.id, { ...context, ready });
    $('chat-hint').textContent = context.dirty ? '先保存论文，再将最新内容带入对话' : '快捷指令会填入草稿，由你发送';
  }
  function bind() {
    if (!target || !frameReady) return;
    const key = JSON.stringify([current, target.cwd]);
    if (lastBinding === key) return;
    lastBinding = key;
    bindingId = crypto.randomUUID();
    send({ type: 'bind-session', projectId: current, cwd: target.cwd, bindId: bindingId });
  }
  frame.addEventListener('load', () => { frameLoaded = true; frameReady = false; lastBinding = ''; send({ type: 'request-ready' }); });
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.channel !== CHANNEL) return;
    const data = event.data;
    if (data.type === 'native-ready' && frameLoaded && !frameReady) { frameReady = true; bind(); }
    if (data.projectId !== current) return;
    if (['session-ready', 'session-error'].includes(data.type) && (!bindingId || data.bindId !== bindingId)) return;
    if (data.type === 'session-ready' && /^[A-Za-z0-9_-]{1,256}$/.test(data.sessionId || '')) {
      clearTimeout(bindTimer);
      sessionId = data.sessionId;
      setReady(true, 'AutoResearch · 对话可连续迭代');
      for (const link of [$('back-dsh'), $('chat-open-dsh')]) link.href = `/?autoresearchSession=${encodeURIComponent(data.sessionId)}`;
    }
    if (data.type === 'session-error') {
      clearTimeout(bindTimer);
      setReady(false, '会话连接失败');
      $('chat-loading').firstElementChild.textContent = typeof data.message === 'string' ? data.message.slice(0, 300) : '无法接入原生会话，请重试。';
      $('chat-retry').hidden = false;
    }
    if (data.type === 'draft-ready') $('chat-hint').textContent = '指令已放入下方输入框，可补充要求后发送';
  });
  async function selectProject(projectId) {
    current = projectId; target = null; lastBinding = ''; sessionId = null; bindingId = '';
    const generation = ++sequence;
    clearTimeout(bindTimer);
    setReady(false, '正在连接项目会话');
    $('chat-loading').firstElementChild.textContent = '正在接入原生对话…';
    $('chat-retry').hidden = true;
    try {
      const result = await api(`/workbench/session-target?${new URLSearchParams({ projectId })}`);
      if (generation !== sequence) return;
      target = result;
      if (frame.getAttribute('src') === 'about:blank') { frameLoaded = false; frame.src = '/?autoresearchChat=1'; }
      else bind();
      bindTimer = setTimeout(() => {
        if (generation === sequence && !ready) {
          $('chat-loading').firstElementChild.textContent = '原生会话尚未连接。可重试，或返回 DSH 工具区继续。';
          $('chat-retry').hidden = false;
        }
      }, 30000);
    } catch (error) {
      if (generation !== sequence) return;
      setReady(false, '会话连接失败');
      $('chat-loading').firstElementChild.textContent = error.message;
      $('chat-retry').hidden = false;
    }
  }
  const handshake = setInterval(() => { if (!frameReady && target) send({ type: 'request-ready' }); }, 1000);
  window.addEventListener('pagehide', () => { clearInterval(handshake); clearTimeout(bindTimer); });
  $('chat-retry').addEventListener('click', () => {
    frameReady = false; frameLoaded = false; frame.src = '/?autoresearchChat=1';
    if (current) void selectProject(current);
  });
  $('chat-open-dsh').addEventListener('click', (event) => { if (!canLeave()) event.preventDefault(); });
  function prompt(kind) {
    const context = getContext();
    if (researchActionDisabled(kind, { ...context, ready })) return;
    send({ type: 'draft', projectId: current, sessionId, text: researchPrompt(kind, context.document) });
  }
  return { update() {
    const context = getContext();
    if (context.projectId && current !== context.projectId) void selectProject(context.projectId);
    refreshButtons();
  } };
}
