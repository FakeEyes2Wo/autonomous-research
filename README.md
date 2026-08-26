# Autonomous Research System

DSH 插件 `@athena/autoresearch`：自动研究闭环。

核心能力：

- **Paper 调研**
  - 两阶段：先广泛领域调研并找相关综述，再选择 direction 查询最新前沿。
  - 生成统一 `paper_wiki/` 和领域知识图谱 `paper_wiki/kg/`。
- **自动实验**
  - `experiment_run`：输入任务要求后自动执行实验。
- **论文生成**
  - `idea → plan → work → evidence → decide → paper | failure report`。
- **项目设置**
  - 项目级 Paper 探索参数、外部生图 API、模型复用与实验参数。
  - 通过 DSH 工具 `project_settings_get` / `project_settings_save` / `figure_api_test` 管理。

---

## 环境要求

- Node.js ≥ 22.19.0
- pnpm
- DSH ≥ 0.1.0-rc.5（`dsh` CLI 可用）
- 可选：pandoc、LaTeX（`latexmk` / `pdflatex` / `xelatex` / `tectonic`）或 Chrome/Edge，用于论文 PDF 生成

---

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

> 说明：profile 必须已经存在（需先由 DSH 创建）。如果只跑无头模式，`run:headless` 会自动创建 `headless` profile，无需手动执行本节。

---

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
3. 如果没有传 `--candidate`，自动先生成 brainstorm 前置流程：
   - 广泛领域调研（先找相关综述）
   - survey paper wiki + 知识图谱
   - 选 direction
   - 查最新前沿
   - 统一 paper wiki
   - 多视角 debate → vote
   - 生成 `input/idea.md`
4. 不传 `--idea` 时**完全从 0 开始，不预设 seed**；
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

### 断点续跑

如果某个 run 中途停止，`AutoResearchService` 会自动读取已有 `state.json` 并恢复：

```powershell
cd packages/autoresearch
npm run run:headless -- --run-dir .runs/run-1787742452500
```

或使用绝对路径：

```powershell
npm --prefix packages/autoresearch run run:headless -- --run-dir "C:\path\to\.runs\run-1787742452500"
```

如果 `state.json` 已经是 `COMPLETED` / `FAILED`，系统会直接返回终态，不会重跑。

---

## 三、项目设置

项目级设置保存在：

```text
<project>/
  .autoresearch/
    project-settings.yaml
    project-secrets.yaml
```

示例：

```yaml
version: 1

paperExploration:
  maxPapers: 80
  minSurveys: 3
  minClusters: 5
  latestWindowYears: 1
  latestPerDirection: 5
  maxSelectedDirections: 3

figureApi:
  enabled: true
  apiUrl: https://example.com/api/generate
  model: ""
  timeoutMs: 60000

model:
  useGlobal: true
  overrides:
    provider: deepseek-official
    model: deepseek-v4-pro

experiment:
  maxRounds: 3
  profile: "允许本地实验和公开数据"
```

> `project-secrets.yaml` 保存 API Key 等敏感信息，应加入 `.gitignore`。

DSH 会话内可用：

```text
project_settings_get
project_settings_save
figure_api_test
```

---

## 四、DSH 工具

插件安装后自动注册：

| 工具 | 作用 |
|---|---|
| `research_hypothesis_add` | 添加/修订假设 |
| `research_action_start` | 开始研究动作 |
| `research_action_finish` | 结束研究动作 |
| `research_evidence_add` | 添加证据 |
| `research_tree_query` | 查询研究树 |
| `experiment_run` | 输入任务要求自动执行实验 |
| `project_settings_get` | 读取项目设置 |
| `project_settings_save` | 保存项目设置 |
| `figure_api_test` | 测试外部生图 API |
| `research_run` | 启动/恢复整个研究闭环 |
| `paper_pipeline_status` | 查看论文流水线状态 |
| `paper_pipeline_last_run` | 查看最近 run |
| `paper_pipeline_resume` | 恢复论文流水线 |

DSH 还注册了 Slash 命令：

```text
/auto_research
/auto_research config <projectDir>
/auto_research status <runDir>
/auto
```

- `/auto_research`：显示 AutoResearch 模式帮助
- `/auto_research config <projectDir>`：查看项目设置
- `/auto_research status <runDir>`：查看 run 状态
- `/auto`：切换自动模式

---

## 五、目录与产物

### 运行产物

在 `--run-dir` 下可能生成：

- `state.json`：运行状态
- `research_tree.json`：研究树
- `evidence_chain.json`：证据链
- `paper_wiki/_index.md`：统一论文 wiki 索引
- `paper_wiki/kg/kg.json`：领域知识图谱
- `paper_wiki/kg/kg.html`：知识图谱可视化
- `paper_draft.md`：论文草稿
- `paper/main.tex`、`paper/main.pdf`：论文 LaTeX / PDF
- `evidence/citations.json`：引用证据
- `FINAL_REPORT.md` 或 `FAILURE_REPORT.md`：最终 / 失败报告
- `EXPERIMENT_REPORT.md`：独立实验报告

### 插件目录

```text
packages/autoresearch/
  src/
    experiment/      独立实验编排
    settings/        项目设置读写
    figure/          外部生图 API Client
    brainstorm/      Paper 调研/知识图谱
    paper/           论文生成
    service/         研究闭环编排
    tools/           DSH 工具注册
  prompts/
    system/          角色 System Prompt
  test/
    unit/            单元测试
    integration/     集成测试
```
