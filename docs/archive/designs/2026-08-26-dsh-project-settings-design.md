# DSH 插件项目设置页设计

日期：2026-08-26
状态：design
目标：为当前 project 提供项目级设置能力，并接入 AutoResearch / Experiment 链路。

> 当前实现是 **DSH 插件**，不是独立 Web 应用。因此设置能力必须优先走 DSH 插件可提供的机制：
> 工具（tools）、命令（commands）、配置文件（cordis/config），以及 DSH 设置页如有插件扩展点则复用。

---

## 1. 结论先行

- 可以复用 DSH 设置页里的“模型 part”，但**不应复制一份模型配置**。
- 项目设置页应该只保存“项目特有”的配置，并通过 `modelProfileId` / `useGlobalModel` 引用现有模型配置。
- 如果 DSH 设置页暂时不支持插件自定义页面，则退化为：
  - 插件提供 `project_settings_get` / `project_settings_save` 工具；
  - DSH Agent 或手动命令可以读取/修改项目设置；
  - DSH UI 可将工具调用渲染成设置卡片。

---

## 2. 项目设置数据模型

```ts
export interface ProjectSettings {
  version: 1

  paperExploration: {
    maxPapers: number            // 最大探索 paper 数
    minSurveys: number           // 最少找到的综述数
    minClusters: number          // 最少子方向数
    latestWindowYears: number    // 最新文献时间窗口
    latestPerDirection: number   // 每个方向最新论文数
    maxSelectedDirections: number // 最多选择方向数
  }

  figureApi: {
    enabled: boolean
    apiUrl: string
    apiKey?: string              // secret
    model?: string               // 外部生图模型
    timeoutMs?: number
  }

  model: {
    useGlobal: boolean           // true = 复用 DSH 设置页模型 part
    profileId?: string           // 引用全局模型配置 ID
    overrides?: {
      provider?: string
      model?: string
      baseUrl?: string
    }
  }

  experiment: {
    maxRounds?: number
    profile?: string
  }
}
```

---

## 3. 存储位置

DSH 全局配置在用户 profile 下，例如 `setting.yaml`；项目级设置不要写进 DSH 全局 `setting.yaml`，而是放在项目本地：

```text
<project>/
  .autoresearch/
    project-settings.yaml        # 项目设置（非 secret 部分）
    project-secrets.yaml         # 仅 API Key 等敏感信息
```

- `project-settings.yaml` 可进入项目 git（可选）。
- `project-secrets.yaml` 必须加入 `.gitignore`。
- 如果 DSH 本身有项目配置目录，优先使用 DSH 官方路径。

---

## 4. 与 DSH 全局 setting.yaml 的关系

DSH 全局 `setting.yaml` 中已有的模型配置是**全局唯一事实源**：

```yaml
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash-vision-exp
  reasoningEffort: max

agent-presets:
  default: anchored-standard

llm-deepseek:
  models:
    - id: deepseek-v4-flash
      name: DeepSeek-V4-Flash
    - id: deepseek-v4-pro
      name: DeepSeek-V4-Pro
    - id: deepseek-v4-flash-vision-exp
      name: DeepSeek-V4-Flash-Vision-Exp
```

项目设置页中的“模型 part”应：

- 只读展示 `agent-default-model`；
- 从 `llm-deepseek.models` 读取可选模型列表；
- 默认 `useGlobal: true`，直接使用 `agent-default-model`；
- 只有项目需要覆盖时才写 `model.overrides`；
- **不要**把全局模型的 provider / model / API Key 复制到项目文件。

这样保证：

```text
DSH setting.yaml = 全局模型
项目 .autoresearch/project-settings.yaml = 项目少量覆盖
```

---

## 5. 复用 DSH 设置页“模型 part”

DSH 设置页中已有的模型配置看作 **全局模型配置源**：

```text
DSH Settings 模型 part
  ├── provider
  ├── baseUrl
  ├── model
  ├── apiKey（脱敏显示）
  └── 路由/优先级
```

项目设置页只做：

```text
模型
  ├── [x] 使用 DSH 全局模型
  ├── [ ] 当前项目覆盖
  │     ├── provider
  │     ├── baseUrl
  │     ├── model
  │     └── 引用现有模型 part（按需显示脱敏 key）
```

