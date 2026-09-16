// Offline prototype smoke test. No dependencies, no DSH profile or credentials.
// Requires Node >= 22 and a local Chromium browser. Optional argv[2]: browser path.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

const pageUrl = new URL('./dsh-settings-prototype.html', import.meta.url)
const html = await readFile(pageUrl, 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
assert.ok(script, 'inline script exists')
new Script(script)
assert.ok(!/\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage)\b/.test(script), 'no network or persistent browser storage')

const browserPath = [process.argv[2],
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(path => path && existsSync(path))
assert.ok(browserPath, 'Pass the installed Chromium executable as argv[2]')
const artifacts = await mkdtemp(join(tmpdir(), 'autoresearch-ui-smoke-'))
const browser = spawn(browserPath, [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0',
  `--user-data-dir=${join(artifacts, 'browser-profile')}`, 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let socket
let serial = 0
const pending = new Map()
const exceptions = []
const requests = []
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++serial
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`Browser startup timeout: ${output.slice(-1500)}`)), 20000)
    browser.once('error', error => { clearTimeout(timeout); reject(error) })
    browser.once('exit', code => { clearTimeout(timeout); reject(new Error(`Browser exited: ${code}`)) })
    browser.stderr.on('data', bytes => {
      output += bytes.toString()
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text)
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
    const entry = pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timeout)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const page = (method, params) => send(method, params, sessionId)
  await page('Runtime.enable')
  await page('Page.enable')
  await page('Network.enable')
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts })
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1060, deviceScaleFactor: 1, mobile: false })
  await page('Page.navigate', { url: pageUrl.href })
  async function evaluate(expression) {
    const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evaluate('document.readyState === "complete" && typeof validationErrors === "function"')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(await evaluate('document.querySelectorAll("#roles tr").length'), 8)
  assert.deepEqual(await evaluate('validationErrors()'), [])
  async function screenshot(name) {
    const result = await page('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(artifacts, name), Buffer.from(result.data, 'base64'))
  }
  await screenshot('desktop-quick.png')
  const results = await evaluate(`(() => {
    const pass = [];
    const check = (condition, name) => { if (!condition) throw new Error(name); pass.push(name); };
    document.querySelector('[data-tab="models"]').click();
    check(!document.querySelector('#panel-models').hidden, 'tab switches');
    const provider = document.querySelector('[data-provider="standard"]');
    provider.value = 'deepseek-official'; provider.dispatchEvent(new Event('change', { bubbles: true }));
    check(draft.modelRouting.tiers.standard.model === 'deepseek-v4-flash', 'provider/model pair updates');
    const tier = document.querySelector('[data-role-tier="planner"]');
    tier.value = 'deep'; tier.dispatchEvent(new Event('change', { bubbles: true }));
    check(!draft.modelRouting.roles.planner.escalateTo && document.querySelector('[data-escalation="planner"]').disabled, 'deep clears redundant escalation');
    const input = document.querySelector('[data-path="budget.maxRunTokens"]');
    input.value = '-1'; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="review"]').click();
    check(!document.querySelector('#errors').hidden && !document.querySelector('#preview-dialog').open, 'invalid budget blocks save');
    input.value = '120000'; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="review"]').click();
    check(document.querySelector('#preview-dialog').open, 'valid draft opens diff');
    check(document.querySelector('#before-yaml').textContent !== document.querySelector('#draft-yaml').textContent && changes(saved, draft).length > 0, 'diff records changes');
    document.querySelector('[data-action="confirm"]').click();
    check(!dirty() && !document.querySelector('#preview-dialog').open, 'memory save syncs snapshot');
    const routing = document.querySelector('[data-path="modelRouting.enabled"]');
    routing.checked = false; routing.dispatchEvent(new Event('input', { bubbles: true }));
    check(document.querySelector('#sum-tier').textContent === '跟随父会话', 'disabled routing explains inheritance');
    document.querySelector('[data-preset="economy"]').click();
    check(draft.budget.maxRunTokens === 60000 && draft.workflow.reflexionRounds === 0, 'economy preset works');
    check(draft.modelRouting.tiers.standard.provider === 'deepseek-official' && draft.modelRouting.roles.supervisor.tier === 'deep', 'preset preserves route and key decision tier');
    document.querySelector('[data-tab="workflow"]').click();
    const mode = document.querySelector('[data-path="workflow.mode"]');
    mode.value = 'legacy'; mode.dispatchEvent(new Event('change', { bubbles: true }));
    check(!document.querySelector('#legacy-note').hidden, 'legacy caveat visible');
    document.querySelector('[data-action="guide"]').click();
    check(document.querySelector('#guide-dialog').open && !document.querySelector('#guide-dialog input'), 'connection guide takes no secrets');
    document.querySelector('#guide-dialog').close();
    draft = clone(defaults); saved = clone(defaults); preset = 'balanced'; renderTables(); syncFields(); clearErrors(); refresh();
    document.querySelector('#toast').hidden = true;
    activateTab('models');
    return pass;
  })()`)
  await evaluate("window.scrollTo(0, 570)")
  await screenshot('desktop-models.png')
  await evaluate('download(); document.querySelector("#toast").hidden = true')
  let exported
  for (let attempt = 0; attempt < 60; attempt++) {
    try { exported = await readFile(join(artifacts, 'autoresearch-v2-example.yaml'), 'utf8'); break } catch (error) { if (error.code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(exported?.includes('version: 2'), 'YAML download completed')
  assert.ok(exported.includes('mode: "minimal"'), 'YAML preserves workflow')
  assert.ok(!/apiKey|apiKeyEnv|Authorization/.test(exported), 'YAML excludes model credentials')
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate("activateTab('quick'); window.scrollTo(0, 0)")
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'mobile page has no horizontal overflow')
  await screenshot('mobile-quick.png')
  assert.deepEqual(exceptions, [], 'no browser script exceptions')
  assert.ok(requests.every(url => url.startsWith('file:') || url.startsWith('data:')), 'no external page requests')
  console.log(JSON.stringify({ status: 'passed', checks: results, yamlDownload: 'passed, no model credentials', scriptSyntax: 'passed', mobileOverflow: 'none', screenshots: artifacts }, null, 2))
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close') } catch {}
    socket.close()
  }
  if (browser.exitCode === null) browser.kill()
  for (const entry of pending.values()) clearTimeout(entry.timeout)
  // Keep the owned temporary profile and screenshots for visual inspection.
  // No recursive deletion of user directories is performed by this script.
}
