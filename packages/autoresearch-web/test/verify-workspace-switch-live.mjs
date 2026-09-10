import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchBrowser } from './browser-harness.mjs';

const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const liveLog = option('--log');
const workspaceTitle = option('--workspace');
const expectedSession = option('--session');
const directSession = process.argv.includes('--direct-session');
const verifyNativeDefault = process.argv.includes('--verify-native-default');
assert.ok(liveLog && workspaceTitle, 'Pass --log <DSH startup log> --workspace <existing workspace title>.');
const log = await readFile(liveLog, 'utf8');
const address = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
assert.ok(address, 'Startup log does not contain a local DSH login URL.');

const browser = await launchBrowser();
try {
  const { page, evaluate, waitFor } = browser;
  await page('Page.addScriptToEvaluateOnNewDocument', { source: `window.__arWarnings=[];{const original=console.warn.bind(console);console.warn=(...args)=>{try{window.__arWarnings.push(args.map(value=>value instanceof Error?{name:value.name,message:value.message,code:value.code}:String(value)))}catch{}return original(...args)}}` });
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  const startAddress = new URL(address);
  if (directSession && expectedSession) { startAddress.searchParams.set('autoresearch', '1'); startAddress.searchParams.set('autoresearchSession', expectedSession); }
  await page('Page.navigate', { url: startAddress.href });
  await waitFor('document.querySelector(".ar-native-brand")');
  await waitFor(`document.body.innerText.includes(${JSON.stringify(workspaceTitle)})`);
  const sessionIdentity = `(()=>{const selected=document.querySelector('[role="treeitem"][aria-selected="true"]');if(!selected)return null;const dataTransfer=new DataTransfer();selected.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer}));return dataTransfer.getData('text/plain')||null})()`;
  await waitFor(sessionIdentity);
  if (directSession && expectedSession) await waitFor(`${sessionIdentity}===${JSON.stringify(expectedSession)}`);
  const originalSession = await evaluate(sessionIdentity);
  assert.ok(originalSession, 'The current native session must expose its identity.');

  if (!directSession) await evaluate('document.querySelector(".ar-native-brand").click()');
  await waitFor('document.querySelector("[data-autoresearch-paper-frame]")');

  const workspaceAction = await evaluate(`(()=>{const title=${JSON.stringify(workspaceTitle)},leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title),row=leaf?.closest('[role="treeitem"]');if(!row)return null;const box=row.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2,expanded:row.getAttribute('aria-expanded')==='true'}})()`);
  assert.ok(workspaceAction, `Workspace ${workspaceTitle} is not present in the native sidebar.`);
  if (!workspaceAction.expanded) {
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: workspaceAction.x, y: workspaceAction.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: workspaceAction.x, y: workspaceAction.y, button: 'left', clickCount: 1 });
  }
  await waitFor(`(()=>{const title=${JSON.stringify(workspaceTitle)},leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title);return leaf?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')==='true'})()`);
  const afterFolderExpansion = await evaluate(sessionIdentity);

  if (expectedSession) {
    if (originalSession !== expectedSession) {
      const existing = await evaluate(`(()=>{const wanted=${JSON.stringify(expectedSession)},rows=[...document.querySelectorAll('[role="treeitem"]')];for(const row of rows){const transfer=new DataTransfer();row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));if(transfer.getData('text/plain')===wanted){const box=row.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}}}return null})()`);
      assert.ok(existing, `Expected fresh session ${expectedSession} is not visible under ${workspaceTitle}.`);
      await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: existing.x, y: existing.y, button: 'left', clickCount: 1 });
      await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: existing.x, y: existing.y, button: 'left', clickCount: 1 });
    }
    await waitFor(`${sessionIdentity}===${JSON.stringify(expectedSession)}`);
  } else {
    const createLabel = `在“${workspaceTitle}”中新建会话`;
    const createFound = await evaluate(`Boolean(document.querySelector('button[aria-label=${JSON.stringify(createLabel)}]'))`);
    assert.ok(createFound, `Workspace ${workspaceTitle} does not expose its native create-session action.`);
    await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(createLabel)}]').click()`);
    try { await waitFor(`(()=>{const id=${sessionIdentity};return Boolean(id)&&id!==${JSON.stringify(originalSession)}})()`, 10000); }
    catch (error) {
      const warnings = await evaluate('window.__arWarnings');
      throw new Error(`Native workspace create did not select a fresh session; warnings=${JSON.stringify(warnings)}`, { cause: error });
    }
  }
  const selectedTargetSession = await evaluate(sessionIdentity);
  assert.ok(selectedTargetSession, 'Selecting the target workspace session must expose its identity.');
  if (expectedSession) assert.equal(selectedTargetSession, expectedSession);
  else assert.notEqual(selectedTargetSession, originalSession, 'The workspace action must create a fresh session.');
  await waitFor(`(()=>{const title=${JSON.stringify(workspaceTitle)},leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title),workspace=leaf?.closest('[role="treeitem"]'),rows=[...document.querySelectorAll('[role="treeitem"]')],start=rows.indexOf(workspace);if(start<0)return false;const following=rows.slice(start+1),boundary=following.findIndex(e=>e.hasAttribute('aria-expanded')),sessions=(boundary<0?following:following.slice(0,boundary)).filter(e=>!e.hasAttribute('aria-expanded'));return sessions.some(row=>{const transfer=new DataTransfer();row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));return transfer.getData('text/plain')===${JSON.stringify(selectedTargetSession)}})})()`);
  await waitFor(`document.querySelector('[data-autoresearch-paper-frame]')?.contentDocument?.querySelector('#project-name')?.textContent===${JSON.stringify(workspaceTitle)}`);
  const projectName = await evaluate('document.querySelector("[data-autoresearch-paper-frame]").contentDocument.querySelector("#project-name").textContent');
  const projectId = await evaluate('document.querySelector("[data-autoresearch-paper-frame]").contentDocument.querySelector("#project").value');
  const target = await evaluate(`fetch('/api/autoresearch/workbench/session-target?'+new URLSearchParams({projectId:${JSON.stringify(projectId)}}),{credentials:'same-origin'}).then(async response=>({status:response.status,body:await response.json()}))`);
  assert.equal(target.status, 200);
  assert.equal(target.body.projectId, projectId);
  assert.equal(typeof target.body.workspaceId, 'string');
  assert.equal(target.body.cwd, 'D:\\teskdesk\\TEST paper');
  await waitFor('document.querySelector(".ar-native-status")?.textContent==="AutoResearch · 连续对话"');
  const workbenchStatus = await evaluate('document.querySelector(".ar-native-status").textContent');
  const screenshot = await browser.screenshot('test-paper-autoresearch-session.png');
  await evaluate('document.querySelector(".ar-native-back").click()');
  await waitFor('!document.querySelector("[data-autoresearch-paper-frame]")');

  let nativeDefaultSessionCreated = false;
  if (verifyNativeDefault) {
    await waitFor('document.querySelector(".ar-native-brand")');
    await waitFor(`document.body.innerText.includes(${JSON.stringify(workspaceTitle)})`);
    const beforeNativeCreate = await evaluate(sessionIdentity);
    const createLabel = `在“${workspaceTitle}”中新建会话`;
    const nativeWorkspaceAction = await evaluate(`(()=>{const title=${JSON.stringify(workspaceTitle)},leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title),row=leaf?.closest('[role="treeitem"]');if(!row)return null;const box=row.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2,expanded:row.getAttribute('aria-expanded')==='true'}})()`);
    assert.ok(nativeWorkspaceAction);
    if (!nativeWorkspaceAction.expanded) {
      await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: nativeWorkspaceAction.x, y: nativeWorkspaceAction.y, button: 'left', clickCount: 1 });
      await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nativeWorkspaceAction.x, y: nativeWorkspaceAction.y, button: 'left', clickCount: 1 });
    }
    await waitFor(`document.querySelector('button[aria-label=${JSON.stringify(createLabel)}]')`);
    await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(createLabel)}]').click()`);
    await waitFor(`(()=>{const id=${sessionIdentity};return Boolean(id)&&id!==${JSON.stringify(beforeNativeCreate)}})()`, 10000);
    const warnings = await evaluate('window.__arWarnings');
    assert.equal(warnings.some((args) => String(args[0]).includes('new session failed:')), false, JSON.stringify(warnings));
    nativeDefaultSessionCreated = true;
  }

  const restore = await evaluate(`(()=>{const wanted=${JSON.stringify(originalSession)},rows=[...document.querySelectorAll('[role="treeitem"]')];for(const row of rows){const dataTransfer=new DataTransfer();row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer}));if(dataTransfer.getData('text/plain')===wanted){const box=row.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}}}return null})()`);
  if (restore) {
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: restore.x, y: restore.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: restore.x, y: restore.y, button: 'left', clickCount: 1 });
    await waitFor(`${sessionIdentity}===${JSON.stringify(originalSession)}`);
  }

  console.log(JSON.stringify({ status: 'passed', workspaceTitle, folderExpansionChangedSession: afterFolderExpansion !== originalSession, freshSessionVerified: expectedSession ? selectedTargetSession === expectedSession : selectedTargetSession !== afterFolderExpansion, sessionBelongsToTargetWorkspace: true, projectName, workbenchStatus, targetCwd: target.body.cwd, nativeDefaultSessionCreated, originalSessionRestored: Boolean(restore), screenshot }, null, 2));
} finally {
  await browser.close();
}
