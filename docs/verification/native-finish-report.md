# DSH AutoResearch 原生工作台联动报告

## 范围

- 工作台仅以 `ctx.get('workspaces').list` 和 `ctx.get('sessions').list` 的快照决定当前项目。会话成员关系优先；只有没有成员关系时才对 `cwd` 做规范化后的精确匹配。
- 普通 preset 与仅靠旧 `cwd` 匹配的未分组会话会继续保留为原生当前会话；科研快捷按钮在此状态禁用，用户可显式点“启动科研会话”后才使用后端权威 `session-target` DTO 的 `workspaceId` 创建或恢复 AutoResearch 会话。
- 项目切换会取消前一请求。父级在每次 `select-project` 中发送选择代次，iframe 必须在 `context` 中回显该代次；旧 A→B→A context 会被丢弃。快捷指令仅写入 DSH scoped draft，替换已有草稿时确认，绝不发送模型请求。
- 保留原生侧栏和原生底部会话，iframe 固定为 `/autoresearch/?embedded=1&workspaceManaged=1`；底部面板支持 16px 间距、拖拽、键盘调整与收起。

## 修改文件

- `packages/autoresearch-web/src/native-workbench-client.js`
- `packages/autoresearch-web/src/client.js`
- `packages/autoresearch-web/test/factory.test.mjs`
- `packages/autoresearch-web/test/verify-live.mjs`
- `docs/verification/native-finish-report.md`

## 验证

已执行并通过：

```powershell
cd packages/autoresearch-web
node --check src/native-workbench-client.js
node --check test/verify-live.mjs
node --test test/factory.test.mjs
```

结果：14/14 单元测试通过。新增覆盖普通/旧 cwd-only 会话保持原生选择、科研能力必须显式启动，以及 A→B→A 延迟 iframe context 被拒绝；既有覆盖确认 workspaceId 创建、保存会话复用、旧 standalone cwd bridge、并发切换、dispose 竞态和草稿覆盖确认。

## 未完成点

- 依照协调要求，尚未运行最终 build 或真实 DSH 浏览器验收，避免与 paper iframe 修改交叉覆盖。统一 build 后使用 `DSH_LIVE_LOG` 与 `DSH_LIVE_WORKSPACE_TITLE=autonomous-research` 运行 `node test/verify-live.mjs`。脚本会展开指定原生目录、通过该目录的“新建会话”控件选择会话、显式启动科研会话，并以 DSH 会话行公开的拖拽 session identity 确认返回后仍是同一会话；该脚本不发送真实模型请求。

## 后续移动端修复

- 已在 `native-workbench-client.js` 通过公开的 `ctx.get('layout').toggleSidebar()` 修复窄屏：仅当真实 DSH frame 不超过 720px 且中心栏不足 300px 时，工作台将原生侧栏收为 56px rail；rail 保留原生工作区入口。工作台卸载时仅在该 rail 仍处于本次折叠状态才恢复。
- 新增窄屏决策单元测试。最新 focused 验证为 `node --check src/native-workbench-client.js` 与 `node --test test/factory.test.mjs`，结果 15/15 通过。桌面 live 已由验收驱动验证；移动截图需在统一 build/restart 后复验。
