# 基于 DSH 生态的可替换内容与替换 Plan

> 核心原则：**效率优先**。
> 只做能实际减少失败、减少重复计算、提升可恢复性的 DSH 适配；
> 不为“看起来原生”而引入额外复杂度和性能开销。

---

## 0. 什么是“效率优先”

1. 能确定性生成的，不用 LLM 重复调用。
2. 能本地修复解析的，不重跑昂贵 subagent。
3. 能轻量状态恢复的，不引入重编排框架。
4. 只有 DSH 原生能解决真实问题时才替换。
5. 每次替换都要有可量化收益。

---

## 1. 可替换内容总览（效率优先级）

| 当前自定义内容 | DSH 原生替代 | 优先级 | 收益 |
|---|---|---|---|
| 自研 subagent 超时/终止 | DSH `wait_agent` + continuable | P0 | 防止假 FAILED、允许长任务继续 |
| JSON / structured parse 不健壮 | 本地解析修复 + 错误回退 | P0 | 避免重跑，保证流程稳定 |
| `SubagentRoleAgentProvider` | `dsh-tool-subagent` + `dsh-subagent` | P0 | 生命周期交给 DSH，减少自研维护 |
| 长任务实验 | `startContinuable` + durable session | P0 | 可恢复，避免整体重跑 |
| 自研 run state / resume | `dsh-session` / persistence | P1 | 仅有在“确实需要跨进程恢复”时做 |
| 自定义 checkpoint | DSH session checkpoint | P2 | 目前阶段性 checkpoint 已够用 |
| human review | DSH ask-user | P2 | 现有轻量实现效率也高 |
| roles / prompt 分发 | DSH skill | P2 | 收益不确定，先不做 |
| goal / 循环驱动 | DSH goal | P3 | 会改变核心流程，慎用 |
| workflow 多代理 | DSH workflow | P3 | 当前固定流程更可控 |
| 项目设置 | DSH settings | P3 | 现有 YAML 足够 |
| 文件 / workspace | DSH fs / storage | P3 | 无必要不迁移 |

---

## 2. 分阶段 Plan（效率优先）

### Phase 0：只做“低成本高收益”适配（不重写流程）

```text
TODO（已完成或进行中）：
- DSH subagent 生命周期适配 ✅
- research-worker 迁移到 startContinuable ✅
- structured / JSON parse 修复（下一步优先）
```

原则：

- 先确保流程稳定，不引入额外代理；
- 每一步都要能减少重跑或提高恢复能力。

### Phase 1：JSON / structured 可靠性（最高性价比）

- 统一 `tryParse → extract → repair → fallback`
- 失败时保留原始输出，不静默重跑
- 如果修复后仍失败，只在该作用域重试 1 次
- 避免因一次格式错误导致整个长流程重跑

### Phase 2：仅在有真实需求时引入 DSH 强基础设施

只有在以下情况才做：

- 需要跨进程恢复长任务；
- 需要 DSH UI 原生管理子代理；
- 自研状态机成为维护瓶颈。

才考虑：

- `dsh-session` / persistence
- `dsh-tool-subagent-control`
- `dsh-jobs`

### Phase 3：暂不做的替换（观望）

- DSH Skill 化
- DSH Goal 循环驱动
- DSH Workflow 多代理编排
- 完全删除 `SubagentRoleAgentProvider`

原因：

- 当前固定研究循环更可控；
- 效率收益尚未验证；
- 过度适配会引入额外上下文和不确定性。

---

## 3. 效率指标

每次适配后衡量：

| 指标 | 目标 |
|---|---|
| 子代理重跑次数 | 下降 |
| 因 JSON 解析失败导致的重跑 | 归零 |
| 长任务误 FAILED | 归零 |
| 可断点恢复阶段 | 增加 |
| 自定义基础设施代码量 | 不增加，优先减少 |
| 单次研究总耗时 | 不因适配而上升 |

只有满足这些指标，才继续下一阶段适配。

---

## 4. 最终目标形态（效率优先版）

```text
DSH Agent（原生）
  ├── Goals / Plan Mode
  ├── Skills（autoresearch 各阶段）
  ├── Native Subagents（one-shot / continuable）
  ├── Native wait/send/list/interrupt
  ├── Session Persistence（run 状态）
  ├── User Questions（human review）
  └── Jobs（长任务后台执行）

@athena/autoresearch
  └── 只保留领域逻辑：
        paper survey / wiki / knowledge graph
        experiment design / execution
        evidence chain
        paper writing prompts
```

---

## 5. 风险

1. 不能一次性全部替换，先 P0/P1；
2. 每个替换保留领域数据文件兼容；
3. 长任务迁移先验证 continuable + resume 取结果闭环；
4. DSH session 替换 run state 前确认旧数据兼容；
5. TODO 调查完成后再决定是否彻底删除 provider。
