# @athena/autoresearch

最小闭环 DSH 插件：`idea → plan → work → evidence → decide → paper | failure report`。

基于 DSH 的 Agent/Subagent 系统实现，不依赖 Athena，不引入旧版 RunSpec/PipelineRunner/EventBus。

## 快速开始

```bash
npm run build
npm test
```

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
2. 未传 `--candidate` 时自动跑 brainstorm：广泛领域调研（先找相关综述）→ survey paper wiki + 知识图谱 → 选 direction → 查最新前沿 → 统一 paper wiki → debate → vote → 生成 `input/idea.md`；
3. 不传 `--idea` 时**完全从 0 开始、不预设 seed**，由 `paper-survey` 先做领域调研和找综述，再选择 direction 并查询最新前沿；传了则以 `--idea` 文本作为初始 seed；
4. 确保 DSH `headless` profile 存在并安装本插件；
5. 调用 `dsh --profile headless "..."` 让 DSH Agent 调用 `research_run` 完成闭环；
6. 如果 Runner 已生成 `paper/main.tex` 则直接使用；否则用 `pandoc` 把 `paper_draft.md` 转换为 `paper/main.tex`；
7. 若本机有 `latexmk` / `pdflatex` / `xelatex` / `tectonic`，继续编译 `paper/main.pdf`；
   - tectonic 在无网络且未缓存 bundle 时可能失败，此时会自动尝试用 Chrome/Edge Headless 将 Markdown 转 HTML 再打印为 `paper/main.pdf`；
8. 打印最终产物路径。

可传参：

```bash
npm run run:headless -- --run-dir C:/tmp/my-run --max-cycles 3
# 或指定 human seed
npm run run:headless -- --idea "conflictive multi-view learning"
# 或手动指定已有 idea 文件，跳过 brainstorm
npm run run:headless -- --candidate C:/path/idea.md --profile-file C:/path/PROFILE.md
```

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

- `research_run`
- `paper_pipeline_status`
- `paper_pipeline_last_run`
- `paper_pipeline_resume`

断点续传流程：

1. `paper_pipeline_last_run` 查看最近 runDir
2. `paper_pipeline_status` 查看 checkpoint
3. `paper_pipeline_resume` 继续

## DSH 插件加载

插件导出 Cordis 插件结构：`name` / `inject` / `apply`。

```ts
import { name, inject, apply } from '@athena/autoresearch'
```

安装到 DSH profile 后，会自动注册：

- 五个 research tools：`research_hypothesis_add` / `research_action_start` / `research_action_finish` / `research_evidence_add` / `research_tree_query`
- 一个控制工具：`research_run`
- 每个 idea 由单个 combined reviewer 从方法论、统计、新颖性、可行性、可复现性等多角度审查

## 目录

- `src/core/`：纯领域核心（ResearchTree、state、错误、工具函数）
- `src/domain/`：各阶段领域逻辑
- `src/agents/`：DSH 角色 Agent 封装
- `src/service/`：闭环编排与恢复
- `src/tools/`：DSH 工具注册
- `src/export/`：evidence_chain 与报告导出
- `src/security/`：目标论文泄漏过滤与检测
- `prompts/`：角色 Agent 的 System Prompt
- `test/`：单元与集成测试
