# Styles Prompt（默认学术风）

作用：控制图风格而不改内容。Staged 流程的 Stage 2 rewrite 必须先读本文件（或用户指定的 style 变体），把风格约束写进 `figure_plan.detail.md`，Stage 3 gen code 只按 detail 渲染。

## 默认风格：academic-minimal

- **画布**：白底 `#ffffff`，外框无阴影；画布 ≤ 1600×1200。
- **调色板**（只允许这些 token，色盲安全）：
  - 节点填充 `#ffffff`
  - 节点描边 `#333333`（1.5px）
  - 主文字 `#333333`
  - 箭头/强调 `#2563eb`
  - 分组容器描边 `#6b7280`（1px，虚线）
  - 禁用/降级元素 `#9ca3af`
- **字体**：sans-serif（Arial/Helvetica）；标题 14px，正文 12px，注释 10px；全部为可编辑 `<text>`。
- **形状**：圆角矩形（rx=6）；节点最小 120×44；同级节点等高等距（水平间距 ≥40px，垂直层距 ≥60px）。
- **箭头**：`marker-end` 实心三角，1.5px，正交路由，不交叉。
- **图标**：仅几何自绘或白名单许可集；图标 16px，与文字左对齐；image model 只许生成图标。
- **分组**：两个 phase 容器用虚线框 + 左上角小标签。
- **文字规则**：每行 ≤ 24 字符自动换行；不用缩写（除非 fixture 已定义）；图例放右上角。
- **禁止**：渐变、阴影、外部位图、外部字体、inline style 之外的多余装饰。

## 用法

- 默认：Stage 2 直接使用本文件。
- 换风格：把 `--style styles/colorblind-minimal.md`（或用户自带 style 文件）指给 Stage 2；内容与布局不变，只变视觉 token。
- 风格 QA：结构自检校验 palette/字体 token 是否落在所选 style 的允许集内；vision reviewer 额外检查“换 style 后内容未变、风格确实切换”。
