# 08 — WRITING（论文写作方向详细设计）

目标：把 `claims.md + outline.md + evidence_chain.json` 写成可编译、可追溯、可审的论文初稿。本文件是 writing stage 的完整执行规范；records-paper 独立路径复用其写作纪律。

## 1. 执行模型：混合 writer

- 单一 writer 会话执行 W0–W2（骨架、notation、矩阵确认）。
- 之后逐 section 写（W4）；每节写前带“已写节摘要 + 全局 notation + 该节 prompt”。
- 全部节写完，由**同一 writer 会话**做一致性 pass（术语/记号/贡献句对齐）。
- 单节失败：最多重试 3 次，每次带 script 报告 + reflexion 意见；仍失败 → 留 `% SECTION_BLOCKED: <section> — <reason>` 原地标记并继续，最终 gate 拦截。

## 2. 写作前冻结：Claims-Evidence Matrix

### 2.1 生成

08 开始前由脚本从 `claims.md` 的 mapping 块 + `evidence_chain.json` 确定性生成并冻结 `claims_evidence_matrix.json`。写作期间只读；需要改映射回 07。

### 2.2 schema（通用 AutoResearch，不绑定 Athena）

```jsonc
{
  "matrix_version": 1,
  "run_id": "ctp_...",
  "claims": [
    {
      "claim_id": "claim-1",
      "candidate_id": "cand-3f9a",
      "hypothesis_ids": ["hyp_..."],
      "experiment_ids": ["exp_hyp_..."],
      "baseline_ids": ["B-..."],
      "admission_label": "SUPPORTED",
      "allowed_wording": "<claims.md 的 final_claim 原文>",
      "metrics": {                       // 通用 metrics map；不同领域字段不同
        "primary": { "value": 8468.7333, "direction": "maximize" },
        "secondary": {}
      },
      "evidence_refs": { "report": "sha256:..." },
      "domain_extra": {                  // 可变字段：不同领域自行扩展
        "environment": "kaggriculture",
        "seeds": [1, 2, 3]
      }
    }
  ]
}
```

规则：

- 核心字段固定：`claim_id/candidate_id/hypothesis_ids/experiment_ids/baseline_ids/admission_label/allowed_wording/evidence_refs`。
- `metrics` 是任意 map；写作数字只能来自这里。
- `domain_extra` 为领域可变字段，由 07 按需填写，不参与 verify 判定。
- 表外数字禁止；写作中需要新数字 → 回 07 补 mapping，重生成矩阵。

## 3. Prompt 组织

```text
prompts/writing/
  common.md          # 总体规则：证据标签、五遍 pass、术语一致、匿名化
  method.md
  experiments.md
  results.md
  limitations.md
  related_work.md
  introduction.md
  conclusion.md
  abstract.md        # abstract 最后调用
```

每个大标题一个 prompt 文件；`common.md` 被所有 section 引用。

## 4. 写作管线 W0–W8

### W0 冻结
读 contract 断言清单；确认 claims.md 无 NEEDS_CONFIRMATION。

### W1 模板与骨架
模板 curl（回退缓存/内置）；编译路径 `overleaf → local → none`；备份旧 paper/。

### W2 矩阵与 notation
读冻结的 `claims_evidence_matrix.json`；写 `math_commands.tex` + 术语表。

### W3 图与表（详见 §5）

### W4 逐节写作（顺序固定，abstract 最后）

| 顺序 | 节 | 软预算 | 关键规范 |
|---|---|---|---|
| 1 | Method | ~1.5 页 | 来自 intervention/report 原文；定义术语与记号 |
| 2 | Experiments | ~2.5 页 | setup → 主结果表 → 消融；数字打标签 |
| 3 | Results | ~1.5 页 | 只写 evidence 支持的结论；按 admission label 控制措辞强度 |
| 4 | Limitations | ~0.5 页 | negative claims 全部出现；范围限定 |
| 5 | Related Work | ~0.75–1 页 | 按 scaffold 分类；每段结尾定位本文 |
| 6 | Introduction | ~1 页 | hook → gap → approach → CONTRIB-* → 最强者结果前置 |
| 7 | Conclusion | ~0.5 页 | 复述贡献 + future claims |
| 8 | Abstract | 150–250 词 | 最后写；what/why hard/how/evidence/strongest result；1 个具体数字 |

- 每节写完追加 `paper_draft.md` 对应段（过程稿）；**终稿用 pandoc 从 LaTeX 转 md 覆盖**（pandoc 缺失则保留过程稿，非必须步骤）。
- 软预算超标在 refinement 阶段按模板压缩。

### W5 证据标签

```latex
% evidence: E-exp_hyp_26fc90321336
The agent achieves a mean final bank balance of 8468.7.
```

- `E:`/`B:` 标签与数字同行或 ±1 行；矩阵里没出现的数字 → `% DATA_NEEDED:` 注释。

### W6 bib（预冻结 + 按需请求）

