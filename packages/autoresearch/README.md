# @athena/autoresearch

最小闭环 DSH 插件：`idea → plan → work → evidence → decide → paper | failure report`。

基于 DSH 的 Agent/Subagent 系统实现，不依赖 Athena，不引入旧版 RunSpec/PipelineRunner/EventBus。

## 快速开始

```bash
npm run build
npm test
```

## 轻量实验工程约定

需要生成可执行代码时，planner、worker、实验设计/反思、证据和 supervisor 角色共享一份插件内置的工程提示。新实验默认采用以下小型结构；实际任务按需缩减，不创建空目录或复杂框架：

```text
<runDir>/
  experiment/
    README.md                 # 环境、smoke、完整运行、评估命令与预期输出
    pyproject.toml            # 或 requirements 文件；其他语言使用项目原有 manifest
    configs/
    src/<package>/            # 数据准备、方法/基线、评估、命令编排按职责拆分
    tests/
    scripts/                  # 可选的薄入口
    notebooks/                # 可选，不能是唯一执行入口
  data/                       # raw（只读）和 prepared 数据
  work/cycle-XX/              # research_run 的无代码输出与不可覆盖的 attempt 子目录
  work/experiment-cycle-XX/   # experiment_run 对应输出
```

Python 项目优先沿用仓库已经选择的工具；manifest 还需配合可复现的解析版本记录。pilot/smoke 只证明可运行性或用于校准，不等于正式验证。正式比较前应冻结带 revision/hash 的设计、主指标、seed/split、有效基线、任务特定的预算单位/容差、停止规则和失败/截尾处理；pilot 改动后新建版本，exploratory/formal 结果不能静默混合。成本敏感比较记录完整 run/episode 的 input/cache/output token、步骤、重试、时间及可得的价格依据。

`workflow.mode=minimal` 保持 planner → worker → 本地 evidence → supervisor 的低调用流程，worker 自行承担重要逻辑测试和 smoke check；research minimal 仅在既有策略要求时进行可选的 post-work review，且该审查只能接受已执行协议或暂停，不能为旧结果追溯改写设计。完整流程会额外使用 minimal verifier、model scout、experiment designer/reflexion 和 evidence agent。两种模式使用同一工程约定，不增加强制角色或新 checkpoint。

planner 会收到一个受限、无敏感信息的 **outer AutoResearch runtime constraints** 区块：有效 workflow mode、outer cycle/round 上限、外层角色模型路由的已知/继承状态、相关 review 策略和全局 LLM 上限。它不代表实验内部的 seed、episode、重试、被研究模型或科学预算；外层路由关闭也不禁止多模型实验。

运行时现在强制两项基本门槛：完整模式最多允许两次自动 redesign，但返回给 worker 的精确版本必须再获得 `proceed`；worker 的结构化结果必须为 completed、摘要非空，并至少列出一个真实、普通、解析后仍位于 real run root 内的文件。缺失文件、目录、glob、遍历、逃逸 symlink、失败或 malformed 输出会在 evidence/supervisor 前进入 `PAUSED` 并保留报告/checkpoint；恢复时缓存 work 也会重新做同样校验，不重跑已完成 worker。旧的 terminal completed run 不追溯修改。

这些运行时门槛只验证 review acceptance 与本地 artifact 的基本形状/路径安全，不证明指标真实。正式协议版本、完整可复现记录、预算匹配、统计充分性和 failure-derived lesson 的事实/解释及 split provenance 边界，仍由 planning、worker、evidence 与 review 明确承担。

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

## 本地文献库 CLI

先运行 `npm run build`。所有命令输出 JSON，文献库存放在项目的
`.autoresearch/literature` 下。`projectId` 默认使用项目目录的真实绝对路径；
服务端通过注册项目找到目录后使用 `canonicalLiteratureProjectId(projectRoot)`，
Web 的项目注册 ID 只用于查找目录。CLI、研究上下文和 Web 均使用
`resolveLiteratureRoot(projectRoot)` 定位同一个库。

```sh
node scripts/literature.mjs import --project ./test-project --records ./papers.json
node scripts/literature.mjs ingest --project ./test-project --manifest ./sources.json
node scripts/literature.mjs index --project ./test-project
node scripts/literature.mjs search --project ./test-project --query '反证' --generation <上一步返回的id>
node scripts/literature.mjs replay --project ./test-project --receipt <search返回的receipt.id>
```

`papers.json` 为含 `title` 的论文数组。`sources.json` 格式如下；`workId` 使用
import 返回的 `mappings[].workId`，`projectId` 使用实际项目绝对路径，
`policyHash` 使用项目授权策略的 SHA-256，不能把示例标记当作真实 ID：

```json
{
  "documents": [{
    "workId": "<import返回的workId>",
    "source": { "kind": "file", "path": "./paper.txt", "mediaType": "text/plain" },
    "sourceKind": "full_text",
    "visibility": {
      "projectId": "<项目的真实绝对路径>",
      "partitionId": "main",
      "roles": ["reader", "researcher", "paper-survey", "paper-frontier-miner", "idea-generator", "idea-reflexion", "planner", "supervisor", "hypothesis-reviser", "writer", "citation-auditor"],
      "policyHash": "<项目策略的64位SHA-256>"
    }
  }]
}
```

