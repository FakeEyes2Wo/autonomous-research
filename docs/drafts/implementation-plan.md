# CPA、研究运行时与 DSH 配置页：实现计划

日期：2026-09-09。状态：核心 schema、minimal workflow、CPA 配置/安全安装器本地契约与 Web S1/S7 已实施；真实 CPA 端点、Claude/PDF 仍为后续验收项。本文保留未完成项，不代表已接通真实模型。

本轮并行复核与本地回归已完成：核心 116 项、Web 13 项及浏览器、CPA 13 项均通过，独立安装与最终 tarball 也已验证。修复范围与执行证据见[本地复核记录](../verification/2026-09-09-verification.md)。

配套：[接入设计](cpa-integration.md)、[研究策略](research-runtime.md)、[页面与接口设计](dsh-settings-ui.md)、[可交互页面原型](ui/dsh-settings-prototype.html)。

## 1. 交付边界

1. GPT 经个人 CPA 接入，保留现有 DeepSeek；CPA 模块可选安装、关闭、卸载，不侵入研究业务。
2. 模型按 `cheap / standard / deep` 分档；角色表决定使用档位及升级条件，不再增加一个路由模型调用。
3. 新项目可显式选择 `workflow.mode: minimal`，旧项目和旧 run 保持 legacy 语义；不使用其他含混的流程名。
4. DSH Web 内配置连接、项目模型表、流程、预算；CLI/headless 不依赖 Web 包。
5. Claude 预留 provider/capability 扩展，首期不宣称已完成 Claude 实测。
6. 保留证据、停止原因、恢复与必要审查；减少冗余调用，不承诺未经测量的节省比例。

不做：新的 Agent Runtime、第二套凭据仓库、独立账户系统、通用工作流引擎、默认自动降级到任意模型。此次计划和原型不触碰用户 DSH profile 或真实凭据。

## 2. 三个包与两个存储范围

```text
@athena/dsh-cpa（可选） ── 配置/安装/诊断 ── DSH pi-ai ── CPA
                                              ↑
@athena/autoresearch ── 策略/上下文/预算 ── DSH 子代理
        ↑
@athena/autoresearch-web（可选） ── DSH 设置页
```

| 包 | 拥有的数据与职责 | 禁止的依赖方向 |
|---|---|---|
| `packages/dsh-cpa` | CPA 路由配置编译、安装差异、诊断 | 不导入 autoresearch，不重复实例化 pi-ai |
| `packages/autoresearch` | 项目设置、角色策略、研究流程、请求账本 | 不依赖 CPA 包或 React |
| `packages/autoresearch-web` | 浏览器表单、项目设置 HTTP 边界、用量展示 | 浏览器不导入 Node/fs；不直接写 profile 或项目文件 |

连接的 provider/model 目录、URL、协议由 DSH Models 管理；宿主 settings 默认位于 **`.dsh/settings.yaml`**（实际路径以宿主配置为准），密钥位于 **DSH credentials/环境变量**。项目的分档、角色、流程、预算位于 **`.autoresearch/project-settings.yaml`**，仅引用连接，不携带模型密钥。运行中使用 run 自己的冻结配置快照。

## 3. 依赖顺序与阶段验收

```text
S0 构建基线 → S1 宿主能力验证 → S2 配置与迁移
                              ├→ S3 CPA 接入 ──────┐
                              ├→ S4 路由/生命周期 ┤→ S5 预算 → S6 minimal
                              └→ S7 Web 配置页 ───┘             ↓
                                                   S8 联调/回归 → S9 Claude
```

S7 表单可在 S2 后与接入、运行时并行制作；真实状态和保存联调须等待对应后端。每批使用独立提交，可单独验证、回退；不要求提交或改动本次任务外的工作区文件。

### S0 — 修复可复现构建

修改 `packages/autoresearch/package.json`、`tsconfig.json`、`scripts/build.mjs` 和依赖锁文件：

- 将 TypeScript 声明为本包开发依赖，构建/类型检查使用本地解析的编译器。
- 清除指向其他个人仓库及全局 nvm 目录的编译器、`paths`、`typeRoots`；DSH/Cordis 声明在本包安装时可解析，同时保持宿主 peer dependency。
- 先保留现有单包安装方式；新增包分别可构建，不为了三个包强制引入 monorepo 编排器。若统一 workspace，单独提交并解释 lockfile 迁移。
- 记录现有单元/集成测试基线，将原有失败与本次回归区分。

验收：干净临时目录按 lockfile 安装后，`npm run build`、`npm run typecheck`、`npm test` 不依赖开发者机器绝对路径。安装依赖或写入全局 profile 是后续实施动作，不是文档验证的一部分。

