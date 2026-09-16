# HTML/SVG 代码重建第二后端最小验证

验证 08-writing §5.3 的第二后端。结论先行：**不做 planner/coder 多 agent，采用单 agent 的“两阶段描述 + reflexion”**（先描述方案，再 rewrite 扩写润色，最后 gen code）。本实验验证该方案是否优于直接生成；通过后才回写 08 §5.3。

固定输入复用 `../drawio-mcp-test/fixture.md` 与 `fixture/figure_spec.json`。

## 1. 实验矩阵

| 臂 | 生成方式 | critic | 产物 |
|---|---|---|---|
| A（基线） | 单次直接生成 SVG | 无 | SVG |
| B（候选） | 单 agent staged reflexion：`figure_plan.md`（描述方案）→ `figure_plan.detail.md`（rewrite 扩写润色 + 应用 style）→ `figure.svg`（gen code） | **外部 vision reviewer**（与生成模型不同；视觉分 <4 时带差异反馈回同一 agent 重做 detail+code，≤3 轮） | plan/detail/SVG × 2 风格变体 |
| C（降级候选） | 同 B 的 staged 流程（只用默认 style） | **无 vision model 时回退 self-critique**（结构自检 + 自查清单代替视觉分） | plan/detail/SVG |
| D（视觉参考） | image model 生成 raster 目标 | 无 | PNG（只作 B/C 的比对基准，不参与终稿） |

## 2. staged 流程细节（B/C 共用）

```text
Stage 1  figure_plan.md        描述性方案：节点清单、分组、边、图标需求、版式倾向
Stage 2  figure_plan.detail.md rewrite：坐标预算、尺寸约束、文本截断、图例
                             + 应用 style（读 styles_prompt.md 或指定 style 变体，
                               把允许的 palette/字体/线宽/箭头 token 写进 detail）
Stage 3  figure.svg            gen code：只依据 detail 写 SVG；label 全部 editable text；
                             无外部资源；颜色/字体只能来自 detail 中的 style token
Stage 4  render + 结构自检（含 style token 校验）
Stage 5  vision critic（B）/ self-critique（C）
Stage 6  不通过 → 把差异反馈（含 style 违例）给同一 agent，回 Stage 2–3，≤3 轮
```

每阶段写文件不写内存；重试只重跑 Stage 2 起，不重跑 Stage 1（方案正确性优先）。
**style 测试**：B 跑两个变体——`styles_prompt.md`（默认 academic-minimal）与 `styles/colorblind-minimal.md`；内容与布局必须一致，只视觉 token 不同。

## 3. 工具与依赖

| 工具 | 用途 | 许可 |
|---|---|---|
| `@resvg/resvg-js` | SVG → PNG | MPL-2.0 |
| `rsvg-convert` 或 Inkscape | SVG → PDF | 开源 |
| Playwright + Chromium | 可选：HTML 版 print-to-PDF 的矢量保持检查 | Apache-2.0 |
| native-svg | 兜底 | 仓库内置 |

## 4. 结构自检（脚本）

- SVG/XML 解析通过；所有 label 是可编辑 text 节点。
- 无外部资源（图片/字体/脚本）；图标来源白名单。
- viewBox 存在；渲染尺寸 ≤ 1600×1200。
- Stage 产物齐全：plan/detail/code 三文件缺一 FAIL。
- style token 校验：SVG 中 palette/字体/线宽必须 ∈ 所选 style 文件允许集；越界记 WARN（视觉 QA 复核）。

## 5. 视觉 QA

- B：外部 vision reviewer 与 D 并排，布局/文字/图例/配色可读性 1–5 分；≥4 通过，<4 反馈差异。两个 style 变体分别评分，并额外检查“换 style 后内容与布局未变、风格确实切换”。
- C：无 vision model 时用 self-critique 清单代替：节点齐全、边无交叉、文字不溢出、图标匹配、style token 合规、与 fixture 描述一致；每项 yes/no。
- 记录 critic 类型：`vision_model | self_critique`。

## 6. 通过标准

- 结构自检：A/B/C 全过。
- B：两个 style 变体视觉分均 ≥4，且 3 轮内收敛 → staged+reflexion 可作第二后端。
- C：self-critique 全 yes，且与 B 同 fixture 的结构产物一致 → 无 vision 降级路径成立。
- style 切换：B 两变体内容与布局一致、palette/字体 token 确实不同 → styles prompt 机制成立；否则 style 机制不采纳。
- 与 A 对比：B/C 视觉分 > A，证明两阶段描述有效；若 B/C ≤ A → staged 方案不采纳，08 保留直接生成。
- B 可选 HTML 版 print-to-PDF 必须保留可选中文本。

## 7. 产物

```text
runs/<date>/
  arm_a/ arm_b_default/ arm_b_colorblind/ arm_c/ arm_d/
  structural_check.json
  visual_scores.json
  verdict.md
```

`verdict.md` 固定结论行：

```text
staged_reflexion_backend: yes | no
vision_critic: used | self_critique_fallback
chosen_flow: staged | direct
chosen_reason: ...
fallback_needed: native-svg | none
```

任何 FAIL → 追加 `../FAILURES.md`。

## 8. 与 08-writing 联动

- B 通过 → 回写 08 §5.3：第二后端采用“单 agent 两阶段描述 + reflexion（vision critic，无 vision 时 self-critique）”。
- B 失败且 A 通过 → 08 保留直接 SVG。
- A/B/C 全失败 → 08 复杂图直接回退 native-svg。
