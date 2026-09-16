# 科研工作台进入工作区：污点与状态传播分析

## 已复现的主因

服务器真实浏览器点击工作区行的“＋”后，科研预设加载失败：

```text
workspaceId（原生工作区）
  → installNativeResearchSessionHook
  → createNativeSessionBridge.createFresh
  → remote.session.create({ workspaceId, agentPreset: 'auto-research' })
  → 服务端 workspaceRegistry.get(workspaceId) 得到 cwd
  → agents.ensureSession(sessionId, cwd, ..., agentPreset)
  → agent-presets 挂载 auto-research
  → delegation / workflow-worker-thread 模块导入
  → 缺少 @deepseek-ai/dsh-workflow，抛错
  × workspace.attachSession(sessionId) 尚未执行
```

因此 `sessionIds=[]` 是本次失败的结果。现有工作区路径可访问，项目清单 API 及 session-target API 均可返回合法映射；没有证据支持“没有配置项目路径”是本次主因。

CLI 为 `0.1.5-alpha.1`，线上多个运行时包为 `0.1.5-rc.2`。失败的 `dsh-workflow-worker-thread@0.1.5-rc.2` 声明 `dsh-workflow` 为 peer dependency，实际未安装。已有安装使用 legacy peer 模式，启动 Web 本身没有覆盖首次按需挂载预设的路径。对 23 个预设模块名直接导入检查，发现 workflow-worker-thread 的传递导入失败；这项检查不等同于完整挂载成功。

## 数据来源、校验与落点

| 来源 | 传播路径与落点 | 当前边界／缺陷 |
| --- | --- | --- |
| 原生 workspace store、工作区行点击参数 | workspaceId → remote session/create → 服务端 registry 查找 | 前端 ID 格式检查；服务端负责解析真实 cwd。不能用任意路径绕过 registry。 |
| localStorage 中保存的 sessionId | bind → 带 sessionId 的创建／恢复请求 | 格式检查与服务端工作区／预设一致性检查；冲突回退前缺少取消代次检查，可能产生过期会话。 |
| 远端 create 响应 | arValue → sessionId → sessions.open | RemoteResult 解析正确；缺少“本地 session list 已包含 ID”的时序保证。真实 DSH open 会拒绝未知 ID。 |
| 项目清单 HTTP 响应 | workspaceId → projectId map → iframe 项目上下文／session-target | 只在挂载时获取一次；未判断 HTTP 状态。新增工作区或初始化延迟会留下过期／缺失映射。 |
| session-target HTTP 响应 | projectId 校验 → workspaceId/cwd 校验 → bridge.bind | 内容校验存在；选择改变后，迟到响应仍会调用新的 bind。取消应在 bind 前检查。 |
| Cordis 可选服务 | ctx.get → hook、store.subscribe、remote create | effect 首次运行时服务不存在就不会绑定；需要跟随服务注入、替换、卸载生命周期。 |
| iframe postMessage | origin/source/channel → projectId/selectionId → paper context | 已检查同源、窗口来源和选择代次；修复须保留这些边界。 |
| 安装预设 YAML 与主机 node_modules | 配置复制 → loader 动态 import → 插件挂载 | 当前安装脚本仅复制配置，没有验证实际宿主可导入预设及传递依赖。 |

## 次生错误与验证重点

1. 修复缺包后仍可能遇到未知会话竞态：使用原生公开 `sessions.refresh()` 和 list 订阅，确认 ID 可见后再 open；不得伪造本地会话记录。alpha 与 rc.2 的公开 `sessions.create()` 都没有 agentPreset 参数，因此不能盲目替换调用。
2. 无当前会话时，全局新建应遵循原生 current/recent workspace 语义；工作区行显式 ID 仍然有效。空状态不能无限显示“正在读取”。
3. 取消边界需要覆盖目标 HTTP 请求、远端创建、冲突重试、本地列表同步和组件／服务卸载，防止旧请求打开错误工作区。
4. 项目映射需随工作区可用性变化刷新，拒绝坏响应并丢弃过期响应；相同映射刷新不应取消正在创建的会话。
5. 安装检查须从指定 DSH 宿主的解析路径导入，不能用项目 devDependencies 掩盖宿主缺包。保留鉴权，不读取凭据，不发送模型消息。

## 修复前证据

- 当前主工作区 Web 测试：60 项通过，0 失败。这说明旧测试未覆盖已复现边界，不代表线上可用。
- 真实浏览器：预设加载错误显示在工作台状态中；没有 HTTP 4xx/5xx 或未捕获 JS 异常，故只检查 Network 状态不足以验收。
- 最终验收：依赖检查通过后，还必须真实创建科研会话，验证工作区成员关系、本地已选会话、科研预设身份及论文工作区载入。只创建空会话，不发送研究任务。

修改计划见同目录 `2026-09-15-workspace-entry-repair.md`。代码变更全部由 subagent 执行。

## 环境修复后的实测

