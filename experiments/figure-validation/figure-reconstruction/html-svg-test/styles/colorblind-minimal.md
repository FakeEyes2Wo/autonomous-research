# Style Variant: colorblind-minimal

在 `styles_prompt.md` 默认风格上，只覆盖以下 token（未覆盖项沿用默认）：

- **画布**：浅灰底 `#f8fafc`；节点白底不变。
- **调色板**：
  - 节点描边 `#1f2937`（2px）
  - 主文字 `#111827`
  - 箭头/强调 `#0f766e`（teal，色盲安全）
  - 分组容器描边 `#475569`（实线，1px）
  - 禁用/降级元素 `#94a3b8`
- **形状**：方角矩形（rx=2），节点最小 128×40。
- **箭头**：空心三角 marker，2px，正交路由。
- **字体**：等宽感 sans（Verdana/DejaVu Sans）；标题 13px bold，正文 11px。
- **图例**：底部横排。

目的：验证同一 fixture 只换 style 文件就能稳定切换视觉风格，内容与布局不变。
