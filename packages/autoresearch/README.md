# @athena/autoresearch

最小闭环 DSH 插件：`idea → plan → work → evidence → decide → paper | failure report`。

基于 DSH 的 Agent/Subagent 系统实现，不依赖 Athena，不引入旧版 RunSpec/PipelineRunner/EventBus。

## 快速开始

```bash
npm run build
npm test
```

## AutoResearch 模式（DSH Preset）

安装时会自动安装：

```text
~/.dsh/.agent-presets/auto_research/
  preset.yml
  agent.cordis.yml
```

DSH Agent 调用 AutoResearch 工具时，相对 `runDir` 和 `projectDir` 会以该调用
会话的工作区目录为基准解析；显式绝对路径语义不变。没有 Agent 上下文的直接
service 或 headless CLI 调用继续保持原有的进程相对路径语义。

在 DSH 模式选择器中选择 **AutoResearch**，而不是直接输入 `/auto_research`：

- 会先探索当前目录
- 会读取项目文件 / README / 现有 `.autoresearch` 配置
- 不清楚时会通过 `ask_user_question` 与你交互
- 然后使用 `research_run` / `experiment_run` / `project_settings_*` / `paper_pipeline_*` 等工具自动执行
- 需要人工决策时会暂停询问

例如：

```text
请先看看当前目录，然后继续我们之前的研究。
帮我调研这个领域的综述和最新前沿，并写入 paper_wiki。
围绕当前项目做一组对比实验，输出 EXPERIMENT_REPORT.md。
```

如果安装后没有看到该模式，重新运行：

```bash
npm run install:dsh -- web
```

> `/auto_research` 是插件注册的轻量 Slash 命令，仅用于查看帮助 / 配置 / run 状态；要自动探索目录并执行任务，请选择 **AutoResearch** Agent Preset。

## 默认论文模板

- 默认使用 `templates/iclr2026.tex` 作为 ICLR LaTeX 模板；
- Writer 必须按该模板输出 `paper/main.tex`，包含匿名投稿、abstract、sections 1-5、`references.bib`；
- `math_commands.tex` 会自动复制到 `paper/`；
- 程序会自动解析 `references.bib`，把每条引用的 PDF 下载到 `<run>/evidence/<bibkey>.pdf`，并生成 `evidence/citations.json`；下载失败会中断论文阶段。

## 无头模式运行

> 必须在 `packages/autoresearch` 目录下执行 `npm run run:headless`；仓库根目录没有 `package.json`。

```bash
cd packages/autoresearch
npm run run:headless
```

脚本会：

1. 准备一个独立 run 目录（默认 `packages/autoresearch/.runs/run-*`）；
2. 未传 `--candidate` 时自动跑 brainstorm：
   - 广泛领域调研（先找相关综述）
   - survey paper wiki + 知识图谱
   - 选 direction
   - 查最新前沿
   - 统一 paper wiki
   - debate → vote
   - 生成 `input/idea.md`
3. Brainstorm 为**无主题探索**：不接收种子课题/方向，完全从广泛文献调研开始；已有确定课题请用 `--candidate` 跳过 brainstorm；
4. 确保 DSH `headless` profile 存在并安装本插件；
5. 调用 `dsh --profile headless "..."` 让 DSH Agent 调用 `research_run` 完成闭环；
6. 如果 Runner 已生成 `paper/main.tex` 则直接使用；否则用 `pandoc` 把 `paper_draft.md` 转换为 `paper/main.tex`；
7. 若本机有 `latexmk` / `pdflatex` / `xelatex` / `tectonic`，继续编译 `paper/main.pdf`；
   - tectonic 在无网络且未缓存 bundle 时可能失败，此时会自动尝试用 Chrome/Edge Headless 将 Markdown 转 HTML 再打印为 `paper/main.pdf`；
8. 打印最终产物路径。

可传参：

```bash
npm run run:headless -- --run-dir C:/tmp/my-run --max-cycles 3
# 或手动指定已有 idea 文件，跳过 brainstorm
npm run run:headless -- --candidate C:/path/idea.md --profile-file C:/path/PROFILE.md
```

### 实验限制文件（`--profile-file`）

`--profile-file` 指定本次实验的领域画像 / 限制文件。脚本会把它复制到：

```text
<runDir>/PROFILE.md
```

`PROFILE.md` 会被以下角色读取：

- `idea-generator`
- `rubric-generator`
- `planner`
- 后续研究流程