基础设施 subagent 已精确安装 `@deepseek-ai/dsh-workflow@0.1.5-rc.2`，manifest/lockfile 仅增加该包，原有 DSH 包版本未变；23 个预设模块导入均通过，并按原配置重启服务，鉴权仍生效。

保留旧应用代码进行隔离验收：首次切页同时发生原生初始化导航时，UI 曾停留普通会话；服务端投影已确认存在 `auto-research` 会话。等待初始化与论文 iframe 稳定后再次点击“＋”，页面成功进入 `AutoResearch · 连续对话`，显示 `test_autoresearch` 论文工作区，无未捕获异常，也未发送模型消息。

该结果确认缺包是已复现的线上阻断主因。前端列表可见性、取消和订阅问题属于通过真实接口约束与回归测试确认的潜在竞态；不能把一次初始化期间的普通会话停留单独视为某个前端竞态的确证。

## 最终组件组合审查补充

实际组件与原生 hook 组合的内存测试进一步复现两条状态传播问题：

- `session.create` 抛出的缺包错误进入状态栏后，内容未变的列表通知触发 `chooseWorkspace → describe`，把错误覆盖为普通会话提示。修复需在等价选择通知下保留操作进度和错误，同时正常结束首次加载提示。
- 当前 A 工作区创建期间，项目映射新增 B，使 `projects → chooseWorkspace → effect cleanup → bridge.cancel` 执行；A 的工作区／项目／会话选择及 `selectionId` 均未变化，却无法打开新会话。修复需拆开订阅资源和选择取消的生命周期，保留真实切换和卸载的取消语义。

这两项已合并交给实现 subagent 修复，要求增加真实组件组合回归，之后只对该修复差异复审。

## 已审查的代码修复

修复分支最终提交为 `ff4718f`。实现和复审均由 subagent 完成，最终无未处理问题。

- 远端创建后，使用原生公开 list／refresh 等待会话可见，再调用 open；等待有上限，并处理刷新合并、订阅清理和取消。
- session-target 响应进入 bind 前检查选择代次；保存会话冲突回退、后续等待均检查取消，避免过期请求改变当前会话。
- 项目映射验证 HTTP 状态及内容，随原生工作区变化刷新；服务注入和资源卸载有配套清理。等价选择通知保留创建进度／错误，无关映射刷新不取消当前创建。
- 增加显式宿主 `check:dsh`，从所选 DSH 安装根执行预设模块的传递导入检查；安装器可在写入配置前运行检查，离线复制会明确提示尚未验证运行环境。

最终组件级回归先复现两项失败，再达到工厂测试35/35通过；运行时与安装器临时宿主测试7/7通过。代码整合和服务器最终验收结果将在完成后记录。

## 部署后新增集成证据

首轮部署后的真实浏览器验收发现面板挂载后被移除。`Runtime.exceptionThrown` 为空，但 CDP 控制台记录了 `Reflect.has called on non-object`，并明确报告 `shell.overlay` 的 slot entry 崩溃。错误落点是 `installInjectedNativeResearchSessionHook`：将单个服务名字符串传给 `ctx.inject`，而实际 Cordis API 要求服务数组或配置映射。此前测试 mock 接受了该无效形状，因此没有捕获。

后续修复已交给 subagent：改用 `['uiWorkspace']`，并使用真实 Cordis 验证延迟服务注入与清理；复审后再同步部署。最终浏览器验收增加控制台错误检查，覆盖被 UI 错误边界捕获的异常。

## 最终验收结果

最终修复提交 `704510f` 已由部署 subagent 同步至当前 checkout 和 `/home/ironmoon/autonomous-research`，保留用户已有修改和服务器部署依赖声明。当前 DSH Web PID779200，仍仅监听127.0.0.1:3080，鉴权有效。

- 本地 Web 构建及完整测试77/77通过，0跳过；核心构建、类型检查通过，运行时／安装器回归7/7通过。
- 服务器核心与 Web 构建通过；显式宿主运行时检查23/23模块导入通过。后续单行 Web 修复重新构建通过，未更改核心或依赖。
- 真实浏览器认证后进入科研工作台，等待初始化完成，点击工作区行“＋”：状态从“正在创建科研会话”变为“AutoResearch · 连续对话”；论文 iframe 显示test_autoresearch，原生会话行被选中。
- CDP控制台错误0、未捕获异常0、失败网络请求0；截图已人工视觉检查。
- 工作区成员数3→4，原有3个成员全部保留；新增session-bf71d900-c99c-4a5b-a7e6-2daf115151cb 的record.rows.agentPreset.val为auto-research。
- 只创建空会话，未发送模型消息或研究任务。现有PDF编译器Tectonic未安装，本次验收不包含论文编译链路。

最终截图：C:/Users/80163/AppData/Local/Temp/autoresearch-workbench-browser-3kxeHi/workspace-entry-final.png。分析、计划与审查材料保留；隔离修复分支保留为可追溯记录，未将用户无关改动提交到main。
