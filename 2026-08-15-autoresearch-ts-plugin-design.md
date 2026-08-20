# AutoResearch TS 插件设计（收敛摘要）

日期：2026-08-15 起草；2026-08-20 收敛
状态：**已被 `2026-08-20-autoresearch-ml-control-plane-design.md` 取代**。本文只保留仍有效的交付物决策与降级链。

## 仍有效的决策

1. 独立 `@athena/autoresearch` 包，作为 DSH 插件运行；复用 DSH 的 Agent/Subagent/Goal/Workflow/Tools/Skills/持久化/审批/模型路由，不自建 Agent Runtime。
2. 交付物：LaTeX/PDF（模板可选）+ 始终生成的 Markdown draft。
3. 模板：官方模板 curl 拉取，失败回退缓存。
4. 成本：首版只做 token 与时间预算，不接计费。
5. LaTeX 编译失败：不设轮次，只受项目总时间限制；每次尝试回传编译输出。
6. 阴性结果保留，写入 limitations/negative results。

## 论文三条路径（沿用）

| 路径 | 编辑 | 编译 | 输出 |
|---|---|---|---|
| `overleaf` | 本地源同步云端 | 云端编译 | PDF |
| `local` | 本地 LaTeX | latexmk/tectonic/pdflatex | PDF |
| `none` | 只写 Markdown | 无 | draft |

## 已被取代

- 硬编码五阶段 RunSpec / Stage / ProviderRegistry / GateRunner / EventBus 框架 → 收敛为 `AutoResearchService` + handoff + 最小状态文件。
- 原工具清单 → 首版只实现 `run/resume/status/stop` 与 handoff 推进。

## 泛化边界

实验执行方一律称为 **Experiment Provider**；Python Athena 只是首个实现。Core 只消费“执行实验并返回 evidence 引用”，不读取具体实验平台的内部类型与状态格式。
