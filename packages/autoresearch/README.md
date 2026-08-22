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

```bash
npm run build
npm run run:headless
```

脚本会：

1. 准备一个独立 run 目录（默认 `packages/autoresearch/.runs/run-*`）；
2. 复制 `examples_articles/reliable_conflictive_multi_view_learning/candidate.md` 和 `PROFILE.md`；
3. 确保 DSH `headless` profile 存在并安装本插件；
4. 调用 `dsh --profile headless "..."` 让 DSH Agent 调用 `research_run` 完成闭环；
5. 如果 Runner 已生成 `paper/main.tex` 则直接使用；否则用 `pandoc` 把 `paper_draft.md` 转换为 `paper/main.tex`；
6. 若本机有 `latexmk` / `pdflatex` / `xelatex` / `tectonic`，继续编译 `paper/main.pdf`；
   - tectonic 在无网络且未缓存 bundle 时可能失败，此时会自动尝试用 Chrome/Edge Headless 将 Markdown 转 HTML 再打印为 `paper/main.pdf`；
7. 打印最终产物路径。

可传参：

```bash
npm run run:headless -- --run-dir C:/tmp/my-run --max-cycles 3
```

## DSH 插件加载

插件导出 Cordis 插件结构：`name` / `inject` / `apply`。

```ts
import { name, inject, apply } from '@athena/autoresearch'
```

安装到 DSH profile 后，会自动注册：

- 五个 research tools：`research_hypothesis_add` / `research_action_start` / `research_action_finish` / `research_evidence_add` / `research_tree_query`
- 一个控制工具：`research_run`

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
