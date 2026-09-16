# 启动分流与恢复改造验收

## 本轮范围

按用户选择，聚焦“自动分流与恢复：准确选择已有项目、新研究、独立实验或继续运行”。代码在 `feat/rag-research` 隔离分支，基线 `6a369f2`。完整启动设计中的研究需求全链路、角色任务图和新 dispatch 服务留待后续；本轮没有做 benchmark。

## 已实现行为

1. **统一只读入口**：注册 `research_prepare`。main agent 明确传入 `project-paper / research / experiment / resume / ambiguous`；代码核对路径、项目身份和运行状态后返回现有执行工具及参数。检查不创建运行、不读取密钥、不调用模型。
2. **按项目恢复**：明确 runDir 优先，其次是经重新核验的 session 绑定，最后是项目 `.autoresearch/runs/` 内的有界查找。多个候选、扫描截断、损坏元数据或缺失旧身份均不擅自派发。有效的明确目录和 session 绑定不受无关目录损坏影响。
3. **按状态推进**：RUNNING/WAITING 返回同一工作流的恢复动作；PAUSED 返回原因且无自动执行动作；COMPLETED/FAILED 只展示终态。相同或作为项目祖先的输出目录、已占用的新运行目录被拒绝。
4. **独立实验恢复**：保存项目/工作流身份以及确切任务、profile、maxRounds；恢复时核对 manifest 内容。不同项目、不同工作流、输入冲突和残缺实验记录不能被当作新研究接管。身份和输入未通过检查时，收尾逻辑不会同步或改写研究输出。
5. **旧记录兼容**：没有身份与实验标记的历史终态主运行仍可只读查询，不派发模型，也不制造新的实验身份。已有实验 manifest 的旧运行继续要求匹配的任务与 profile。
6. **入口一致**：preset、session prompt 与 CLI 使用相同的分流语义。CLI 增加 `--project-dir / --run-dir`；相对 runDir 按所选项目解释。`--resume` 在 profile 安装及 DSH 启动前检查运行，不再依赖全局 last-run。

## 验证

| 检查 | 结果 |
| --- | --- |
| Node 24.4.1：最终固定代码的完整核心套件 | 534/534，0 失败、0 跳过，exit 0，309.3 秒 |
| Node 22.19.0：新增分流、工具、CLI、实验身份及历史兼容测试 | 39/39，exit 0 |
| 核心套件中的 Windows 三分钟进程恢复检查 | 通过，实际 180.1 秒 |
| TypeScript 构建、类型检查 | 通过 |
| 两个 CLI 模块语法检查 | 通过 |
| 实际 CLI 指定不存在的恢复目录 | 输出 needs-input，exit 2，未进入启动会话分支 |
| 子 agent 交叉复审 | 重要问题已修复并复审，无遗留阻塞项 |

核心验证命令（在 `packages/autoresearch`）：

```powershell
node scripts/build.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node --experimental-strip-types scripts/test.mjs
node --experimental-strip-types --test test/unit/startup-tools.test.ts test/unit/startup-prepare.test.ts test/unit/session-startup.test.ts test/unit/experiment-resume-identity.test.ts test/integration/research-compatibility.test.ts
node --check scripts/start-session.mjs
node --check scripts/session-startup.mjs
```

本地原始日志保存在 `.superpowers/sdd/2026-09-17-startup-routing/`。最终核心结果为 `core-stable.log`；`node22-focused-final.log` 使用仓库已有的 Node 22.19.0 测试二进制。`stable-inputs.json` 记录相关源码与测试的 SHA-256，验证结束后核对无变化。不会把未完成或失败的早期诊断结果当作最终通过证据。

## 边界

- main agent 根据 persona 发起首次检查；未增加宿主 first-turn 自动执行 hook。
- session 绑定在当前插件实例内，跨进程恢复依赖项目运行目录或明确 runDir。
- 保持原实验授权、冻结 policy 和预算机制；没有新增预算或后台总控模型。
- 本轮没有启动真实 DSH 模型会话、付费 smoke 或完整论文生成；测试验证工具行为、持久记录、兼容性及现有运行时回归。
- 未合并主工作目录、未修改全局 DSH 安装或配置。Web 源码未改动，本轮未重跑 Web 套件。
