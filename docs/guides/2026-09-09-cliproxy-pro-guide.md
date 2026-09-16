# 用 CLIProxyAPI 的 ChatGPT 登录接入 DSH（可移植指引）

更新日期：2026-09-09。本文只说明用户自行部署 CLIProxyAPI、再把本机路由登记到 DSH Models 的连接方式。仓库中的 `@athena/dsh-cpa` 是可选的 DSH 配置适配包：它编译和安装 `llm-pi-ai.providers` 路由，不安装或启动 CLIProxyAPI，也不代替 DSH 的 credentials 管理。

## 先分清两种凭据

CLIProxyAPI 的 Codex OAuth 登录使用 ChatGPT 账号。完成登录后，CLIProxyAPI 在自己的 `auth-dir` 中保存上游认证状态；这个 OAuth 状态不能复制到 DSH 的 API key 字段，也不能当作 OpenAI Platform API key。

CLIProxyAPI 的 `api-keys` 是**本机代理的客户端访问 key**。DSH Models 的 API key 字段填写其中一个本地代理 key，DSH 通过 credentials 保存它，发给 `http://127.0.0.1:8317/v1`。因此，示例中的 `REPLACE_WITH_LOCAL_PROXY_KEY` 必须由用户在本机替换成自己的值，本文不生成真实秘密。

