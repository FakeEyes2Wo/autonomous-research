# Simplified 方案 Subagent Review 汇总

> 本次使用 16 个子代理，按 8 个问题分别执行：
> 1 个 simplify 子代理 + 1 个 review 子代理。
> 所有子代理只输出建议，未修改代码。

## 总览

| 问题 | 结论 | 风险 | 简化评分 | 建议 |
|---|---|---:|---:|---|
| agents：RoleName / AgentRequest | needs_changes | medium | 3 | 补 FakeAgentProvider 与调用点迁移后再做 |
| brainstorm：Ranking / Handoff | needs_changes | low | 3 | 保留 cheapTest 默认值、合并候选接口后落地 |
| core：常量 / StateStore / 签名 | needs_changes | medium | 2 | 分阶段，暂缓 StateStore，先做低成本常量派生 |
| domain：GateInput / RunFiles | needs_changes | medium | 3 | 明确迁移范围，GateInput 用强类型区分 |
| export/paper：EvidenceChain / 审计 | needs_changes | medium | 3 | 按更小改动实现，同步旧测试 |
| paper：Context / LatexEngine | needs_changes | low | 3 | 避免提前构造半成品 PaperContext |
| service：ResearchRunner / Stage | needs_changes | medium | 4 | 保留公开构造器兼容并补迁移清单 |
| providers/session/tools | needs_changes | low | 3 | 先做 HumanReviewMode 与 schema 去重，AgentRequest 独立变更 |

---

## 1. agents：RoleName 派生 / AgentRequest / RoleSpec

**verdict**: needs_changes  
**typecheckRisk**: medium  
**simplificationScore**: 3

### 关键问题
1. 遗漏 `test/integration/fake-agent-provider.ts`
   - 它仍实现旧的 `run(role, _input, _context)`。
   - `tsconfig` 只 include `src`，`npm run typecheck` 无法发现该运行时破坏。
2. 16 处 `provider.run` 调用点只有风险列表，没有完整迁移模板。
3. 为切断 type-only 循环新增 `agent-types.ts` 可能是过度设计。
   - 当前 types 与 roles 之间都是 `import type`，通常可直接接受类型级循环或简单调整导入路径。
4. 该阶段不解决任何人工 TODO，应明确定位为 Phase 1 前置。

### 建议
- 将 FakeAgentProvider 同步改为 `run(request: AgentRequest)`。
- 给出所有调用点的统一模板：
  ```ts
  this.provider.run({ role, input, context })
  ```
- 优先采用更简单方案：`RoleName` 由 `roles/index.ts` 派生，`types.ts` 只 re-export，不新增 `agent-types.ts`。
- 为派生后的 RoleName 增加 prompt 文件存在性检查或测试，弥补编译期保护。

---

## 2. brainstorm：RankingStrategy / IdeaHandoff / BrainstormContext

**verdict**: needs_changes  
**typecheckRisk**: low  
**simplificationScore**: 3

### 关键问题
1. `IdeaHandoff.cheapTest` 未保留当前默认值：
   - chair 未返回且 `winner.cheapTest` 为空时，会写出空 bullet。
2. 新增 `RankingRequest` 比总方案 5.2 多一层抽象。
3. 未合并 `CandidateDirection` / `RankedDirection`，仍保留两套相似接口。
4. `ranking` 没有通过 `ResearchRunnerOptions` / `AutoResearchService` 透传到主流程，实际无法从外部替换。

### 建议
- `cheapTest` 为空时回退到 `'Run the minimal validation experiment'`。
- 删除 `RankingRequest`，直接使用 `rank(ctx, candidates, provider)` 或纯函数。
- 合并 `CandidateDirection` 与 `RankedDirection`。
- 如果要在主流程替换 ranking，就把 `ranking` 透传到 ResearchRunner；
  如果暂不需要，则明确只支持直接构造 `BrainstormPipeline` 时注入。
- 同步更新 `prompts/system/brainstorm.md`、`agents/roles/brainstorm.ts` 和 fake provider。

---

## 3. core：常量派生 / StateStore / ResearchTree / HypothesisPool

**verdict**: needs_changes  
**typecheckRisk**: medium  
**simplificationScore**: 2

### 关键问题
1. `StateStore` 没有任何调用方，引入后会出现“类 API + 自由函数”双 API 并存。
2. `ResearchTree.add`、`withRetry`、`syncFromTree` 签名变更影响面大，迁移不完整会破坏中间态。
3. `origin_candidate_id` 改成 `origin_idea_id` 是持久化 schema 变更，但没有旧 JSON 归一化逻辑。
4. `parseDecision` 如果直接用 readonly tuple 的 `includes(record.action)`，严格模式下可能类型报错。
5. 删除 `ResearchTree.path()` 属于对外 API 破坏，需确认可接受。
6. 对只有 2 个参数的 `ResearchTree.add` 做对象化，收益有限，可能属于过度设计。

