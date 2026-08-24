# Autonomous Research System 设计文档

[简体中文](README.md) | [繁體中文](README.zh-TW.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Autonomous Research System：从 candidate / 实验记录到可追溯论文包的自动化研究控制平面。复用 DSH 的 Agent、Subagent、Goal、Workflow、Tools、Skills、持久化、沙箱、审批与模型路由；只新增研究控制语义。

## 当前执行基线

| 文档 | 内容 |
|---|---|
| [2026-08-20-autoresearch-ml-control-plane-design.md](2026-08-20-autoresearch-ml-control-plane-design.md) | **唯一实现基线**：AutoResearchService + 最小状态 + 动态 rubric + 自主迭代 + Domain Profile（ML v1） |
| [2026-08-16-candidate-to-paper-design.md](2026-08-16-candidate-to-paper-design.md) | candidate → paper 全流程（默认入口） |
| [2026-08-16-records-to-paper-design.md](2026-08-16-records-to-paper-design.md) | 已有实验记录 → paper（第二入口） |
| [2026-08-16-idea-generation-design.md](2026-08-16-idea-generation-design.md) | brainstorm + 候选生成 + 门禁 |
| [2026-08-15-hypothesis-local-pool-design.md](2026-08-15-hypothesis-local-pool-design.md) | HypothesisPool 生命周期索引 |
| [2026-08-15-autoresearch-figures-and-experiment-design.md](2026-08-15-autoresearch-figures-and-experiment-design.md) | 论文图、可信实验、消融规则 |

## 代码实现

- [packages/autoresearch/](packages/autoresearch/)：最小闭环 DSH 插件（TypeScript），实现 `idea → plan → work → evidence → decide → paper | failure report`，复用 DSH Agent/Subagent 系统。
  - 无头运行：`cd packages/autoresearch && npm run run:headless`

## Handoff（领域流程执行手册）

| 组 | 文件 |
|---|---|
| candidate→paper | [candidate-to-paper-handoff/](candidate-to-paper-handoff/)：00 总控 + 01–10 各阶段 |
| records→paper | [records-paper-handoff/](records-paper-handoff/)：00 总控 + 01、02、04、05（含数据契约；写作复用 candidate 08） |
| 最小验证 | [verify_exp/](verify_exp/)：图管线、drawio MCP、pure LLM / drawio 结果 |

## 历史 / 延期参考（非实现基线）

- `2026-08-15-autoresearch-ts-plugin-design.md`：交付物决策与三条论文路径仍有效；旧框架已收敛。
- `2026-08-15-autoresearch-detailed-design.md`：历史实现级设计，保留恢复与质量闸原则。
- `2026-08-15-autoresearch-protocols-and-paper-engine.md`：Paper Engine 规则仍有效；阶段协议已由 2026-08-20 取代。
- `2026-08-15-autoresearch-generalization-and-minimalism.md`：M4 泛化参考。

## 关键决策

1. 不实现第二套 Agent Runtime / EventBus / DAG / 任务队列。
2. ML v1 只实现一个主要 `AutoResearchService` + 最小 state/events。
3. 实验执行方统一为 **Experiment Provider**（当前实现 Athena）；Core 不依赖其私有类型。
4. 证据契约统一为 `evidence_chain.json`；论文引用统一为 `E:`/`B:` 标签；四段 ID：`candidate_id → hypothesis_id → experiment_id → paper tag`。
5. 实验前动态生成并冻结 rubric；失败、DRAW、负结果不得删除。
6. 论文三路径：Overleaf → local TeX → Markdown-only；编译修复只受时间预算。
7. 通用化时机：第二个真实领域接入后提炼最小 Domain Profile，不预建空壳接口。
