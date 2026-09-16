# 长程运行时调研与审查（2026-09-16）

范围：长期记忆、上下文管理、跨会话任务持续性、异步作业恢复，以及可观测的 durable workflow。代码审查同时覆盖 `main` 与未合并 worktree `feat/evidence-driven-research`（HEAD `5034eb1`）。本报告只写设计审查，不修改源码、不提交 commit。

## 结论摘要

当前 `main` 已经有可恢复的文件骨架：`state.json`（实际常量见 `core/utils.ts:5`）、`events.jsonl`、阶段 marker、纸张 pipeline checkpoint 和请求预算账本。未合并 worktree 又完成了记录级 research context、记忆生命周期与依赖失效、不可变 `CURRENT.json` 研究快照、continuable child registry，以及 unknown worker receipt 的 fail-closed 处理。把这些功能再列成“待实现”会重复工作。

长期运行的主要缺口是运行时协调语义，而不是再增加一个向量库：

1. 多进程/跨服务器没有共享的任务租约、心跳、作业查询和 supervisor；当前多数锁与 registry 是 Node 进程内 Promise，或只能处理本地文件。
2. `state.json` 与 `events.jsonl` 不是一个提交单元；崩溃可以留下“状态已前进、事件未写入”或反向的窗口。远端作业提交、receipt、结果评估也没有统一的两阶段/对账协议。
3. unknown receipt 会暂停，这是正确的安全边界，但没有 provider-neutral `query(idempotencyKey)` / `cancel` / `reconcile` 接口，故暂停后的恢复仍靠人工。
4. 当前上下文选择已经可审计、可拒绝 stale dependency，但仍是一次调用的选择与裁剪；没有 MAGE/AgentFold 式按子目标边界维护 active execution path、验证压缩摘要并从错误分支恢复的状态机。
5. 需要用“故障注入后是否无重复外部作业、无丢失科学提交、可继续”验收；其中“无重复外部作业”只对支持 provider-side 幂等提交和可查询/对账的后端成立，不具备这些能力时应安全暂停 unknown，而不作 exactly-once 承诺。

建议优先级：P0 建立单写入 supervisor + durable job reconciler + lease/heartbeat；P0 把阶段事件、外部作业和科学 snapshot 绑定为带 hash 的 attempt journal；P1 把现有 structured context 扩展为可验证的 active-path memory；P1 引入跨 run/model 的经验证 procedural playbook；P2 用 METR 风格的人类时间等价和故障注入矩阵评测。

## 文献与工程资料矩阵

下表的“结果”仅复述来源的实验或工程观察；“对本仓库的推断”是本审查的设计推断，二者分开。论文均链接 arXiv 原文 HTML/摘要；工程资料标为官方文档，不能视作同行评审证据。

