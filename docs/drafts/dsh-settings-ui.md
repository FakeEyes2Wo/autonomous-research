# DSH 前端配置设计

日期：2026-09-09。状态：`packages/autoresearch-web` 已有 S1/S7 正式 bundle；已通过核心 settings bridge、公开 SlotCore factory 和临时 React/Chromium 页面 smoke。真实 DSH Loader/profile 仍待发布前验证。已有[独立交互原型](ui/dsh-settings-prototype.html)，它只用于离线展示。

## 1. 最短配置路径

用户只需完成三步：

1. **DSH 设置 → Models**：创建 CPA 连接、设置客户端 API key、获取或手工填写模型列表。
2. **DSH 设置 → AutoResearch → 模型分档**：将目录中的真实模型分配给 cheap、standard、deep；按需调整高智能角色。
3. **流程与预算 → 校验并保存**：选择 minimal、交付类型对应的可选步骤及限额；新 run 使用保存后的策略。

正式接入使用 DSH 页面内的设置 section，不创建另一套登录、聊天或文件管理 UI。静态原型的侧栏和顶栏只用于说明宿主位置，正式插件不重复渲染宿主外壳。

### 现有 Models 页面可直接使用的 CPA 表单

以下来自本机 DSH `0.1.5-alpha.1` 已安装包的 README、类型和客户端实现；不是对所有后续版本的保证。

| 字段 | GPT 示例 | 注意 |
|---|---|---|
| Provider ID | `cpa-gpt` | 小写字母开头、唯一；创建后固定 |
| 显示名称 | CPA GPT | 仅展示 |
| API | `openai-responses` | 实际代理需支持；不支持时显式另选协议 |
| Base URL | `http://127.0.0.1:8317/v1` | 地址示例，需按个人部署修改 |
| API key | CPA 客户端 key | 不是上游账户信息，也不是管理 API key |
| Models | 目录获取，或手工填真实别名 | `gpt-self` 只是本文示例 |
| Context window / Max tokens | 按部署填写 | `/models` 的存在不证明容量或工具能力 |

原生页面支持用尚未保存的 URL/key 发现模型，用户选中后才保存。key 通过 credentials 写入；留空编辑保留旧值；路由保存在 DSH 宿主 settings（默认 `.dsh/settings.yaml`，实际路径以宿主配置为准）的用户设置层。绿色凭据状态仅表示“已配置”，不表示请求测试通过。

当前 Models 卡片没有 reasoning 控件。首期为深度档单独配置 `cpa-gpt-deep` 的 route 默认 reasoning；配置示例见[接入设计](cpa-integration.md)。必须先确认模型支持 high。可选 CPA 包生成并预览该高级配置，复用已有凭据引用；不要求用户每次研究手改 YAML。

普通 `settings.section` 没有已验证的跨 section 跳转函数。因此第一版按钮显示“设置 → Models”的准确指引；只有宿主新增正式导航接口后，才实现直接跳转。不伪造链接、不修改全局安装文件。

## 2. 页面布局

```text
DSH / Settings / AutoResearch     项目选择 ▾    配置版本/未保存状态
  快速配置 | 模型分档 | 流程 | 预算
  ┌───────────────────────────────┬───────────────────┐
  │ 当前页表单 / 角色表             │ 有效策略摘要       │
  │ 字段错误就地显示               │ 来源/适用范围      │
  │ 高级项按需展开                 │ 风险/未验证提示    │
  └───────────────────────────────┴───────────────────┘
  下次运行生效                 放弃修改  预览 YAML  校验并保存
```

大屏双栏，窄屏摘要在表单下方；表格横向滚动或转卡片。所有图标有文字/accessible label；状态同时使用文字，不能只用红绿区分。保持键盘焦点、dialog 关闭后焦点返回、字段错误可定位。

### A. 快速配置

- 项目选择来自服务器允许的项目列表；首期只展示 opaque ID/名称和可写状态，不把本地绝对路径发到浏览器，也不将 runDir 当作项目根。
- 连接卡：CPA 未安装 / route 未配置 / 凭据已配置 / 未探测 / 最近探测结果，分别呈现。没有 CPA 时仍允许 DeepSeek-only。
- 三个草稿预设：节省调用、平衡研究、高质量审查。预设调整分档策略/可选步骤/预算，不自动安装插件、不自动发请求、不替换不存在的模型。
- 展示必须保留的环境检查、证据验证和科研停止理由，说明预设不会关闭这些职责。
- “准备运行”先校验模型、能力和预算实现状态；保存成功和可运行不是同一种状态。

### B. 模型分档与高智能角色表

