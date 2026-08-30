# Figure 图片输入 + Self-Reflexion 设计

> Figure 不再走泛化 AgentLoop。
> 它需要独立的 self-reflexion 流程：如果模型支持图片输入，则把真实生成的图片作为视觉输入，让模型结合图片进行反思。
> 如果不支持图片，则退回纯文本 reflexion。

---

## 1. 能力确认

### 方式一：配置声明

在 `ProjectSettings.model` 或 `figureApi` 增加：

```ts
export interface ModelSettings {
  useGlobal: boolean
  overrides?: {
    provider?: string
    model?: string
    reasoningEffort?: string
  }
  supportsImageInput?: boolean   // 新增
}
```

`project-settings.yaml`：

```yaml
model:
  useGlobal: true
  supportsImageInput: true
```

### 方式二：运行时探测（可选）

在 provider 层增加能力接口：

```ts
export interface RoleAgentProvider {
  run(...): Promise<RoleOutput>
  capabilities?: {
    imageInput?: boolean
  }
}
```

如果 provider 返回：

```ts
capabilities.imageInput === true
```

则启用视觉 reflexion。

---

## 2. 图片输入链路

### 2.1 `RoleInput` 扩展

```ts
export interface PaperRoleInput {
  ...
  figureImages?: string[]   // 图片文件路径，用于视觉反思
}
```

### 2.2 `SubagentRoleAgentProvider` 支持图片 block

当前只支持：

```ts
prompt: [{ type: 'text', text }]
```

扩展为：

```ts
prompt: [
  { type: 'text', text },
  ...images.map((path) => ({
    type: 'image',
    image: path,
  })),
]
```

或者：

```ts
{
  type: 'image_url',
  image_url: `file:///...`
}
```

具体 block 格式取决于 DSH subagent runtime。

### 2.3 图片采集

在 figure 生成后，扫描：

```text
paper/figures/
  *.png
  *.jpg
  *.jpeg
  *.svg
  *.pdf
```

把实际生成的图片路径传给 `figure-generator` 作为：

```ts
figureImages: [...]
```

---

## 3. Figure 专属 Self-Reflexion

### 流程

```text
figure-generator
  ↓
执行脚本
  ↓ 生成 image files
如果模型支持图片输入：
  ↓
figure-generator
  输入 = 图片 + plan
  做一个视觉 self-reflexion
  ↓
如果模型不支持图片输入：
  ↓
figure-generator
  输入 = latexIncludes + scripts 描述
  文本 self-reflexion
```

### Reflexion Prompt

```text
Self-reflexion round N:
- Look at the actual generated figure images.
- Check:
  - textOverload
  - elementOverload
  - elementOverlap
  - embedded main/overall figure title
- Return improved scripts and latexIncludes.
```

---

## 4.代码位置

- Figure 逻辑保持在 `src/paper/phases.ts`
- 不接入通用 `runReflexionAgentLoop`
- 图片采集 helper：
  ```text
  src/paper/figure-images.ts
  ```
- Provider 图片 block 支持：
  ```text
  src/providers/subagent-provider.ts
  ```

---

## 5.降级策略

| 情况 | 行为 |
|---|---|
| 模型支持图片 | 视觉 self-reflexion |
| 模型不支持图片 | 文本 self-reflexion |
| 没有生成图片文件 | 文本 self-reflexion |
| 图片读取失败 | 跳过图片，文本 self-reflexion |

---

## 6. 验收标准

1. 如果 `supportsImageInput === true`，self-reflexion 输入包含真实图片。
2. 如果 `supportsImageInput === false`，不发送图片，行为与当前一致。
3. Figure 不走通用 AgentLoop。
4. 图片来自 `paper/figures/`，路径安全处理。
5. `npm run typecheck` / `npm test` 通过。
