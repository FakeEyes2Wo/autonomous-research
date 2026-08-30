# Figure Vision Reflexion Spec

## 1. Objective

让 figure self-reflexion 在模型支持图片输入时，能够看到实际生成的图片，结合图片进行反思。

## 2. Scope

- Figure 不纳入通用 AgentLoop。
- 仅修改 figure 生成/反思路径。
- 保留当前文本 self-reflexion 作为降级。

## 3. Capability Detection

- `ModelSettings` 增加：
  ```ts
  supportsImageInput?: boolean
  ```
- `PaperOptions` 增加：
  ```ts
  supportsImageInput?: boolean
  ```
- `AutoResearchService` 从 `projectSettings.model.supportsImageInput` 透传到 `paperOptions`.

## 4. Data Flow

```text
figure-generator
  ↓ 执行脚本
  ↓ 生成 raster images
collectFigureImages(paperDir)
  ↓
figure-generator self-reflexion
  input.figureImages = [...paths]
  ↓
如果 supportsImageInput = true
  → 使用图片作为视觉输入
如果 false
  → 不传 figureImages，保持文本反思
```

## 5. Role Input

`PaperRoleInput` 增加：

```ts
readonly figureImages?: string[]
```

`figure-generator` 的 sections 加入 `figureImages`，便于 prompt 渲染。

## 6. Image Collection

新增 helper：

```text
src/paper/figure-images.ts
```

只收集 raster 图片：

```ts
png / jpg / jpeg / webp / gif
```

返回绝对路径数组。

## 7. Reflexion Integration

在 `src/paper/phases.ts` 的 `generateFigures` 中：

- 首次脚本执行成功后收集图片。
- 如果 `ctx.deps.options.supportsImageInput === true`：
  - 每轮 self-reflexion 调用传入：
    ```ts
    figureImages
    ```
- 否则不传。

## 8. Provider / Runtime Image Blocks

`SubagentRoleAgentProvider` 需要支持将 `figureImages` 转换为模型可见内容块：

- 如果运行时支持 attachment 服务，将图片字节保存为 `ImageAttachmentRef`，再构造：
  ```ts
  { type: 'image', attachment: ref }
  ```
- 如果当前运行时无法构造 attachment，则降级为在 prompt 中列出图片路径，并记录 warning。

## 9. Acceptance Criteria

1. `supportsImageInput` 可从 project settings 配置。
2. 图片收集只包含 raster 格式。
3. 支持图片时，self-reflexion 输入包含图片信息。
4. 不支持图片时，行为与当前文本反思一致。
5. `npm run typecheck` / `npm test` 通过。
