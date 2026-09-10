# 研究流程与模型策略草稿

更新日期：2026-09-09。状态：minimal 流程、配置 schema 与请求账本基础已实施；运行时硬预算和真实模型联调仍有限。连接和模块边界见[CPA 接入草稿](cpa-integration.md)，总体验收见[当前状态](current-status.md)。

## Upstream experiment validation addendum (2026-09-10)

Each planner call now receives a bounded, non-secret summary of the effective **outer AutoResearch** workflow mode, maximum cycle/round count, model-routing state and known resolved/inherited planner route, applicable review behavior, and global LLM ceilings. These values do not define experiment-internal seeds, episodes, retries, models under study, or budget matching. Disabled outer model routing does not prohibit a multi-model experiment.

Full/legacy design reflexion permits at most two redesigns. The exact design returned to a worker must receive an explicit `proceed`; a missing/invalid verdict or unresolved `revise` enters `PAUSED` while preserving design/review files. A second human `revise` also pauses. Research minimal's optional post-work review is review-only: it may accept the executed protocol or pause, but cannot revise a protocol and attach that new design to old results. Auto-mode human-review skipping is unchanged.

All fresh and cached worker results pass the same basic local validation before evidence or supervisor decisions. A successful result needs a non-empty summary and at least one existing regular file whose real path stays within the real run root. Missing files, directories/globs, lexical traversal, outside absolute paths, escaping symlinks, failed status, and malformed output produce a normal `PAUSED` result with an actionable report. Resume revalidates cached work without rerunning a completed worker. Existing terminal completed runs are not changed retroactively.

This deterministic gate establishes only result shape, local file existence, and path containment. It does not prove metrics true. Scientific protocol versioning, pilot/formal separation, whole-run or whole-episode budget matching, statistical adequacy, and complete per-attempt reproducibility remain explicit planning, execution, evidence, and review responsibilities.

## 目标与当前依据

优先减少无条件步骤、重复上下文和失败重跑，再按任务选择模型。保留原始证据和可恢复状态；没有实测前不承诺节省百分比。

当前 `packages/autoresearch` 的主要放大点：

| 源码 | 现状 | 改造方向 |
|---|---|---|
| `src/service/runner.ts` | 一个 cycle 固定包含计划、验证、模型选择、设计、反思、执行、证据、insight、候选生成和决策 | 合并计划与设计，其余按需 |
| `src/service/steps/idea.ts` | 最多 5 个候选，各自再反思 | 明确 idea 跳过生成，候选数配置上限 |
| `src/service/agent-loop.ts` | 默认 3 轮，每轮最多 3 次尝试；`next === current` 比较收敛 | 限制轮数，以明确 verdict 或有效字段指纹停止 |
| `src/service/agent.ts`、`src/providers/subagent-provider.ts` | 外层 2 次与 JSON 3 次叠加 | 最多 6 次角色启动，不等于底层请求数；去掉整任务重跑 |
| `src/service/agent.ts:58`、`src/agents/factory.ts` | 完整研究树重复发送，没有输入 token 上限 | 相关证据摘要、增量和引用 |
| `src/paper/phases.ts:350` | 默认 2 轮 improvement | 默认 0，审计或交付需求触发修改 |
| `src/service/runner.ts` | maxPapers 被传为 surveyMinPapers | 将调研宽度落实为上限 |

`research-worker` 的一次角色启动内可以多次调用模型。成本与预算必须观察底层请求，不能只比较角色数量。

## 最小流程

```text
明确 idea / profile
  -> 本地资源与环境检查
  -> 一次结构化计划与实验设计
  -> worker 执行
  -> 本地证据收集与验证
  -> 一次 supervisor 决策
```

| 步骤 | 默认行为 | 增加模型调用的条件 |
|---|---|---|
| 调研与候选生成 | 明确课题时跳过 | 缺少方向、关键资料或用户明确要求 |
| rubric | 复用适用模板或已有冻结版本 | 新评价目标、指标冲突或不可证伪 |
| planner / minimal verification / designer | 一次结构化输出，资源先本地检查 | 复杂实验、统计协议冲突、泄漏风险时另加独立审查 |
| model scout | 跳过 | 新 backbone、可用资源或模型条件不明确 |
| evidence | 本地核验路径、指标、日志与证据 ID | 多产物存在语义冲突或需额外解释 |
| result reflexion / insight | 合并或跳过 | 决策所需的新增证据、异常归因 |
| paper | 按交付需求进入 | experiment-only 不生成论文；draft 一次合并审计，submission 独立语义审计 |
| improvement / polish | 默认不循环 | 未通过审计或用户要求修改 |

必须保留的是检查职责，而不是固定次数的模型调用。原始 artifacts、证据 ID、数值和不确定性、数据泄漏检查、科研结论与停止理由都不能省略。预算暂停不能被描述成研究失败或成功。语言模型的 proof 审阅不能被描述成机器验证的形式化证明。

