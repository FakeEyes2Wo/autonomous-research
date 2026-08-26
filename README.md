# Autonomous Research System

DSH 插件 `@athena/autoresearch`：最小闭环研究自动化（`idea → plan → work → evidence → decide → paper | failure report`）。本文档只包含两件事：**DSH 插件安装** 与 **无头模式运行脚本**。

## 环境要求

- Node.js ≥ 22.19.0
- pnpm
- DSH ≥ 0.1.0-rc.5（`dsh` CLI 可用）
- 可选：pandoc、LaTeX（`latexmk` / `pdflatex` / `xelatex` / `tectonic`）或 Chrome/Edge，用于论文 PDF 生成

## 一、DSH 插件安装

1. 构建插件：

   ```powershell
   cd packages/autoresearch
   npm run build
   ```

2. 安装到已有 DSH profile（默认 `web`）：

   ```powershell
   npm run install:dsh -- web
   ```

   或：

   ```powershell
   node scripts/install-dsh-plugin.mjs web
   ```

   脚本会修改 `<DSH_HOME>\profiles\web\package.json`（添加 `"@athena/autoresearch": "link:<repo>\packages\autoresearch"`），并向 `cordis.patch.yml` 注入插件加载行。默认 `<DSH_HOME>` 为 `%USERPROFILE%\.dsh`，可通过环境变量 `DSH_HOME` 覆盖。

3. 安装 profile 依赖并启动 DSH：

   ```powershell
   cd $env:USERPROFILE\.dsh\profiles\web
   pnpm install
   dsh --profile web
   ```

   会话内会自动注册 research 工具、`experiment_run` 独立实验工具与 `research_run` 控制工具。

> 说明：profile 必须已经存在（需先由 DSH 创建）。如果只跑无头模式，`run:headless` 会自动创建 `headless` profile，无需手动执行本节。

## 二、无头模式运行脚本

### 目录说明

| 目录 | 是否能运行 npm 脚本 |
|---|---|
| `C:\...\autonomous-research`（仓库根目录） | ❌ 没有 `package.json`，直接 `npm run` 会报 `ENOENT` |
| `C:\...\autonomous-research\packages\autoresearch`（插件运行目录） | ✅ 有 `package.json`，可以运行 `npm run run:headless` |

> **重要：`npm run run:headless` 必须在 `packages/autoresearch` 目录下运行。**

```powershell
# 方式 1：进入插件目录（推荐）
cd packages/autoresearch
npm run run:headless

# 方式 2：在仓库根目录使用 npm --prefix
npm --prefix packages/autoresearch run run:headless
```

脚本会：

1. 构建插件（`npm run build`）；
2. 创建运行目录 `.runs/run-<timestamp>`（可用 `--run-dir` 指定）；
3. 如果没有传 `--candidate`，自动先生成 brainstorm 前置流程：广泛领域调研（先找相关综述）→ survey paper wiki + 知识图谱 → 选 direction → 查最新前沿 → 统一 paper wiki → 多视角 debate → vote → 生成 `input/idea.md`；
4. 不传 `--idea` 时**完全从 0 开始，不预设 seed**：先由 `paper-survey` 做广泛领域调研并找相关综述，再选 direction 并挖最新论文；
5. 如果传了 `--idea`，则把该文本作为 brainstorm 的初始 seed；
6. 确保 DSH `headless` profile 存在并完成 `pnpm install`；
7. 启动 `dsh --profile headless`，由 Agent 调用 `research_run` 完成研究闭环；
8. 生成论文产物：优先 LaTeX 编译，缺失时用 pandoc + Chrome/Edge 以 HTML→PDF 兜底；
9. 打印最终产物路径。

> 注意：`run:headless` 自动创建的 `headless` profile 会禁用 sandbox / permission 预设并改用本地 shell / fs provider，请在可信环境中运行。

### 常用参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--profile` | `headless` | DSH profile 名 |
| `--run-dir` | `.runs/run-<timestamp>` | 运行输出目录 |
| `--idea` | 无 | brainstorm 的初始人类 idea/seed 文本；不传则完全从 0 开始 |
| `--candidate` | 无 | 手动指定 `idea.md` 文件路径；传了会跳过 brainstorm |
| `--profile-file` | 无 | 手动指定 `PROFILE.md` 文件路径 |
| `--max-cycles` | `5` | 研究循环最大轮数 |
| `--venue` | 无 | 目标会议，如 `ICLR` / `NeurIPS` / `ICML` |
| `--assurance` | 无 | `draft` 或 `submission` |
| `--effort` | 无 | `lite` / `balanced` / `max` / `beast` |
| `--illustration` | 无 | `figurespec` / `gemini` / `codex-image2` / `mermaid` / `false` |
| `--style-ref` | 无 | 论文风格参考文件路径 |
| `--auto-proceed` | `true` | 论文流水线自动继续（`true` / `false`） |
| `--human-checkpoint` | `true` | 论文流水线人工检查点（`true` / `false`） |
| `--max-improvement-rounds` | 无（内部默认 `2`） | 论文改进轮数上限 |

### 示例

```powershell
# 全自动：先 brainstorm，再研究闭环
cd packages/autoresearch
npm run run:headless

# 带人类 idea seed
npm run run:headless -- --idea "conflictive multi-view learning"

# 手动指定已有 idea 和 profile
npm run run:headless -- --candidate C:/path/idea.md --profile-file C:/path/PROFILE.md --max-cycles 3 --venue ICLR --effort balanced
```

### 产物

运行结束后，在 `--run-dir` 下可能生成：

- `state.json`：运行状态
- `research_tree.json`：研究树
- `evidence_chain.json`：证据链
- `paper_draft.md`：论文草稿
- `paper/main.tex`、`paper/main.pdf`：论文 LaTeX / PDF
- `evidence/citations.json`：引用证据
- `FINAL_REPORT.md` 或 `FAILURE_REPORT.md`：最终 / 失败报告
