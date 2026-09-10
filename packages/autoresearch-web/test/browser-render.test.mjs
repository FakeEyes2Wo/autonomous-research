// Real React + built DSH client factory smoke. The HTTP host and project are
// temporary; this never starts DSH or reads the user's profile/credentials.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { apply } from '../dist/index.js'
import * as settings from '../../autoresearch/dist/settings/index.js'

const root = await mkdtemp(join(tmpdir(), 'autoresearch-web-browser-'))
await writeFile(join(root, 'seed.txt'), 'temporary project\n', 'utf8')
let conflictRoleOnce = true
const service = {
  readProjectSettingsDocument: async ({ root: projectRoot }) => { const value = await settings.readProjectSettingsDocument(projectRoot); return { revision: value.revision, document: value.settings } },
  validateProjectSettingsCandidate: async ({ candidate }) => settings.validateProjectSettingsCandidate(candidate),
  patchProjectSettingsDocument: async ({ root: projectRoot, expectedRevision, operations }) => { if (conflictRoleOnce && operations.some((operation) => operation.path === 'modelRouting.roles.planner')) { conflictRoleOnce = false; const error = new Error('simulated concurrent edit'); error.code = 'STALE_REVISION'; throw error } const value = await settings.patchProjectSettingsDocument(projectRoot, { expectedRevision, ops: operations.map((operation) => ({ ...operation, path: `/${operation.path.split('.').join('/')}` })) }); return { revision: value.revision, document: value.settings } },
}
const apiRoutes = new Map()
const dispose = await apply({
  webServer: { register(route) { apiRoutes.set(route.path, route.handler); return () => apiRoutes.delete(route.path) } },
  autoresearchSettings: service,
}, { standaloneProjects: true, projects: [{ id: 'smoke', name: 'Temporary smoke project', root }] })

const client = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
const reactPath = existsSync(new URL('../node_modules/react/umd/react.development.js', import.meta.url))
  ? new URL('../node_modules/react/umd/react.development.js', import.meta.url)
  : new URL('../../autoresearch/node_modules/react/umd/react.development.js', import.meta.url)
const reactDomPath = existsSync(new URL('../node_modules/react-dom/umd/react-dom.development.js', import.meta.url))
  ? new URL('../node_modules/react-dom/umd/react-dom.development.js', import.meta.url)
  : new URL('../../autoresearch/node_modules/react-dom/umd/react-dom.development.js', import.meta.url)
const react = await readFile(reactPath, 'utf8')
const reactDom = await readFile(reactDomPath, 'utf8')
const html = `<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.__ModuleLoader__={load(spec){window.__dshBundle=spec}}</script><script>${react}</script><script>${reactDom}</script><script>${client}</script><script>
const loaded=window.__dshBundle.factory((name)=>name==='react'?React:undefined); let section; const slots={inject(_name,fn){fn()},register(options,component){if(options.name==='settings.section')section=component;return()=>{if(options.name==='settings.section')section=undefined}}}; loaded.apply({locale:{register(){}},slots}); const root=ReactDOM.createRoot(document.querySelector('#root')); root.render(React.createElement(section,{close(){window.__closed=true}})); window.__rendered=true;
</script>`
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/autoresearch')) return apiRoutes.get('/api/autoresearch')?.(req, res)
  if (req.url === '/react.js') { res.setHeader('content-type', 'text/javascript'); return res.end(react) }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