### 建议
- 拆成两步：
  1. 先做无行为变化的 `const` 数组派生和 `path()` 删除。
  2. 再单独做 `add/withRetry` 签名收敛，并在同一次提交迁移所有调用方。
- 暂缓 `StateStore`，等 `service/runner` 真正迁移时再引入。
- `HypothesisPool.load` 增加旧字段归一化：
  ```ts
  origin_idea_id: raw.origin_idea_id ?? raw.origin_candidate_id
  ```
- `parseDecision` 使用：
  ```ts
  (RESEARCH_DECISION_ACTIONS as readonly string[]).includes(record.action)
  ```
- 优先对象化参数确实很多的接口：
  - `transition`
  - `withRetry`
- 保留 `ResearchTree.add` 现有签名，或提供兼容 overload。

---

## 4. domain：GateInput / RunFiles / Candidate→ResearchIdea

**verdict**: needs_changes  
**typecheckRisk**: medium  
**simplificationScore**: 3

### 关键问题
1. `RunFiles` 与现有自由函数的去留不明确：
   - 保留薄封装则没真正消除 `runDir`。
   - 删除则需要迁移 runner 中所有读写调用点。
2. `GateInput` 把 `reviews/validationPlan` 设为可选，再用运行时抛错，削弱编译期类型安全。
3. `RunFiles` 包含 `paperDraftPath`、`writeFinalReport` 等源码中无调用方的公共方法，扩大接口。
4. 未真正落点人工 TODO：brainstorm handoff 正则属于后续独立事项。

### 建议
- 用派生类型区分：
  ```ts
  type PreGateInput = Pick<GateInput, 'structural' | 'falsifiability'>
  ```
  `lightHardGate` 的 `reviews/validationPlan` 设为必填，保留单对象入参。
- 明确二选一：
  - 全部内部迁移到 `RunFiles`。
  - 或者保留 free functions 为 deprecated 薄封装。
- `RunFiles` 只包含实际使用的方法：
  - `readIdea`
  - `readRubric`
  - `writeRubric`
  - `freezeRubric`
  - `readPlan`
  - `writePlan`
  - `writeFailureReport`
- 人工 TODO 单独立项，不与本次 domain 清理混在一起。

---

## 5. export/paper：EvidenceChain 结构化 + 审计去正则

**verdict**: needs_changes  
**typecheckRisk**: medium  
**simplificationScore**: 3

### 关键问题
1. 遗漏 `test/unit/evidence-export.test.ts`：旧测试仍按旧签名调用 `exportEvidenceChain`。
2. `exportEvidenceChain` 是根入口 re-export 的公开 API，修改返回签名是破坏性变更。
3. “减少正则消耗”表述过度：`numericClaimAudit` 仍会保留 `% evidence:` 正则，实际主要是去掉 ResearchTree 二次加载。
4. 与总文档不一致：
   - 文档写 `collectEvidenceIds(tree)`，方案写成 `collectEvidenceIds(chain)`。
   - 文档写 `auditPaper({ runDir, chain })`，方案写成 `auditPaper(runDir, chain)`。
5. 新增 `collectEvidenceIds` 可能无真实调用，有轻微过度设计。
6. `EvidenceChain` 仍使用宽泛 `ResearchNode[]`，类型化收益有限。

### 建议
- 优先采用更小改动：
  - 保留 `exportEvidenceChain` 旧签名或增加兼容 shim。
  - `PaperPipeline.audit` 通过已有 `evidencePath` 读取 `evidence_chain.json`，构造已知证据 ID 映射。
- 若坚持 `auditPaper` 接收 chain，按文档改为单对象：
  ```ts
  auditPaper({ runDir, chain })
  ```
- 删除未使用的 `collectEvidenceIds`，或实现文档中的 tree 版本并提供真实调用。
- 本次不要宣称“消除正则消耗”，改为：
  - 已知证据集合来自结构化源
  - 移除 ResearchTree 二次加载
- 保持 `PaperPipeline.run` 签名兼容或提供 deprecation/overload。

---

## 6. paper：PaperContext 分组 + LatexEngine 注册表 + runCompileLoop

**verdict**: needs_changes  
**typecheckRisk**: low  
**simplificationScore**: 3

