# 发布版本号与 Git Tag 规范

本规范适用于 AutoResearch 仓库的源码发布、预发布和 GitHub Release。核心包与 Web 包作为同一产品同步发布；创建 Git tag、创建 GitHub Release 和发布到 npm 是不同操作，不互相隐含。

## 1. Tag 命名

产品发布统一使用小写 `v` 前缀：

| 类型 | 格式 | 示例 |
| --- | --- | --- |
| 正式发布 | `vMAJOR.MINOR.PATCH` | `v0.3.0` |
| 开发预览 | `vMAJOR.MINOR.PATCH-alpha.N` | `v0.3.0-alpha.1` |
| 功能测试版 | `vMAJOR.MINOR.PATCH-beta.N` | `v0.3.0-beta.1` |
| 候选发布版 | `vMAJOR.MINOR.PATCH-rc.N` | `v0.3.0-rc.1` |

版本主体遵循 [SemVer 2.0.0](https://semver.org/lang/zh-CN/)。本仓库进一步约定：预发布序号从 `1` 开始，同一阶段递增；版本数字不补零；发布 tag 不使用 `+build` 后缀，也不使用日期、中文、分支名或 `latest`、`final` 等别名。

允许的 tag 格式可用以下表达式检查；格式合法不代表版本递增或发布验收已经通过：

```regex
^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(alpha|beta|rc)\.[1-9][0-9]*)?$
```

预发布示例顺序为 `v0.3.0-alpha.1` → `v0.3.0-beta.1` → `v0.3.0-rc.1` → `v0.3.0-rc.2` → `v0.3.0`。可以跳过不需要的阶段；同一 tag 名称不得重复使用。

## 2. 如何选择版本号

按本次发布中影响最大的变更决定级别，不按提交次数或开发日期决定。

| 变更 | 当前 `0.x` 阶段 | `1.0.0` 及以后 |
| --- | --- | --- |
| 保持兼容的缺陷修复、小幅样式修正、性能修正 | PATCH，例如 `0.2.0` → `0.2.1` | PATCH，例如 `1.2.0` → `1.2.1` |
| 新增能力、工作流或明显的交互改版 | MINOR，例如 `0.2.0` → `0.3.0` | MINOR，例如 `1.2.0` → `1.3.0` |
| 不兼容的接口、配置、数据格式或宿主要求变化 | MINOR，并明确列出破坏性变更 | MAJOR，例如 `1.2.0` → `2.0.0` |

MINOR 递增时 PATCH 归零；MAJOR 递增时 MINOR 和 PATCH 归零。`0.x` 表示接口仍在演进，不代表可以在 PATCH 中悄悄破坏兼容性。首次 `1.0.0` 应以公共接口与升级约定已经稳定为依据。

兼容性判断包括工具参数和返回值、配置 schema、checkpoint/恢复、持久化数据与产物格式、导出接口，以及 Node.js、DSH、Cordis 的支持范围。提高最低宿主版本或移除既有支持也要按不兼容变更处理。

例如，科研工作台从聊天分屏调整为独立主页面属于交互能力改版，适合 MINOR；单独修复返回按钮失效通常属于 PATCH。纯文档、注释或测试整理默认随下一次发布交付，无需每次打 tag。维护旧版本分支时可以发布该维护线的新 PATCH，但不得复用已发布版本。

## 3. Tag 与包版本的一致性

对产品 tag `vX.Y.Z` 或 `vX.Y.Z-rc.N`，去掉开头 `v` 后的字符串必须与以下内容一致：

- `packages/autoresearch/package.json` 的 `version`。
- `packages/autoresearch-web/package.json` 的 `version`。
- 两个包各自 `package-lock.json` 中的根包版本记录，包括顶层 `version` 和 `packages[""].version`。
- Web 包对 `@athena/autoresearch` 的发布兼容声明。本仓库采用同步发布，该 peer dependency 固定为本次核心包的完整版本，预发布后缀也要一致。

Web 的本地开发依赖可以继续使用 `file:../autoresearch`；锁文件中若存在核心包版本记录，也应与实际解析结果一致。通过包管理器更新锁文件，不要全局替换所有依赖版本。DSH、Cordis、React 等依赖有各自的版本，不随产品版本机械改号。

`packages/dsh-cpa` 是可选配套工具，保留独立包版本。本规范的 `v...` tag 标记整个仓库快照，Release 说明应列出该快照中的 CPA 版本；不要求 CPA 随核心和 Web 一起改号，也不另设 `core-v...` 或 `web-v...` 标签。

**已有历史需保留：**2026-10-18 编写本规范时，本地已有附注标签 `v0.2.0`，其核心和 Web 包版本均为 `0.2.0`；当前工作树中的两个包版本为 `0.1.0`。下一次发版前必须将其统一到选定的新版本，不能根据工作树的旧版本号重新发行 `v0.1.x` 或覆盖 `v0.2.0`。这是一项发版前检查，本规范本身不修改包版本。实际发版时仍需同步远端 tag 后确认版本占用情况。

## 4. 发布前准备与验收

1. 确定发布范围和目标分支，整合本次代码；正式发布使用维护分支上的最终提交。不要在发布过程中顺带提交他人的无关修改，有混合改动时使用独立工作区整理发布。
2. 同步远端 tag，检查拟用名称未被占用，明确上一版本作为变更比较基线。
3. 更新核心、Web、锁文件及兼容声明；在 `docs/releases/<tag>.md` 写入本次发布说明，该目录不存在时创建。
4. 在最终发布内容上执行验收，并在说明中链接 `docs/verification/` 下的对应记录。版本更新、合并或修复若影响构建结果，应重新执行受影响检查。
5. 将版本和发布说明纳入提交。创建 tag 前工作树应干净，检查输出和记录必须对应最终待打标内容。

仓库根目录没有 npm scripts，以下命令从根目录逐条执行。PowerShell 默认不会因为上一条原生命令失败就停止；每条执行后都应检查退出码，失败时先处理，不要继续打 tag。

```powershell
# 产品发布的基础检查；核心 test 已包含 build。
npm --prefix packages/autoresearch run typecheck
npm --prefix packages/autoresearch test
npm --prefix packages/autoresearch-web run build
npm --prefix packages/autoresearch-web test

# 涉及 Web/UI 时执行。
npm --prefix packages/autoresearch-web run test:browser
npm --prefix packages/autoresearch-web run test:native-panel:browser
npm --prefix packages/autoresearch-web run test:workbench:browser
npm --prefix packages/autoresearch-web run test:literature:browser

# 涉及 CPA 时执行。
npm --prefix packages/dsh-cpa run typecheck
npm --prefix packages/dsh-cpa test
```

DSH/Cordis 依赖、预设或安装方式变化时，还需要运行核心 `check:dsh`，并用隔离 profile 验证实际宿主加载、预设和会话创建。涉及打包清单时，先构建，再对相关包执行 `npm pack --dry-run` 检查资源；如交付 `.tgz`，还应验证真实包在独立目录中的安装和使用。

RC 和正式发布要求发布范围内的必需检查通过。Alpha/Beta 可以明确披露尚未完成的能力与已知问题，但不能把失败、未执行或受环境阻塞的检查写成通过。构建或基本安装/启动失败时，不发行可安装版本。历史测试记录不能替代本次结果；宿主加载通过也不能宣称真实模型请求、科研流程或研究结论已经验证。

## 5. 更新版本、创建及推送 Tag

以下是 PowerShell 操作模板，`0.3.0-rc.1` 仅为示例，不代表已决定或已发布下一版本。推送步骤在代码整合、验收和版本提交完成后执行。

先核对远端和版本名称：

```powershell
git remote -v
git fetch origin --tags
# fetch 失败或出现同名 tag 冲突时，先停止并查清原因。
git tag --list

$releaseVersion = '0.3.0-rc.1'
$releaseTag = "v$releaseVersion"
git ls-remote --tags origin "refs/tags/$releaseTag"
# 上一条命令必须成功且无匹配；有匹配表示该版本已被占用。
```

只更新包版本，不让 npm 提前提交或打 tag。`--no-git-tag-version` 的行为见 [npm version 文档](https://docs.npmjs.com/cli/v11/commands/npm-version/)：

```powershell
npm --prefix packages/autoresearch version $releaseVersion --no-git-tag-version --ignore-scripts
npm --prefix packages/autoresearch-web version $releaseVersion --no-git-tag-version --ignore-scripts
```

随后按第 3 节更新 Web 的核心 peer dependency 和相关锁文件，检查 diff，执行第 4 节验收并提交。上述命令不会替代依赖一致性检查。版本准备提交建议命名为 `chore(release): v0.3.0-rc.1`。

发布 tag 必须使用附注标签（annotated tag），记录发布名称并指向明确 commit；已配置签名时可使用 `-s` 代替 `-a`。这与 [Git 对发布标签的建议](https://git-scm.com/docs/git-tag)一致。

```powershell
git status --short
# 确认无未提交内容，且 HEAD 是刚完成验收的最终发布提交。
$releaseCommit = git rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0) { throw '无法确定发布提交' }

git tag -a $releaseTag $releaseCommit -m "AutoResearch $releaseTag"
if ($LASTEXITCODE -ne 0) { throw '创建 tag 失败；不要覆盖已有 tag' }

git show --no-patch $releaseTag
git rev-parse "${releaseTag}^{commit}"
# 解引用后的 commit 必须等于 $releaseCommit。
```

确认当前分支是选定的发布分支，再显式推送该分支与这一个 tag：

```powershell
$releaseBranch = git branch --show-current
if ($LASTEXITCODE -ne 0 -or -not $releaseBranch) { throw '需要在选定的发布分支上推送' }

git push --atomic origin $releaseBranch "refs/tags/$releaseTag"
if ($LASTEXITCODE -ne 0) { throw '发布推送未完成，先检查远端状态' }

git ls-remote --tags origin "refs/tags/$releaseTag" "refs/tags/$releaseTag^{}"
# 对附注 tag，^{} 行是目标 commit；须与 $releaseCommit 一致。
```

不使用 `git push --tags` 批量推送无关标签，不使用 `--force`。远端不支持原子推送或出现非快进拒绝时，先处理发布分支与远端状态，不以强推绕过。

## 6. GitHub Release 与发布说明

GitHub Release 必须引用已经推送并核对过的 tag。使用 `--verify-tag` 可避免 tag 不存在时由 GitHub CLI 从默认分支自动创建标签，具体行为见 [gh release create 文档](https://cli.github.com/manual/gh_release_create)。

```powershell
# 预发布：先生成草稿，核对说明和附件。
gh release create $releaseTag --verify-tag --draft --prerelease --title "AutoResearch $releaseTag" --notes-file "docs/releases/$releaseTag.md"

# 正式发布使用无后缀版本，创建草稿时去掉 --prerelease。
# 草稿核对完成后发布。
gh release edit $releaseTag --draft=false
```

`alpha`、`beta`、`rc` 对应的 GitHub Release 必须标记为 prerelease；正式版使用不带后缀的 tag。预发布升级为正式版时，需要更新包版本、完成验收并新建正式 tag，保留之前的候选标签和记录。

发布说明至少包含以下内容；没有对应变更时写“无”，未验证时明确写“未验证”：

```markdown
# AutoResearch vX.Y.Z

- 发布日期：YYYY-MM-DD
- 上一版本：vA.B.C
- 包版本：core / web / CPA
- 已验证环境：Node.js / DSH / Cordis / 操作系统

## 主要变化
用户可见的新能力、修复及影响范围。

## 兼容性与升级
破坏性变更、配置或数据迁移、宿主要求、安装/回退步骤。

## 验证结果
检查命令、通过/失败/未执行状态及验收记录链接。

## 已知问题
限制、影响范围及可用的规避方式。
```

如附带 `.tgz` 或其他构建产物，只能从对应 tag 的源码生成，并记录文件名、对应版本和 SHA-256。不能用工作树中未提交的代码制作同名发布附件。源码 tag 或 GitHub Release 的存在不代表这些包已经发布到 npm；npm 发布需要另行安排。

## 7. 发布后的不可变性与回退

- 推送后的 tag 不删除、不移动、不重建；正式版和预发布版同样适用。
- RC 发现问题，修复后发布下一个 RC；正式版发现问题，按变更性质发布新的 PATCH、MINOR 或 MAJOR。
- 错误发布保留记录，在 Release 说明中注明问题和替代版本。不能通过改指向让旧版本名称代表另一套源码。
- 文字勘误可以补充 Release 说明；发布源码和同名构建附件不可静默替换。
- 回退使用已验证的旧 tag，并按该版本说明处理数据或配置兼容性；若主线需要撤销功能，提交 revert 后以新版本发布。
