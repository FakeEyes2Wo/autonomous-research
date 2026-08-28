# 基于 DSH 生态的可替换内容与替换 Plan

> 核心判断：保留研究领域逻辑，替换基础设施层。

---

## 1. 可替换内容总览

| 当前自定义内容 | DSH 原生替代 | 优先级 |
|---|---|---|
| `SubagentRoleAgentProvider` | `dsh-tool-subagent` + `dsh-subagent` | P0 |
| 自定义等待/超时 | `wait_agent` / `send_message` / `list_agents` | P0 |
| 自定义 run state / resume | `dsh-session` + `dsh-session-persistence-jsonl` | P0 |
| 自定义 checkpoint | `dsh-session-checkpoint-policy` + `dsh-session-query` | P1 |
| 自定义 human review | `dsh-tool-ask-user` / `dsh-user-questions` / `dsh-user-approval` | P1 |
| 自定义 auto mode | DSH permission / approval presets | P1 |
| 自定义 roles / prompt 分发 | `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill` | P1 |
| 自定义后台实验任务 | `dsh-jobs` / `dsh-tool-jobs` / continuable subagent | P1 |
| 自定义 goal / 循环驱动 | `dsh-goal` + `dsh-tool-goal` + `dsh-command-goal` | P2 |
| 自定义 plan / 审批 | `dsh-plan-mode` | P2 |
| 自定义项目设置 | `dsh-settings` + `dsh-settings-file` | P2 |
| 自定义多 agent 协作 | `dsh-workflow` + `dsh-tool-workflow` | P2 |
| 自定义文件/workspace | `dsh-fs` / `dsh-workspace` / `dsh-storage` | P3 |
| 自定义产物展示 | `dsh-client-ui-deliverables` / session export | P3 |

---

## 2. 分阶段 Plan

### Phase 0：能力调查（不写代码）

```text
TODO：
- 验证 dsh-tool-subagent continuable 是否能替代 RoleAgentProvider
- 验证 wait_agent timeout 是否只是父代理等待
- 验证 list_agents / send_message / interrupt_agent 是否覆盖长任务管理
- 验证 dsh-session-persistence 是否能存储 run state
- 验证 dsh-skill 是否能挂载 brainstorm / paper 流程
```

产出：DSH 能力映射表 + 可删除代码清单 + 保留领域逻辑清单。

### Phase 1：替换 subagent 编排层

- 长任务使用 continuable / background；
- 主 Agent 使用原生 subagent + wait + list + interrupt；
- 保留 `RoleName → prompt` 映射。

### Phase 2：用 DSH Session 替代自研状态机

- `state.json` → DSH session；
- `events.jsonl` → session log；
- run phase / checkpoint → session checkpoint；
- 保留领域数据：research_tree、hypothesis_pool、paper_wiki、evidence_chain。

### Phase 3：把研究流程变成 DSH Skill

```text
skills/
  autoresearch-paper-survey/
  autoresearch-direction-select/
  autoresearch-frontier-miner/
  autoresearch-experiment-runner/
  autoresearch-paper-writer/
```

每个 skill 包含触发条件、prompt、工具、输出规范、知识库。

### Phase 4：用 DSH Goal 替代研究循环驱动

替换 `ResearchRunner` 的 while 循环、maxCycles、supervisor decide。

### Phase 5：替换 Human Review 与审批

使用原生 ask-user / user-questions / approval / plan mode。

### Phase 6：删除自研代码并迁移数据

确认每个阶段验证通过后，再删除自研基础设施。

---

## 3. 最终目标形态

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

## 4. 风险

1. 不能一次性全部替换，先 P0/P1；
2. 每个替换保留领域数据文件兼容；
3. 长任务迁移先验证 continuable + resume 取结果闭环；
4. DSH session 替换 run state 前确认旧数据兼容；
5. TODO 调查完成后再决定是否彻底删除 provider。