OpenAI 官方文档把 Codex 的两种登录方式定义为“用 ChatGPT 登录以使用订阅访问”和“用 API key 按用量访问”。用 ChatGPT 登录时 Codex 使用 ChatGPT 工作区的权限、额度和计费；用自己的 API key 则按 API pricing 计费。[OpenAI Codex authentication](https://developers.openai.com/codex/auth/)（当前重定向至 [ChatGPT Learn authentication](https://learn.chatgpt.com/docs/auth)）和 [OpenAI Help：ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275/) 说明了这一点。ChatGPT 与 API 平台本身也是两套独立的计费系统。[OpenAI Help：Managing billing for ChatGPT and the API platform](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform)

这不构成“Pro 可无限调用”或“ChatGPT 网页上能看到的每个模型都能通过代理调用”的承诺。模型可见性、Codex 额度、工作区权限和服务端策略都可能不同；配置前以代理返回的当前 `/v1/models` 列表为准。

## 1. 准备 CLIProxyAPI 配置

Windows 官方 Quick Start 建议下载 release 后直接运行；macOS 和 Linux 也可以使用官方列出的安装方式。为便于迁移，建议把代理配置文件和认证目录放在项目目录之外，并在启动时显式传入 `--config`。下面的文件只有占位客户端 key：

```yaml
# 放在项目目录之外，例如 Windows 的 C:\Users\<user>\.cli-proxy-api\config.yaml
# 不要把真实 api-keys 或 auth-dir 下的认证文件提交到仓库。
host: "127.0.0.1"
port: 8317
auth-dir: "~/.cli-proxy-api"
api-keys:
  - "REPLACE_WITH_LOCAL_PROXY_KEY"
```

`127.0.0.1` 将服务限制在本机；如果确实要让其他机器访问，必须自行评估网络边界并显式改 host 和访问控制。8317 是 CLIProxyAPI 官方示例端口。`auth-dir` 是 OAuth token 的保存位置，应该位于用户私有目录并与仓库分开。`api-keys` 列表中的值只用于“客户端 → 本机代理”这一跳。

字段含义和默认配置见 [CLIProxyAPI Basic Configuration](https://help.router-for.me/configuration/basic)；认证文件用途见 [CLIProxyAPI Authentication Directory](https://help.router-for.me/configuration/auth-dir)。

## 2. 让 CLIProxyAPI 完成 ChatGPT 登录

在 CLIProxyAPI 可执行文件所在目录运行。Windows PowerShell 的 release 文件名通常为 `cli-proxy-api.exe`：

```powershell
.\cli-proxy-api.exe --config "$HOME\.cli-proxy-api\config.yaml" --codex-login
```

如果配置文件就在当前目录，可简写为：

```powershell
.\cli-proxy-api.exe --codex-login
```

无图形浏览器时，使用：

```powershell
.\cli-proxy-api.exe --config "$HOME\.cli-proxy-api\config.yaml" --codex-login --no-browser
```

命令会打印登录 URL；在可用浏览器中完成 ChatGPT 登录。CLIProxyAPI 官方说明本地 OAuth 回调使用端口 `1455`，所以 headless、远程端口转发或防火墙配置必须允许这条本机回调路径。[CLIProxyAPI Codex（OpenAI via OAuth）](https://help.router-for.me/configuration/provider/codex)

启动代理服务时使用同一份配置：

```powershell
.\cli-proxy-api.exe --config "$HOME\.cli-proxy-api\config.yaml"
```

macOS/Linux 的二进制命令为 `./cli-proxy-api`，其余参数相同：

```bash
./cli-proxy-api --config "$HOME/.cli-proxy-api/config.yaml" --codex-login
./cli-proxy-api --config "$HOME/.cli-proxy-api/config.yaml" --codex-login --no-browser
./cli-proxy-api --config "$HOME/.cli-proxy-api/config.yaml"
```

官方 Quick Start 还列出 macOS Homebrew 服务、Linux 安装脚本/AUR，以及从源码构建时 Linux/macOS 使用 `cli-proxy-api`、Windows 使用 `cli-proxy-api.exe`。这些是代理自身的部署选择，不改变 DSH 的连接字段。[CLIProxyAPI Quick Start](https://help.router-for.me/introduction/quick-start)

## 3. 先从代理获取真实模型 ID

确认代理已启动后，再查询本机模型目录。PowerShell 示例仍使用占位 key：

```powershell
$proxyKey = 'REPLACE_WITH_LOCAL_PROXY_KEY'
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:8317/v1/models' `
  -Headers @{ Authorization = "Bearer $proxyKey" }
```

macOS/Linux：

```bash
curl -fsS \
  -H 'Authorization: Bearer REPLACE_WITH_LOCAL_PROXY_KEY' \
  http://127.0.0.1:8317/v1/models
```

从响应中逐字选择当前真实的 model `id`。不要把 `gpt-self`、某个网页模型名称或本文示例当成可用 ID；仓库 preset 中的 `gpt-self` 只是示例别名。`/v1/models` 能证明目录返回了什么，不能单独证明工具、图片输入、reasoning 或上下文容量一定可用。

## 4. 在 DSH Settings → Models 填写连接

DSH 的原生 Models 页面管理连接和凭据，AutoResearch 页面只保存项目对 `provider/model` 的引用。当前仓库记录的实际表单字段如下：

| DSH Models 字段 | 示例填写 | 规则 |
| --- | --- | --- |
| Provider ID | `cpa-gpt` | 小写字母开头、唯一；创建后作为项目引用的一部分 |
| Display name | `CPA GPT` | 仅用于显示 |
| API | `openai-responses` | 首选；代理必须支持 Responses 协议 |
| Base URL | `http://127.0.0.1:8317/v1` | 与代理 host/port 对应，末尾不要再拼 `/models` 或 `/responses` |
| API key | `REPLACE_WITH_LOCAL_PROXY_KEY` 的实际本地代理 key | 这是代理客户端 key，交由 DSH credentials 保存；不填 OAuth token 或上游管理 key |
| Models | 第 3 步返回的真实 `id` | 可获取或手工登记；不要猜 ID |
| Context window / Max tokens | 按实际部署填写 | 目录存在不等于容量已验证 |

如果部署只提供 Chat Completions，API 字段可以明确选择 `openai-completions`；协议失败不会由适配器静默切换。一个 provider route 只应使用一种协议。先保存 CPA route 和 credentials，再在 AutoResearch 的“模型分档”中为 `cheap`、`standard`、`deep` 选择已登记的 provider/model 对。

DSH 宿主 settings 通常位于 `.dsh/settings.yaml`，实际路径以宿主配置为准；项目文件只保存策略引用，不保存模型密钥。对应的原生配置形状如下，模型 ID 仍须替换为第 3 步的实际值：

```yaml
llm-pi-ai:
  providers:
    cpa-gpt:
      displayName: CPA GPT
      api: openai-responses
      baseURL: http://127.0.0.1:8317/v1
      apiKeyEnv: CPA_API_KEY
      models:
        - id: <MODEL_ID_FROM_V1_MODELS>
          contextWindow: <DEPLOYMENT_VALUE>
          maxTokens: <DEPLOYMENT_VALUE>
          input: [text]
```

这里的 `apiKeyEnv: CPA_API_KEY` 是 DSH credential/environment **引用名**，不是把 key 写进 YAML。使用 `@athena/dsh-cpa` 时，适配器配置中的 `credentialRef: CPA_API_KEY` 会映射为这个原生字段。

## 5. 可移植运行方式与仓库边界

迁移到另一台机器或操作系统时，只需重新部署对应的 CLIProxyAPI binary/服务，复制一份不含真实秘密的配置模板，选择新的私有 `auth-dir`，重新完成该机的 ChatGPT 登录，然后重新查询 `/v1/models` 并登记实际 ID。不要把 OAuth token、`auth-dir` 内容、代理客户端 key 或 DSH credentials 放进 Git、项目 YAML、URL、日志或截图。

本机当前只核对到：PATH 中没有 `cli-proxy-api`/`cli-proxy-api.exe` 命令，进程列表中没有匹配的 CLIProxy 进程。这不能证明整台机器未安装；安装位置、GUI 服务或其他用户目录尚未确认。本文没有读取任何 auth/config/credentials 文件，也没有启动代理、修改真实 DSH profile、登录账号或发起模型请求。

仓库内的 CPA 适配器只做本地配置契约、安装器和诊断：静态 doctor 不联网；显式 `--network` 时只检查配置 route 的 `<baseURL>/models`，且不是模型调用。当前仓库验收仍把真实 CPA endpoint/model smoke 单独列为 pending，因此本指南完成的是连接准备与字段映射，不能替代用户自己的小额、明确授权的真实端点验收。

## 官方资料

- [CLIProxyAPI Codex provider：`--codex-login`、`--no-browser`、1455 回调](https://help.router-for.me/configuration/provider/codex)
- [CLIProxyAPI Basic Configuration：`host`、`port`、`auth-dir`、`api-keys`](https://help.router-for.me/configuration/basic)
- [CLIProxyAPI Authentication Directory](https://help.router-for.me/configuration/auth-dir)
- [CLIProxyAPI Quick Start：Windows、macOS、Linux 与源码构建](https://help.router-for.me/introduction/quick-start)
- [OpenAI Codex authentication：ChatGPT 登录与 API key 登录](https://developers.openai.com/codex/auth/)
- [OpenAI Help：ChatGPT Work and Codex 的额度/计费区别](https://help.openai.com/en/articles/20001275/)
- [OpenAI Help：ChatGPT 与 API 平台独立计费](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform)