### 实验代码与产物组织

当前实现由 `src/agents/factory.ts` 从插件自身目录内联共享实验工程提示，因此从任意 `runDir` 启动都不要求工作区内存在 `prompts/`。提示只发给 planner、research-worker、experiment designer/reflexion、minimal verifier、evidence agent 和 supervisor；论文写作、brainstorm 等无关角色不接收。

可执行的新任务默认把代码放在 `<runDir>/experiment/`：README、语言对应的依赖 manifest/版本记录、`configs/`、`src/<package>/` 和重要逻辑的 `tests/`，仅按需加入薄 `scripts/` 或非唯一入口的 `notebooks/`。`<runDir>/data/` 保存 raw/prepared 数据；无代码实验输出进入当前 `work/cycle-XX` 或 `work/experiment-cycle-XX`，每次尝试使用唯一子目录并记录配置、seed、版本/来源、split、命令/cwd/退出码、日志和指标。理论或无需代码任务明确说明 N/A。

minimal 模式仍只有 planner、worker、本地 evidence、supervisor 的职责链；完整模式由独立设计/反思和 evidence 角色复核。`workDir` 作为 worker 的上下文标题传入，但不加入 role sections/fingerprint，所以为旧 pending/completed worker 补充该上下文不会制造 task revision 冲突。supervisor 的 evidence 通过 Reflexion 输入实际渲染。反思返回的修订设计会继续传到 worker，并写入 standalone stage marker。

这是面向角色的指导和审查职责，不是新增的确定性代码质量 gate：运行时没有新增角色、状态迁移或必填输出字段。新 run 从约定布局开始；恢复旧 run 时不迁移已完成 stage、不批量移动现有文件，也不破坏旧 evidence 路径，只在后续角色调用中沿用或在 README 映射现有布局。短输入预算仍可能因内联提示而拒绝调用，需通过正常的 `maxInputTokens` 配置给实验角色预留上下文。

## 模型分档表

档位只表示能力需求；provider/model、reasoning 和价格不写死在业务代码中。

| role/task | 默认档位 | 需要 deep 的条件 |
|---|---|---|
| 文献元数据、格式修复、短摘要 | cheap，能本地做则不调用 | 跨来源语义冲突才转交综合任务 |
| survey / frontier / direction | standard | 跨域综合、新颖性权衡、证据冲突 |
| idea-generator | deep | 新颖假设生成；模板重放可 standard |
| rubric / idea-reflexion | standard | 可证伪性不清、因果矛盾、fatal flaw |
| planner / experiment-designer | standard | 新方法、多约束冲突、复杂统计协议 |
| model-scout | cheap | 普通元数据不升级；复杂方法比较转 standard 或 deep |
| experiment-reflexion | deep，仅风险触发 | 关键方法错误、无法由本地规则判定 |
| research-worker | standard | 复杂故障诊断或方法修改；单纯执行命令不升级 |
| evidence-agent | cheap / standard，优先本地 | claim-evidence 矛盾需要推理 |
| supervisor | deep | 影响继续、修改或结束研究的决策 |
| paper planner / contract | standard | 证据覆盖与主张强度冲突 |
| writer | deep | 跨章节综合；局部替换可 standard |
| figure / polish | cheap / standard | 涉及数学、证据语义或复杂图形表达 |
| claim / citation / proof 审计 | standard | 证据断链、关键逻辑争议；确定性检查本地完成 |

高智能升级来自可配置语义信号，不依赖一个额外的“路由 agent”。格式错误、transport 错误、预算不足都不自动升级模型。

## 项目配置

```yaml
version: 2
modelRouting:
  enabled: true
  defaultTier: standard
  tiers:
    cheap: { provider: deepseek-official, model: deepseek-v4-flash }
    standard: { provider: cpa-gpt, model: gpt-self }
    deep: { provider: cpa-gpt-deep, model: gpt-self }
  roles:
    planner:
      tier: standard
      escalateTo: deep
      escalateOn: [evidence_conflict, quality_low]
    research-worker: { tier: standard, maxInputTokens: 12000, maxOutputTokens: 6000 }
    supervisor: { tier: deep, maxInputTokens: 10000, maxOutputTokens: 3000 }
    writer: { tier: deep, maxInputTokens: 24000, maxOutputTokens: 8000 }
workflow:
  mode: minimal          # legacy | minimal
  brainstorm: auto       # enabled | auto | never
  deepDive: auto
  modelScout: auto
  experimentReview: auto
  postResultSynthesis: auto
  paper: auto
  paperImprovementRounds: 0
  candidateLimit: 3
  reflexionRounds: 1
budget:
  maxInputTokens: 24000
  maxOutputTokens: 8000
  maxRunTokens: 120000
  maxRoleCalls: 120
  maxRetriesPerCall: 1
  jsonRepairAttempts: 1
  maxUpgradesPerTask: 1
  context:
    treeSummaryTokens: 2500
    evidenceTokens: 5000
    paperTokens: 8000
    failureTokens: 2500
```