### 关键问题
1. 在 contract/figures 阶段提前构造完整 `PaperContext`，再事后刷新，会产生“暂时为空/无效”的结构，容易漏掉 figures fallback。
2. 代码片段中的刷新顺序与注释不完全一致。
3. `PaperContext` 分组本身不减少 class attrs / enum，本轮实际收益有限。
4. `LATEX_ENGINE_ORDER` 与 `Record<string, LatexEngine>` 双事实来源，新增引擎需改两处。
5. `evidencePath` 放在内容组里语义略乱。

### 建议
- 更简单做法：
  - 维持 contract/figures 完成后构造最终 `PaperContext`。
  - contract/figures 使用窄参数对象，不提前构造半成品 ctx。
- 如果坚持让 contract/figures 接收 `PaperContext`，明确：
  - 构造点放在 plan 后、Promise.all 前。
  - figures fallback 也纳入刷新逻辑。
- LaTeX 引擎用单一数组作为事实源：
  ```ts
  const latexEngines = [
    { name: 'latexmk', ... },
    { name: 'tectonic', ... },
    { name: 'xelatex', ... },
    { name: 'pdflatex', ... },
  ] as const satisfies readonly LatexEngine[]
  ```
- 将 `evidencePath` 放入 `PaperPaths` 或独立 `PaperSources`。
- 考虑通过 `spawnSync` 的局部 `env` 注入代理，减少全局 `process.env` 副作用。

---

## 7. service：ResearchRunner attrs / RunSession / StageRequest

**verdict**: needs_changes  
**typecheckRisk**: medium  
**simplificationScore**: 4

### 关键问题
1. `new ResearchRunner(provider, options, logger?)` 是公开 API 破坏性变更。
2. 方案只给了片段式示例，未列出所有需要同步迁移的私有方法和 `ResearchTree.load` 后刷新 `session.tree` 的点。
3. `RunSession.tree` 的刷新依赖人工维护，缺少机制约束。
4. `ReviewGateRequest` 携带完整 `RunSession`，但 reviewGate 实际不需要 tree。
5. 本阶段不涉及人工 TODO。

### 建议
- 保留旧构造器兼容：
  ```ts
  constructor(options: ResearchRunnerOptions) {
    this.provider = options.provider
    this.options = options
    this.logger = createLogger()
  }
  ```
  或者提供静态 `ResearchRunner.create(provider, options, logger?)`。
- 增加集中 `reloadSessionTree(session)` helper，避免散落手动赋值。
- `ReviewGateRequest` 只保留实际需要的字段。
- 删除 `ResearchRunContext` 时保留兼容别名：
  ```ts
  export type ResearchRunContext = RoleExecutionContext
  ```
- 将 service 收口定位为“后续 TODO 的前置重构”，不与人工 TODO 验收混在一起。

---

## 8. providers/session/tools：共享常量 + schema 去重

**verdict**: needs_changes  
**typecheckRisk**: low  
**simplificationScore**: 3

### 关键问题
1. `AgentRequest` 改造同样会影响 `test/integration/fake-agent-provider.ts`。
2. 本方案没有真正减少 class attrs，也没有落点人工 TODO。
3. `tools` 中 `paper` 参数通过 `as PaperOptions` 强转，会隐藏 schema 与类型不一致。
4. `AgentRequest` 属于 API 破坏，应独立变更并配套测试。

### 建议
- 先只做低风险高收益项：
  - `HumanReviewMode` 共享常量
  - tools schema 常量去重
- `AgentRequest` 拆成独立变更，并同步 FakeAgentProvider。
- `tools` 中明确 `PaperToolOptions`，或在 `toResearchRunOptions` 中显式过滤额外字段。
- 本阶段定位为 Phase 1，不把 class attrs / TODO 作为验收目标。

---

## 下一步建议

1. **优先做低风险部分**
   - core 的 `const` 数组派生
   - session 的 `HumanReviewMode`
   - tools 的 schema 常量去重
   - agents 的 `RoleName` 派生（先不切 AgentRequest）

2. **把高风险项拆成独立变更**
   - `AgentRequest` 需要连同 FakeAgentProvider、所有调用点、集成测试一起改。
   - `Service Runner` 收口需要完整迁移清单和树刷新机制。
   - `PaperContext` 调整需要避免半成品生命周期。

3. **TODO 分阶段闭环**
   - brainstorm ranking/handoff
   - EvidenceChain 结构化审计
   - LatexEngine 注册表
   每个 TODO 单独提交，避免一次改动过大。

4. **每步运行**
   ```bash
   npm run typecheck
   ```
   并补充集成测试验证 FakeAgentProvider 等测试实现已同步。
