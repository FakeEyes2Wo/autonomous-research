# DSH 对话式科研工作台

从 DSH 左上角「科研工作台」进入，或打开当前 DSH 地址的 `/?autoresearch=1`。左侧保留 DSH 原生工作区与会话导航，右侧上方是 LaTeX / PDF，下方是原生科研对话。

## 切换科研目录与新建会话

原生左栏中的一个工作区目录就是一个科研项目。点击目录名称只会展开或折叠它的会话列表，不会改变当前项目。要切换目录，可以选择该目录下的已有会话；空目录或需要全新会话时，先进入科研工作台，再点目标目录行右侧的 `+`。工作台会在所点目录中创建一个全新的 AutoResearch 会话，不会复用其他目录记住的科研会话。顶部「新会话」在工作台中同样使用当前选中的原生工作区。

等待新会话自动选中后再开始研究。左栏目录、论文区右上角项目名，以及原生输入框上方的目录名应当一致；模式应显示 `AutoResearch`。返回工具区后，原生新建会话恢复 DSH 自己的默认模式。

论文区使用 DSH 的主题颜色和字体。底部对话左右及底边保留约 16 px，拖动分隔线可改变高度，聚焦分隔线后也可用上下方向键调整；「收起」只收起对话区域。窄屏会在主栏过窄时折叠原生侧栏，用户仍可手动展开导航，论文区可切换源码与 PDF。返回工具区会清理由工作台临时施加的布局状态，并保留用户自己的侧栏习惯。

## 生成与反复修改

1. 在「生成论文」填入的原生草稿中补充研究主题、数据和评价标准，然后发送。快捷按钮不会自动发送请求。
2. AutoResearch 将运行产物放在当前项目的 `.runs/<run>/paper/` 或 `runs/<run>/paper/`。工作台发现新论文后给出打开提示；当前已有论文不会被静默切换。
3. 保存本地编辑，再点「改进论文」或「检查论证」。指令会带入当前论文的相对路径，在同一原生会话里继续讨论。已完成的研究无需为了改稿重新恢复运行。
4. 文件被工具更新后，未编辑的源码会同步；有未保存草稿时只提示，保留草稿。点击「查看最新内容」前会确认是否放弃未保存修改。
5. 「保存并编译」显式生成 PDF。若 AutoResearch 已生成 `main.pdf`，可直接只读预览；未经验证的源文件对应关系会在预览栏说明。

「返回工具区」保留当前会话身份。原生左栏选中的工作区目录就是当前论文项目；没有独立的项目登记或项目选择器。未选择工作区时论文区显示空状态。切换工作区时，本页内存会保留每个工作区未保存的草稿、所选论文和版本基线；回到该工作区会恢复草稿。若磁盘版本已变化，下一次保存会使用原有版本基线执行冲突检查，草稿不会自动写回文件。

## 可移植性

- 插件通过 DSH 公共 slots、sessions 和原生 conversation 接入，不修改全局 DSH 包。
- 原生主栏布局以 DSH `0.1.5-alpha.1` 的公开 data 属性为兼容锚点；升级 DSH 后应复跑实机验收。
- 原生 DSH workspace registry 是生产环境唯一的目录来源；一个原生 workspace 目录就是一个项目。论文 iframe 仅在同源父页面发出 `select-project` 后使用 opaque project ID。`standaloneProjects: true` 与 `projects` allowlist 只用于没有原生 registry 的显式 standalone test-host fallback。
- 所有文档和 PDF 访问都校验 canonical root，浏览器不提交任意文件路径、模型密钥或项目绝对路径。父页面拥有原生会话和工作区监听；iframe 只回传论文 context。
- PDF.js 随插件打包，编译器使用配置、`TECTONIC_PATH` 或 `PATH`。迁移后不要求原机器端口、代理、浏览器或目录结构。
- 独立论文页面仍位于 `/autoresearch/`；主要入口是保留 DSH 左栏的原生工作台。

## 验证命令

```powershell
npm --prefix packages/autoresearch-web run build
npm --prefix packages/autoresearch-web test
npm --prefix packages/autoresearch-web run test:browser
npm --prefix packages/autoresearch-web run test:workbench:browser
```

实机脚本 `packages/autoresearch-web/test/verify-live.mjs` 从 `DSH_LIVE_LOG` 指定的本地启动日志读取登录地址，只在内存中使用认证。该验收检查原生入口、真实 PDF、侧栏、会话草稿和返回同一会话；快捷指令只写入草稿，不发送真实模型请求，也不修改用户论文。

2026-09-10 的实机验收在 390×844 下得到 56 px 原生导航 rail 和 334 px 可见论文区。手动展开导航后 observer 不会立即折回；选中同一科研会话并关闭导航后论文区恢复，回到桌面并退出仍返回同一会话和草稿。统一 Web 测试为 57/57，设置浏览器检查、pending PDF 专项、完整 workbench browser 和真实 DSH 验收均通过。嵌入页确认退出后只在一秒内抑制紧随其后的 iframe 重复 `beforeunload`；取消退出或窗口过期后，未保存草稿仍受保护。