function findOnPath(name) {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(command, [name], { encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : undefined
}
function findBrowser() {
  const explicit = [process.env.BROWSER_PATH, process.env.CHROME_PATH].filter(Boolean)
  const platformDefaults = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).flatMap((root) => [join(root, 'Google/Chrome/Application/chrome.exe'), join(root, 'Microsoft/Edge/Application/msedge.exe')])
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
  for (const candidate of [...explicit, ...platformDefaults]) if (isAbsolute(candidate) && existsSync(candidate)) return candidate
  const pathNames = process.platform === 'win32' ? ['chrome.exe', 'msedge.exe'] : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']
  return pathNames.map(findOnPath).find(Boolean)
}
const browserPath = findBrowser()
assert.ok(browserPath, 'Chromium executable is required for browser smoke')
const profile = await mkdtemp(join(tmpdir(), 'autoresearch-web-browser-profile-'))
const browser = spawn(browserPath, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let socket
let serial = 0
const pending = new Map()
function send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++serial; const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000); pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }) }
try {
  const endpoint = await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error(`browser startup timeout: ${output.slice(-500)}`)), 20000); browser.stderr.on('data', (data) => { output += data.toString(); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]) } }); browser.once('error', reject) })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); const entry = pending.get(message.id); if (!entry) return; clearTimeout(entry.timeout); pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result) })
  const target = await send('Target.createTarget', { url: 'about:blank' }); const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }); const sessionId = attached.sessionId
  const page = (method, params) => send(method, params, sessionId)
  await page('Runtime.enable'); await page('Page.enable'); await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  const evaluate = async (expression) => { const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value }
  for (let i = 0; i < 80; i += 1) { if (await evaluate('window.__rendered && document.querySelectorAll("input").length > 0')) break; await new Promise((resolve) => setTimeout(resolve, 100)) }
  assert.equal(await evaluate('document.querySelector("[aria-label=\\"AutoResearch project settings\\"]") !== null'), true)
  assert.equal(await evaluate('document.body.innerText.includes("模型来源") && document.body.innerText.includes("研究强度") && document.body.innerText.includes("论文输出")'), true)
  assert.equal(await evaluate('document.querySelector("details.ar-advanced")?.open === false'), true)
  assert.equal(await evaluate('document.querySelector(".ar-workbench-link")?.getAttribute("href") === "/?autoresearch=1"'), true)
  assert.equal(await evaluate('document.body.innerText.includes("revision")'), false)
  assert.deepEqual(await evaluate(`(()=>Object.fromEntries(['模型来源','研究强度','论文输出'].map((name)=>{const field=[...document.querySelectorAll('label')].find((node)=>node.textContent.includes(name)); return [name,field?.querySelector('select')?.value];})))()`), { '模型来源': 'inherit', '研究强度': 'balanced', '论文输出': 'auto' })
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true)
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
  const customIntensity = await evaluate(`(()=>{const advanced=document.querySelector('details.ar-advanced'); advanced.open=true; const target=document.querySelector('label[data-path="workflow.candidateLimit"] input'); if(!target) throw new Error('candidateLimit input not found'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(target,'4'); target.dispatchEvent(new Event('input',{bubbles:true})); return new Promise((resolve)=>setTimeout(()=>{const intensity=[...document.querySelectorAll('label')].find((node)=>node.textContent.includes('研究强度'))?.querySelector('select'); resolve({value:intensity?.value, open:advanced.open});},100));})()`)
  assert.deepEqual(customIntensity, { value: 'custom', open: true })
  await evaluate(`(()=>{[...document.querySelectorAll('button')].find((node)=>node.textContent.includes('撤销'))?.click();})()`)
  const closeGuard = await evaluate(`(()=>{const target=document.querySelector('label[data-path="workflow.candidateLimit"] input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(target,'4'); target.dispatchEvent(new Event('input',{bubbles:true})); return new Promise((resolve)=>setTimeout(()=>{window.confirm=()=>false; [...document.querySelectorAll('button')].find((node)=>node.textContent.includes('关闭'))?.click(); resolve(window.__closed===true);},100));})()`)
  assert.equal(closeGuard, false)
  await evaluate(`(()=>{[...document.querySelectorAll('button')].find((node)=>node.textContent.includes('撤销'))?.click();})()`)
  const screenshot = await page('Page.captureScreenshot', { format: 'png' })
  const screenshotPath = join(profile, 'dsh-autoresearch-settings.png')
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const saved = await evaluate(`(async()=>{const target=document.querySelector('label[data-path="budget.maxRunTokens"] input'); if(!target) throw new Error('maxRunTokens input not found'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(target,'130000'); target.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,100)); const button=[...document.querySelectorAll('button')].find((node)=>node.className.includes('primary')); button.click(); await new Promise(r=>setTimeout(r,500)); const result=await fetch('/api/autoresearch/settings?projectId=smoke'); const body=await result.json(); return {maxRunTokens:body.document?.budget?.maxRunTokens, revision:body.revision};})()`)
  assert.equal(saved.maxRunTokens, 130000)
  const invalidBudget = await evaluate(`(async()=>{const target=document.querySelector('label[data-path="budget.maxRunTokens"] input'); if(!target) throw new Error('maxRunTokens input not found'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(target,'-1'); target.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,100)); const button=[...document.querySelectorAll('button')].find((node)=>node.className.includes('primary')); button.click(); await new Promise(r=>setTimeout(r,500)); return document.querySelector('[role="alert"]')?.textContent || '';})()`)
  assert.equal(invalidBudget.includes('/budget/maxRunTokens'), true, invalidBudget)
  const restoreBudget = await evaluate(`(async()=>{const target=document.querySelector('label[data-path="budget.maxRunTokens"] input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(target,'130000'); target.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,100)); const button=[...document.querySelectorAll('button')].find((node)=>node.className.includes('primary')); button.click(); await new Promise(r=>setTimeout(r,500)); const result=await fetch('/api/autoresearch/settings?projectId=smoke'); const body=await result.json(); return body.document?.budget?.maxRunTokens;})()`)
  assert.equal(restoreBudget, 130000)
  const clearedBudget = await evaluate(`(async()=>{const target=document.querySelector('label[data-path="budget.maxRunTokens"] input'); if(!target) throw new Error('maxRunTokens input not found'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(target,''); target.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,100)); const button=[...document.querySelectorAll('button')].find((node)=>node.className.includes('primary')); button.click(); await new Promise(r=>setTimeout(r,500)); const result=await fetch('/api/autoresearch/settings?projectId=smoke'); const body=await result.json(); return {alert:document.querySelector('[role="alert"]')?.textContent || '', maxRunTokens:body.document?.budget?.maxRunTokens};})()`)
  assert.equal(clearedBudget.alert.includes('finite positive integer'), false)
  assert.equal(clearedBudget.maxRunTokens, 120000)
  const roleConflict = await evaluate(`(async()=>{const row=[...document.querySelectorAll('.ar-table tbody tr')].find((node)=>node.textContent.includes('planner')); const tier=row?.querySelector('select'); if(!tier) throw new Error('planner tier control not found'); tier.value='deep'; tier.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,100)); const button=[...document.querySelectorAll('button')].find((node)=>node.className.includes('primary')); button.click(); await new Promise(r=>setTimeout(r,300)); const conflictAlert=document.querySelector('[role="alert"]')!==null; window.confirm=()=>true; const reload=[...document.querySelectorAll('button')].find((node)=>node.textContent.includes('重新加载')); reload.click(); await new Promise(r=>setTimeout(r,400)); const latest=await fetch('/api/autoresearch/settings?projectId=smoke'); const body=await latest.json(); return {conflictAlert, roleTier:tier.value, rolePersisted:Boolean(body.document?.modelRouting?.roles?.planner)};})()`)
  assert.equal(roleConflict.conflictAlert, true)
  assert.equal(roleConflict.roleTier, '')
  assert.equal(roleConflict.rolePersisted, false)
  const clearedProject = await evaluate(`(async()=>{const select=[...document.querySelectorAll('select')].find((node)=>[...node.options].some((option)=>option.value==='smoke')); if(!select) throw new Error('project selector not found'); select.value=''; select.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,100)); const target=document.querySelector('label[data-path="budget.maxRunTokens"] input'); return {status:document.querySelector('.ar-badge')?.textContent || '', maxRunTokens:target?.value || null};})()`)
  assert.equal(clearedProject.status, '请选择项目', JSON.stringify(clearedProject))
  assert.equal(clearedProject.maxRunTokens, null)
  console.log(JSON.stringify({ status: 'passed', rendered: true, savedAndReloaded: saved, roleConflict, screenshot: screenshotPath, projectRoot: root }, null, 2))
} finally {
  dispose(); server.close(); if (socket?.readyState === WebSocket.OPEN) { try { await send('Browser.close') } catch {} socket.close() }; if (browser.exitCode === null) browser.kill(); for (const entry of pending.values()) clearTimeout(entry.timeout)
}
