# drawio MCP 能力最小化验证

验证 08-writing §5.3 的第一后端：drawio MCP。输入固定为 `fixture.md` + `fixture/figure_spec.json`。

## 1. 候选实现（官方 + 社区 fallback）

| 臂 | 实现 | 形态 | 关键能力 | 数据出机器？ |
|---|---|---|---|---|
| A | 官方 hosted MCP App Server `https://mcp.draw.io/mcp` | 远程 MCP | `search_shapes`（10k+ shapes）、`create_diagram`（XML → 内联视图/XML 文本） | 是 |
| B | 官方 Assistant Plugin（Codex CLI / Claude Code）+ 本地 draw.io Desktop CLI | 本地插件 + 本地导出 | 生成 `.drawio`，`--export png/svg/pdf --embed-diagram`，`--layout elk` / `libavoid` | 否 |
| C | 官方 Tool Server `npx @drawio/mcp` | 本地 stdio | `open_drawio_xml`（浏览器编辑器）、XML/CSV/Mermaid、v1.3+ libavoid | 否 |
| D | 社区 `bread-wood/drawio-mcp`（MIT） | 本地 stdio | `create_diagram/add_elements/add_connections/export_diagram/list_styles`，纯 XML 操作 | 否 |

数据政策：若宿主不允许图数据出机器，A 只做能力探测，不传正式内容；正式图只用 B/C/D。

## 1.5 安装与探测

> 本机已装 draw.io 26.0.16（winget 用户级安装，`C:\Users\80163\AppData\Local\Microsoft\WinGet\Links\DrawIO.exe`）。
> CLI 已验证可用：
> `DrawIO.exe --export --format png --embed-diagram --output out.png in.drawio`（exit 0）。
> 未来在新机器上按本表安装，执行 §1.5.2 的探测命令并把结果写 `runs/<date>/probe.md`。

### 1.5.1 安装

| 臂 | 安装 |
|---|---|
| A | 无安装；在 MCP host 添加远程 URL `https://mcp.draw.io/mcp` |
| B | 1) 安装 draw.io Desktop（https://www.drawio.com），确认 `drawio` 在 PATH；2) Codex：`codex plugin marketplace add jgraph/drawio-mcp` + `codex plugin add drawio@drawio`；Claude Code：`/plugin marketplace add jgraph/drawio-mcp` + `/plugin install drawio@drawio` |
| C | Node 20+：`npx @drawio/mcp`（或按 host 配置 stdio server） |
| D | `git clone https://github.com/bread-wood/drawio-mcp.git && cd drawio-mcp && npm install && npm run build`，在 MCP host 指向 `dist/index.js`；导出依赖 draw.io CLI |

### 1.5.2 探测命令

```bash
# 本地 draw.io CLI（B/D 的导出依赖）
where drawio          # Windows；Unix: which drawio
drawio --version
drawio --export --help

# C 工具服务器自检
npx @drawio/mcp --help

# A 远程 MCP：由 MCP host 发起握手，记录 tools 列表
```

探测结果记录到 `runs/<date>/probe.md`：

```text
drawio_cli: installed | missing | <version>
drawio_export: ok | fail
mcp_a_reachable: yes | no
mcp_c_handshake: yes | no
mcp_d_build: yes | no
```

任一缺失不阻塞实验，按 §2 步骤 8 记录降级路径即可。

## 2. 实验步骤（每臂）

1. **连通性**：MCP 握手成功，列出 tools。
2. **形状检索**：`search_shapes("neural network")` / `("database")` / `("agent")` 返回可用 style 字符串（A 独有；B/C/D 用 `list_styles` 或内置库替代）。
3. **生成**：用 `fixture.md` 描述生成 `.drawio` XML。
4. **结构自检**：XML 解析、元素数 ≥ 预计 80%、所有 label 为可编辑文本（非 image/foreignObject 截图）、无外部 URL 资源。
5. **布局**：
   - A：`create_diagram` 带 `postLayout: "elk"` 与默认各一份。
   - B：`drawio --layout elk` 与 `--layout libavoid` 各一份。
   - C：只测 libavoid（ELK 不支持）。
   - D：不测自动布局（记录为能力缺失）。
6. **导出**：
   - B：`drawio --export --format png --embed-diagram`、`svg --embed-diagram`、`pdf --embed-diagram`；解包检查 SVG/PDF 内嵌 XML 是否保留。
   - D：`export_diagram` PNG/SVG（依赖 draw.io CLI）。
   - A/C：只记录“不提供 headless 导出”，不判失败。
7. **视觉 QA**：vision reviewer 对每臂产物打分（布局/文字/图例/配色可读性 1–5）。
8. **降级路径**：
   - 本地 `drawio` CLI 缺失：验证 `.drawio` 文件保留 + 导出跳过 + 记录原因（08 §5.3 应回退 HTML/SVG）。
   - hosted MCP 不可达：A 记 FAIL(env)，B/C/D 继续。
9. **成本与耗时**：每臂记录 token 估算与 wall-clock。

## 3. 通过标准

| 能力 | 通过线 |
|---|---|
| MCP 连通与 tools 可用 | 至少 B/C/D 之一握手成功；A 单独记录 |
| 形状检索 | A：3/3 查询返回非空 style；否则 A 记 WARN |
| XML 生成 | 结构自检全过 |
| 可编辑性 | 所有 label 是 text 节点；导出 SVG/PDF 内嵌 XML（B） |
| 自动布局 | B/A 的 ELK 产物视觉分 ≥4；libavoid 无交叉（人工/vision 判定） |
| 导出 | B 产出 png+svg+pdf；D 产出 png/svg；缺失 drawio CLI 时降级记录正确 |
| 视觉分 | ≥4 才允许 drawio MCP 作第一后端；<4 → HTML/SVG 代码重建接替 |

## 4. 产物

```text
runs/<date>/
  arm_a/ arm_b/ arm_c/ arm_d/
  structural_check.json
  visual_scores.json
  verdict.md
```

`verdict.md` 固定结论行：

```text
drawio_mcp_first_backend: yes | no
chosen_impl: hosted | assistant-plugin | tool-server | bread-wood
chosen_reason: ...
fallback_needed: html-svg | native-svg | none
```

任何 FAIL → 追加 `../FAILURES.md`。

## 5. 与 08-writing 的联动

- 验证结果回写 08 §5.3 后端优先级：如果 B 通过而 A 因数据政策禁用，优先级写为“本地 drawio（plugin/CLI）→ HTML/SVG → native-svg”。
- 若全部 drawio 臂失败，08 §5.3 删除 drawio 优先级，直接 HTML/SVG。
