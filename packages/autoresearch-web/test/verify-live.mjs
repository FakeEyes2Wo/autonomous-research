// Explicit local deployment acceptance. DSH_LIVE_LOG names a startup log from
// the instance being checked. Authentication stays in memory and is not printed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchBrowser } from './browser-harness.mjs';

const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const liveLog = option('--log') || process.env.DSH_LIVE_LOG;
const workspaceTitle = option('--workspace') || process.env.DSH_LIVE_WORKSPACE_TITLE;
assert.ok(liveLog, 'Pass --log <DSH startup log> or set DSH_LIVE_LOG.');
assert.ok(workspaceTitle, 'Pass --workspace <existing DSH workspace title> or set DSH_LIVE_WORKSPACE_TITLE.');
const log = await readFile(liveLog, 'utf8');
const address = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
assert.ok(address, 'Startup log does not contain a local DSH login URL.');
function networkDiagnostics(items) {
  const pending = items.filter((item) => !item.finished);
  const counts = {};
  for (const item of pending) {
    const key = `${item.type}:${item.pathname}:${item.status ?? 'pending'}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return { completed: items.length - pending.length, pending: pending.length, counts, recentPending: pending.slice(-30) };
}
const browser = await launchBrowser();
try {
  const { page, evaluate, waitFor } = browser;
  await page('Network.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: address });
  await waitFor('document.querySelectorAll("button").length > 3');
  await waitFor('document.querySelector(".ar-native-brand")');
  await waitFor(`document.body.innerText.includes(${JSON.stringify(workspaceTitle)})`);
  const workspaceAction = await evaluate(`(()=>{const title=${JSON.stringify(workspaceTitle)};const leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title);const workspace=leaf?.closest('[role="treeitem"]');if(!workspace)return null;const box=workspace.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2,expanded:workspace.getAttribute('aria-expanded')==='true'}})()`);
  assert.ok(workspaceAction, 'The requested native workspace directory is not selectable.');
  if (!workspaceAction.expanded) {
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: workspaceAction.x, y: workspaceAction.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: workspaceAction.x, y: workspaceAction.y, button: 'left', clickCount: 1 });
  }
  await waitFor(`(()=>{const title=${JSON.stringify(workspaceTitle)};const leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title);return leaf?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')==='true'})()`);
  await waitFor(`(()=>{const title=${JSON.stringify(workspaceTitle)};const leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title);const workspace=leaf?.closest('[role="treeitem"]');if(!workspace)return false;const rows=[...document.querySelectorAll('[role="treeitem"]')];const start=rows.indexOf(workspace);return rows.slice(start+1).some(e=>e.hasAttribute('aria-selected'))})()`);
  const existingSessionAction = await evaluate(`(()=>{const title=${JSON.stringify(workspaceTitle)};const leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title);const workspace=leaf?.closest('[role="treeitem"]');const rows=[...document.querySelectorAll('[role="treeitem"]')];const start=rows.indexOf(workspace);const session=rows.slice(start+1).find(e=>!e.hasAttribute('aria-expanded'));if(!session)return null;const box=session.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()`);
  assert.ok(existingSessionAction, 'The expanded workspace has no existing selectable session.');
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', ...existingSessionAction, button: 'left', clickCount: 1 });
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', ...existingSessionAction, button: 'left', clickCount: 1 });
  await waitFor('!document.body.innerText.includes("选择一个工作区开始")');
  const sessionIdentity = `(()=>{const selected=document.querySelector('[role="treeitem"][aria-selected="true"]');if(!selected)return null;const dataTransfer=new DataTransfer();selected.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer}));return dataTransfer.getData('text/plain')||null})()`;
  const selectedSessionBefore = await evaluate(sessionIdentity);
  assert.ok(selectedSessionBefore, 'The native selected session must expose its session identity.');
  assert.equal(await evaluate('document.querySelector(".ar-native-brand").getAttribute("href").includes("embedded")'), false);
  await evaluate('document.querySelector(".ar-native-brand").click()');
  const paperDoc = 'document.querySelector("[data-autoresearch-paper-frame]")?.contentDocument';
  await waitFor(`${paperDoc}?.querySelector("#project")?.value`);
  await waitFor(`!${paperDoc}.querySelector("#new-document").disabled`);
  assert.equal(await evaluate(`${paperDoc}.querySelector("#project").hidden`), true, 'Native workspace mode must not expose an independent project selector.');
  assert.equal(await evaluate(`${paperDoc}.querySelector("#notice").hidden`), true, await evaluate(`${paperDoc}.querySelector("#notice").textContent`));
  assert.equal(await evaluate(`${paperDoc}.querySelector("#engine-state").textContent.includes("可以编译")`), true);
  await waitFor(`${paperDoc}.querySelector("#pdf-canvas").dataset.renderedPage === "1"`);
  await waitFor('document.querySelector("[data-ar-start-research]")');
  assert.equal(await evaluate('document.querySelector("[data-ar-prompt=generate]").disabled'), true, 'A normal DSH session stays selected until research is explicitly started.');
  await evaluate('document.querySelector("[data-ar-start-research]").click()');
  await waitFor('!document.querySelector("[data-ar-prompt=generate]").disabled', 45000);
  const researchSessionBefore = await evaluate(sessionIdentity);
  assert.ok(researchSessionBefore, 'The explicitly created AutoResearch conversation must be selected.');
  assert.notEqual(researchSessionBefore, selectedSessionBefore, 'Starting research must create or reopen a distinct AutoResearch session.');
  await waitFor('document.querySelector("[data-ar-research-center] textarea,[data-ar-research-center] [contenteditable=true]")', 20000);
  assert.equal(await evaluate('document.querySelector(".ar-native-chat-border").getBoundingClientRect().bottom <= innerHeight - 12'), true);
  assert.equal(await evaluate('document.querySelector("[data-autoresearch-paper-frame]").getBoundingClientRect().left >= 250'), true, 'The native workspace sidebar stays visible');
  const chatBeforeResize = await evaluate('document.querySelector(".ar-native-chat-border").getBoundingClientRect().height');
  await evaluate('document.querySelector(".ar-native-grip").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true}))');
  assert.ok(await evaluate('document.querySelector(".ar-native-chat-border").getBoundingClientRect().height') > chatBeforeResize);
  await evaluate('document.querySelector(".ar-native-collapse").click()');
  assert.equal(await evaluate('document.querySelector(".ar-native-collapse").getAttribute("aria-expanded")'), 'false');
  await evaluate('document.querySelector(".ar-native-collapse").click()');
  await evaluate('document.querySelector("[data-ar-prompt=generate]").click()');
  await waitFor('document.querySelector(".ar-native-status").textContent.includes("已填入")');
  assert.equal(await evaluate('([...document.querySelectorAll("textarea,[contenteditable=true]")].some(e=>(e.value||e.textContent).includes("请使用 AutoResearch")))'), true);
  const workbenchScreenshot = await browser.screenshot('dsh-workbench.png');
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitFor('(()=>{const frame=document.querySelector("[data-autoresearch-paper-frame]"),root=document.querySelector("[data-shell-overlay]")?.parentElement,sidebar=root?.firstElementChild;if(!frame||!sidebar)return false;const box=frame.getBoundingClientRect();return sidebar.getBoundingClientRect().width<=72&&Math.max(0,Math.min(box.right,innerWidth)-Math.max(box.left,0))>=300})()', 10000);
  const mobilePaper = await evaluate(`(()=>{const frame=document.querySelector('[data-autoresearch-paper-frame]'),doc=frame?.contentDocument,editor=doc?.querySelector('#editor'),title=doc?.querySelector('#document-name');if(!frame||!doc||!editor||!title)return null;const frameBox=frame.getBoundingClientRect(),editorBox=editor.getBoundingClientRect(),titleStyle=getComputedStyle(title),editorStyle=getComputedStyle(editor);return {frameLeft:frameBox.left,frameRight:frameBox.right,frameWidth:frameBox.width,editorWidth:editorBox.width,titleWidth:title.getBoundingClientRect().width,titleWritingMode:titleStyle.writingMode,editorWritingMode:editorStyle.writingMode,scrollWidth:document.documentElement.scrollWidth}})()`);
  assert.ok(mobilePaper, 'Mobile paper frame controls must remain available.');
  const mobilePaperVisibleWidth = Math.max(0, Math.min(mobilePaper.frameRight, 390) - Math.max(0, mobilePaper.frameLeft));
  assert.ok(mobilePaperVisibleWidth >= 300, `Mobile paper visible width became unusable: ${JSON.stringify({ ...mobilePaper, visibleWidth: mobilePaperVisibleWidth })}`);
  assert.ok(mobilePaper.editorWidth > 0, `Mobile editor disappeared: ${JSON.stringify(mobilePaper)}`);
  assert.ok(mobilePaper.titleWidth > 0, `Mobile title disappeared: ${JSON.stringify(mobilePaper)}`);
  assert.equal(mobilePaper.titleWritingMode, 'horizontal-tb');
  assert.equal(mobilePaper.editorWritingMode, 'horizontal-tb');
  assert.ok(mobilePaper.scrollWidth <= 390, `Mobile page overflowed: ${JSON.stringify(mobilePaper)}`);
  const mobileSidebar = await evaluate(`(()=>{const overlay=document.querySelector('[data-shell-overlay]'),root=overlay?.parentElement,pane=root?.querySelector(':scope > [data-rightbar-col]')?.previousElementSibling;const attrs=(node)=>node?Object.fromEntries([...node.attributes].map(a=>[a.name,a.value])):null;return {innerWidth,root:{x:root?.getBoundingClientRect().x,width:root?.getBoundingClientRect().width,attrs:attrs(root),children:[...root.children].map(e=>({tag:e.tagName,cls:String(e.className),x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width,attrs:attrs(e)}))},pane:{x:pane?.getBoundingClientRect().x,width:pane?.getBoundingClientRect().width,attrs:attrs(pane)},rightbars:[...document.querySelectorAll('[data-rightbar-col]')].map(e=>({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width,attrs:attrs(e)})),sidebarCollapsed:Boolean(root?.hasAttribute('data-sidebar-collapsed'))}})()`);
  assert.equal(mobileSidebar.sidebarCollapsed, true, `Mobile native sidebar was not collapsed: ${JSON.stringify(mobileSidebar)}`);
  await evaluate('document.querySelector("button[aria-label=\\"打开侧边栏\\"]")?.click()');
  await waitFor('document.querySelector("[data-sidebar-collapsed]")?.getAttribute("data-sidebar-collapsed") !== "true"');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await evaluate('Boolean(document.querySelector("[data-sidebar-collapsed]"))'), false, 'Manually opening the mobile sidebar must not be folded back by ResizeObserver.');
  const mobileWorkspaceAction = await evaluate(`(()=>{const title=${JSON.stringify(workspaceTitle)};const leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title);const workspace=leaf?.closest('[role=treeitem]');if(!workspace)return null;const box=workspace.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2,expanded:workspace.getAttribute('aria-expanded')==='true'}})()`);
  assert.ok(mobileWorkspaceAction, 'The mobile sidebar must expose the selected workspace directory.');
  if (!mobileWorkspaceAction.expanded) {
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: mobileWorkspaceAction.x, y: mobileWorkspaceAction.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mobileWorkspaceAction.x, y: mobileWorkspaceAction.y, button: 'left', clickCount: 1 });
  }
  const mobileSessionAction = await evaluate(`(()=>{const title=${JSON.stringify(workspaceTitle)},desired=${JSON.stringify(researchSessionBefore)};const leaf=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()===title);const workspace=leaf?.closest('[role=treeitem]');const rows=[...document.querySelectorAll('[role=treeitem]')];const start=rows.indexOf(workspace);const session=rows.slice(start+1).find(e=>{if(e.hasAttribute('aria-expanded'))return false;const dataTransfer=new DataTransfer();e.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer}));return dataTransfer.getData('text/plain')===desired});if(!session)return null;const box=session.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()`);
  assert.ok(mobileSessionAction, 'The mobile sidebar must expose a selectable session.');
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', ...mobileSessionAction, button: 'left', clickCount: 1 });
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mobileSessionAction, button: 'left', clickCount: 1 });
  await waitFor(`(${sessionIdentity}) === ${JSON.stringify(researchSessionBefore)}`);
  await evaluate('document.querySelector("button[aria-label=\\"收起侧边栏\\"]")?.click()');
  await waitFor('document.querySelector("[data-sidebar-collapsed]")?.getAttribute("data-sidebar-collapsed") === "true"');
  await waitFor('(()=>{const frame=document.querySelector("[data-autoresearch-paper-frame]"),root=document.querySelector("[data-shell-overlay]")?.parentElement,sidebar=root?.firstElementChild;if(!frame||!sidebar)return false;const box=frame.getBoundingClientRect();return sidebar.getBoundingClientRect().width<=72&&Math.max(0,Math.min(box.right,innerWidth)-Math.max(box.left,0))>=300})()', 10000);
  const mobileNavigationCandidates = await evaluate('(()=>[...document.querySelectorAll("button,[role=button]")].map((node)=>({text:node.textContent.trim().slice(0,80),aria:node.getAttribute("aria-label"),title:node.getAttribute("title"),className:String(node.className).slice(0,100),hidden:node.hidden,rect:(()=>{const b=node.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)}})()})).filter((item)=>!item.hidden&&item.rect.width>0&&item.rect.height>0).slice(0,100))()');
  const mobileScreenshot = await browser.screenshot('dsh-workbench-mobile.png');
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector(".ar-native-back").click()');
  await waitFor('document.querySelectorAll("button").length > 3 && !document.querySelector("[data-autoresearch-paper-frame]")');
  assert.equal(await evaluate('/Failed to load plugins|cannot get property|already has locale/.test(document.body.innerText)'), false);
  await waitFor(sessionIdentity);
  assert.equal(await evaluate(sessionIdentity), researchSessionBefore, 'Returning to native tools must preserve the selected DSH session.');
  await waitFor('([...document.querySelectorAll("textarea,[contenteditable=true]")].some(e=>(e.value||e.textContent).includes("请使用 AutoResearch")))');
  assert.deepEqual(browser.exceptions, []);
  console.log(JSON.stringify({ status: 'passed', selectedExistingWorkspace: workspaceTitle, nativeCompilerAvailable: true, nativePdfRendered: true, nativeChatDraftOnly: true, sameSessionReturn: true, sidebarRetained: true, resizeAndCollapse: true, desktopAndMobile: true, mobileSidebar, mobileNavigationCandidates, workbenchScreenshot, mobileScreenshot }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ failureScreenshot: await browser.screenshot('dsh-live-failure.png'), exceptions: browser.exceptions.map(e=>e.split('\n')[0]), treeSummary: await browser.evaluate(`(()=>[...document.querySelectorAll('[role="treeitem"]')].map(e=>({tag:e.tagName,workspace:e.textContent.includes(${JSON.stringify(workspaceTitle)}),expanded:e.getAttribute('aria-expanded'),selected:e.getAttribute('aria-selected'),draggable:e.draggable,level:e.getAttribute('aria-level')})).slice(0,80))()`), draggableSummary: await browser.evaluate(`(()=>[...document.querySelectorAll('[draggable="true"]')].map(e=>{const box=e.getBoundingClientRect();return {tag:e.tagName,role:e.getAttribute('role'),expanded:e.getAttribute('aria-expanded'),selected:e.getAttribute('aria-selected'),tabindex:e.getAttribute('tabindex'),className:String(e.className).slice(0,160),children:e.children.length,x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)}}).filter(e=>e.width>0&&e.height>0).slice(0,80))()`), network: networkDiagnostics(browser.networkSnapshot()), paperDiagnostics: await browser.evaluate(`(async()=>{const doc=document.querySelector('[data-autoresearch-paper-frame]')?.contentDocument;if(!doc)return null;const projectId=doc.querySelector('#project')?.value,documentId=doc.querySelector('#document')?.value;const result={project:Boolean(projectId),document:Boolean(documentId),editorDisabled:doc.querySelector('#editor')?.disabled,newDisabled:doc.querySelector('#new-document')?.disabled,saveState:doc.querySelector('#save-state')?.textContent};if(!projectId||!documentId)return result;try{const response=await fetch('/api/autoresearch/workbench/document?'+new URLSearchParams({projectId,documentId}),{signal:AbortSignal.timeout(3000)});result.documentStatus=response.status;if(response.ok){const data=await response.json();result.hasPdf=Boolean(data.pdf?.url);if(data.pdf?.url)try{const pdf=await fetch(data.pdf.url,{signal:AbortSignal.timeout(3000)});result.pdfStatus=pdf.status;result.pdfBytes=(await pdf.arrayBuffer()).byteLength}catch(error){result.pdfError=error.name}}}catch(error){result.documentError=error.name}return result})()`), paperFrameText: await browser.evaluate('document.querySelector("[data-autoresearch-paper-frame]")?.contentDocument?.body?.innerText.slice(-1500)') }));
  throw error;
} finally { await browser.close(); }
