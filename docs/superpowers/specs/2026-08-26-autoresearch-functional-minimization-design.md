# Autoresearch 函数式泛化与最小化设计

## 目标

在完整保留现有能力、公开 API、产物格式和功能边界的前提下，进一步减少 `packages/autoresearch/src` 的维护者心智负担。本轮主要消除：

- 无生命周期 class 及其重复 attrs；
- provider、logger、options、runDir、state、tree 和 agent context 的层层转发；
- 纯转发 façade、一次性别名和低价值 helper；
- 多份手写 role、phase、gate、engine、audit 定义；
- 语义与变化原因相同、却分别维护的重复算法。

本轮允许彻底调整内部类型和调用接口。独立功能不得为了减少行数而合并。

## 设计原则

1. 保留功能边界，删除无意义的对象层级。
2. 只有维护状态、不变量或真实生命周期的概念使用 class。
3. 语义与变化原因相同的实现必须共享，不允许复制后分别维护。
4. 仅代码形状相似、但业务规则不同的流程不强行合并。
5. 共享机制集中实现，业务决策保留在所属功能附近。
6. 不引入 workflow DSL、EventBus、DAG、依赖注入框架或新的错误层级。
7. 优先减少概念数量，而不是机械追求最低行数。

## 方案选择

采用“按功能分开的函数式核心”。保留 `brainstorm`、`idea`、`experiment`、`paper`、`tools` 等目录和职责边界；删除没有独立状态的 class，改用模块函数或依赖工厂。

未采用以下方案：

- 仅把 attrs 收进 options/context：它隐藏复杂度，但不减少 façade、转发方法和对象关系。
- 完全数据驱动工作流：它需要额外解释器或 DSL，并会把不同业务语义压入同一配置系统。

## 目标结构

```text
service/
  runner.ts              顶层研究循环
  context.ts             RunContext 与状态刷新
  agent.ts               runAgent / runStage
  steps/
    idea.ts              idea 与 rubric
    experiment.ts        实验设计、执行、证据、决策
    paper.ts             从研究流程进入论文流程

paper/
  pipeline.ts            checkpoint 编排
  phases.ts              各论文阶段函数
  engine.ts              LaTeX 引擎选择与编译

brainstorm/
  pipeline.ts            brainstorm 编排
  ranking.ts             排序算法
  handoff.ts             结构化交接
```

`ResearchTree` 和 `HypothesisPool` 保留为 class，因为它们维护集合不变量与持久化行为。其余 class 必须证明自己拥有独立状态或生命周期。

## 运行上下文

稳定依赖与单次运行状态分开定义：

```ts
interface RuntimeDeps {
  provider: RoleAgentProvider
  options: ResearchRunnerOptions
}

interface RunContext {
  deps: RuntimeDeps
  runDir: string
  state: RunState
  tree: ResearchTree
  agent: RoleExecutionContext
  logger: Logger
}
```

约束：

- 每次运行只创建一个 `RunContext`。
- logger 在创建 context 时确定，不再通过 `setLogger()` 修改。
- context 只保存稳定依赖和权威状态。
- `planText`、`experimentDesign` 等阶段性数据通过局部参数和返回值传递，不堆入 context。
- 不再建立互相嵌套、字段重复的 context 类型。
- `reloadTree(ctx)` 是刷新 `ctx.tree` 的唯一实现。

## class 与 attrs 收敛

计划删除以下无状态或纯转发 class：

- `ResearchSteps`；
- `RoleRunner`；
- `IdeaSteps`；
- `ExperimentSteps`；
- `PaperSteps`；
- `PaperPhases`。

对应行为转为所属模块内的命名函数。`ResearchRunner` 与 `PaperPipeline` 若属于公开兼容入口，可以保留为薄适配器，但内部最多保存一个依赖对象；若不是公开 API，则改成工厂或普通函数。

禁止：

- 父对象与子对象重复保存 provider、logger 或 options；
- 保存能够从其他 attr 推导的字段；
- 只做 getter、别名或逐方法转发的成员函数；
- 为一次性调用创建长期存活的步骤对象。

## 参数与返回值

