# 2026-09-09 本地复核与验收记录

范围：按 `implementation-plan.md` 的 S0、S2–S8 复核已有实现；运行时、Web/项目配置、CPA 安装器分别由独立子代理检查。本记录中的 mock/fake 测试不代表真实 CPA、Claude 或 DSH Loader/profile 已验收。

环境：Windows，Node.js `v24.4.1`，npm `11.4.2`；DSH 兼容锚点为 `0.1.5-alpha.1`。本轮没有验证 Node.js 最低支持版本。

## 构建与发布资源

| 检查 | 命令/方法 | 结果 |
|---|---|---|
| 核心接续基线 | `npm run typecheck`；`npm test`（包含 build） | 类型检查通过；112/112 |
| 独立安装 | 将核心源码、测试、脚本、prompts、templates 和包清单复制到新建的系统临时目录；`npm ci --ignore-scripts --offline --no-audit --no-fund` | 按 lockfile 安装 41 个依赖；不复用工作区 node_modules，不运行依赖安装脚本 |
| 独立构建与测试 | 临时目录内 `npm run typecheck`；`npm test` | 接续基线 112/112；同步最终源码后类型检查、构建通过，116/116 |
| 发布资源 | `npm pack --dry-run --json` | 修复前模板数为 0，修复后 10 个模板文件全部进入包 |
| 实际打包产物 | `npm pack --ignore-scripts`，解包至上述临时目录；仅补入测试文件，直接运行产物中的 dist | 首次 18/18；最终产物 19/19，包含 checkpoint 事件修复回归 |

发布资源修复：`packages/autoresearch/package.json` 的 `files` 漏掉 `templates/`，而论文阶段会从该目录读取模板。已将模板目录加入打包清单。独立目录第一次测试因验证复制清单漏掉模板出现 4 个 ENOENT；补齐验证输入后通过，并进一步用实际 tarball 验证发布资源修复。

打包产物检查命令（工作目录为解包后的包）：

```powershell
node --experimental-strip-types --test test/integration/brainstorm-loop.test.ts test/integration/leakage-loop.test.ts test/integration/minimal-loop.test.ts test/unit/paper-workflow.test.ts test/unit/paper-phases.test.ts
```

## 并行复核修复

- 请求账本：重复 `requestId` 必须保持角色、档位、模型、有效输入上限和预留预算等归因不变；重复 `roleStartId` 也核对档位及能力状态，冲突返回 `REQUEST_CONFLICT`。交叉复核后补齐默认值等价处理：省略 `attempt/cacheHit/capabilityStatus` 或预算字段，与显式填写相同有效默认值保持幂等；实际输入上限从 20 改到 15 或 5 仍拒绝复用。
- minimal 恢复：继续 supervisor 前检查证据结果是否已登记，避免重复追加 `minimal-evidence-*` 结果事件；若 plan/work checkpoint 已存在但结果事件因崩溃缺失，则补写缺失事件。回归验证恢复只调用 supervisor，plan/work/evidence 结果各一条。
- CPA 安装状态：核对 `managedBy` 与绑定的 settings 路径，拒绝跨 settings 复用安装状态；Windows 等价路径大小写保持兼容。
- CPA nativeConfig：公共 API、安装 CLI 和 doctor CLI 统一转换逻辑，非法 provider 条目返回配置错误。
- CPA 验证：主代理重新执行 `npm run build`、`npm run typecheck`、`npm test`，全部通过，测试为 13/13；静态 doctor 与安装器仅在临时目录使用模拟配置。
- Web 表单：清空数字字段按删除覆盖值处理，由 schema 恢复默认值；清空项目选择同步清理草稿和 revision，过期加载响应由版本令牌丢弃。
- Web API：畸形 JSON/非对象请求体返回 400，不调用配置保存服务；校验消息保留字段路径。
- Web 验证：主代理重新执行 `npm run build`、`npm test`（13/13）、`npm run test:browser`，全部通过；浏览器覆盖预算保存、非法值字段路径、清空恢复默认、冲突重载与清空项目。

## 最终回归

以下命令在各包目录执行，均由主代理确认退出码为 0：

| 包/产物 | 检查 | 结果 |
|---|---|---|
| `packages/autoresearch` | `npm run typecheck`；`npm test`（含 build） | 116/116，无失败或跳过 |
| `packages/autoresearch-web` | `npm run build`；`npm test`；`npm run test:browser` | 13/13；浏览器通过 |
| `packages/dsh-cpa` | `npm run build`；`npm run typecheck`（JS 语法检查）；`npm test` | 13/13 |
| 独立目录最终源码 | `npm run typecheck`；`npm test`（含 build） | 116/116 |
| 最终核心 tarball | 10 个模板资源；上述研究/论文测试命令 | 19/19 |

三个子代理完成分域修复和交叉审查。交叉审查发现的账本默认值/有效上限问题及 checkpoint 事件缺口均已修复，最终复核无阻断项。工作区未提交、未推送。

## 验收边界

- 本轮本地复核修复与回归已完成，S8 的真实运行时/端点验收仍是独立门槛。
- 仅使用 fake/mock provider 和临时文件；没有科研实验、模型付费请求或真实 DSH profile/credentials 写入。
- 真实端点、原生请求预算/隐藏重试、语义升级、预算调整恢复入口及 Claude 仍以 `TODO-addendum.md` 为准；PDF/LaTeX 阅读器以 `TODO.md` 为准。
