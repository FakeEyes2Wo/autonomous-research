# verify_exp — 最小化验证实验

本目录存放 design 的**最小化验证实验**：任何写进 handoff 的机制，在正式实现前先用最小代价验证可行性。当前覆盖：

| 子目录 | 验证对象 | 问题 |
|---|---|---|
| `figure-reconstruction/` | 08-writing §5 图管线 | drawio MCP / HTML-SVG 代码重建 / native-svg 三后端，哪个能满足“可编辑 + 好看 + 可自动验收” |
| `figure-reconstruction/drawio-mcp-test/` | drawio MCP 第一后端能力 | 形状检索 / XML 生成 / ELK 布局 / 本地导出 / 可编辑性 / 降级路径 |
| `figure-reconstruction/html-svg-test/` | HTML/SVG 代码重建第二后端 | 直接 SVG / HTML→PDF / 两段式 SVG 三臂 + raster 目标比对 |
| `structure_img_data/` | 10 个论文级架构图 prompt | 固定输入 |
| `structure_img_out/` | pure LLM SVG 生成（Agent） | 最新一次 LLM→SVG→PNG 验证结果 |
| `pure_LLM/` | pure LLM 结果存档 | 10/10 LLM 生成的 SVG+PNG+report |
| `drawio_mcp/` | drawio MCP 绘制结果（AI 全权 + reflexion） | 10/10：search_shapes 候选图标 → 生成 Agent 自行布局/分组/选图标 → Critic Agent 查图标匹配与版面 → REVISE 反馈重画 ≤3 轮 → create_diagram + CLI 导出 |

## 通用规则

1. 每个验证实验必须有：输入、步骤、产物、通过标准、失败记录。
2. 验证产物留在各自子目录（SVG/PNG/PDF + 报告 md），不进入 paper 目录。
3. 验证不通过：记录原因到 `FAILURES.md`，并在 08-writing 相应小节标注“未验证”。
4. 外部依赖（drawio MCP、vision reviewer）不可用时，验证其**降级路径**而非跳过。

## 目录约定

```text
verify_exp/
  README.md
  structure_img_data/           # 10 个 prompt（固定输入）
  structure_img_out/            # pure LLM 最新验证产物（svg/png/llm.txt/report.json）
  pure_LLM/                     # pure LLM 结果存档
  drawio_mcp/                   # drawio MCP 结果（drawio/llm.txt/mcp.json/report.json）
  scripts/
    render_structure_svgs.py    # Agent → SVG → PNG 验证
    render_structure_drawio.py  # Agent → drawio XML → hosted drawio MCP 验收
  figure-reconstruction/
    README.md
    drawio-mcp-test/            # 第一后端实验设计（含安装与探测）
    html-svg-test/              # 第二后端实验设计（含 styles prompt）
```
