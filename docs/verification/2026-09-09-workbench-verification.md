# 科研工作台验收记录 · 2026-09-09

本记录覆盖用户新增的精简配置页、LaTeX/PDF 科研工作台、返回原生 DSH 和可移植性要求。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 核心 `npm test`（含重新构建） | 121 / 121 通过 |
| 核心 `npm run typecheck` | 通过 |
| Web `npm test` | 25 / 25 通过 |
| Web 构建 | 通过，PDF.js 静态资源与许可已打包 |
| 精简配置页浏览器回归 | 通过，含真实保存、校验、空数字恢复默认、409、未保存离开提示、390px 视口 |
| 工作台真实 Tectonic + PDF.js 浏览器回归 | 通过，含保存、实际 PDF 文本与 canvas、Range、失败保留旧预览、冲突保留草稿、返回宿主 |
| 插件与项目整体迁移 | 通过：复制 dist 与项目到全新目录，无原 node_modules，重建宿主后能预览持久化 PDF |
| 迁移环境缺少编译器 | 通过：禁用新编译，仍能编辑、保存和读取已有 PDF |
| `npm pack --dry-run` | 228 个文件，约 2.67 MB；工作台入口、PDF.js main/worker/资源/许可齐全 |
| 真实 DSH 0.1.5-alpha.1 | 通过：原生设置 → AutoResearch → 工作台 → 返回 DSH 工具区；高级设置默认折叠，无插件加载错误 |

真实 DSH 已更新并运行在 `http://127.0.0.1:3080/`。本次最后启动的进程 PID 为 `141648`，日志位于宿主备份目录 `web-autoresearch-20260909-193113/dsh-web-8.*.log`。日志中的登录 token 不进入仓库或本记录。

## 复核修复

- 编译请求统一 `expectedRevision`，PDF DTO 带 `sourceRevision`。
- 保存按文档串行，两个相同 revision 的并发提交只允许一个成功。
- 同一文档只允许一个运行/排队构建，防止 PDF 与版本 metadata 交错发布。
- 编译安全快照限制扩展名、文件数、目录数、深度及总大小，跳过依赖和生成目录。
- 构建临时目录创建使用共享 Promise；停止插件时等待运行任务退出后清理，完成后清除单次构建临时文件。
- 严格 JSON MIME、同源/CSRF、opaque ID、symlink 校验、PDF magic/大小/Range 和受控错误输出。
- 删除核心 engine/headless 中固定 Windows 路径和默认 `7890` 代理；使用 PATH、`TECTONIC_PATH`、`BROWSER_PATH` / `CHROME_PATH` 与调用环境。

## 重现命令

```sh
npm --prefix packages/autoresearch test
npm --prefix packages/autoresearch run typecheck
npm --prefix packages/autoresearch-web run build
npm --prefix packages/autoresearch-web test
npm --prefix packages/autoresearch-web run test:browser
npm --prefix packages/autoresearch-web run test:workbench:browser
```

浏览器测试通过 PATH/平台标准位置查找 Chromium、Chrome 或 Edge，也支持 `BROWSER_PATH` / `CHROME_PATH`。工作台完整浏览器验证需要 Tectonic；可用 PATH 或 `TECTONIC_PATH` 提供。

真实宿主只读导航验收使用 `packages/autoresearch-web/test/verify-live.mjs`，通过 `DSH_LIVE_LOG` 提供本次已启动 DSH 的日志路径；该脚本不修改 profile、不调用模型、不打印认证信息。

真实操作系统验收在 Windows 完成；没有声称已在 macOS/Linux 实机运行。CLIProxyAPI 的 OAuth 和 DSH 连接方式已核验并记录于 [接入指南](../guides/2026-09-09-cliproxy-pro-guide.md)，未代用户登录、读取认证文件或发起付费模型请求。
