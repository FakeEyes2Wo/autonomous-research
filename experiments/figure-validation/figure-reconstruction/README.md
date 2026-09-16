# 图重建最小化验证

验证 08-writing §5 图管线。两个实验组：

| 实验组 | 问题 | 文档 |
|---|---|---|
| `drawio-mcp-test/` | drawio MCP 到底能不能作为第一后端：形状检索、XML 生成、ELK 布局、本地导出、可编辑性 | `drawio-mcp-test/README.md`（含安装与探测） |
| `html-svg-test/` | 代码重建第二后端：单 agent 两阶段描述（plan→rewrite→code）+ reflexion，vision critic 无则 self-critique | `html-svg-test/README.md` |
| `structure_img_data/` + `scripts/render_structure_svgs.py` | 10 个论文级架构图 prompt 的最小渲染验证 | 脚本读 md prompt → native-svg 渲染 → PNG + 结构自检 + report.json |

## 固定输入

`drawio-mcp-test/fixture.md`：一张固定复杂图描述（`kind=architecture`、`estimated_elements=12`、`needs_icons=true`）与对应 `figure_spec.json`。

所有臂都用同一输入，产物落 `drawio-mcp-test/runs/<date>/<arm>/`。

## 通用验收

1. 结构自检：XML/SVG 语法、viewBox、可编辑文本节点、无外部资源、图标来源白名单。
2. 视觉分：vision reviewer 对布局/文字/图例/配色可读性打 1–5 分，≥4 通过。
3. 通过标准：
   - drawio MCP 可用且视觉分 ≥4 → 可作第一后端。
   - 不可用或视觉分 <4 → HTML/SVG 代码重建接替。
   - 两者都失败 → native-svg 兜底；raster 目标仅作视觉参考。
4. 任何 FAIL 追加 `FAILURES.md`。
