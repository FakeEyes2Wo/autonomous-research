# AutoResearch 科研工作台与迁移指南

入口：DSH 的「设置 → AutoResearch → 打开科研工作台」。也可访问当前 DSH 地址下的 `/autoresearch/`；地址和端口继承当前宿主。右上角「返回 DSH 工具区」回到原生界面。

## 日常使用

配置页默认只显示模型来源、研究强度、论文输出三个选项。默认沿用 DSH 的模型；自定义模型档位、角色、工作流和预算在「高级设置」中。已有高级配置不会因打开页面而重置；选择强度只调整运行预算、候选数量、复盘轮数，修改后需要保存。

工作台左侧是 LaTeX 源码，右侧是 PDF。选择项目与论文，或者点击「新建论文」。论文使用项目中的 `main.tex`，新论文放在 `paper/main.tex`，已有目录不会覆盖，下一篇为 `paper-2/main.tex`。可使用 Tab 插入缩进、Ctrl/Cmd + S 保存、Ctrl/Cmd + Enter 保存并编译。窄屏通过「LaTeX 编辑 / PDF 预览」切换。

保存有 revision 检查。如果 DSH 工具或另一窗口已经修改源文档，页面保留当前编辑并提示冲突，需先保留需要的文字再重新加载。编译失败保留上次成功的预览；源文档与预览不一致时会标记「预览较旧」。PDF 支持翻页、页码、缩放、适合宽度和下载。

成功的预览及版本信息保存于论文目录下 `.autoresearch-preview/`，与项目一起迁移；编译临时目录使用系统临时目录。查看或刷新页面不会启动编译。模型凭据仍在 DSH 原生 Models/credentials 中，本页不保存密钥。

## 可移植运行

运行要求：Node.js >= 22.19.0、DSH >= 0.1.5-alpha.1（当前实测锚点为 alpha.1）、现代浏览器。PDF.js、字体映射和 WASM 随 Web 插件打包，浏览器不依赖 CDN；实际编译使用单独安装的 Tectonic。

在新电脑安装相应操作系统的 [Tectonic](https://tectonic-typesetting.github.io/en-US/install.html)，将可执行文件加入 PATH。终端中 `tectonic --version` 可用于检查。Tectonic 首次编译可能下载 TeX 资源，使用已缓存资源后可以离线编译相应文档；项目使用的中文字体、额外宏包仍需新环境具备。

编译器选择顺序：Web 插件的 `workbench.compiler` → `TECTONIC_PATH` 环境变量 → PATH 中的 `tectonic`。不内置特定盘符或用户目录，不强制本机代理；需要代理时使用环境变量。缺少编译器时仍可编辑、保存、读取已有预览，只禁用新编译。

可移植的宿主配置示例（`cordis.patch.yml` 中 Web 插件的 config）：

```yaml
projects:
  - id: my-research
    name: 我的研究
    root: .
# 通常不需要以下配置。确需指定编译器时填写本机可执行文件路径：
# workbench:
#   compiler: /path/to/tectonic
```

相对 `root` 按 **启动 DSH 时的工作目录** 解析。因此使用 `root: .` 时应先进入研究项目，再运行 `dsh web`。若希望从任何目录启动 DSH，则在该电脑的宿主配置中登记项目绝对路径；路径属于宿主配置，不写入论文或项目策略。

从源码迁移时重新安装依赖并构建，不复制旧电脑的 `node_modules`：

```sh
npm --prefix packages/autoresearch install --ignore-scripts --legacy-peer-deps
npm --prefix packages/autoresearch run build
npm --prefix packages/autoresearch-web install --ignore-scripts --legacy-peer-deps
npm --prefix packages/autoresearch-web run build
```

再按 [Web 包安装说明](../../packages/autoresearch-web/README.md) 将两个本地包接入新电脑 DSH profile，并重新登记项目目录。依赖 PDF.js 的开发资源已经复制到 `dist/vendor/pdfjs`，构建后的 Web 包运行时无需访问源码仓库中的 PDF.js `node_modules`。

也可在两个包目录分别运行 `npm pack`，把构建后的 `.tgz` 包带到另一台机器安装。源包尚未发布到 npm，不能假设执行 `npm install @athena/autoresearch-web` 会取得本仓库版本。DSH 宿主依赖仍由对应版本的 DSH 提供。

## 范围与验证

本次实际测试与部署结果见 [验收记录](../verification/2026-09-09-workbench-verification.md)。

当前工作台发现项目根目录或直接子目录下的 `main.tex`，编辑该论文入口。同目录的宏包、参考文献和图片可随论文参与编译；多文件章节可以由 DSH 工具编辑。论文资源应放在论文目录内，快照不包含上级目录文件。本次不包含文献搜索阅读器、多人协作、全文检索、SyncTeX 或网页端任意文件管理。

实现使用跨平台 Node 文件与进程接口，并针对相对路径、编译器缺失、包内资源和项目迁移进行验证。真实桌面和窄屏浏览器验证在 Windows 上执行；不把这些结果描述为已经在 macOS/Linux 实机验收。

编译通过 Tectonic 的 `--untrusted` 禁用已知危险能力，命令和参数由服务器固定，不接受浏览器命令。该选项的具体边界见 [Tectonic compile 文档](https://tectonic-typesetting.github.io/book/latest/v2cli/compile.html)。

GPT Pro 自用连接方法见 [CLIProxyAPI 接入指南](2026-09-09-cliproxy-pro-guide.md)。