不把全局模型的 API Key 复制到项目设置中。

---

## 6. DSH 插件提供的能力

### 5.1 若 DSH 设置页支持插件面板

- 插件贡献一个 `project_settings` 面板。
- 面板字段绑定上面的 `ProjectSettings`。
- 保存调用插件后端工具写入项目文件。

### 5.2 若暂不支持插件面板（推荐当前方案）

插件新增两个 DSH 工具：

```text
project_settings_get
  输入: { projectDir: string }
  输出: ProjectSettings（secret 脱敏）

project_settings_save
  输入: { projectDir: string, patch: Partial<ProjectSettings> }
  输出: ProjectSettings
```

DSH Agent / 命令可以调用这两个工具完成设置修改；UI 可把调用渲染为设置卡片。

---

## 7. 接入 AutoResearch 链路

### 6.1 Paper 探索数量

`AutoResearchService.run()` 读取项目设置：

```ts
const projectSettings = await loadProjectSettings(projectDir)
```

然后传给 `runBrainstorm`：

```ts
{
  surveyMinPapers: settings.paperExploration.maxPapers,
  surveyMinSurveys: settings.paperExploration.minSurveys,
  surveyMinClusters: settings.paperExploration.minClusters,
  latestWindowYears: settings.paperExploration.latestWindowYears,
  latestPerDirection: settings.paperExploration.latestPerDirection,
  maxSelectedDirections: settings.paperExploration.maxSelectedDirections,
}
```

### 6.2 外部生图 API

`PaperOptions` 增加：

```ts
figureApi?: {
  enabled: boolean
  apiUrl: string
  apiKey?: string
  model?: string
  timeoutMs?: number
}
```

`generateFigures()` 中：

- 如果 `figureApi.enabled`，先生成 figure spec，再调用外部生图 API；
- 返回图片后写入 `paper/figures/`；
- 失败时可选择“降级到本地生成”或“中断并提示”。

### 6.3 独立实验

`runExperimentTask()` 同样读取项目设置：

```ts
maxRounds: settings.experiment.maxRounds
profile: settings.experiment.profile
```

---

## 8. 安全边界

- API Key 不进入 LLM prompt。
- API Key 不在日志中输出。
- 设置读取接口默认脱敏：`sk-***`。
- `project-secrets.json` 忽略 git。
- 如需测试外部生图 API，提供专用工具 `figure_api_test`，只返回成功/失败与脱敏错误信息。

---

## 9. UI 页面设计

新增页面：**项目设置 / Project Settings**

```text
├── Paper 探索参数
│     ├── 最大探索论文数
│     ├── 最少综述数
│     ├── 最少子方向数
│     ├── 最新时间窗口
│     ├── 每方向最新论文数
│     └── 最大方向数
├── 外部生图 API
│     ├── 启用
│     ├── API URL
│     ├── API Key（密码输入 + 显示/隐藏）
│     ├── 模型
│     ├── 超时
│     └── 测试连接
├── 模型
│     ├── 使用 DSH 全局模型（默认）
│     └── 项目覆盖
└── 独立实验
      ├── 最大轮数
      └── 默认 PROFILE
```

---

## 10. 实现阶段

### Phase 1：后端数据层
- `src/settings/project-settings.ts`
- `loadProjectSettings(projectDir)`
- `saveProjectSettings(projectDir, settings)`
- secret 分离与脱敏

### Phase 2：DSH 工具
- `project_settings_get`
- `project_settings_save`
- `figure_api_test`

### Phase 3：链路接入
- Brainstorm options
- PaperOptions.figureApi
- Experiment options

### Phase 4：外部生图客户端
- `src/figure/api-client.ts`
- 支持 POST figure spec / prompt
- 超时与错误处理

### Phase 5：UI/设置页
- 若 DSH 支持插件面板，注册面板；
- 否则将工具调用包装成 DSH 设置卡片/命令。

### Phase 6：测试
- 设置读写 / 默认值 / 校验
- 脱敏
- 生图 API mock
- 链路集成
