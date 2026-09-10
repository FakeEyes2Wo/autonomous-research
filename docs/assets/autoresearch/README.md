# AutoResearch README 截图

更新日期：2026-09-10。

本目录的 PNG 来自仓库当前构建产物和本地浏览器夹具，用于展示实际界面，不是设计稿。所有项目、论文和聊天内容均为测试示例；截图过程没有连接真实 DSH profile、provider 或模型，没有发起模型请求，也没有运行科研任务。

| 文件 | 尺寸 | 来源与状态 |
|---|---:|---|
| `settings.png` | 1440×1200 | `test/browser-render.test.mjs` 的临时 settings fixture |
| `workbench-desktop.png` | 1440×1100 | `test/workbench-browser.mjs` 的临时 mock host；成功编译与 PDF 渲染状态 |
| `workbench-mobile.png` | 390×844 | 同一构建、host contract 与 Tectonic 路径的成功态临时 capture adapter；通过真实界面切换 PDF、折叠科研对话后截图 |

标准复现命令：

```powershell
npm --prefix packages/autoresearch-web run build
npm --prefix packages/autoresearch-web run test:browser
npm --prefix packages/autoresearch-web run test:workbench:browser
```

标准 workbench 测试的移动截图有意覆盖旧 PDF、外部更新和新论文发现状态，因此 README 中的移动主图改在成功编译后立即捕获。临时 adapter 位于被 `.gitignore` 排除的 `.runs/readme-screenshots/`，只编排已构建的 Web 包、loopback 临时项目、mock 原生聊天 bridge 和隐藏浏览器；它不修改生产源码、现有测试、依赖或 lockfile，也不编辑截图像素。

这些图片只能说明相应本地 UI 状态被实际渲染。它们不证明真实 DSH 部署、真实 provider/CPA 连通性、模型能力、科研执行或科学结论。
