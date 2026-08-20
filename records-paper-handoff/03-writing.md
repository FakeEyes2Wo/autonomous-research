# 03 — WRITING

按 outline 写 LaTeX + Markdown draft；数字可机械追溯。详细写作设计见 `../candidate-to-paper-handoff/08-writing.md`。

## 要点
1. 模板 curl 拉取回退缓存；编译路径 `overleaf→local→none`；latexmk/tectonic/pdflatex。
2. Claims-Evidence Matrix：每个数字对应 `experiment_id/baseline_id + value + evidence_refs`；矩阵外禁止。
3. 逐 section 写并同步 draft；abstract 最后写。
4. 图 role-aware：数据图确定性矢量；方法图 raster 打样→代码重建 SVG/HTML，失败保 raster；native-svg 兜底；EDA 图禁入。
5. 标签 `% evidence: E-...`/`B-...`（±1 行）；无证据写 `DATA_NEEDED`，绝不编造。
6. 五遍 pass：clutter/AI-ism、语态、句长、关键词一致、数字引用。
7. bib：DBLP→CrossRef→`[VERIFY]`，只含被引条目。

## 铁律
备份旧 paper/；每节一个文件；匿名化按模板；`DATA_NEEDED/TODO/FIXME` 进入 REVIEW 前清空。
