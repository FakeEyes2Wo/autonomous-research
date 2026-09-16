# 项目设计草稿

更新日期：2026-09-13。以下是尚未成为当前入口的设计、实施与待办草稿；已实施能力以[当前状态](../verification/current-status.md)和[验收矩阵](../verification/acceptance-matrix.md)为准，示例仍不代表真实 CPA 已连通。

验证、部署和完成报告已集中在[验收目录](../verification/README.md)；三份使用指南已集中在[指南目录](../guides/README.md)。本目录保留未明确归类的草稿、计划、原型与 TODO。

## 当前决定

- 通过 CPA（CLIProxyAPI）接入 GPT 自用，连接能力作为可安装、可关闭的独立模块。
- 复用 DSH 的工具执行、会话、子代理和原生 LLM 适配器。
- 后续 Claude 接入通过 provider 路由扩展，研究步骤不绑定模型厂商。
- 模型按 `cheap / standard / deep` 配置，明确高智能任务、升级条件和预算。
- 精简流程使用 `workflow.mode: minimal`；`Lean / lean` 留给后续数学、物理中的形式化证明工具。

## 草稿入口

| 文档 | 内容 |
|---|---|
| [CPA 接入与模块边界](cpa-integration.md) | 接入包职责、DSH 契约、连接配置、Claude 扩展和接入验收 |
| [研究流程与模型策略](research-runtime.md) | 最小闭环、可配置模型表、上下文、重试、缓存、预算与恢复 |
| [详细实现计划](implementation-plan.md) | S0–S9 文件级任务、依赖顺序、测试与发布条件 |
| [DSH 配置页面设计](dsh-settings-ui.md) | 原生 Models 配置方式、项目表单、保存事务及安全边界 |
| [额外功能 TODO](TODO.md) | 已找到文献 PDF 阅读、LaTeX PDF 产物预览及安全边界；本轮不实现 |
| [交互页面原型](ui/dsh-settings-prototype.html) | 可离线打开；预设、模型表、流程、预算、差异预览和 YAML 导出 |

## 实施顺序

| 阶段 | 工作 | 完成依据 |
|---|---|---|
| P0 | 修正本地构建依赖；创建可选 CPA 接入包；接通项目模型到子代理的传递 | 短任务与长任务实际使用指定模型，工具调用和结构化结果正确；移除 CPA 不影响其他 provider |
| P1 | 实现角色路由、输入限制、请求账本、预算和有限格式修复 | 路由可配置，重试不重复启动完整实验；统计包含子代理内部模型请求 |
| P2 | 增加 minimal 流程，合并计划与设计，按需调研和论文生成 | 明确课题跳过重复生成；证据完整；恢复不重复已完成步骤 |
| P3 | 验证 Claude 路由及协议差异 | 同一研究流程可切换 provider，工具和恢复契约通过验证 |

实现按功能小批次推进，保持每批可构建、可验证。先使用本地 mock 和已有 fake provider 检查协议及流程，再接真实 CPA。验证范围覆盖改动涉及的行为；不运行真实科研实验来检验文档编辑。

上述 P0–P3 是能力分组，具体执行以[详细实现计划](implementation-plan.md)的 S0–S9 为准。Web 表单在配置服务完成后可并行制作，真实保存、模型路由和预算状态须随对应后端一起验收。

## 已有证据与未完成事项

`implementation-status.md` 不在本目录；请以 `../autonomous-research/implementation-status.md` 为准。它记录 branch-local、尚未合并到 `main` 的实现状态。

本轮设计基于仓库 `b1e456b` 及本机 DSH `0.1.5-alpha.1` 的公开类型和实现。provider/model 连接由 DSH Models 与 credentials 管理，项目设置只保存引用；协议与真实模型能力仍需按用户部署验收。

核心 schema、minimal workflow 基础、请求账本接口与 Web settings bundle 已改造并有本地测试证据；仍没有真实 CPA 连通性或模型能力结果。真实接入使用用户部署的 baseURL、凭据引用和模型别名；示例容量及 reasoning 能力需按该部署核实。配置校验通过不等于真实模型接入完成。

离线页面原型不依赖网络、不收集密钥，保存仅影响浏览器内存；正式插件源码位于 `packages/autoresearch-web`，已通过核心文件读写、公开 SlotCore、临时 Cordis host 和 React/Chromium 页面验收，但尚未部署到真实 DSH Loader/profile。可使用 `npm run test:browser` 在本机 Edge/Chrome 无头模式验证正式 bundle；测试截图及临时浏览器 profile 写入系统临时目录。
