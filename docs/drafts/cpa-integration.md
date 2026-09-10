# CPA 接入与模块边界草稿

更新日期：2026-09-09。状态：配置适配、安装器和本地契约测试已实施；真实 CPA 端点模型请求仍待用户配置验收。流程与模型策略见[研究运行草稿](research-runtime.md)，实施顺序见[草稿索引](README.md)，总体验收见[当前状态](current-status.md)。

## 接入方案

新增可选接入包 `@athena/dsh-cpa`，复用 DSH 的 `@deepseek-ai/dsh-llm-pi-ai`。CPA 管理上游账户和代理，DSH 执行工具、管理子代理与会话，AutoResearch 负责研究步骤与证据。

GPT 优先通过 `openai-responses` 接入；需要 Chat Completions 时显式选 `openai-completions`。未来 Claude 可使用 CPA 路由，或 pi-ai 已有的 `anthropic-messages`。每个 provider 路由只使用一种协议，协议失败不触发自动切换。

只改代理 URL 无法解决现有模型配置未生效、角色分档和预算问题；自建 Agent Runtime 又会重复工具循环与恢复机制。因此本轮采用可选接入包与项目策略模块，不重写 harness。

## 模块职责

```text
AutoResearch 领域步骤
  -> 模型路由、上下文选择、预算
  -> DSH subagent / 工具执行
  -> DSH LLM 注册表
      -> 现有 DeepSeek provider
      -> pi-ai 插件
          -> CPA GPT
          -> 后续 CPA Claude / 原生 Claude
```

| 模块 | 职责 | 依赖边界 |
|---|---|---|
| `packages/dsh-cpa` | 配置编译、可选 Cordis 组合、安装与诊断 | 依赖 DSH 公开能力，不依赖研究业务 |
| `autoresearch/src/settings` | v1/v2 配置读取、迁移、验证 | 不保存模型请求密钥 |
| `autoresearch/src/policy/model-routing.ts` | role/task 到 provider/model/预算的纯函数解析 | 不直接发请求 |
| `autoresearch/src/policy/context.ts` | 字段选择、证据引用、输入裁剪 | 不增加路由判断模型 |
| `autoresearch/src/policy/usage.ts` | 请求账本、预算预留与结算 | 按实际请求计量 |
| `autoresearch/src/providers` | 向 DSH 传递模型、工具范围和生命周期参数 | 复用 DSH 工具执行 |
| `packages/autoresearch-web`（可选） | DSH 项目设置页、Host 项目设置 API、有效策略展示 | 调用核心设置服务；CLI 不依赖 Web；不另存模型密钥 |
| 现有 service/experiment/paper/brainstorm | 领域编排、产物、验证和恢复 | 不导入 CPA 接入包 |

接入包当前交付文件为 `packages/dsh-cpa/src/config.mjs`、`src/doctor.mjs`、`src/installer.mjs`、`presets/cpa.cordis.yml`、`scripts/install.mjs` 及相应测试。它提供 DSH 插件组合，不新增第二套 LLM registry。宿主已有 pi-ai 实例时合并路由，缺少时才安装一个；不重复注册设置命名空间或调用原生插件 `apply()`。

前端复用 DSH 原生 Models 管理连接，新增 AutoResearch section 管理项目策略，不改写全局安装中的前端包。详见[页面设计](dsh-settings-ui.md)和[文件级实施计划](implementation-plan.md)。

## 当前代码与约束

源码路径以下均相对 `packages/autoresearch`：

| 位置 | 检查结果 | 需要处理 |
|---|---|---|
| `src/index.ts:58` | 固定创建 `SubagentRoleAgentProvider` | 注入项目策略，保留默认 DSH 执行 |
| `src/settings/project-settings.ts` | `model.overrides` 仅存储和展示 | 接通实际调用，拒绝无效配置 |
| `src/providers/subagent-provider.ts` | 本地 Like 类型遗漏 `agentOptions`、`toolFilter` | 使用公开契约，确保 one-shot 与 continuable 都传递策略 |
| `src/service/agent.ts:32`、provider JSON 循环 | 外层默认 2 次，内层 3 次尝试 | 取消叠加整任务重跑 |
| `src/agents/types.ts` | 返回值没有 usage | 增加向后兼容的统计关联 |
| `scripts/build.mjs:6`、`package.json:20` | 编译器路径指向另一个个人仓库 | 改为本包开发依赖 |

本机 DSH `0.1.5-alpha.1` 的公开类型已核对：

- `SubagentStartRequest` 支持 `agentOptions`、`toolFilter`、`persona`；continuable 请求保留这些字段，但没有 `outputSchema`。
- alpha.1 的 AgentOptions/model-selection 契约支持可选 `reasoningEffort`；路由在模型能力校验通过时传递它，不能仅凭模型名称推断能力。
- one-shot 的结构化结果由 DSH 子代理结构化输出工具约束；不能将其表述为 CPA 原生 strict JSON。
- DSH 的 `inputTokens` 为未缓存输入，缓存读写单列；reasoning 是输出明细。