### S1 — 先验证三个会影响架构的宿主接口

基于本机 DSH `0.1.5-alpha.1` 建立最小兼容性测试；后续兼容性复验使用临时 profile，不再触碰真实 profile（历史升级影响见 [升级记录](dsh-upgrade-record.md)）：

1. **调用策略**：用 fake/mock LLM 检查 one-shot、continuable、恢复均接收 provider/model/maxTokens/toolFilter；确认 route 默认 reasoning 真正进入模型请求。
2. **预算钩子**：找到公开的每次 LLM 请求前后拦截点，包含 worker 内循环、压缩/标题等辅助请求。记录可观察的 attempt、requestId、usage 和取消语义。
3. **Web 插件加载**：最小页面注册 `settings.section`；验证 `dsh.client`、`./client` 导出、宿主依赖 external、原生 lazy-factory 客户端打包、卸载清理和热更新。

决策出口：

- alpha.1 的 AgentOptions/model-selection 契约支持可选 `reasoningEffort`；项目策略只在模型能力和路由校验通过时传递该字段，不把未知能力硬编码为成功。
- 没有公开请求前钩子时，提出最小上游扩展及其测试；未接通前只能报告用量，不能上线“硬预算已生效”。不偷偷 monkey-patch 宿主内部。
- 输入 tokenizer/usage 不完整时明确 `estimated/unknown`；只有有可靠边界的数据才显示硬限额生效。CPA 上游内部重试属于可见性边界，不能声称掌握其全部计费。
- 普通设置 slot 只提供关闭回调，没有已验证的 Models 深链接；首期给出导航指引，不调用假想 `openSection()`。

验收：形成小型兼容性矩阵和自动化测试，三项分别标记 supported / limited / blocked；受阻项不阻塞无关表单制作，但阻止对应生产能力发布。

### S2 — 配置 schema、迁移和统一保存服务

修改/新增：

```text
autoresearch/src/settings/
  project-settings.ts        # 兼容现有公开入口
  schema.ts                 # v2 类型、字段验证、默认值
  migration.ts              # v1 → v2 内存迁移
  service.ts                # get / validate / patch / effective
  revision.ts               # 文件内容 revision + 原子替换
autoresearch/src/tools/index.ts
autoresearch/test/unit/project-settings.test.ts
```

- 增加 modelRouting、workflow、budget；保留 paperExploration、figureApi、experiment 和旧 model 的兼容读取。
- 文件缺失可用默认值；YAML 语法错误、类型错误和未知核心字段应返回字段路径，不能静默恢复默认再覆盖原文件。扩展字段需明确命名空间与保留规则。
- v1 读取不落盘，缺失 workflow.mode 为 legacy；用户保存才写 v2。已有 run 的配置来源为 checkpoint，不受项目新默认覆盖。
- 修正工具当前浅层合并：对允许字段使用明确 patch 路径，同一次提交原子更新 provider/model；更新一个角色不得丢弃其兄弟角色。
- `expectedRevision` 校验、每项目串行写入、同目录临时文件原子替换；替换前再次检查外部编辑。多个宿主写同一项目需统一锁/单写者策略并测试 Windows 语义。冲突返回 409，不覆盖；损坏配置允许下载原文后修复。
- validation 输出 `errors[{path,code,message}]`、warnings 和 effective route 来源。秘密不出现在返回值、日志和模型上下文中。
- 在核心包 package.json 增加稳定的 `./settings` 服务导出与纯 `./settings-contract` 导出；后者只含 DTO/schema/纯验证，不传递 Node/fs 依赖。Web Host 调服务，浏览器只依赖纯契约，避免导入核心插件入口产生宿主副作用。

验收：迁移、未知字段、非法 YAML、补丁兄弟字段保留、并发保存、磁盘失败、路径安全、无密钥导出测试通过。CLI 工具与 Web 后端调用同一保存服务。

### S3 — 可插拔 CPA 接入

新增：

```text
packages/dsh-cpa/
  package.json
  src/index.mjs
  src/config.mjs
  src/doctor.mjs
  src/installer.mjs
  presets/cpa.cordis.yml
  scripts/install.mjs
  test/cpa.test.mjs
```

