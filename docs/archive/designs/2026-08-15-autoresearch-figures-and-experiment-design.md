# 论文图与可信实验 / 消融规则（仍有效）

日期：2026-08-15；2026-08-20 保留为领域规则
状态：**仍有效**，被 candidate-to-paper / records-to-paper handoff 引用。

## 论文图（role-aware）

| 图类型 | 生成方式 |
|---|---|
| 实验数据图 | 从 `evidence_chain.json` 确定性生成矢量图，LLM 不得手写数字 |
| 方法/架构图 | 生成 Agent 全权设计；可用 drawio MCP / HTML-SVG / image 打样重建；native-svg 兜底 |
| EDA 图 | **不得进入论文** |

- 结构自检：语法、viewBox、可编辑文本、无外部资源、图标来源白名单。
- 视觉 QA：vision reviewer 评分 ≥4；无 vision 时 self-critique 清单。
- 降级链：drawio MCP → HTML/SVG 代码重建 → native SVG。

## 可信实验（预注册）

1. 实验前冻结：datasets / splits / baselines / metric / direction / seeds / 统计方法 / 表结构（数值后填）。
2. 单一变量；test 只对最终 SOTA 暴露一次。
3. 结果必须可追溯到 dataset、config、seed、metric、source output。
4. 负 / null / 不确定结果保留，不得删除。

## 消融

- 每个被论文主张的组件至少一行 remove/replace 消融。
- 表中数字只来自 evidence，不允许 LLM 编造。
- 消融表由证据确定性生成。

## 泛化边界

`ExperimentDesign` / `ExperimentEvidence` 字段为通用契约，不依赖具体实验平台；平台差异由 Source Adapter 归一为 `evidence_chain.json`。
