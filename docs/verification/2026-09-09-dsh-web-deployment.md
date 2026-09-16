# 2026-09-09 DSH Web 实际部署验证

用户明确要求移除失效的 `dsh-new-session-fix`、安装 AutoResearch 并启动 `dsh web`。本次操作针对用户的真实 `web` profile，更新了此前仅有临时宿主测试的验收结论。

## 安装与修复

- 修改前备份了 web profile 的包清单、Cordis 配置、锁文件及已有 AutoResearch preset，备份位于 DSH home 下的 `backups/web-autoresearch-20260909-193113`。
- 移除旧插件的依赖、加载项及已断开的 node_modules junction；旧插件源目录原本已不存在。
- 安装核心与可选 Web 包的本地链接、核心加载项、Web 加载项及 AutoResearch agent preset。Web allowlist 仅登记本次工作区。
- 修复安装器将 `autoresearch-web` 误识别为核心加载项的问题，新增真实临时 profile 的共存/幂等回归。
- Web 后端使用公开 `ctx.get` 查询可选 settings service，避免在真实 Cordis 中读取未声明属性时抛错。
- Web 源码包声明本地核心 dev dependency，确保源码链接安装时能解析 `@athena/autoresearch/settings`。
- Web 客户端导出 `inject: ['locale', 'slots']`，并使用独立的 `autoresearch` 翻译命名空间，避免与原生 `settings` 翻译注册冲突。

## 验证结果

- DSH `0.1.5-alpha.1` 实际启动成功，监听 `http://127.0.0.1:3080/`。
- 完成原生 token/cookie 认证后，首页、项目列表和当前项目 settings GET 均返回 200，`serviceAttached` 为 true。认证数据不写入本文。
- 独立 Chromium 浏览器加载真实 DSH，打开“设置 → AutoResearch”，确认页面渲染、当前项目选择和无插件加载错误。
- 核心 `npm test`：117/117；Web build 和 `npm test`：16/16；临时浏览器保存/冲突/重载测试通过。
- 实际 profile 验证只读取项目配置，没有提交配置修改或发起模型/研究任务。真实 CPA 端点、模型能力和原生请求预算验收仍未完成。

该结果只覆盖当前本机 web profile，不代表其他 DSH 版本或部署环境自动兼容。此前独立安装和打包产物的记录保留在 [本地复核记录](2026-09-09-verification.md)。
