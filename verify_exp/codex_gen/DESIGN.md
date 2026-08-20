# Codex draw.io MCP 全量生成设计

日期：2026-08-20

## 目标

从零实现一套自包含的 draw.io MCP 图表生成实验，对
`structure_img_data/` 中定义的 10 个论文级架构图输入逐一重新生成图表。
本次新增的程序、输入副本、图表源文件、导出图片、日志和报告全部放在
`codex_gen/` 中，不修改或复用现有生成脚本和既有生成产物。

## 目录结构

```text
codex_gen/
  DESIGN.md
  inputs/                 # 10 个固定 prompt 的自包含副本
  generate.py             # 从零编写的生成、MCP 验收与导出程序
  outputs/
    <stem>.drawio         # 可编辑 draw.io XML
    <stem>.png            # 位图预览
    <stem>.svg            # 矢量图
    <stem>.pdf            # 文档导出
    <stem>.mcp.json       # MCP 调用结果与形状检索摘要
    <stem>.check.json     # XML 和导出检查结果
  report.json             # 10 张图的汇总报告
  FAILURES.md             # 仅在出现失败时记录
```

实施阶段的临时计划或运行记录也只能位于 `codex_gen/`；完成后删除临时计划。

## 生成流程

1. 将 10 个固定 prompt 复制到 `codex_gen/inputs/`，按文件名排序处理。
2. `generate.py` 独立解析每个 prompt 的标题、节点、边、分组和注释。
3. 对每个输入直接连接 hosted draw.io MCP，调用 `search_shapes` 检索候选形状。
4. 程序从零构建可编辑 draw.io XML。每张图采用与语义匹配的布局，同时共享统一的论文图视觉规范：克制配色、清晰层级、可读标签、正交连线和充足留白。
5. 调用 MCP `create_diagram` 验收 XML，并优先保存 MCP 回传的 XML。
6. 使用本地 Draw.io CLI 将 `.drawio` 导出为 PNG、SVG 和 PDF。
7. 写入单图检查结果与总报告；某张图失败时继续处理其余输入，并记录具体失败阶段。

若当前 Windows 环境拒绝执行 Draw.io Desktop CLI，则使用本次在
`codex_gen/generate.py` 中从零编写的原生 SVG 渲染器作为导出降级路径；
SVG 与 `.drawio` 共享同一规格和位置数据，再由 Chrome Headless 输出 2× PNG
和矢量 PDF。此降级不替代 draw.io MCP：每个 `.drawio` 仍必须通过
`create_diagram` 验收。

## 独立性约束

- 不导入、复制或修改 `scripts/render_structure_drawio.py`。
- 不读取 `drawio_mcp/` 或 `structure_img_out/` 的既有图表实现。
- 允许读取固定输入 `structure_img_data/*.md`，但运行时使用的是复制到
  `codex_gen/inputs/` 的副本。
- 除 `codex_gen/` 外不创建或修改任何文件。

## 错误处理

- MCP 连接、`search_shapes` 和 `create_diagram` 使用有限次数重试，并保存错误文本。
- 每张图在调用 MCP 前进行 XML 良构性、根节点、顶点、边和外部资源检查。
- Draw.io CLI 缺失或单格式导出失败不会中断其他图；失败写入单图检查与汇总报告。
- 最终退出码仅在 10 张图均通过结构检查、MCP 验收和三格式导出时为 0。

## 验收标准

- `codex_gen/inputs/` 包含 10 个输入文件。
- `codex_gen/outputs/` 对每个输入包含 `.drawio`、`.png`、`.svg`、`.pdf`、
  `.mcp.json` 和 `.check.json`。
- 10 个 `.drawio` 文件均为良构 XML，包含可编辑文本节点、至少两个可见顶点和至少一条边，且不引用外部图片 URL。
- 10 次 `create_diagram` 均成功。
- 30 个导出文件均存在且非空；PNG 可解码并具有有效宽高，SVG 可解析，PDF 具有有效文件头。
- `report.json` 明确给出每张图的状态以及总通过数；任何失败同时记录在 `FAILURES.md`。

## 论文直接使用标准

- 图形采用克制的科研论文视觉语言：白色背景、低饱和分组色、深灰正文、单一主强调色，不使用装饰性或卡通化素材。
- 全图使用 Helvetica/Arial 兼容字体，标题、分组、节点和注释形成明确字号层级。
- 节点对齐、组框留白和正交连线经过逐图检查；不存在文字截断、节点遮挡、难以辨认的箭头或无意义的大面积空白。
- PNG 以 2 倍缩放导出，适合论文预览与常规排版；SVG 和 PDF 作为首选矢量成稿，可无损缩放。
- 对“正向/风险”“训练/推理”“输入/融合”等语义使用有限的差异化色彩，但保持黑白打印下仍可通过标签和结构理解。
- 10 张 PNG 必须逐张视觉验收；自动结构检查通过但视觉质量不足时仍视为未完成。
- 画布不强制统一为 A4 页面，而是按信息结构选择有限的标准比例：横向流程优先 16:9，双层流程优先 3:2，汇聚结构优先 4:3，纵向层级优先 4:5。PDF 页面紧贴图形并保持与 SVG 相同的长宽比，避免大面积空白或任意超宽页面。