| 控件 | 保存字段 | 交互规则 |
|---|---|---|
| 启用项目模型路由 | modelRouting.enabled | 关闭后显示旧 model.useGlobal/overrides 的真实有效来源 |
| 默认档位 | modelRouting.defaultTier | cheap / standard / deep |
| 三档 provider、model | modelRouting.tiers.* | 从有效目录选择，原子保存配对；换 provider 需重新选模型 |
| 档位输入/输出上限 | tiers.*.maxInputTokens / maxOutputTokens | 高级项，可继承；与模型及角色限制取最小值 |
| 角色档位 | modelRouting.roles.*.tier | 留空继承 defaultTier；不生成另一个模型路由任务 |
| 升级目标、触发信号 | roles.*.escalateTo / escalateOn | 成对验证；仅语义信号，禁止 transport/schema 错误自动升级 |
| 角色输入/输出上限 | roles.*.maxInputTokens / maxOutputTokens | 可选，显示最终有效上限和来源 |

默认先显示 planner、research-worker、supervisor、writer；其余角色折叠。idea-generator、supervisor、writer、风险审查是需要重点配置的高智能角色，完整建议表见[研究策略](research-runtime.md)。列表来自同一个 role registry，不能前后端各维护不同枚举。

reasoning 展示为只读的 route 有效默认值及验证状态；首期不在角色编辑器中提供一个底层不接收的 reasoningEffort 字段。未来接通公开 model-selection API 后再增加角色级控件及恢复测试。

### C. 流程

| 字段 | 初始建议 | 说明 |
|---|---|---|
| workflow.mode | 新项目显式 minimal；旧项目 legacy | 切换预览步骤差异，保存不重写旧 run |
| brainstorm / deepDive / modelScout | auto | 明确课题和已有资料可跳过 |
| experimentReview | auto | 风险触发，不是每轮无条件调用 |
| postResultSynthesis | auto | 有新增证据且决策需要时执行 |
| paper | auto | 依据交付要求；实验任务不自动写论文 |
| candidateLimit | 3 | 0 禁用候选生成，与 brainstorm 同时校验 |
| reflexionRounds | 1 | 0 仅关闭额外反思，不关闭基本验证 |
| paperImprovementRounds | 0 | 不自动润色循环，审计失败仍需处理 |

步骤控件统一为 `enabled / auto / never`，显示中文“启用 / 按需 / 关闭”。关键风险出现但对应独立检查被禁止时，系统暂停并解释，不跳过风险继续。交付类型沿用 run 请求；若页面要发起 run，需另做入口，不能凭空新增未被消费的项目字段。

### D. 预算与统计

基础区显示单次输入/输出、整次 run token、角色启动次数。高级区显示重试、格式修复、每任务升级次数以及上下文分区额度。

- 数值只接受有效整数；0 的语义按字段区分，不将空值当 0。非法、负数、NaN、超模型能力分别提示。
- 输入与预留输出之和不能超过 contextWindow；context 分区合计仍受总输入上限。页面提示不代替服务器校验。
- 同时显示“配置请求的限额”和“运行时执行状态”：已验证拦截 / 仅可观测 / 用量未知；后两种不能展示硬限制已生效。
- 用量表列出角色、provider/model、调用、输入、缓存、输出、估算/未知。reasoning 单列明细不重复入总数。
- 无 run 显示空态，不生成虚假节省曲线。暂停原因显示 budget_exhausted，支持后续显式调整剩余执行策略；不默认清空历史账本。

## 3. 保存语义

1. 读取配置和 revision；损坏 YAML 显示修复入口，不替换成可直接覆盖的默认值。
2. 控件只编辑草稿；切换项目或离开有未保存变更时提示。无更改不发保存请求。
3. 本地即时检查 → 服务端 validate → 展示差异、有效路由、警告和影响的 run 范围。
4. 用户确认后提交 expectedRevision 和允许的 patch ops；服务端原子校验保存，返回新 revision。
5. 409 时保留草稿，提供“查看最新 / 重新应用”；不能自动覆盖另一窗口或 CLI 的修改。
6. 保存后显示“下次新运行生效”；现有 run 的模型、模式和预算快照仍冻结。显式调整暂停 run 是单独命令，不混入项目保存。

连接配置与项目配置是两个事务。新增 CPA route 时先保存全局路由/凭据并确认结果，再允许项目引用。原生 credentials 失败只重试凭据步骤；不要重复创建 provider。页面不能将跨 profile/项目的写入包装成保证原子的“一键保存”。

## 4. 原生扩展与新增接口

已核对的宿主入口：

- `dsh-client-ui-settings` 定义 `settings.section` 列表 slot；`dsh-client-ui-settings-general` 承担设置外壳。
- 新包通过 `dsh.client` manifest、`./client` export 加载；注册唯一 `autoresearch` section ID，卸载清理注册和订阅。
- 客户端遵守 DSH 的 lazy-factory bundle 注册格式，React/DSH 依赖外置，不能直接输出普通 ESM bundle 就宣称可加载。
- 原生 settings.mutate 带 expectedRevision，适用于 DSH 宿主 settings（默认 `.dsh/settings.yaml`，实际路径以宿主配置为准）；credentials 是独立写入通道。这些 API 在本机实现中受 loopback 约束。AutoResearch 项目文件不能冒充宿主 settings namespace。
- Host 的 `ctx.webServer.register()` 可注册 HTTP 路径；它本身不替业务完成鉴权。首期用该公开入口承载新的项目 API。

