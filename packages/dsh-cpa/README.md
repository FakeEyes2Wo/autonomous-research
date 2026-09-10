# @athena/dsh-cpa

可选的 CPA（CLIProxyAPI）接入包。它只编译 DSH 原生
@deepseek-ai/dsh-llm-pi-ai 的 llm-pi-ai 路由配置，不实现第二套 HTTP/SSE
客户端，也不创建 Agent Runtime。DSH 0.1.5-alpha.1 的 dsh-base 已经挂载
llm-pi-ai，所以 CPA 只需要写入用户 settings。

## 配置

复制 presets/cpa.cordis.yml 到安全位置，确认 CPA 的真实模型别名，然后通过
apiKeyEnv: CPA_API_KEY 引用 credential/env。配置中只允许
openai-responses 和 openai-completions，协议不会静默切换。gpt-self 是
示例别名，必须替换成 /models 或 CPA 实际接受的模型 ID。

## 安装器

所有命令默认只做 dry-run；只有显式 --apply 才写入 DSH_HOME/settings.yaml。
安装器维护 DSH_HOME/.athena-dsh-cpa.json，仅保存自己管理的 route 指纹，不保存密钥。

    # 先检查配置并查看计划
    node scripts/install.mjs --config .\my-cpa.yml

    # 明确确认后写入
    node scripts/install.mjs --config .\my-cpa.yml --apply

    # 只移除仍未被手工修改的自有 route
    node scripts/install.mjs --uninstall --apply

如果已有同名但非本安装器管理的 route，安装会报告冲突并拒绝覆盖。安装后手工
修改过的 route 也不会被更新或卸载；请先备份并人工处理。写入会保留 settings
中其它 namespace 和其它 provider，目标文件在替换前留有带时间戳的备份。

## Doctor

静态检查不会联网，也不会读取或打印 credential 值：

    node scripts/doctor.mjs --config .\my-cpa.yml

只有显式指定 --network 才会针对配置内每个 route 请求该 route 的
GET <baseURL>/models。请求禁止重定向，有 5 秒超时；返回结果只说明 HTTP
可达性，不把模型能力或高 reasoning 当作已验证。网络错误使用受控错误码，不回显
底层异常和凭据。

## 设计边界

- CPA 路由通过单个 DSH pi-ai 实例注册，运行时仍由 DSH credentials 和
  llm-pi-ai 负责请求。
- apiKeyEnv 是 credential/environment 引用名，不是 API key。
- cpa-gpt 和 cpa-gpt-deep 是独立 route；深度 route 的 reasoning 默认只在
  显式配置并经实际端点验证后使用。
- 该包不修改全局 DSH node_modules，不连接真实账户，测试只使用临时目录和 mock
  fetch。

Runtime limitation: the installer only writes the user settings routes. It does not claim
that DSH is running or that CPA is reachable. The selected DSH profile must compose the
0.1.5-alpha.1 dsh-base bundle, which owns the single native llm-pi-ai instance. This package
does not modify bundles, global node_modules, or a runtime registry.
