# AutoResearch 详细设计（收敛摘要）

日期：2026-08-15 起草；2026-08-20 收敛
状态：**历史实现级设计**。包结构、zod 契约与阶段伪代码已由 `2026-08-20-autoresearch-ml-control-plane-design.md` 精简；领域流程见各 handoff。

## 仍被引用且有效的部分

- 阶段产出目录约定（paper/、packaging/、logs/compile/）。
- PaperComposer / Reviewer / Packaging 的行为规则（现由 records-paper 与 candidate-to-paper handoff 承载）。
- 崩溃恢复原则：步骤开始前保存当前 step id；未完成步骤同 id 重试；Provider 失败不得当 gate 通过。
- 质量闸必须给出 `blocking_factor` 与证据，不得静默放行。

## 已被取代

- 固定包目录、服务 class 列表、RunSpec zod、StateStore、PipelineRunner、Stage/Provider/Gate 注册细节。
- 旧测试计划与验收清单 → 见 `2026-08-20` 第 12 节（只测会导致错误研究结论的确定性逻辑 + fake 集成）。

## 泛化边界

所有实验平台相关字段一律以 **Experiment Provider** 抽象出现；证据契约统一为 `evidence_chain.json`，论文契约统一为 `E:`/`B:` 标签与 `trace_audit.json`。