- provider、logger、runDir、state、tree 和 agent context 从 `RunContext` 获取。
- 阶段特有、不可推导的数据显式传入。
- 参数共同描述一个业务命令时才建立 request 类型。
- 只有一个调用点的一次性 request 类型优先内联，避免类型文件膨胀。
- 返回值只包含调用者实际消费的内容。
- 不把多个无关参数机械包装成一个对象以伪装简化。

示例：

```ts
runExperimentDesign(ctx, {
  planText,
  minimalVerification,
  modelScout,
  feedback,
})
```

## 必须共享的实现

### 唯一数据源

以下定义分别只允许存在一个注册表或 `const` 数据源，类型、校验和 schema 从该源派生：

- role；
- run phase 与 status；
- review gate 与 verdict；
- research node kind；
- LaTeX engine；
- paper audit spec；
- human review mode。

### 执行机制

- `runAgent()`：Agent 调用、重试、计时、日志和错误 cause。
- `runStage()`：阶段迁移、Agent 调用、结构化结果序列化和可选文件落盘。
- `reviewGate()`：跳过条件、询问 reviewer、结果记录和询问失败降级。
- checkpoint phase runner：检查完成状态、执行、保存成功结果。
- optional file read：仅对明确允许缺失的文件返回 `undefined`。

### 领域算法

- brainstorm ranking 只有一个可复用实现；
- evidence 查询和 ID 收集只有一个实现；
- paper audits 由统一 spec 表驱动；
- LaTeX engine 由统一注册表选择和执行；
- JSON 结构化文本提取使用一个纯函数实现；
- 安全路径、目录创建、原子写入和 JSON 持久化复用 core 基础设施。

共享边界由“语义与变化原因相同”判断。idea、rubric、experiment、evidence 各自的 approve/revise/reject 策略属于不同业务规则，保持在对应流程附近；它们只共享 review 的执行和记录机制。

## 数据流

```text
公开入口
  -> 创建 RunContext
  -> 功能编排函数
  -> 领域函数 / Agent 执行函数
  -> ResearchTree、运行状态与文件产物
```

- `state` 和 `tree` 继续作为研究流程的权威状态。
- paper checkpoint 继续作为论文流程的恢复依据。
- 两套恢复语义不合并。
- 临时阶段结果通过返回值沿显式控制流传递。
- 研究循环和论文流程保持可直接阅读的条件、循环和分支，不转换为通用工作流配置。

## 错误与恢复

- `runAgent()` 统一负责重试、计时、错误日志并保留原始 cause。
- 仅在兼容旧产物或文件明确可选时允许 fallback。
- 删除无说明的 `catch { return '' }`，改用命名明确的 `readOptionalText()` 或让错误传播。
- review gate 询问失败继续按现有能力降级，并持久化跳过原因。
- checkpoint 只在阶段产物成功写入后推进。
- 不新增错误 class 层级，不改变公开错误行为。

## 兼容性

必须保持：

- 包的公开导出和调用能力；
- DSH tools 的名称、输入 schema 和输出形态；
- 已有运行目录、文件名和 JSON schema；
- prompt 的业务输入；
- research state、paper checkpoint 与恢复行为；
- brainstorm、research、paper 和 human review 的现有能力。

公开 class 如需保留，只作为薄兼容适配器调用函数式核心，不复制实现。

## 测试与验收

实施前先用现有测试固定行为。每个重构批次运行 TypeScript 检查和相关单元测试，最后运行完整测试。

新增或强化以下测试：

- `runAgent` 的成功、重试与错误传播；
- `runStage` 的状态迁移、结果序列化与可选落盘；
- optional read 只吞掉明确的文件缺失；
- review gate 的 approve、skip 和询问失败记录；
- audit registry 的缓存读取、并行执行、解析与落盘；
- 公开 API、文件名、JSON schema 和 checkpoint 兼容性；
- 完整 brainstorm、research 与 paper 集成流程。

结构验收：

- 不存在 `ResearchSteps` 等纯转发 façade；
- 无状态步骤模块不使用 class；
- role、phase、gate、engine 和 audit spec 不存在第二份手写定义；
- 相同语义和变化原因的算法不存在局部复制版本；
- 不新增万能 context、workflow DSL 或为未来需求准备的抽象；
- 独立功能仍能从目录和调用链上单独理解与测试。

完成标准是：现有能力与兼容性测试通过，同时对象关系、attrs、转发层、重复算法和必须记忆的概念数量均减少。
