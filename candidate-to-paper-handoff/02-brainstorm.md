# 02 — BRAINSTORM

目标：把 `candidate.json` 的模糊方向展开成 1–3 个可执行研究方向。双模运行，产物统一为 `BRAINSTORM.md`。

## 模式选择

| 模式 | 触发 | 行为 |
|---|---|---|
| interactive | `AUTO_PROCEED=false` 或 `stdin interactive` | 按 brainstorming skill：一次一问 → 2–3 方向带权衡 → 用户选定 |
| autonomous | `AUTO_PROCEED=true` | 发散 5–10 方向 → 每个做 novelty/feasibility/evidence 三方批评 → 收敛 1–3 |

## 输入

- `<run_dir>/candidate.json`
- 文献证据：零输入/自治时经子进程调 paper_scout → paper_fetch → paper_markdown → paper_rag；失败降级 web search 或本地 corpus。

## 步骤

1. 读 candidate.json 的 direction 与 a_priori_ideas。
2. interactive：向用户一次问一个问题；给 2–3 方向（含权衡与推荐）；记录用户选择。
3. autonomous：发散 5–10 方向 → 逐方向批评 → 收敛 1–3。
4. 写 `BRAINSTORM.md`：

```markdown
# Brainstorm
## Inputs
- candidate_id: cand-3f9a
- direction / a-priori ideas 摘要

## Directions considered
| id | direction | novelty | feasibility | evidence | chosen |
|---|---|---|---|---|---|
| D1 | ... | ... | ... | ... | yes |
| D2 | ... | ... | ... | ... | no |

## Selected directions
1. ...

## Rejected directions + why
- ...
```

## Gate

- 至少 1 个 `chosen=yes` 方向；否则 FAIL → `FAILURE_REPORT.md`（不硬编方向）。

## 人工闸

`AUTO_PROCEED=false` 时在此暂停，展示 BRAINSTORM.md 等批准。

## 产出

- `<run_dir>/BRAINSTORM.md`