- 复用原生 pi-ai 配置：默认模板 openai-responses，可显式选择 openai-completions；两者不做静默协议切换。
- 安装器先输出 DSH 宿主 settings（默认 `$DSH_HOME/settings.yaml`，实际路径以宿主配置为准）的 diff，显式 apply 后写入；发现已有 pi-ai 时只合并缺少的自有路由。
- 路由分别命名 `cpa-gpt` / `cpa-gpt-deep`；模型别名、容量、high 能力以实际部署验证为准。可共用已有凭据引用，不复制上游账户秘密。
- 跟踪安装器拥有的条目与原值；卸载仅撤销仍未被用户改动的自有条目。存在项目引用时提示受影响项目，不悄悄改投其他提供方。
- doctor 分层：静态校验 → 用户点击目录发现 → 用户确认的小额请求/工具检查。结果区分 key 已配置、目录可达、文本通过、工具通过、结构化通过、reasoning 未验证；保存动作不自动产生付费请求。
- 网络检查只访问所选允许路由，不提供任意 URL 服务端代理；localhost 可用于本机 CPA，其他主机须显式配置。重定向重新校验目标。

验收：mock 流式请求、tool call/result、截断、错误、取消、usage；安装两次无变化，卸载保留用户 route；不安装 CPA 时 DeepSeek 的构建和运行均可用。

### S4 — 模型路由与子代理生命周期

新增 `policy/model-routing.ts`；修改 `agents/types.ts`、`providers/subagent-provider.ts`、`service/agent.ts`、`src/index.ts`。

- 路由纯函数输入 project settings、role/task、run overrides、模型目录；输出原子 provider/model、maxTokens、工具范围、来源和有效上限。
- 优先级：运行显式选择 > role > defaultTier。关闭 modelRouting 时，useGlobal 跟随父会话，否则验证并应用旧 overrides。
- 验证协议、模型存在性和必要工具/图片能力；不通过则执行前报错。未知能力需探测或人工确认，不能从模型名字推断。
- one-shot/continuable 同时接通 agentOptions；不更改父 agent；监听先于启动，取消唤醒等待，finally 释放临时资源。
- childId、冻结模型/工具/策略版本落盘；恢复沿用原子任务。厂商私有 replayState 不跨协议搬运。
- 去掉外层整角色 withRetry 与内层 JSON 尝试相乘。先本地解析，再最多一次无副作用格式修复；失败 worker 不重演已完成实验。

验收：两个并行角色用不同模型互不污染；配置真的影响底层请求；异常/取消无悬挂 waiter；恢复无重复工具副作用；已保存但不存在的模型不静默回退。

### S5 — token 控制、账本、上下文与升级

新增 `policy/context.ts`、`policy/usage.ts`、`policy/budget.ts`；仅在确有复用收益时增加纯结果缓存模块。

- 每请求关联 run/task/child/request，使用稳定 ID 去重；角色汇总不是第二笔 token 消耗。
- 请求前原子预留、结束结算；统计未缓存输入、缓存读/写、输出。reasoning 已含输出时不重复累加。
- 限额取运行余额、角色、档位、模型能力的最小值；先留输出空间，再选择输入。按角色发送相关树节点、证据引用和增量，不发送完整树。
- usage 缺失保留估算/未知预留，恢复不清零；并发预留不能超卖。停止后保留 budget_exhausted checkpoint，不超支追加总结模型调用。
- 升级只响应已配置的语义信号；网络错误、格式错误、预算不足不升级。默认每任务最多一次，计数持久化。
- 缓存先覆盖可验证、无副作用的结构化整理；含模型/提示/schema/策略/证据哈希和新鲜度。worker、supervisor、实时检索默认禁用。
- 导出每次请求和每角色汇总；UI 区分 observed / estimated / unknown 及预算执行状态。

验收：并发、断流、取消、缺失 usage、恢复、辅助请求、上下文上限、缓存失效测试。尚不能前置拦截时，预算执行状态保持有限支持并阻止误导性的硬限额开关。

### S6 — 最小研究闭环

修改 `service/runner.ts`、`service/steps/idea.ts`、`service/agent-loop.ts`、`experiment/steps.ts`、`paper/phases.ts` 和相应 role/prompt/schema。

- runner 按冻结模式分支，保留 legacy；minimal 不复制一整套领域状态机。
- planner/designer 合并为一次结构化任务；资源、文件、证据存在性由本地检查承担。
- 明确课题跳过重复 idea 生成；调研、model scout、额外反思、结果综合由条件触发。
- 修复 maxPapers 被传成调研下限；candidateLimit/reflexionRounds 有界；收敛使用 verdict/有效字段指纹。
- paper=auto 依据交付类型；实验任务不自动写论文；improvement 默认 0，失败审计不能被跳过后标为成功。
- 必要统计/泄漏/证据检查不可因 never 而消失：禁止额外审查且遇到关键风险时暂停并说明待解决问题。

验收：普通明确课题 cycle 为 plan/design、worker、supervisor 三次角色启动；复杂风险正确加审查；旧 run、论文 checkpoint 和工具入口兼容。底层请求数量和 token 另行统计。

