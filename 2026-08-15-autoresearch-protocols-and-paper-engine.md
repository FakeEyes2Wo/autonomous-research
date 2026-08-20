# Paper Engine 规则（收敛摘要）

日期：2026-08-15 起草；2026-08-20 收敛
状态：阶段协议部分已被取代；**Paper Engine 规则仍有效**，由 records-paper / candidate-to-paper handoff 引用。

## 模板

- 官方模板 curl 拉取，URL 白名单，失败回退缓存；无缓存置 WAITING。
- style 文件只读；LLM 只写 `main.tex` / `sections/*.tex` / `bibliography.bib`。

## 编译

- `latexmk` / `tectonic` / `pdflatex`；输出 PDF 与 stdout/stderr 原文日志。
- 编译失败自修复不设轮次，只受项目时间限制；每次尝试回传控制台输出。
- 降级链：Overleaf → local TeX → Markdown-only。

## Reviewer

- `compile_ok` 优先；不过进入编译修复循环，不消耗内容修订轮数。
- 内容闸：evidence 可追溯、模板合规、阴性结果完整、claim 方向一致、不过度声明。
- 所有拒绝必须带 `blocking_factor` 与证据。

## Packaging

```text
packaging/<run_id>/
  paper.pdf / paper_draft.md / paper_sources.zip
  evidence_chain.json / trace_audit.json
  审查报告 + 复现包 + FINAL_REPORT.md（或 FAILURE_REPORT.md）
```

## 泛化边界

不再绑定 Athena 内部类型；证据输入统一为 `evidence_chain.json`，论文引用统一为 `E:<experiment_id>` / `B:<baseline_id>` 标签。