| 来源（日期，原文） | 机制与已报告结果 | 对长期运行时的可迁移启示与限制 |
|---|---|---|
| **MemGPT: Towards LLMs as Operating Systems**（Packer et al., 2023-10-12；v2 2024-02-12）[arXiv](https://arxiv.org/abs/2310.08560) | 将 context window 当作 fast memory、外部存储当作分页层，使用函数调用/interrupt 做虚拟上下文管理。多会话 DMR 中，论文报告 GPT-4 + MemGPT accuracy 92.5%、GPT-4 Turbo + MemGPT 93.4%，高于固定上下文基线。 | 说明“无限历史”必须有显式换入/换出策略和控制流，而非简单 append。不能直接推出科学任务可靠性：实验是文档分析和对话记忆，未验证外部作业 exactly-once、证据有效性或跨进程恢复。 |
| **Reflexion: Language Agents with Verbal Reinforcement Learning**（Shinn et al., 2023-03-20；v4 2023-10-10）[arXiv](https://arxiv.org/abs/2303.11366) | 将环境反馈转成 verbal reflection，写入 episodic memory，在下一 trial 使用；HumanEval Python pass@1 报告 91.0（对比 GPT-4 80.1），并报告 AlfWorld +22%、HotPotQA +20%。消融显示 self-reflection 相对仅 episodic memory 再提高约 8 个百分点的特定设置结果。 | 适合将“失败原因/下一次避免什么”写成可检索经验，但反思文本是候选解释，不能成为正式证据。worktree 已把 observation、interpretation、decision 分离并要求 provenance；后续仍需把反思纳入验证门，而不是自动提升 lifecycle。 |
| **Voyager: An Open-Ended Embodied Agent with Large Language Models**（Wang et al., 2023-05-25；v2 2023-10-19）[arXiv](https://arxiv.org/abs/2305.16291) | 自动 curriculum、可执行代码 skill library、将环境反馈/执行错误/self-verification 纳入迭代提示；论文报告比先前方法多 3.3x unique items、2.3x travel distance、关键 tech milestone 最多快 15.3x，并能把技能迁移到新 Minecraft world。 | 适合本项目的“procedural memory”：保存可执行 recipe、前置条件、失败原因和验证器，而不是只保存摘要。结果依赖 Minecraft/GPT-4 黑盒环境，不能证明在科研管线中迁移；技能必须带版本、适用范围和验收脚本。 |
| **AgentFold: Long-Horizon Web Agents with Proactive Context Management**（Ye et al., 2025-10-28；ICLR 2026 版本见 [OpenReview](https://openreview.net/forum?id=IuZoTgsUws)，原文 [arXiv](https://arxiv.org/abs/2510.24699)） | 将工作区拆成 invariant question、multi-scale state summaries、latest interaction；模型显式产生 folding directive，可细粒度压缩单步，或在子任务完成时深度合并多步。SFT 的 AgentFold-30B-A3B 在 BrowseComp 36.2%、BrowseComp-ZH 47.3%、WideSearch 62.1%、GAIA 67.0%；文中报告 100 turns 后约 7k tokens 并可扩展至 500 turns。 | 适合把 `treeSummary` 的“全树摘要”变成按连续 step range 的可验证摘要，保留最近完整 interaction；但论文依赖训练出的 folding policy，摘要错误风险仍在，科研系统必须保留原始证据和可回滚范围，且不能把 benchmark 分数当作科学有效性。 |
| **DeepAgent: A General Reasoning Agent with Scalable Toolsets**（Li et al., 2025-10-24；v3 2026-02-05，WWW 2026）[arXiv](https://arxiv.org/abs/2510.21618) | 用 `<fold_thought>` 触发 auxiliary LLM 把历史折叠为 episodic/working/tool 三类 JSON memory；在八类 tool-use/downstream benchmark 上评测。消融中 DeepAgent-32B-RL 平均 48.1；去掉 memory folding 为 44.2，GAIA 53.3 降至 44.7。 | 启示是把“长期目标/当前障碍/工具经验”分层，并记录 fold 触发点；但 memory folding 与 ToolPO 训练耦合，且为模型级 benchmark。仓库可先实现确定性 envelope、验证器和回滚，再考虑 LLM 摘要，避免将不可验证压缩写入 canonical state。 |
| **Beyond Semantic Organization: Memory as Execution State Management for Long-Horizon Agents (MAGE)**（Chen et al., 2026-06-04）[arXiv](https://arxiv.org/abs/2606.06090) | 把记忆建成 hierarchical state tree；Grow 记录 action/observation，Compress 在子目标边界生成 summary，Maintain 验证摘要与底层 trace，Revise 回退到边界并从新 sibling branch 继续。MemoryArena 四域结果中平均较 baseline 提升 7.8–20.4 pp、较 long-context token 减少 55.1%；表中 Mage SR 在 Bundled Shopping 39.33%、Travel 15.19%、Web Search 56.56%。 | 与本仓库最贴合：`CURRENT` 的父快照链已有 immutable lineage，但还没有执行状态树的 active path、子目标 summary validator 和“坏分支隔离后重新执行”。论文 benchmark 是 action-conditioned MDP，不是科研证据；可迁移的是状态操作语义，不是分数。 |
| **Measuring AI Ability to Complete Long Software Tasks**（METR/Kwa et al., 2025-03-18；v4 2026-07-10，NeurIPS 2025）[arXiv](https://arxiv.org/abs/2503.14499)，维护页 [METR](https://evals.alignment.org/time-horizons/) | 定义 50% task-completion time horizon：以人类专家完成时长标注任务，拟合成功概率随时长变化的 logistic 曲线。论文在其任务集报告 2019–2025 约每 7 个月翻倍；其摘要给 Claude 3.7 Sonnet 约 50 分钟。METR 明确指出该量是任务难度/能力指标，不是 agent 可以连续运行的 wall-clock，并警告自动评分、较整洁任务对现实“messy”任务的外推限制。 | 用它设计本项目的 horizon 曲线：固定任务族，报告 50%/80% 完成时长、恢复后成功率、重复外部作业率和人工介入分钟数。不要把 METR 的趋势外推成产品承诺；要加入网络中断、异步 GPU、动态资源和高可靠性约束。 |
| **Auto-RecSys: Harnessing Autonomous Research Agents for Industry-Scale Recommender System**（Li et al., 2026-09-10）[arXiv](https://arxiv.org/abs/2609.10922) | 最新且最贴近自主科研运行时。针对训练数日、跨服务器和脆弱依赖，提出 distributed asynchronous execution、centralized cross-server memory、cognitive-procedural separation；每个 idea 独立 state，global registry 避免冲突；Execution Evolution Loop 累积 playbook/dead ends，Idea Evolution Loop 使用实验结果改进后续想法。作者报告 31 iterations 中 major fixes 从 4.0 降至 0.5/iteration，并声明当前没有 playbook update 的正式 validation gate。 | 直接支持 P0/P1：持久 FSM、per-job isolation、跨服务器 registry、skill 与 deterministic scripts 分层、失败原因与修复共同存储。需谨慎：这是 2026-09-10 v1 的工程论文/观测性评估，不是随机对照；“human time reduced”不能替代 completion/recovery correctness。 |
| **Effective harnesses for long-running agents**（Anthropic Engineering，2025-11-26，官方工程文档）[文章](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 官方报告把长任务失败归为 one-shot（一个 session 做太多，交接时半成品）和 declare victory early。建议 initializer 先建环境/任务清单，coding agent 每 session 做增量工作，留下 progress artifacts，并在每次 session 先运行基础端到端检查。 | 这是产品工程经验，不是论文实验。对本项目的具体启示是把“下一可执行动作、已验证 artifact、失败恢复动作”作为 handoff contract，并让 supervisor 在声明完成前复查 acceptance。 |
| **Harness design for long-running application development**（Anthropic，2026-03-24，官方工程文档）[文章](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 官方进一步描述 planner/generator/evaluator 三 agent、把大任务拆成小块、结构化 handoff；清空 context 后用 handoff 解决 context anxiety 和 coherence loss。 | 可迁移为 planner/worker/supervisor 的职责边界与独立验证；仍是工程报告，不能替代故障注入和科学有效性评测。 |
| **Temporal durable execution 官方资料**（截至 2026-09-16）[Docs](https://docs.temporal.io/)；[Workflow Execution](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/workflow-execution/workflow-execution.mdx)；[Activity Execution](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/activities/activity-execution.mdx) | Temporal 将 workflow event history 持久化，worker 崩溃后 replay 到最新状态；Activities 有 timeout/retry policy，官方明确 activity 可能在投递或 worker 崩溃时丢失，依赖 start-to-close timeout，并要求 activity 幂等。 | 本项目不必立即引入 Temporal；应借鉴其语义：确定性 controller、把非确定性 LLM/工具调用作为 activity，并持久化其结果供 replay 复用；事件历史是 source of truth，每个外部副作用有 idempotency key/timeout/heartbeat/query。仅写本地 JSON 不足以得到跨服务器 durable execution。 |

## 代码审查：main 基线

### 已有能力（不应重复列为待实现）

- `policy/context.ts:5-10` 提供确定性 token heuristic；`:31-52` 按 priority、全局和 section cap 裁剪，必需段落裁不下会记录 `insufficientSections`。这是预算防护，不是 tokenizer 上界。
- `policy/request-ledger.ts:182-228` 以 request id 幂等预留/settle，并在 `:221-223` 的 `recoverPending` 把未结算 reservation 记成 unknown；`:234-240` 使用 lock + 原子替换，`remainingTokens` 和 `remainingRoleCalls` 可审计。
- `core/state.ts:6-20,23-37` 用实际文件 `state.json` 原子写入并载入（文件名常量在 `core/utils.ts:5`）；`:40-45` 追加 `events.jsonl`；`:56-70` 记录 phase/result/decision。
- `experiment/runner.ts:84-105` 的 `.autoresearch/experiment-<cycle>-<stage>.json` 是阶段幂等 marker；`:235-261` 重载已有状态并恢复 ledger；`:386-387` 明确宣称 resume 不会重新 dispatch 已完成 worker。
- `service/autoresearch-service.ts:124-149` 重载 state，冻结 policy snapshot，并启动 request ledger；`:202-204` 的 `resume` 复用同一 `run` 路径。`service/runner.ts:171-330` 在 cycle/phase/planVersion 间继续运行，`:343-349` 能将异常落为 PAUSED。
- `paper/checkpoint.ts:6-41` 已有 paper phase checkpoint 和原子保存。

### 可证明的缺口

1. **状态与事件不是一个提交。** `core/state.ts:56-62` 先 `saveState` 再 `appendEvent`；进程在两者之间退出时，resume 看到新 phase，却无法从 event log 证明 transition。`appendEvent`（`:40-45`）也没有事件序号、prev hash、fsync 或跨进程 lock。
2. **运行状态没有 owner/lease/heartbeat。** `core/types.ts:14-48` 的 `RunState` 只有 status/phase/cycle/stepId/planVersion/updatedAt，没有 attempt、lease owner、fencing token、next retry 或外部 job id；`AutoResearchService.run` 每次在 `:124-131` 载入并直接写 `RUNNING`，两个进程可同时执行同一 run。
3. **unknown 的恢复被截断。** `request-ledger.ts:221-223` 可以把 pending 结算为 unknown，但 `service/autoresearch-service.ts:149` 仅调用 `recoverPending('interrupted')`；没有 provider status query，也没有判断已提交远端训练是否完成。安全地暂停仍会浪费人工且没有自动对账。
4. **外部副作用与本地 marker 没有统一 attempt。** `experiment/runner.ts` 的 stage marker 保护本地 worker 返回值，但“提交外部 job → job 已创建 → 本地未写 receipt”仍是 crash window；重启只能看到缺 marker，不能根据 idempotency key 查询 provider。
5. **多步 agent loop 没有 durable supervisor。** `service/runner.ts:171-330` 是一个 async while；它能在函数调用边界 save，但没有后台 poller、定时器、租约回收、跨服务器 claim 或 out-of-order completion。`agent-loop.ts:37-98` 的 reflexion 是内存中的 rounds/retry，不是可恢复 workflow。
6. **上下文是“裁剪”而非“执行状态管理”。** heuristic 计数和整段 record selection 可以避免超预算，但没有 subgoal boundary、summary validation、active-path rollback；长任务只会继续积累 tree/memory records 或暂停。

## main → feat/evidence-driven-research：已经新增什么

以下均已在 worktree 实现，应作为当前设计基线而非重复需求：

| 能力 | 代码证据 | 剩余边界 |
|---|---|---|
| 记录级 context contract | `research-context/types.ts:44-121` 定义 scope、snapshot/protocol hash、required/focus、selected/excluded manifest；`assemble.ts:49-100` 以相同 selected records 生成 rendered hash/call id 并原子写 `context/<call-id>.json`。 | 仍使用 heuristic token（报告自身说明为 estimate）；manifest 与 run directory 同步，跨服务器共享/版本迁移没有实现。 |
| scope/access/stale dependency | `research-context/select.ts:15-128` 过滤 visibility/access/lifecycle，检查依赖 hash，扩展 opposing/conflict closure，必需闭包放不下则抛 `CONTEXT_INSUFFICIENT` 或 `STALE_CONTEXT_DEPENDENCY`。 | 这是“选择时拒绝”；没有自动构造可验证的多尺度 execution summary 和从错误边界回滚。 |
| memory lifecycle | `memory/store.ts:49-173` 以 JSONL 记录 observation/interpretation/procedure/decision，hash/version/provenance，transition 会追加版本并使 dependent summary invalidated；`:203-227` 批量转换依赖图为 context records。 | `memoryLocks` 是进程内 Promise；跨进程仍依赖单写者。默认 store 以 run scope 为主，没有中央跨服务器 playbook、租约或 update validation gate。 |
| canonical scientific snapshots | `research/store.ts:15-18,153-169,172-243` 使用不可变 snapshots、`CURRENT.json` hash pointer、parent/version 检查与 writer lock；`service/research-cycle.ts:21-70` freeze protocol，`:92-145` capture/validate/assess，`:180-224` commit decision/revision。 | `CURRENT` 是科学提交点，但 `state.json`/`events.jsonl`/job registry 仍不是同一事务；writer lock 只识别 PID，不是 lease/fencing token。 |
| worker unknown receipt | `service/research-cycle.ts:73-90` 用 `attempt.json`；`:78-87` 已有 `wx` 防止未知/失败 attempt 被静默 redispatch；`experiment/steps.ts:274-313` 对 completed receipt 复用，对 unknown 暂停，并把失败/结果写入 assessment。 | 没有 adapter-neutral query/cancel/reconcile；unknown 仍需人工查后删除/修复 marker。 |
| continuable child registry | `providers/subagent-provider.ts:253-289` 原子更新 `.autoresearch/subagent-tasks.json`；`:355-455` 支持 provisioning/pending/completed、固定 child id、重连和 task fingerprint。 | `registryLocks`/`taskLocks` 是 Node 进程内；registry 没有 lease heartbeat、provider query、failed/unknown 状态和跨主机 CAS。进程死在 `pending` 时仍需人工恢复。 |
| provenance-aware output | `export/evidence-chain.ts` 与 `research-outputs.ts` 将 current snapshot/hash 和 unknown provenance 带入报告；`docs/superpowers/plans/2026-09-12-evidence-driven-runtime-report.md:14-30,39-49` 记录了完成 resume、revision resume、unknown job、canonical commit 后中断等 focused fixtures。 | 这些是本地 deterministic fixtures，不是跨进程/跨服务器、真实 scheduler、网络分区下的 durable execution 证明。 |

## 净新增设计（按优先级）

### P0-A：Run Supervisor + durable job reconciler

增加 provider-neutral 的 `RunSupervisor`，将一个 run 拆成持久的 step attempts，而不是把 while loop 当作唯一控制器：

```text
Run (frozen policy + run lease)
  └─ StepAttempt (plan/design/submit/poll/assess/decide/paper)
       ├─ state: pending | leased | running | succeeded | failed | unknown | paused
       ├─ attemptId, idempotencyKey, inputHash, outputHash
       ├─ owner, fencingToken, startedAt, heartbeatAt, nextRetryAt
       └─ external: provider, externalJobId, receiptHash, lastQueryAt
```

每次 claim 必须进行 compare-and-swap：`pending → leased` 只接受当前 fencing token；心跳过期后由 supervisor 标记 `stale`，先调用 `query(idempotencyKey/externalJobId)`，得到 completed/failed 才能 settle；查询不到才保持 `unknown` 并暂停。只有后端明确提供 provider-side idempotency 和按 key/job id 查询（必要时 cancel）时，才可以对同一 logical attempt 给出“不会重复提交”的保证；此时同一 key 应返回原 job id，禁止“超时即重新提交”。不具备这些能力的后端必须把提交结果视为 unknown 并暂停，不能宣称零重复；`cancel` 也必须有 provider 回执，不能仅把本地状态改成 canceled。

第一版可以继续使用本地文件，但至少要有跨进程 lock（lock 文件带 owner、createdAt、lease expiry、fencing token，不能只靠 Promise/PID），并把每个 attempt 独立文件原子替换；单机事件表可以使用 SQLite，跨服务器协调必须接入服务化一致存储，例如 Postgres/Temporal，SQLite 本身不能承担跨服务器租约与 fencing。目标不是立刻换基础设施，而是先固定语义。

### P0-B：统一 attempt journal 与提交顺序

在 `state.json`/`events.jsonl`/`CURRENT.json` 外增加 append-only `attempts.jsonl`（单机也可用 SQLite event table；跨服务器应使用服务化一致存储），每条事件有 `seq`、`prevHash`、`runId`、`attemptId`、phase、input/output hash、wall clock、monotonic clock、actor/fencing token。恢复时：

1. 先验证 journal hash chain 和最后一个完整 event；
2. 重建可派生的 runtime view；
3. 验证 `CURRENT.json`、stage marker、worker receipt 的 hash 是否与 event 相符；
4. 对未闭合 attempt 进入 reconciler，而不是直接重新调用。

至少将 `transition + appendEvent` 改成 write-ahead event → atomic runtime view，或同一文件事务。现有 `CURRENT` 仍作为科学 canonical commit；runtime checkpoint 只能是可重建 view，不能覆盖 canonical snapshot。这样可处理“科学 commit 成功但 runtime checkpoint 尚未写完”的窗口，也能识别“marker 存在但 output hash 不匹配”。

### P0-C：监督器职责与人工边界

Supervisor 不负责替代科学 supervisor agent。前者是 deterministic runtime reconciler，负责 claim、poll、timeout、retry、budget、lease 和 handoff；后者是 LLM role，负责 hypothesis/evidence/decision。LLM activity 的输出具有非确定性：调用前把 context manifest hash、policy snapshot hash、budget reservation 和 input intent 写入 attempt；模型返回后再持久化 output 与 receipt。恢复/重放时优先复用已持久化的结果，只有显式创建新 attempt 才重新调用模型，避免把一次重放误当成同一调用的确定性再现。

加入状态信号：`job.completed`、`job.failed`、`human.approved`、`human.rejected`、`budget.exhausted`、`context.stale`。信号只能令 controller 产生新 event，不能直接修改 `CURRENT`。人工恢复 unknown job 时必须提交 provider receipt/hash 和选择 `adopt-completed`、`mark-failed` 或 `cancel-confirmed`，不能通过删除 marker 解锁。

### P1-A：将 structured context 扩展为 active execution memory

沿 MAGE 的 Grow/Compress/Maintain/Revise 设计，但保留现有 record-level provenance：

- Grow：每个 action/observation 先写 immutable raw node，并链接 attemptId、artifact hash、context manifest hash。
- Compress：只在明确的 subgoal boundary 生成 summary envelope，列出覆盖 node ids、保留的 constraints、未解决冲突和下一 action；原始节点永不删除。
- Maintain：确定性 schema/依赖检查先运行，再由 verifier 检查 summary 是否覆盖 required records；失败 summary 进入 `candidate`，不得进入 active path。
- Revise：以目标 boundary 的上下文创建新的 execution snapshot/branch，并将 active pointer 指向新分支；旧路径标 `inactive/error`，新尝试使用新的 branch/attempt id。不得回写或删除已提交的 `CURRENT`、科学 snapshot 或历史证据；`CURRENT` 只能通过新的 revision/child snapshot 延续 parent lineage。
- Select：仍使用 worktree 的 required/opposing/conflict closure；active path 只是候选，不能绕过 scope/access/stale 检查。

引入 AgentFold 的“latest interaction 完整、历史按连续范围折叠”：最近一个 step 不压缩，完成子任务后才折叠；每次折叠记录前后 token、被覆盖范围和 verifier verdict。这样可同时实现 long-run token bounded 与执行分支修订。

### P1-B：跨 run/model 的 procedural playbook

在 run-scoped memory 之外增加显式 `project/model playbook`，分离：

- validated recipe：脚本、命令、依赖、硬件、输入/输出契约和验收命令；
- dead end：错误根因、修复、适用版本、禁止重试条件；
- raw trace：完整 attempt/日志引用，供审计和重新抽取；
- confidence/lifecycle：candidate → validated → disputed/invalidated。procedure 提升必须通过独立 fixture 或语义成功验证（复现所声明行为并检查输出契约）；单个成功 receipt、agent 自述或单独人工判断都不足以升级。验证结果必须引用独立 fixture/validator、环境 fingerprint 与对应 attempt hashes。

这对应 Auto-RecSys 的 Execution Evolution Loop，但补上其自承认的缺口：playbook update 不能只靠 agent 判断。recipe 必须引用独立 validator/fixture 的语义成功结果及对应 commit/job/metric hashes；版本或环境 fingerprint 改变时自动降级并要求 re-validation。Idea Evolution Loop 只读取 validated result 和明确 unknown/failed outcome，不能把 procedural success 当科学支持。

### P1-C：资源与预算的长程策略

当前 request ledger 的 token budget 很好地防止一次 run 越界，但不表达“外部 GPU job 已花多少、未来还要保留多少”。扩展 reservation 为多维资源（LLM token、GPU-hour、storage、provider quota），用 `reserved/committed/released/unknown` 四态；unknown 不自动释放，等 reconciler 确认。每个 cycle 在 dispatch 前保留 recovery budget，防止最后一次调用把 run 卡在没有钱生成 handoff 的状态。

## 故障注入验收矩阵

每项至少重复 20 次，并比较无注入对照；所有断点都需检查 journal hash、CURRENT hash、ledger totals、external job count、最终 evidence lineage。外部作业“零重复”只适用于后端同时支持幂等提交与可查询/对账；否则预期是 unknown 安全暂停，而不是 exactly-once 承诺。

| 注入点 | 预期恢复行为 | 失败判据 |
|---|---|---|
| `saveState` 前/后、`appendEvent` 前/后 | 重启后 event journal 重建一致 runtime view；若 transition 不完整则重做 deterministic view，不重复 LLM/external side effect | state.phase 与 event phase 无法解释，或出现重复 step result |
| request reservation 后、provider call 前 | reservation 可重放；同一 request id 返回同一 reservation，不重复扣费 | committed/reserved totals 不守恒 |
| provider submit 前、返回 job id 后、receipt 写入前 | 对支持 provider-side idempotency 和 query 的后端，reconciler 用 idempotency key 查询；已创建 job 只 adopt，不重提。后端不支持这些能力时，结果保持 unknown 并暂停，不自动重提 | 在具备上述后端能力时一个 logical attempt 出现 >1 external job；或不具备时未经人工确认就重提 |
| worker 运行中进程/主机崩溃 | lease 过期；先 query，completed 复用 artifact，failed 按 policy retry，unknown 暂停 | 未查 provider 就 redispatch，或 unknown 被发布为 evidence |
| stage output 写入前/后、marker 写入前/后 | output 必须 hash/validate 后标记 succeeded；半写文件 quarantine 并重建 | marker 存在但 output 缺失/哈希不符 |
| `CURRENT` commit 后、runtime-decision checkpoint 前 | 从 `CURRENT` materialize decision/report，不再次调用 supervisor | 新 LLM decision 覆盖 canonical decision |
| context manifest 写入中、依赖升级后 | manifest hash 失配或 stale dependency 明确失败；重新 assemble 新 call id | 旧 context 静默继续送给 actor |
| 两个进程/两台服务器同时 resume | 一个 fencing token 获得 run lease；另一个只读/等待 | 同 cycle 两次 planner/worker dispatch |
| human approve/reject 与 job callback 乱序 | event order 和 precondition 决定可接受转移；过期信号进入 dead-letter | 过期 approve 改写新 snapshot |
| token/GPU budget 在 dispatch 前后耗尽 | 保留 handoff/recovery 预算；run 进入 PAUSED 并记录缺口 | 预算耗尽但无可执行恢复说明，或越过 global cap |

### 通过门槛

- 对支持 provider-side idempotency/query 的后端，0 个重复 external job（同一 logical attempt）；对不支持的后端，0 个 unknown 被自动重提，且每个都进入暂停/人工对账；另须 0 个未解释的 ledger token、0 个 stale context 被 dispatch。
- 注入后最终 canonical snapshot 与无注入对照的前缀字节相同，或出现明确的新 revision；不得静默覆盖历史。
- completed receipt 至少一次恢复成功；unknown receipt 至少一次安全暂停并在人工提供 provider receipt 后 adopt；两者都不能靠删除文件通过。
- 运行可从任意 phase 生成 handoff：`current snapshot/hash`、`active attempt`、`next action`、`blocked reason`、`budget remaining`、`required human/provider input`。

## 评测与限制

建议建立三个层次：

1. **Runtime correctness**：上述故障注入和跨进程 race；指标是 duplicate rate、lost-progress rate、time-to-reconcile、lease fencing violations。
2. **Context/memory quality**：固定任务轨迹，比较 full-history、现有 record selection、active-path folding；指标是 required-record recall、stale rejection precision、summary verifier pass rate、token/step、错误分支污染率。
3. **Long-horizon capability**：按 METR 给每个任务做专家时长标注，报告 50%/80% completion horizon，同时固定 provider/model/prompt；另报告人工分钟数、恢复次数和成本。科研任务还要有证据有效性与 provenance gate，不能只看最终文本。

限制必须公开：MemGPT/Reflexion/Voyager 的实验环境与本项目科学实验不同；AgentFold、DeepAgent、MAGE 是近期论文/预印本，结果可能依赖特定 backbone、训练集和 benchmark；Auto-RecSys 是 2026-09-10 v1 的工程论文，31 次迭代的 fix-rate 是观察性结果，且作者承认 playbook 缺少正式 validation gate；Anthropic 内容是官方工程经验；Temporal 内容是供应商文档和语义参考。所有“应采用”的内容属于设计推断，不是这些来源已证明的科研效果。

## 来源核验清单

- 方法/实验原文：MemGPT、Reflexion、Voyager、AgentFold、DeepAgent、MAGE、METR、Auto-RecSys，均以 arXiv 页面日期和版本为准。
- 工程实践：Anthropic 两篇文章，发布日期分别为 2025-11-26 与 2026-03-24。
- Durable workflow：Temporal 官方文档强调 event history replay、Activity timeout/retry、丢失 task 依赖 timeout 及 activity 幂等；本报告借其语义，不声称仓库已集成 Temporal。
