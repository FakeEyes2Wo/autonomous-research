# 2026-09-13 目录整理验收

本次目录整理按迁移前 mapping 执行，保留源码包、`examples_articles/`、`.runs/` 和 `packages/autoresearch/runs/` 的原位置。迁移操作由各目录 owner 完成；本页记录整合检查，不代表产品功能或真实模型实验验收。

## 迁移结果

| 组别 | 来源 | 目的地 | 结果 |
|---|---|---|---|
| 历史设计 | `docs/2026-08-*.md`（16 文件） | `docs/archive/designs/` | 纳入 docs 总体 hash proof；必要引用更新单列记录 |
| 工作流 | 两个根 handoff 目录（16 文件） | `docs/workflows/` | 文件保留，内部相对链接按新路径更新并复核 |
| 指南 | 3 份 `docs/drafts/2026-09-*.md` | `docs/guides/` | 纳入 docs 总体 hash proof；必要引用更新单列记录 |
| 验收记录 | 11 份草稿/状态/完成记录 | `docs/verification/` | 纳入 docs 总体 hash proof；必要引用更新单列记录 |
| 图形验证 | `verify_exp/`（219 个 tracked 文件） | `experiments/figure-validation/` | 以迁移前 git HEAD blob 清单复核：216 个内容一致，3 个文档差异属于预期路径更新；磁盘上的 3 个已有 pyc 不计入 tracked 证明 |
| 研究材料 | 6 份 txt/html/json | `research/materials/` 主题组 | 六份文件 SHA-256 与迁移前一致 |

材料迁移的逐文件 hash/count 记录见 `.runs/directory-reorganization/materials-before.json` 与 `materials-after.json`；docs mapping 和总体 hash 证明见同目录下的 `docs-preflight-mapping.json`、`docs-before-files.json`、`docs-after-files.json` 与 `docs-hash-proof.json`。docs 证明包含 46 个迁移文件的总体记录（33 个 unchanged、13 个因引用更新而预期编辑）。这些运行证据位于被 `.runs/` 忽略的本地目录，不属于产品源码。

## 导航与保护

根 `README*.md` 已更新到设计归档、工作流、图形验证和新指南路径；根 README 也增加了[项目目录说明](../project-layout.md)。Web 包和 handoff prompt 的文档链接同步更新。

全局 `*.pdf` 忽略规则保留，同时只对迁移前已 tracked 的 20 个图形 PDF 加入精确否定规则；未来同目录 PDF 仍保持忽略。`git check-ignore --no-index` 已验证一个既有 PDF 可见、一个未来命名 PDF 仍被忽略。

## 复核命令

在仓库根目录运行以下只读命令即可重现目录、hash/count、Markdown 链接和 Python AST 检查：

```powershell
powershell -NoProfile -File scripts/maintenance/verify-directory-reorganization.ps1 `
  -Root . `
  -MappingPath .runs/directory-reorganization/docs-preflight-mapping.json,.runs/directory-reorganization/materials-before.json `
  -Phase After `
  -CheckPython
```

脚本不会移动文件、改写链接、创建 `__pycache__` 或运行付费实验。验收时 Markdown fenced code 和明显占位符会排除；提供迁移前 JSON 基线时，报告会把同一坏链归为 `preExistingBroken`，把迁移新增坏链列为 `newlyBroken`。上面的复核命令未传 `-BaselinePath`，因此只重新计算当前树 hash；完整的迁移前后内容一致性以各 worker 的 hash proof 为准。

root 实际运行结果：exit 0，`passed=True`，38 个 mapping，37 个 Markdown 文件、202 条本地引用、0 条缺链，169 个 Python 文件 AST 解析通过且 0 个错误。由于命令未提供迁移前 baseline，这次运行验证的是当前路径、冲突、链接和语法；内容一致性仍以各 worker 的独立证明为准。

本次目录检查未运行整个产品测试套件、真实 provider 请求或科研实验。核心源码路径及运行产物路径保持原样。