以下全部是**待新增**接口，不是已存在的 `connection.api.autoresearch`。浏览器使用 same-origin fetch 和明确的服务契约；若未来采用 Typert，须先完成真实注册/codegen，不能只在 TypeScript 中伪造客户端类型。

| 方法与路径 | 输入 | 返回/作用 |
|---|---|---|
| GET `/api/autoresearch/projects` | 无任意路径参数 | 已授权 projectId、name、CSRF token、可写状态；不返回 root |
| GET `/api/autoresearch/settings?projectId=…` | 注册 ID | settings、revision、diagnostics、effectiveSummary |
| POST `/api/autoresearch/settings/validate` | projectId、candidate、baseRevision | 字段错误、警告、有效路由及预算能力状态；不落盘 |
| PATCH `/api/autoresearch/settings` | projectId、expectedRevision、ops | 已保存 settings/revision；409 冲突、422 字段错误 |
| GET `/api/autoresearch/runs/summary?projectId=…&runId=…` | 受项目约束的 run ID | 冻结策略、状态、脱敏用量；没有 run 时为空态 |

模型目录及全局 route/credential 状态优先复用已经存在的 DSH 客户端 API 和推送；不新增任意代理 URL 探测端点。CPA doctor 若需要 Web 入口，作为接入包独立注册、显式触发、允许路由范围内的检查，另行验收。

Host 初期配置明确的 `projects: [{id, name, root}]` allowlist；可后续衔接已验证的 DSH workspace 描述接口。不得把 DSH 进程 cwd 无条件视为当前研究项目。服务启动时 canonicalize root，读取/写入再检查符号链接/junction 与边界；拒绝越界 projectId/runId/path。

安全边界：插件 API 只接受 loopback socket 和 `127.0.0.1`/`localhost`/`::1` Host；浏览器读写均限制准确 Origin/Host，不开放 CORS；写请求要求 `application/json` 与页面首次 GET 获取的 CSRF token，限制 body 大小和方法，拒绝缺失/不匹配来源。远端页面首期只读/不可用，不因增加自用功能改变宿主暴露范围。正式联调必须覆盖 DNS rebinding、远端 socket、缺 Origin 写请求、恶意来源和符号链接置换。

### 当前实现事实（2026-09-09）

- `packages/autoresearch-web` 已提供 `dsh.client` manifest、`./client` lazy-factory bundle、`settings.section` 注册和 Host prefix API。
- API 使用显式 `projects: [{id, name, root}]` allowlist，并在启动时 canonicalize；浏览器只见 opaque `projectId`，不见 root。
- Host 优先使用注入的统一 settings service；否则通过 `@athena/autoresearch/settings` bridge 调用 `readProjectSettingsDocument(projectDir)`、`validateProjectSettingsCandidate(projectDir, candidate)`、`patchProjectSettingsDocument(projectDir, expectedRevision, operations)`。核心导出缺失时返回 503，不执行第二套文件写入。
- 已验证 package build、lazy bundle JavaScript 语法、allowlist/same-origin/CSRF API 单测、公开 SlotCore factory、核心 settings 文件读写、临时 React/Chromium 页面渲染与保存重载。尚未通过真实 DSH Loader/profile，不宣称已安装或已接通用户运行时。
- 页面会明确显示“预算声明已保存、底层请求拦截/并发归属未验证”，不把配置字段当成硬限额成功。

## 5. 原型与生产的明确差别

| 原型已提供 | 正式实现仍需完成 |
|---|---|
| 离线表单、四个页面区、三档和角色表 | 原生 DSH slot、模型目录订阅 |
| 模型路由示例、连接填写指引 | 真实宿主 settings/credentials 操作 |
| 预设、校验、差异预览、内存保存、YAML 下载 | 服务端验证、事务、revision 冲突处理 |
| 流程/预算配置交互 | 实际子代理路由、预算拦截、minimal 执行 |
| 状态明确标为示例/未探测 | 真实 doctor、实际 usage 与运行恢复 |

原型不收集密钥、不发网络请求、不使用 localStorage；刷新会丢失草稿。下载的 YAML 是离线 v2 schema 示例，不应直接覆盖项目文件。正式 schema、后端和 Web bundle 已通过本地测试；真实 DSH Loader/profile 部署仍需显式验收。

## 6. 验收场景

- 五分钟内按页面指引完成已有 CPA 的连接选择和项目分档；高智能角色不用编辑源码。
- provider 缺失、模型被删、CPA 禁用、旧项目、非法 YAML、权限不足均有明确且不误导的状态。
- 保存一个角色不丢失其他角色和既有项目配置；双窗口冲突不丢数据；运行中保存不会改变当前实验。
- 切换 DSH 连接清空旧连接的目录与凭据状态；页面卸载清理订阅，未打开设置时不轮询。
- secret 不出现在浏览器持久存储、URL、日志、错误原文、配置导出和研究提示词中。
- 使用键盘完成配置；窄屏可查看整张角色表；错误有字段路径、焦点和修正建议。

实施批次、文件清单及发布条件见[详细实现计划](implementation-plan.md)。