文件路径相对于 manifest。来源还支持 `{"kind":"text","text":"原文"}`、
`{"kind":"url","url":"https://…"}` 和 `{"kind":"registered","documentId":"已入库ID"}`。
只有显式 `ingest` URL 才下载原文；search、replay 和读取已注册文献不联网。
未知 CLI 参数会报错。多策略项目需显式传入 `--policy-hash`；可用
`--run`、`--role`、`--split`、`--partitions` 收窄读取范围。

核心 API 通过 `@athena/autoresearch/literature` 导出。`ingestManifest` 默认拒绝本地路径，
只有可信本地 CLI 传 `allowLocalFiles: true`。manifest 可附带 `works`（仅 candidate）
及 `searchReceipts`（`provider/query/createdAt/rawResponse/resultWorkIds`），保存外部搜索原始响应，
不自动搜索或提升元数据可信度；解析器返回的元数据须通过 `registerMetadata` 保存来源再注册。
检索只打包完整 span；必需原文不可用或超预算时分别抛出
`REQUIRED_SOURCE_UNAVAILABLE`、`LITERATURE_CONTEXT_INSUFFICIENT`。
模型实际收到的片段由 `recordExposure` 的 prepared → sent/unknown 追加链记录。
search 首次读取 active generation 时自动固定该 run 的版本，读取过程中发布新索引也不会中断；后续仍可 replay。
直接读取历史 generation 则要求该 run 已通过 `pinGeneration` 固定该版本。

## 源码目录

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
## Existing project to paper

In the `auto_research` preset, the main agent can dispatch `project_paper_run`
with an existing `projectDir` and a separate `runDir`. The service captures a
bounded source inventory, generates source-linked contribution candidates, then
uses the normal research loop for supplementary validation and paper generation.
Historical results remain unverified until the evidence checks admit them.
`research_run` with the saved `runDir` resumes the same project identity and
frozen budget; it does not repeat completed discovery or reset spent tokens.

Discovery is tool-free. Its default inventory is at most 40 files, 8 KiB per
file and 40 KiB total, with visible omissions. Missing or changed required source
bytes stop resume. A paused budget is returned as `PAUSED` with the saved phase
and error; a paused run is not a completed paper.

For example, the main agent can call:

```json
{
  "projectDir": "C:/research/my-project",
  "runDir": "C:/research/my-project/.autoresearch/runs/project-paper-1",
  "maxCycles": 3
}
```

Use a fresh run directory for the initial `project_paper_run`; subsequently call
`research_run` with that same `runDir`. The main agent schedules missing validation
within the frozen budget before entering the paper pipeline. Historical project
observations never become validated findings simply because the model describes
them as such. With the local execution grant below, keep the run directory inside
the bound project root. Budget or unsupported-validator pauses require resolution
before the corresponding scientific claim can advance.

## Trusted local experiment execution

Durable task graphs require a host execution grant. The model-facing tools cannot
create or enlarge this grant. To allow trusted local programs, configure the
AutoResearch Cordis plugin in the host profile, for example:

```yaml
- id: autoresearch
  config:
    localExperiments:
      projectRoots: ['C:/research/my-project']
      executables: ['C:/Program Files/nodejs/node.exe']
      envNames: ['EXPERIMENT_SEED']
      maxWallMs: 300000
      maxRunWallMs: 3600000
      maxLogBytes: 1048576
      maxArtifactBytes: 10485760
```

Use the actual absolute executable path on the host. Each job's working directory
must resolve inside the run's authorized project; executable, environment names
and per-job budgets are checked before execution. Concurrency is one and aggregate
wall usage/reservations persist across controller restarts. Without a grant,
task-graph execution pauses. This grants execution of trusted programs; it is not
a sandbox for hostile code. The local backend currently requires Windows process
tree containment. CPU, GPU and currency hard caps are unavailable and remain null.

Embedding applications can instead supply
`AutoResearchServiceOptions.experimentRuntimeForProject(projectDir)` and the
equivalent optional factory to `createExperimentRunTool`. The factory is a trusted
host API, separate from model-generated task graphs and project settings files.

文献角色权限使用实际角色名：CLI 默认 researcher，Web 阅读使用 reader，研究 planner/supervisor 等分别核对权限。Web 显式入库由服务端赋予当前项目的标准阅读/研究角色；浏览器不能自报角色或其他项目。已有受限文档不会自动扩权。research-worker 还必须满足冻结 protocol 的 allowed_literature_span_ids。

新研究需在项目设置中明确启用 literature.mode: lexical（默认 off）。maxResults 范围 1–40，默认 8；maxContextChars 范围 1000–100000，默认 12000。索引构建必须显式执行，研究固定使用首次绑定的 generation，恢复不会自动切换新文献版本。

## Durable runtime verification

The default software suite includes a three-minute Windows subprocess recovery
test. Longer controlled runs are explicit and make no model calls:

```sh
node scripts/runtime-soak.mjs --duration-hours 2 --config test/fixtures/jobs/soak-config.json --output <empty-directory>
node scripts/runtime-soak.mjs --duration-hours 24 --config test/fixtures/jobs/soak-config.json --output <another-empty-directory>
```

Keep the process running until `report.json` records its terminal outcome. The
report derives restart, duplicate-submission, lost-result and budget counts from
the persisted jobs and execution logs. A running or interrupted test is not a
completed duration check. See [verification record](../../docs/verification/2026-09-16-research-rag-runtime.md)
for actual results and the separate limits of mocked, local-process and paid-model
checks.
