# 项目目录说明

本页是仓库根目录的导航约定。源码、研究材料、实验结果、工作流手册和历史设计分别归类，迁移保留文件内容；必要的 Markdown 引用更新单列记录。一次目录整理应保留迁移前后的文件数量、字节数和 SHA-256 证据。

## 根目录

```text
packages/                 可安装源码包和包级文档
docs/                     设计、指南、验收记录和工作流手册
research/materials/       外部论文文本、HTML、JSON 等研究资料
experiments/              可复跑的实验与验证产物
examples_articles/        内置论文数据集和评估样例，保持原路径
.runs/                    根目录临时运行产物，保持原路径并继续忽略
scripts/maintenance/      只读维护与目录验收脚本
```

`packages/autoresearch/runs/` 是核心包已有的运行数据，也保持原路径。`packages/` 下的 TypeScript 源码、配置和测试属于产品实现；目录整理不复制或重构这些代码。

## 文档分层

| 目录 | 用途 | 入口 |
|---|---|---|
| `docs/archive/designs/` | 带日期的历史设计和方案，作为背景资料保留 | [设计文档目录](archive/designs/README.md) |
| `docs/workflows/` | 从候选或已有实验记录到论文的执行手册 | [工作流目录](workflows/README.md) |
| `docs/guides/` | 面向使用者的安装、部署和工作台指南 | [对话式工作台指南](guides/2026-09-10-conversational-workbench-guide.md) |
| `docs/verification/` | 可复核的部署、实验、验收和完成记录 | [目录验收报告](verification/2026-09-13-directory-reorganization.md) |
| `docs/autonomous-research/` | 当前维护的自动化科研通式和循环规范 | [通式](autonomous-research/general-form.md) |
| `docs/drafts/` | 尚未归档的草稿、计划、TODO 和原型 | [草稿目录](drafts/README.md) |

历史设计、草稿和验收记录的语义不同：草稿不代表已交付，验收记录只覆盖记录中声明的范围，历史设计不自动成为当前实现契约。

## 研究材料与实验

`research/materials/<paper-group>/` 按论文或研究主题分组保存外部资料。材料文件是输入和参考资料，不是可导入的源码模块；引用它们时应使用新路径，并保留来源说明。

`experiments/figure-validation/` 保存图形重建验证实验的脚本、输出和报告。它可以用于验证图形管线和结果形状，不能替代正式研究的统计审查。`examples_articles/` 保持为样例数据入口，不与研究材料目录合并。

## 迁移与链接约定

本次整理采用以下固定目的地：

- `docs/2026-08-*.md` → `docs/archive/designs/`，文件名保持不变；
- `candidate-to-paper-handoff/`、`records-paper-handoff/` → `docs/workflows/`，目录内容保留，必要引用更新单列记录；
- 三份工作台/代理指南 → `docs/guides/`；
- 验收和部署记录 → `docs/verification/`；
- `verify_exp/` → `experiments/figure-validation/`；
- 六份散落的论文资料 → `research/materials/` 下对应主题组。

Markdown 链接按链接所在文件解析。代码块中的示例链接和明显的占位符会被验收脚本排除；现有的坏链要在报告中标为既有问题，迁移后新出现的坏链必须单独修复。相对链接不要假定旧根目录仍存在。

## 只读验收

验收脚本需要一个 JSON 映射文件，接受 `migrations`、`mapping` 或 `files` 数组；每项至少包含 `source` 和 `destination`，路径必须相对仓库根目录。例如：

```json
{
  "migrations": [
    {
      "source": "docs/example.md",
      "destination": "docs/archive/designs/example.md"
    }
  ]
}
```

迁移前生成基线（脚本只向标准输出写 JSON，重定向由调用者决定）：

```powershell
powershell -NoProfile -File scripts/maintenance/verify-directory-reorganization.ps1 `
  -Root . `
  -MappingPath .runs/directory-reorganization/mapping.json `
  -Phase Before > .runs/directory-reorganization/before.json
```

迁移后复核位置、冲突、内容 hash 和 Markdown 链接；可同时传入多个 worker 的 mapping：

```powershell
powershell -NoProfile -File scripts/maintenance/verify-directory-reorganization.ps1 `
  -Root . `
  -MappingPath .runs/directory-reorganization/docs-preflight-mapping.json,.runs/directory-reorganization/materials-before.json `
  -Phase After `
  -BaselinePath .runs/directory-reorganization/before.json `
  -CheckPython
```

脚本不会创建目录、移动文件、改写 Markdown、写入 `__pycache__` 或启动产品实验。它报告迁移项的文件数、目录数、总字节数、树 SHA-256、路径冲突、reparse point、Markdown 缺链分类和可用时的 Python AST 语法错误。