模型 ID 为示例或仓库已有命名，运行前必须确认部署可用性。各档也允许 maxInputTokens/maxOutputTokens，未填写时继承全局上界。首期 reasoning 来自 provider route 默认值；不能向 DSH 基础 AgentOptions 添加一个无效字段来假装支持。

`workflow.mode=minimal` 启用最小流程；字段缺失和 v1 迁移为 legacy。run 保存流程及策略版本，恢复不改变已完成步骤。`Lean / lean` 保留给未来数学、物理研究的 Lean 语言及形式化证明工具，不用作流程名。

`enabled` 请求一个可选步骤，`auto` 根据上表条件执行，`never` 禁止可选步骤。必须检查的问题仍需解决；例如独立审查被禁用但出现关键统计冲突时，记录待解决问题并暂停，不能跳过后继续。paper=auto 取决于交付需求，improvement=0 不表示未通过的审计变成通过。

candidateLimit=0 禁用候选生成，reflexionRounds=0 禁用额外反思，基本产物验证始终存在。brainstorm 的文献数沿用 paperExploration.maxPapers，并修正当前将其用作下限的传递。

升级仅允许配置了 escalateTo/escalateOn 的角色，由本地校验或已验证结构化质量结果触发；支持 quality_low、fatal_flaw、evidence_conflict、high_stakes_decision。相同 task 默认最多一次，目标档位相同时不重跑。worker 升级仅恢复明确失败的子任务，不能重演已完成实验。

## 预算、上下文与缓存

调用上限取运行、档位、角色、模型能力中最严格值。先预留输出，再计算剩余输入空间，确保输入加输出不超过 contextWindow 和 run 剩余额度。reasoning 占用输出预留；context 各字段的合计也受输入总上限约束。

上下文按角色 sections 选择，优先传递「claim → evidence ID → metric/uncertainty → source path」。研究树只传相关节点和最近变化，原文按需读取。裁剪标注来源与遗漏，保留 ID、数值、单位、路径和反证；关键证据不足时检索或暂停，不凭裁剪后的片段下结论。

缓存只用于可证明无副作用的结果，key 包含 provider/model/reasoning、task、标准化输入、prompt/schema/policy 版本、artifact hash、来源新鲜度和工具能力。环境敏感检查加入环境指纹，否则禁用缓存。worker、supervisor、人工反馈修改、随机候选和实时检索默认禁用缓存。命中后重新验证依赖存在且 schema 有效，记录命中而不重复累计旧用量。

## 请求账本与恢复

账本分别记录 role 启动和底层 LLM 请求；taskId、childId、requestId 相互关联。角色汇总不能再次进入 token 总数。maxRoleCalls 限制实际角色启动，包含修复和升级；maxRetriesPerCall 限制 DSH 模型步骤重试，AutoResearch 不再叠加整任务重试。

请求统计包含 inputTokens、cacheReadTokens、cacheWriteTokens、outputTokens、reasoningTokens、provider/model、attempt、routingReason、usageSource、stopReason。DSH inputTokens 是未缓存输入：

```text
totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
```

reasoningTokens 已包含在输出时只作明细。缺失 usage 标记 unknown/estimated，不能当作零；估算预留不能无依据释放。CPA 内部重试可能不可见，报表注明统计边界。价格由外部表提供，不把订阅调用假设为零成本。

每次底层请求前原子预留、结束后结算，包括 worker 内部调用以及压缩、标题等辅助请求。取消或断流保存原 childId 和已执行工具结果；预算耗尽写入可恢复的 budget_exhausted，不能额外超支调用 supervisor。恢复不清零预算、尝试和升级计数；旧 run 没有历史账本时明确标记历史用量未知。

JSON/schema 错误先本地提取、修复、校验，再最多一次同档位的无工具结果修复。仍失败时保留原始产物及未完成状态，不升级 deep、不重跑实验。收敛采用明确 verdict/no_material_change 或有效字段指纹，不用对象身份判断语义相同。

## 验收

- fake provider 验证角色表、升级触发、工具限制及预算优先级；并发与恢复不能多获得额度。
- minimal 模式下，已有明确课题和合格证据的普通 cycle 只需计划/设计、worker、supervisor 三次角色调用；底层 token 另行实测。
- 复杂风险会增加必要检查，experiment-only 不进入 paper；旧 run 维持原策略。
- 缓存依赖变化即失效；错误修复不重复执行 worker；未知用量在报表中可见。
- 核心状态、原始产物、证据路径、科研停止理由、论文 checkpoint 和既有工具入口保持兼容。
