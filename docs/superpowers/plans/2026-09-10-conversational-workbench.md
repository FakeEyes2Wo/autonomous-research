# Conversational Research Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DSH 中提供可反复对话改进论文的工作台，上方 LaTeX / PDF 分栏，下方原生对话横跨页面并保留边距。

**Architecture:** 插件注册 DSH 左上角入口，在原生主栏中组合上方论文面板与下方原生对话，原生左侧工作区和会话导航保持可用。论文页面独立部署为同源资源，使用有来源校验的消息传递当前项目、论文上下文与 DSH 主题变量；宿主以受限文件发现提供生成论文和只读预览。

**Tech Stack:** DSH public slots / sessions, React 18, vanilla browser modules, Node.js, PDF.js, Tectonic.

## Delivery status (2026-09-10)

- Tasks 1–4 are implemented around the native workspace registry, native session bridge, bounded paper discovery and same-origin parent/iframe protocol. One native workspace directory is one project; production has no separate project registration or selector. `standaloneProjects` is an explicit test-host fallback only.
- Core verification is complete at 121/121 and the installer/preset regression at 1/1. The last workbench increment does not change core, so those suites are not repeated.
- The final bounded Web increment proves mobile sidebar ownership/cleanup and reuses a pending PDF load for the same project, document and version while preventing stale generations from attaching to another file.
- Final evidence: unified build; Web 57/57 (factory 16/16, sync 6/6); settings, stalled-PDF and full workbench browser regressions; and real DSH acceptance at 390×844 with a 56 px rail, 334 px of visible paper, manual sidebar expansion/close, desktop cleanup and same-session return.

## Global Constraints

- 底部对话左右及底边保留 16 px；支持收起与调整高度，小屏仍能使用。
- 保留 DSH 原生左侧工作区，使用原生主题配色与字体。
- 不修改全局 DSH 安装文件，不写固定用户路径、端口、浏览器或代理地址。
- 不自动发送模型请求；快捷指令只填入草稿，用户确认发送。
- 继续使用原生会话、模型选择、工具调用、审批及历史。
- 未保存论文不能被后台同步覆盖；跨项目响应不能应用到当前项目。
- GET 不触发编译或写文件，路径仍受项目白名单约束。
- 保留现有工作区修改，不提交或清理无关文件。

### Task 1: Native workbench entry and conversation (web_settings_review)

**Files:** `packages/autoresearch-web/src/client.js`, new `src/native-workbench-client.js`, focused native integration tests.

**Interfaces:** iframe `/autoresearch/?embedded=1&workspaceManaged=1`; it sends `ready` after `/projects` loads. The parent owns native workspace/session state and sends `select-project` with `{projectId: string | null, selectionId: string}`. The child echoes `selectionId` and emits `context` with `projectId`, `document: {id, relativePath, revision} | null`, `dirty`, `busy`; parent may send `request-context`; child emits `exit` only after checking unsaved edits. Check both `event.origin` and `event.source` before using any message.

- [x] Register a top-left workbench entry using public slots and retain native navigation.
- [x] Keep the native conversation usable in the bottom panel, including model controls and approvals.
- [x] Add resize / collapse controls and session continuation; research shortcuts populate drafts only.
- [x] Complete final mobile manual-expand, desktop habit and exit-cleanup verification.

### Task 2: Generated paper discovery

**Files:** `packages/autoresearch-web/src/workbench.js`, `test/workbench.test.mjs`.

**Interfaces:** document list and document objects add `relativePath`; PDF retains `{url, version, sourceRevision}` where unverified pipeline source revision is `null`.

- [x] Test discovery of `runs/<run>/paper/main.tex` and `.runs/<run>/paper/main.tex`, symlink refusal and bounded traversal.
- [x] Implement bounded discovery and readonly pipeline `main.pdf` preview with content versions.
- [x] Preserve preview metadata restoration, save conflicts and fixed compiler invocation tests.

### Task 3: Context validation

**Files:** `packages/autoresearch-web/src/native-workbench-client.js`, `src/workspace-projects.js`, focused factory/API/native-host tests.

- [x] Verify native public session creation, workspace binding and AutoResearch preset contracts against installed source.
- [x] Validate message source/origin, `selectionId`, relative paths and project/session mapping at the existing bridge boundaries.
- [x] Make the native workspace registry authoritative; keep standalone allowlists behind explicit test-host opt-in.

### Task 4: Compact paper UI and live synchronization

**Files:** `src/workbench.html`, `src/workbench.css`, `src/workbench-client.js`, new `src/workbench-sync.js`, `test/workbench-sync.test.mjs`, `test/workbench-browser.mjs`.

**Interfaces:** poll the existing list/document GET endpoints; compare `revision` and PDF `version`. Pure policy returns `apply`, `conflict`, or `unchanged` based on captured document identity, request generation and dirty/busy state.

- [x] Write policy tests for clean updates, changed identity, changes during fetch, dirty draft conflicts and PDF-only updates.
- [x] Compact the heading and toolbar; embedded mode fills its panel with the editor and preview.
- [x] Add a separate update notice with explicit load-latest action; clean drafts synchronize, dirty drafts stay intact.
- [x] Emit context messages only to the same-origin parent; preserve URL parameters and leave guards.
- [x] Verify a stalled PDF is non-blocking, same-version polling reuses its pending load, and a later project/document generation cannot receive it.
- [x] Restore the managed-save conflict, embedded exit and subsequent browser flow with exact document and dirty-state preconditions.

### Task 5: Package and live verification

**Files:** build script / asset allowlist / package manifest as required; guide and current-status docs.

- [x] Bundle all new client resources locally and run Web/browser checks appropriate to changed behavior; retain the unchanged 121/121 core evidence.
- [x] Review implementation and fix the mobile sidebar and pending-PDF findings.
- [x] Start a hidden DSH web process, inspect the actual native UI and capture desktop/mobile screenshots.
- [x] Record checks and limitations; report the running workbench entry and interaction behavior.