1. 写作前（W1.5）bib worker 按 `related_work_scaffold.md` 检索并验证，产出冻结 `bibliography.bib` + `bib_keys.md`（`key: 一句话标签`）。
2. writer 上下文**只放 `bib_keys.md`**，不放 bib 全文。
3. 需要新文献：writer 把请求追加到 `bib_requests.md`（一句话为什么需要 + 候选 title/DOI）。
4. bib worker（独立调用）验证 DBLP→CrossRef→`[VERIFY]`，更新 `bibliography.bib` 与 `bib_keys.md`；writer 下一轮拿增量。
5. 程序自动解析冻结 `bibliography.bib`/`references.bib`，把每个条目的 PDF 下载到 `<run>/evidence/<bibkey>.pdf`，并生成 `evidence/citations.json`；任一条目下载失败则 gate 失败。
6. 终稿跑 dead-entry 清理（只含被 cite 条目）。

### W7 质量 pass（脚本 + writer）

脚本检查（gate 或报告）：

| # | 检查 | 方式 | 性质 |
|---|---|---|---|
| 1 | 数值标签：E:/B: 存在 + 值与矩阵一致 | verify-trace 增量版 | gate |
| 2 | 占位符/未完成：DATA_NEEDED/TODO/FIXME/TBD/SECTION_BLOCKED | grep | gate |
| 3 | cite 存在性：每个 `\cite` 有 bib 条目且被引 | bib 卫生脚本 | gate |
| 4 | clutter 词表：delve/pivotal/landscape/tapestry/underscore… | 词表 grep + 计数 | 只报告 |
| 5 | 句长：>40 词句子列表 | 正则粗分句 | 只报告 |
| 6 | 模板合规：section 顺序/匿名/页数 | 模板规则 | gate |
| 7 | 引用 PDF 已下载：`evidence/citations.json` 无 failed 且每个被引 key 有 PDF | 下载脚本 + manifest | gate |

writer 自检（每节，报告 4/5 作为输入）：

- 主动语态；banana rule（关键词一致）；数字与引用自检；反向大纲（段落首句连读成文）；贡献句与 CONTRIB-* 一一对应。

### W8 首轮编译
latexmk/tectonic/pdflatex；日志原文保存；失败进 09 编译修复循环（不限轮，只受时间预算）。

## 5. 图管线（详细）

### 5.1 分流判据

- outline 给每张图 `FigureSpec`：`{name, kind, estimated_elements, needs_icons, caption_src}`。
- `kind ∈ {flow, relation}` 且 `estimated_elements ≤ 8` → **直接 SVG 代码**。
- `kind ∈ {architecture, method, ablation_overview}` 或 `estimated_elements > 8` 或 `needs_icons=true` → **打样-重建**。

### 5.2 直接 SVG（简单图）

writer/图 agent 直接写 SVG → 结构自检（XML 语法/viewBox/文本可编辑/无外部资源）→ render → 通过即用。

### 5.3 打样-重建（复杂图）

```text
方法/架构描述
  → [可选] image model 生成 raster 视觉目标（仅目标，不是终稿）
  → 矢量重建，后端优先级：
       1. drawio MCP（可用时）：LLM 描述 → drawio XML → render SVG/PDF
       2. HTML/SVG 代码重建：editable text/shapes/connections
       3. native-svg 内置兜底
  → render（SVG → PNG/PDF）
  → QA（§5.4）
  → 不通过：把视觉差异反馈给重建 agent，迭代 ≤3 轮
  → 仍不通过：回退 raster 目标（保留原图）或 native-svg，并在图注记录 fallback
```

### 5.4 美观 QA = 结构自检 + 视觉比对

1. 结构自检（脚本）：SVG/XML 合法、viewBox、可编辑文本、无外部资源、图标来源白名单。
2. 视觉比对（vision reviewer）：重建图与 raster 目标并排，逐项检查布局/文字/图例/配色可读性，给 1–5 分；≥4 通过，<4 反馈差异重画。

### 5.5 图标资源规则

- 几何框/箭头/文字：代码自绘。
- 图标允许：白名单宽松许可集（MIT/ISC/CC0，如 Lucide/Excalidraw 库）；**image model 只许生成图标（icon），不许生成整图**；AI 图标需记录来源与许可，进 `figures/assets_manifest.json`。
- 无许可标注的素材禁入。

### 5.6 最小化图管线验证

图管线的每次改动先在 `../../../experiments/figure-validation/figure-reconstruction/` 跑最小验证：

- 同一张复杂架构图：drawio MCP / HTML-SVG / native-svg 三后端各出一份产物。
- 记录：是否可编辑、视觉评分、渲染尺寸、降级路径是否触发。
- 验证通过标准与实验矩阵见 `../../../experiments/figure-validation/README.md`。

## 6. 写作工具边界

- 可写：`main.tex`、`sections/*.tex`、`tables/*.tex`、`bibliography.bib`、`bib_requests.md`、`figures/`、`paper_draft.md`。
- 只读：模板 style、`claims_evidence_matrix.json`、claims/outline/contract。
- 每节一次一个文件；跳过节必须带 `% SECTION_BLOCKED` 标记。

## 7. Gate

- 脚本检查 1/2/3/6/7 全过；4/5 报告落盘。
- 所有 CONTRIB-* 有正文声明与标签；无 `SECTION_BLOCKED` 残留。
- 首轮编译结果落盘。

## 8. 产出

- `paper/` 源文件 + `paper_draft.md`
- `claims_evidence_matrix.json`（冻结副本）
- `bibliography.bib` + `bib_keys.md` + `bib_requests.md`
- `evidence/citations.json` + `evidence/*.pdf`
- `figures/assets_manifest.json`
- 首轮编译日志