其作用是告诉模型：

- 这个研究方向/领域是什么；
- 允许使用哪些方法和资源；
- 禁止做什么；
- 哪些内容算有效证据；
- 最终交付物是什么。

示例：

```markdown
# PROFILE

- 允许：本地小规模数据实验、公开文献检索、代码分析与统计检验。
- 禁止：读取或引用隐藏目标论文；删除阴性/失败结果。
- 有效证据：可复现的日志、数据、代码或统计输出。
- 交付：Markdown 论文草稿与最终/失败报告。
```

该参数是可选的：

- 如果未传，runner 会尝试读取 `<runDir>/PROFILE.md`；
- 如果仍不存在，则 profile 为空字符串。

断点续跑：

```bash
npm run run:headless -- --run-dir .runs/run-1787742452500
```

---

## 独立自动实验

新增 `experiment_run` 工具，用户只需提供任务要求：

```text
experiment_run
  runDir: /path/to/run
  projectDir: /path/to/project   # 可选
  task: "比较两个优化器在小型公开 ML benchmark 上的效果"
  maxRounds: 3
```

它自动执行：

```text
任务要求
  → 自动生成实验计划
  → 最小可行性验证
  → 模型选择
  → 实验设计 + 反思
  → 实际执行 worker
  → 收集 evidence
  → 结果反思 + insight
  → supervisor 决策
  → EXPERIMENT_REPORT.md
```

也可编程调用：

```ts
import { runExperimentTask } from '@athena/autoresearch'

const result = await runExperimentTask(
  { provider },
  {
    runDir,
    task: '比较两个优化器',
    agentContext,
  },
)
```

---

## 项目设置

项目设置保存在：

```text
<project>/
  .autoresearch/
    project-settings.yaml
    project-secrets.yaml
```

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

DSH 工具：

```text
project_settings_get
project_settings_save
figure_api_test
```

其中：

- `project_settings_get`：读取设置，API Key 脱敏
- `project_settings_save`：局部更新设置
- `figure_api_test`：测试外部生图 API 连通性
- `model.useGlobal=true` 时复用 DSH `setting.yaml` 的 `agent-default-model`
- API Key 保存在 `project-secrets.yaml`，不应进入 git

---

## DSH 会话使用

```bash
npm run build
node scripts/start-session.mjs --profile autoresearch
```

或者带任务启动：

```bash
node scripts/start-session.mjs --profile autoresearch --prompt "继续上次研究"
```

会话内可用：

- `experiment_run`
- `project_settings_get`
- `project_settings_save`
- `figure_api_test`
- `research_run`
- `paper_pipeline_status`
- `paper_pipeline_last_run`
- `paper_pipeline_resume`

Slash 命令：

```text
/auto_research
/auto_research config <projectDir>
/auto_research status <runDir>
/auto
```

其中 `/auto_research` 是轻量帮助命令；实际的“自动探索当前目录并执行研究”入口是 DSH 模式选择器中的 **AutoResearch** Agent Preset。

断点续传流程：

1. `paper_pipeline_last_run` 查看最近 runDir
2. `paper_pipeline_status` 查看 checkpoint
3. `paper_pipeline_resume` 继续

---

## DSH 插件加载

插件导出 Cordis 插件结构：`name` / `inject` / `apply`。

```ts
import { name, inject, apply } from '@athena/autoresearch'
```

安装到 DSH profile 后，会自动注册：

- 五个 research tools：`research_hypothesis_add` / `research_action_start` / `research_action_finish` / `research_evidence_add` / `research_tree_query`
- 独立实验工具：`experiment_run`
- 项目设置工具：`project_settings_get` / `project_settings_save` / `figure_api_test`
- 一个控制工具：`research_run`
- 每个 idea 由单个 combined reviewer 从方法论、统计、新颖性、可行性、可复现性等多角度审查

---

## 目录

```text
src/
  experiment/      独立实验编排与实验步骤
  settings/        项目设置读写
  figure/          外部生图 API Client
  brainstorm/      Paper 调研、paper wiki、知识图谱
  paper/           论文生成与审计
  service/         研究闭环编排与恢复
  agents/          角色 Agent 封装
  tools/           DSH 工具注册
  export/          evidence_chain 与报告导出
  security/        目标论文泄漏过滤与检测
prompts/
  system/          角色 System Prompt
test/
  unit/            单元测试
  integration/     集成测试
```