保留现有函数式模块原则：无状态步骤使用函数，只有生命周期或集合不变量需要 class。role、phase、audit 等定义各有一个数据源；临时阶段结果走参数和返回值，不堆入万能 context。保留 ResearchTree、HypothesisPool 及现有 checkpoint 的职责，不增加通用工作流引擎、事件总线或纯转发类。

## 连接配置

连接信息由 DSH Models/credentials 管理；DSH 宿主 settings 默认位于 `.dsh/settings.yaml`（实际路径以宿主配置为准），项目只引用 provider/model。接入包编译到原生 `llm-pi-ai.providers`：

```yaml
llm-pi-ai:
  providers:
    cpa-gpt:
      displayName: CPA GPT
      api: openai-responses
      baseURL: http://127.0.0.1:8317/v1
      apiKeyEnv: CPA_API_KEY
      transport: sse
      retryPolicy:
        mode: normal
        maxRetries: 1
      models:
        - id: gpt-self
          contextWindow: 32768
          maxTokens: 8192
          input: [text]
    cpa-gpt-deep:
      displayName: CPA GPT Deep
      api: openai-responses
      baseURL: http://127.0.0.1:8317/v1
      apiKeyEnv: CPA_API_KEY
      transport: sse
      reasoning: high
      retryPolicy:
        mode: normal
        maxRetries: 1
      models:
        - id: gpt-self
          contextWindow: 32768
          maxTokens: 8192
          input: [text]
          reasoningEfforts:
            high: high
```

`gpt-self` 是用户在 CPA 中配置的示例别名，不是官方模型 ID；容量是示例。第二条路由仅在目标模型确认支持 high 后使用，不从模型名称猜能力。模型目录只能确认 ID，不能证明工具、图片或 reasoning 可用。

密钥使用面向 CPA 客户端的 API key，通过 DSH credentials 或环境变量解析。上游账户与管理 API 密钥不进入该配置。验证拒绝普通 headers 中的认证密钥，诊断及日志不输出秘密。

## 调用、迁移与生命周期

1. 从显式 projectDir 读取策略，不能总将 runDir 当作项目根。解析 role/task，原子选定 provider/model，验证必须能力。
2. 选择上下文、预留预算，将 `agentOptions: { provider, model, maxTokens }` 和工具范围传到 DSH。纯推理角色只获得需要的工具。
3. 每次底层请求绑定 taskId、childId、requestId，记录 usage；结果接受前检查 stopReason、schema 和产物。
4. 长任务持久化 childId，恢复原任务；启动前安装结束监听，取消时释放等待，one-shot 在 finally 中 dispose。不得因结果格式错误重新执行实验。

项目配置采用 v2；v1 在内存中迁移，显式保存时写 v2。`modelRouting.enabled=false` 时沿用旧选择意图：useGlobal 继承父 agent 模型，其他情况使用 overrides。启用新路由时按「运行显式选择 > 项目 role > defaultTier」解析，记录来源，不更改父会话默认模型。任何无效配置都返回字段路径，不静默回退默认值。

流程模式、策略版本和有效模型选择随 run 落盘。旧 run 恢复保留原流程和已完成产物，不能因更新配置重复实验。模型/协议切换只携带兼容的领域信息；厂商私有 replayState 不跨不兼容路由复用。

## 可插拔与 Claude 扩展

安装器输出 dry-run diff，幂等合并指定 profile 的自有条目，不修改 shell/fs 权限。禁用或移除时撤下 CPA 自有路由，保留其他 provider 和 AutoResearch。用户已修改的条目不能被卸载器覆盖；在途调用使用已冻结配置，后续调用遇到已禁用路由时明确失败。

Claude 第一条路径是在 CPA 提供可用模型后增加 `cpa-claude` 路由；第二条路径是配置原生 `anthropic-messages`。模型表引用该路由即可。工具 ID、图片、thinking、缓存和恢复分别验收，研究业务不出现按厂商名称分支。

## 验收

- 构建不依赖个人绝对路径，现有公开导出和工具入口继续可用。
- 本地 mock 覆盖流式分片、多工具 ID、结构化结果、截断、取消、错误和 usage；同时验证 DSH one-shot 与 continuable 的有效模型。
- 两个并行任务选择不同模型时互不串配置，恢复后模型和工具范围保持一致。
- 无效模型、密钥或能力在执行研究前报错；关闭 CPA 后 DeepSeek 路径仍可用。
- 真实 CPA 验证记录 CPA/DSH/pi-ai 版本与部署模型；配置校验不代替连通性和行为测试。

依据：CPA 官方仓库说明支持 OpenAI（含 Responses）与 Claude 兼容客户端；具体部署仍须验证。[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)

Responses 与 Chat Completions 的请求、工具结果和结构化输出形状不同，适配不能仅替换 URL。[OpenAI 迁移文档](https://developers.openai.com/api/docs/guides/migrate-to-responses)
