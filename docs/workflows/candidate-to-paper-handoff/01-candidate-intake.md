# 01 — CANDIDATE INTAKE

目标：把人类写的模糊 idea（`candidate.md`）变成带稳定 ID 的机器可读 `candidate.json`，作为全链四段 ID 的根。

## 输入

`candidate.md`，格式与 `../../../examples_articles/*/candidate.md` 一致：

```markdown
# Candidate

## Direction
<一句模糊方向>

## A-priori ideas（先验、无证据）
1. ...
2. ...
```

约束：只允许方向 + 先验猜测；**禁止**数字、论文结论、ground-truth 链接（保持“零证据人类输入”语义）。

## 步骤

1. 读取 `candidate.md`；缺 Direction → FAIL。
2. 生成 `candidate_id = "cand-" + 4 hex`（代码生成，LLM 不写 ID）。
3. 写 `candidate.json`：

```jsonc
{
  "candidate_id": "cand-3f9a",
  "direction": "<Direction 原文>",
  "a_priori_ideas": ["...", "..."],
  "created_at": "..."
}
```

4. 记录 `candidate_id` 到 `RUN_STATE.md`，后续模块必须引用。

## Gate

- `candidate.json` schema 合法且 `direction` 非空；否则 FAIL。

## 产出

- `<run_dir>/candidate.json`
