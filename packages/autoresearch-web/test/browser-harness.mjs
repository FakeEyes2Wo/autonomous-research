import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

export function findBrowser() {
  const names = process.platform === 'win32' ? ['chrome.exe', 'msedge.exe'] : ['chromium', 'chromium-browser', 'google-chrome', 'microsoft-edge'];
  const candidates = [process.env.BROWSER_PATH, process.env.CHROME_PATH, ...String(process.env.PATH || '').split(delimiter).flatMap((part) => names.map((name) => join(part, name)))];
  if (process.platform === 'win32') for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) if (root) candidates.push(join(root, 'Microsoft/Edge/Application/msedge.exe'), join(root, 'Google/Chrome/Application/chrome.exe'));
  if (process.platform === 'darwin') candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  assert.ok(executable, 'Set BROWSER_PATH to a Chromium, Chrome or Edge executable to run browser verification.');
  return executable;
}

export async function launchBrowser() {
  const directory = await mkdtemp(join(tmpdir(), 'autoresearch-workbench-browser-'));
  const child = spawn(findBrowser(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket; let serial = 0; const pending = new Map(); const exceptions = []; const network = new Map();
  async function close() {
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    socket?.close();
    if (child.exitCode === null) child.kill();
  }
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 20000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.stderr.on('data', (bytes) => { text += bytes.toString(); const match = text.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(String(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).replace(/([?&](?:token|key)=)[^\s&]+/gi, '$1[redacted]'));
      if (message.method === 'Network.requestWillBeSent') {
        let pathname;
        try { const url = new URL(message.params.request.url); if (url.protocol === 'http:' || url.protocol === 'https:') pathname = url.pathname; } catch {}
        if (pathname) {
          if (!network.has(message.params.requestId) && network.size >= 200) network.delete(network.keys().next().value);
          network.set(message.params.requestId, { requestId: message.params.requestId, pathname, type: message.params.type, status: null, finished: false, failure: null });
        }
      }
      if (message.method === 'Network.responseReceived') {
        const item = network.get(message.params.requestId);
        if (item) item.status = message.params.response.status;
      }
      if (message.method === 'Network.loadingFinished') {
        const item = network.get(message.params.requestId);
        if (item) item.finished = true;
      }
      if (message.method === 'Network.loadingFailed') {
        const item = network.get(message.params.requestId);
        if (item) { item.finished = true; item.failure = String(message.params.errorText || 'failed').slice(0, 160); }
      }
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    await page('Runtime.enable'); await page('Page.enable');
    const evaluate = async (expression) => {
      const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const waitFor = async (expression, timeout = 20000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(`Boolean((${expression}))`)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
      throw new Error(`Timed out waiting for ${expression}; page: ${await evaluate('document.body.innerText.slice(-1800)')}`);
    };
    return { directory, exceptions, page, evaluate, waitFor, close, networkSnapshot: () => [...network.values()].map((item) => ({ ...item })), screenshot: async (name) => {
      const screenshot = await page('Page.captureScreenshot', { format: 'png' });
      const path = join(directory, name); await writeFile(path, Buffer.from(screenshot.data, 'base64')); return path;
    } };
  } catch (error) { await close(); throw error; }
}
