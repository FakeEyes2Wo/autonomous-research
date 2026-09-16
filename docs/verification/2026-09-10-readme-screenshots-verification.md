# README 与界面截图验证记录

日期：2026-09-10。状态：`passed`。

## 交付范围

- 根 `README.md` 已整理为中文公共入口，覆盖源码安装、核心与可选 Web/CPA、对话与 headless 用法、`minimal|legacy`、实验工程与科学协议、pre-work gate、`PAUSED`/恢复、产物 provenance 和排错。
- 三张 PNG 均由当前 Web 构建实际渲染；示例项目、论文和聊天是本地测试 fixture/mock，不是真实研究或模型输出。
- 没有修改生产/runtime、现有测试、依赖、lockfile、DSH profile 或 provider 配置；没有模型请求或研究重跑。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `npm --prefix packages/autoresearch test` | parent fresh run：exit 0；155 passed，0 failed/cancelled/skipped/todo；命令包含 build |
| `npm --prefix packages/autoresearch run typecheck` | parent fresh run：exit 0 |
| `npm --prefix packages/autoresearch-web test` | parent fresh run：exit 0；60/60 |
| `npm --prefix packages/autoresearch-web run test:browser` | 受限沙箱中的浏览器 CDP 在 `Runtime.enable` 超时；未改源码或超时配置。获批的沙箱外隐藏浏览器重试 exit 0，`status: passed` |
| `npm --prefix packages/autoresearch-web run test:workbench:browser` | 同类受限沙箱 CDP 超时后，获批的沙箱外隐藏浏览器重试 exit 0；`realLatexCompilation=true`、`pdfRendered=true`、`nativeChatBridgeMock=true` |
| `node .runs/readme-screenshots/capture-success-mobile.mjs` | 沙箱内 `Runtime.enable` 超时；获批重试 exit 0。390×844、`preview=与已保存内容一致`、`build=编译成功`、第 1 页已渲染、对话已通过界面按钮折叠 |
| `pandoc README.md --from=gfm --standalone --embed-resources --resource-path=. --metadata title="AutoResearch README preview" --output=.runs/readme-screenshots/README-preview.html` | exit 0、无警告；三张 PNG 均成功内嵌，生成本地自包含预览，不提交该 HTML |

浏览器重试均使用 loopback 临时项目和隐藏子进程。超时属于受限浏览器环境差异，获批重试使用相同仓库构建及夹具；没有通过放宽测试断言或编辑应用来掩盖失败。

## 最终图片

| 文件 | 尺寸 | 字节 | SHA-256 |
|---|---:|---:|---|
| `docs/assets/autoresearch/settings.png` | 1440×1200 | 85,229 | `96BA3250DCB48F514C2A92F1E6195CFEC48E1EBF9291E4DCC9204DF42904AE7B` |
| `docs/assets/autoresearch/workbench-desktop.png` | 1440×1100 | 84,489 | `D061651958EC479A1CB4E997A30C914FE0411B2684FFCC9D51206CAE499FC72B` |
| `docs/assets/autoresearch/workbench-mobile.png` | 390×844 | 31,228 | `122DFE8D4365A8C09015B462625708343EE95D9A0864E9F42FC87F43033AAE9E` |

`settings.png` 来自 `<temp>/autoresearch-web-browser-profile-*/dsh-autoresearch-settings.png`；桌面图来自 `<temp>/autoresearch-workbench-browser-*/workbench-desktop.png`。标准 workbench 测试的移动图故意处于旧 PDF/同步发现流程之后，因此没有用作公共主图；最终移动图由忽略目录内的 adapter 在同一真实 UI 成功编译状态捕获，未编辑图片像素。

## 视觉与内容检查

Parent 已逐张验收最终文件：

- settings：内容可读，无凭据或不相关项目数据；最终哈希与已查看原图一致；
- desktop：LaTeX/PDF 工作台状态和桌面构图可读，无私密信息；最终哈希与已查看原图一致；
- mobile：390×844，显示“与已保存内容一致”，PDF 标题/正文、导航和折叠后的科研对话栏可见，无私密数据；
- 三图均明确属于 sample/test fixture 与 mock chat，不表示真实 DSH/provider/model 成功。

Markdown 自查确认：截图 alt/caption、标题层级、表格和代码块可读；快速导航的 7 个锚点均匹配 Pandoc 生成的标题 ID（包括 `minimal-与-legacy完整workflow`）；文档链接仅指向本次跟踪交付、两个 package README 与对话式工作台指南。公共文件不记录本机绝对临时路径、用户名、密钥或真实用户项目名。自包含预览位于忽略目录 `.runs/readme-screenshots/README-preview.html`，只用于发布前本地查看。