### S7 — DSH Web 项目配置页

新增可选 `packages/autoresearch-web`（已通过公开 SlotCore factory、临时 Cordis host 的 `webServer` 注入/卸载、核心 settings 文件读写和临时 React/Chromium 页面 smoke；alpha.1 真实 DSH Loader/profile 仍是发布门槛），详细字段与接口见[页面设计](dsh-settings-ui.md)：

```text
src/index.js                    # Host：项目路由、生命周期、HTTP 安全边界
src/core-bridge.js              # 调用核心 ./settings 直接函数，不复制文件写入
src/contract.js                 # API prefix 与 bridge 契约
src/client.js                   # DSH settings.section 与 lazy-factory React 页面
scripts/build.mjs               # 复制可发布的 Host/client bundle
test/                            # allowlist/CSRF/API 与真实 SlotCore factory 测试
```

- 接入既有 DSH Settings → Models 管理 CPA；新增 Settings → AutoResearch 管理项目。不要复制 DSH 全局凭据表单，也不硬改其 Models 卡片。
- 页面分为快速配置、模型分档、流程、预算；所有字段展示当前作用域、有效值来源、变更生效时间。
- 一键预设仅修改当前草稿；模型 ID 必须从本机有效目录选择，不把原型示例当作可用模型。
- 保存前校验和差异确认，expectedRevision 冲突可重载/重新编辑；运行中项目保存仅影响新 run，旧 run 不自动热切模型。
- 初期同源、loopback-only Host HTTP API，项目由明确 allowlist 注册，前端只传 opaque projectId；不扫描磁盘、不接受任意路径。写请求强制准确 Host/Origin、JSON 和 CSRF token。
- 使用 DSH 原生样式/语言/slot/dispose 机制；外部连接受现有权限及新增项目端点权限约束。远端浏览器首期只读或明确不可用。

验收：桌面/窄屏/键盘操作、非法字段、无 provider、未装 CPA、连接切换、配置冲突、错误 YAML、卸载恢复；所有凭据不进入 localStorage、URL、日志、项目导出；已完成公开 SlotCore factory、临时 Cordis host 注入、核心 settings 文件读写和临时 React/Chromium 页面 smoke，真实 DSH Loader/profile 仍需独立验证。Web 包不装时 CLI 可独立运行。

### S8 — 联调、质量比较与交付

- 分层运行：纯函数单测 → fake provider 集成 → 本地协议 mock → DSH 临时 profile → 用户明确配置的真实 CPA 小额 smoke test。
- 固定一组有明确证据的任务，对 legacy/minimal 记录角色启动、真实请求、输入/输出/缓存、重试、耗时、证据完整性、审计结果。用同任务比较，不用角色数代替 token 节省率。
- 第一轮真实测试不跑完整科研实验；验证文本、工具、结构化结果、取消/恢复及路由隔离即可。
- 交付 README、无秘密示例、安装/禁用/卸载说明、DSH/CPA/pi-ai 版本矩阵、已知限制和测试证据。
- 发布前检查敏感数据、个人路径、未解决高风险项；不自动提交、推送或修改全局 profile。

### S9 — Claude 适配

新增经过实际确认的 `cpa-claude` 或原生 Anthropic route；复用同一角色表。单独验收消息/工具 ID、thinking、图片、缓存计量、stopReason、恢复与速率限制。若现有 pi-ai 存在协议能力缺口，再新增最小 adapter 或上游修复；不提前复制 HTTP/SSE 栈。

## 4. 推荐提交粒度与首个可用版本

| 批次 | 最小交付 | 必须通过 |
|---|---|---|
| 1 | 本地构建 + 三项宿主能力验证 | 可复现构建、接口结论 |
| 2 | v2 schema/迁移/事务保存 | 配置兼容、安全与冲突测试 |
| 3 | CPA 可选包 + 实际子代理选模 | 协议与生命周期测试 |
| 4 | Web 路由/模型表/保存 | 临时 profile 内可用，CLI 不受影响 |
| 5 | 账本/输入裁剪/有限修复/预算 | 无重复副作用，统计边界诚实 |
| 6 | minimal 与条件步骤 | 质量回归、恢复一致性 |
| 7 | 流程/预算页、文档、真实小额联调 | 可配置且可验证的自用版本 |
| 8 | Claude route | 同一契约矩阵通过 |

先交付“页面选模型 → 配置保存 → 子代理实际使用该模型”的端到端闭环，再扩大优化范围。正式实施前唯一需要用户提供的运行数据是 CPA 地址、可用模型别名及凭据配置位置；页面原型和本地 mock 不需要真实密钥。
