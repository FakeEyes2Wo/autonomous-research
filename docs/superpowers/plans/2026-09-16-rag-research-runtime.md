# B：研究循环接入与持久实验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将文献与合法实验反馈送入下一轮假设生成，保存多个候选，并让实验在控制器重启后可核对和继续。

**Architecture:** 整合既有证据分支；文献经 ResearchContext 选择后进入 prompt。候选选择、科研判断、持久执行分离，job 产物通过原有 evidence admission 才能改变科研状态。

**Tech Stack:** 现有 TypeScript 研究引擎、ResearchStore、request ledger、SQLite 事务与本地 Node 作业 supervisor。

## Global Constraints

- 遵循[总计划](2026-09-16-rag-research-roadmap.md)，本轮只编写计划。
- 完整 `packages/...` 路径相对仓库根；省略前缀的 `src/`、`test/`、`scripts/`、`prompts/` 统一相对 `packages/autoresearch/`。B0 后的模块指整合后核心包，不从 `.worktrees` 做运行时 import。
- 实验并发默认 1；隐藏测试结果不参与 successor 选择。
- 支持/反对、unknown、invalid 分开；没有新增领域 validator 的任务维持 exploratory/unknown。
- 作业重连不等于从任意程序的中间继续计算；只有声明应用 checkpoint 能力的后端支持 resume。

---

## B0：证据分支整合与基线固化

**Files — 整合现有模块：**

- `packages/autoresearch/src/research/`、`src/memory/`、`src/research-context/`。
- `src/service/research-cycle.ts`、`src/service/research-context.ts`、`src/service/runner.ts`、`src/experiment/runner.ts`。
- 分支 `test/unit/research-store.test.ts`、`research-core.test.ts`、`research-context.test.ts`、`memory-store.test.ts`、`test/integration/evidence-driven-loop.test.ts`。
- 新增 `packages/autoresearch/test/integration/research-compatibility.test.ts`，记录 main 旧产物的读取用例。

**Interfaces:** 保持 `ResearchStore`、`researchContextForRole`、`commitResearchDecision`、`paired_sign_test_v1` 的现有 API；此任务不重新设计它们。

- [ ] 记录 main/证据分支 HEAD、工作区 diff 与未跟踪文件；按 worktree 技能建立集成工作区。只整合经核对的证据相关改动；不把证据分支整棵目录复制覆盖当前 main。
- [ ] 建立兼容 fixture：历史 main 的 state/tree/paper_records/evidence 文件逐字节保存为测试输入。旧 run 缺新字段必须保持旧可读状态或明确进入迁移，不能自动制造 validated evidence。
- [ ] 在分支已有测试上补断言：

```ts
// 放到 evidence-driven-loop 的现有四路径 fixture 内。
assert.notEqual(successor.active_hypothesis.version, parent.active_hypothesis.version)
assert.ok(successor.hypotheses.some(h => h.id === parent.active_hypothesis.id))
assert.equal(parent.content_hash, savedParentHash)
```

`parent/successor` 为该 fixture 从真实 ResearchStore 读取的快照，`savedParentHash` 在决策前保存。用实际四条路径分别触发，不能只直接调用 revision 函数替代集成测试。

- [ ] 解决接口冲突并保留现有 main 新功能；验证 research/experiment × minimal/legacy 都把准入结果传到下一轮。unknown receipt 保持 pause，completed artifact 不重复执行。
- [ ] 在核心包执行 `npm run typecheck`、`npm test`；记录本次真实结果，不沿用历史“232 通过”。独立提交 `feat(research): integrate evidence-driven research baseline`。

## B1：ResearchContext、baseline 与引用核对

**Dependencies:** A5 + B0。

**Files — Create:** `packages/autoresearch/src/literature/context-adapter.ts`、`baseline.ts`、`claim-assessment.ts`、`test/unit/literature-context.test.ts`、`literature-baseline.test.ts`、`test/integration/literature-research-loop.test.ts`。

**Modify:** `src/service/research-context.ts`、`src/service/agent.ts`、`src/service/steps/idea.ts`、`src/service/research-cycle.ts`、`src/brainstorm/deep-dive.ts`、`src/settings/schema.ts`、`migration.ts`、`src/policy/model-routing.ts`；提示词 `prompts/system/idea-generator.md`、`hypothesis-reviser.md`、`planner.md`、`citation-auditor.md`。配套修改设置 contract 的现有测试。

**Interfaces:** 使用 A 的 SourceSpan/RetrievalReceipt，已有 `ContextRecord` 与 `ResearchContextRequest`。新增如下类型：

```ts
export interface BaselineSpec {
  task: string; datasetVersion: string; split: string; metric: string
  direction: 'min' | 'max'; maxComputeSeconds: number; allowedComponents: string[]
}
export interface BaselineCandidate {
  workId: string; spanIds: string[]; spec: Partial<BaselineSpec>
  implementation: string | null; estimatedComputeSeconds: number | null
}
export interface BaselineFit {
  workId: string; status: 'matched' | 'mismatch' | 'unknown'
  reasons: string[]; spanIds: string[]
}
export interface ClaimAssessment {
  claimId: string; spanIds: string[]
  locatorValid: boolean
  relation: 'supports' | 'refutes' | 'partial' | 'mixed' | 'unknown'
  conditions: string[]; assessor: 'human' | 'calibrated_model' | 'unreviewed'
  assessorVersion: string; evidenceHash: string
}
export declare function matchBaseline(spec: BaselineSpec, candidate: BaselineCandidate): BaselineFit
export declare function toLiteratureRecords(spans: SourceSpan[], receipt: RetrievalReceipt): ContextRecord[]
export declare function checkCitationLocators(claims: { id: string; spanIds: string[] }[],
  spans: SourceSpan[]): { missing: string[]; located: string[] }
```

- [ ] 先写 baseline 测试，故意给高引用论文不匹配的数据/指标：

```ts
const spec = { task: 'classification', datasetVersion: 'd1', split: 'dev',
  metric: 'accuracy', direction: 'max' as const, maxComputeSeconds: 60,
  allowedComponents: ['classifier'] }
const fit = matchBaseline(spec, { workId: 'famous', spanIds: ['s1'],
  spec: { ...spec, datasetVersion: 'd2' }, implementation: 'repo@sha',
  estimatedComputeSeconds: 10 })
assert.equal(fit.status, 'mismatch')
assert.ok(fit.reasons.includes('datasetVersion'))
```

- [ ] 确认测试失败后实现逐字段匹配：任务/数据/指标/方向/可改组件有已知冲突则 mismatch，必需配置缺失则 unknown；只有来源完整且条件兼容才 matched。额外消融 baseline 标本地设计，不伪装成文献方案。替换 deep-dive 的 citations top3，保留旧结果文本接口。
- [ ] 增加设置 `literature: {mode:'off'|'lexical', maxResults:8, maxContextChars:12000}`。hybrid 随 C3 暂缓。模式默认 off，整数边界分别 1–40、1000–100000；新 run 固定到 policy snapshot，旧 run 读旧 policy 时补 off，不在 resume 时自动升级。
- [ ] 首次检索创建 run binding `{runId,generationId,policyHash,createdAt}` 并登记 generation pin；resume 读取该 binding。显式知识更新写 `{previousGenerationId,nextGenerationId,reason,sourceEventIds}`，提交成功后的调用才切换索引。retraction/correction 使受影响 claim 待重审，access_revoked 禁止读取；这些事件不被固定 generation 屏蔽。
- [ ] role 检索用途：survey/deep-dive→survey；planner→baseline；hypothesis-reviser→revision；writer/auditor→citation。research-worker 默认只拿冻结 protocol 明确允许的文献 span，不能自动拿历史结果和 treatment memory。
- [ ] 将外部 span 转为 layer 3/artifact 记录，payload 带 `author_reported`、版本、原文、locator 和 receipt ID；科学 polarity 不由文献存在决定。ClaimAssessment 已识别的反方和冲突双方进入 required closure；未核对的模型评论维持 candidate。
- [ ] request builder 先从当前 claim 的已登记 ClaimAssessment 找反证/冲突 span IDs，写入 requiredSpanIds；不能只在 top-k 内寻找反证。缺失必需来源时暂停该决定并报告具体缺口，不能通过改写查询绕过。未发现的反证仍属于召回评测问题，不承诺遍历全部文献。
- [ ] 调用顺序：retrieve → toLiteratureRecords → 现有 context selector → 根据最终 selected records 写 prepared exposure → provider call → 更新 sent/unknown。剩余窗口先满足 protocol/内部必要反证；必要闭包超预算抛现有 ContextInsufficientError。
- [ ] 把选中原文字节和检索 manifest 经 ResearchStore 的 captureBytes 保存为 SourceRef；candidate 的 discovery_source_ids 使用已登记 SourceRef ID，另存文献 span 映射，禁止虚构引用 ID。
- [ ] citation 检查分两层：checkCitationLocators 做 ID/hash/范围存在性；ClaimAssessment 保存人工或校准模型的语义关系。不把合法 DOI、数字字符串命中或相似度阈值直接判成 supports。无语义检查者结果为 unknown。
- [ ] 集成测试让 fake provider 捕获真实最终 prompt：一个有效阴性、一个 OOM、一条反证文献；断言前者进入 revision，OOM 只进入诊断，反证未被小窗口静默丢弃。加入生成不存在 span ID 的输出应拒绝准入的测试。
- [ ] 构建后运行三个新增测试及 `settings-validation-v2.test.ts`、`settings-service-v2.test.ts`；提交 `feat(research): ground research context and baselines in source spans`。

## B2：保留全候选与可解释选择

**Files:** 新增 `src/research/candidates.ts`、`selection.ts`、`test/unit/research-selection.test.ts`；修改 `src/service/research-cycle.ts`、`src/service/steps/idea.ts`、`src/core/research-tree.ts` 和 hypothesis-reviser 提示词。

**Interfaces:**

```ts
export interface ResearchCandidate {
  id: string; parent: { id: string; version: number }
  mechanismKey: string; changedAssumption: string; prediction: string
  disconfirmingObservation: string; sourceEvidenceIds: string[]; sourceSpanIds: string[]
  distinguishes: string[]; unresolvedConstraints: string[]
  estimatedCost: number; feasible: boolean
  status: 'proposed' | 'eligible' | 'selected' | 'deferred' | 'rejected'
}
export interface SelectionDecision {
  policyVersion: 'rules-v1'; candidateIds: string[]; selectedId: string | null
  reasons: Record<string, string[]>; snapshotHash: string
  stopReason: 'budget' | 'no_feasible_candidate' | null
}
export declare function selectCandidate(candidates: ResearchCandidate[], input: {
  snapshotHash: string; remainingCost: number; testedMechanismKeys: string[]
  registeredAlternatives: string[]
}): SelectionDecision
```

`estimatedCost`/`remainingCost` 统一用整数微货币单位，与 runtime 的 costMicros 一致；无可靠费用估计时不能用 0 冒充免费，可先退回人工/规则限定的探索预算。CPU/GPU/墙钟限制另由任务与 job budget 校验，不硬换算成模型费用。

- [ ] 写测试：同一组完整候选正序/逆序选择相同 ID；不可执行和超预算项不被选择。

```ts
const first = selectCandidate(candidates, input)
const second = selectCandidate([...candidates].reverse(), input)
assert.equal(first.selectedId, second.selectedId)
assert.equal(first.candidateIds.length, candidates.length)
assert.ok(first.selectedId === null ||
  candidates.find(c => c.id === first.selectedId)!.estimatedCost <= input.remainingCost)
```

fixture 三项：a feasible/cost2/distinguishes[A,B]，b feasible/cost1/distinguishes[A]，c infeasible/cost0；A/B 均为注册解释，remainingCost=2，a/b 的其余预测/反证/来源字段给定非空有效值；预期选 a。再将 a 的来源改为未登记 ID，准入层拒绝该候选。

- [ ] 实现来源/父版本/可观察预测校验；每次保存所有候选，包括拒绝原因。排序依次为可执行且预算内、能区分的已登记解释数量、未测试机制、成本、稳定 ID。模型随意新造解释 ID 不增加得分。
- [ ] mechanismKey 使用规范化的机制/干预/结果变量和协议条件生成；语义近似由模型提出 duplicate suggestion，未核对不能强行合并。已有机制新措辞作为待合并版本，不能保证纯字符串规则识别所有复述。
- [ ] decision 与 candidate 集合绑定同一个 snapshotHash，提交时 CAS 校验当前快照；过期选择重建输入。新证据可以重开 deferred 分支，必须记录重新选择依据。
- [ ] ResearchTree 展示选中/保留/拒绝状态与父版本链接；不另建独立科学状态源。LLM 输出 stop 仅为建议，实际预算和可执行性规则决定停止。
- [ ] 构建后执行 `research-selection.test.ts`、`research-tree.test.ts` 和 B1 集成测试；提交 `feat(research): retain and select evidence-grounded candidates`。

## B3：持久 job、后端回执与预算

**Files — Create:** `src/runtime/contracts.ts`、`job-store.ts`、`job-controller.ts`、`budget.ts`、`executors/local.ts`、`local-supervisor.ts`、`test/unit/job-controller.test.ts`、`test/unit/job-budget.test.ts`、`test/integration/job-recovery.test.ts`、`test/fixtures/jobs/controlled-job.mjs`。核心包新增 runtime CLI export/脚本只由本任务负责人修改。

**Interfaces:**

```ts
export type JobStatus = 'queued' | 'submitting' | 'running' | 'succeeded' |
  'failed' | 'cancel_requested' | 'cancelled' | 'unknown'
export interface JobSpec {
  id: string; attemptId: string; taskId: string; protocolHash: string; inputHash: string
  executable: string; args: string[]; cwd: string; env: Record<string, string>
  budget: { wallMs: number; cpuSeconds: number | null; gpuSeconds: number | null;
    costMicros: number | null; maxLogBytes: number; maxArtifactBytes: number }
  checkpoint: { resumeArgs: string[]; path: string } | null
}
export interface JobReceipt {
  jobId: string; backendId: string; status: JobStatus; inputHash: string
  protocolHash: string; heartbeatAt: string | null; progressAt: string | null
  exitCode: number | null; artifactManifestHash: string | null
}
export interface JobBackend {
  submit(spec: JobSpec, fence: number): Promise<JobReceipt>
  inspect(jobId: string): Promise<JobReceipt>
  collect(jobId: string): Promise<JobReceipt>
  cancel(jobId: string): Promise<JobReceipt>
}
export declare function reconcile(receipt: JobReceipt):
  'watch' | 'collect' | 'diagnose' | 'wait_unknown' | 'finished'
```

数据库表至少包含 jobs/spec hash/status、attempts、leases/fence、reservations、usage、receipts、outbox。每次状态变更/预算预留/提交意图在同一事务落盘；jobId 与提交 key 唯一。后台 worker 复用 A1 的 SQLite 技术模式，但不把 job 状态放进文献 catalog。

- [ ] 首先写 unknown 恢复行为测试并确认失败：

```ts
import { reconcile } from '../../dist/runtime/job-controller.js'
assert.equal(reconcile({ jobId: 'j1', backendId: 'b1', status: 'unknown',
  inputHash: 'input', protocolHash: 'protocol', heartbeatAt: null,
  progressAt: null, exitCode: null, artifactManifestHash: null }), 'wait_unknown')
```

- [ ] 写 fake backend 集成测试：第一次 submit 接收 job 后抛连接错误；controller 重启只 inspect 同一 jobId，submit 计数维持 1。fake 时钟仅验证过期逻辑，不代替真实进程测试。
- [ ] 本地 supervisor 用 `spawn(process.execPath, args,{detached:true,windowsHide:true,stdio:已打开日志句柄})` 启动并 unref；持久化启动意图，supervisor 自己打开 job DB、领取唯一执行权，再启动实际实验。控制器退出不向该 supervisor 传播自动取消。
- [ ] 用 jobId、随机 nonce、主机标识、启动身份和本地控制通道核对进程；PID 单独存在不能证明是同一 job。取消通过 supervisor 发送并等待实验退出；若子进程树无法确认终止，保持 cancel_requested/unknown 和资源预留，不能报告 cancelled。
- [ ] fence 在数据库事务中单调增加，控制命令必须带当前 fence。提交关键窗口 persisted submitting 后，任何新领取者必须 inspect；不能因 lease 过期直接重启旧作业。后端无法证实未启动时保持 unknown。
- [ ] supervisor 每 5s heartbeat，进展依据任务产物/声明阶段更新；长计算无新日志不自动判死。wall deadline 使用原起始时刻，重启不重置；超时请求取消并保存原因。日志轮转后保留序号/bytes/hash，超过产物上限停止收集并明确失败。
- [ ] 预算启动前 reserve，完成后 settle；unknown 仍占 reserve；cancel 只有确认停止才释放。现有 LLM request ledger 是模型费用事实源，新 runtime ledger 以 request ID 关联，不能再扣同一笔费用。没有后端计量的 CPU/GPU/费用字段保持 null；配置硬上限但无法计量/执行时拒绝启动该 profile。
- [ ] 本地任务 checkpoint 默认为 null；支持 resume 的任务必须验证 checkpoint 内容、输入/协议 hash、应用版本。恢复计算是新 attempt，保留先前费用；已完成任务直接 collect，不启动 resume。
- [ ] 构建后执行上述三个测试；真实进程测试在提交前、spawn 后回执前、完成后收集前终止 controller，再启动新 controller，核对执行计数和预算。补两 controller 竞争、PID 复用模拟、重复终态回执和取消未确认。
- [ ] 提交 `feat(runtime): persist job receipts recovery and resource reservations`。

## B4：任务依赖图、实验 runner 与幂等结果准入

**Dependencies:** B2 + B3。

**Files:** 新增 `src/experiment/task-graph.ts`、`artifact-manifest.ts`、`runtime-adapter.ts`、`test/unit/experiment-task-graph.test.ts`、`test/integration/durable-experiment-loop.test.ts`；修改 `src/experiment/runner.ts`、`steps.ts`、`src/service/runner.ts`、`src/service/research-cycle.ts`、`src/experiment/evidence-validator.ts`、`src/export/evidence-chain.ts`。

**Interfaces:**

```ts
export interface ExperimentTask {
  id: string; dependsOn: string[]; protocolHash: string; inputHash: string
  stage: 'prepare' | 'baseline' | 'develop' | 'formal' | 'reproduce' | 'summarize'
  job: JobSpec; validatorId: string
}
export interface ArtifactManifest {
  jobId: string; attemptId: string; protocolHash: string; inputHash: string
  artifacts: { relativePath: string; bytes: number; sha256: string; kind: string }[]
  evaluatorVersion: string; environmentHash: string
}
export declare function readyTasks(tasks: ExperimentTask[],
  completed: { taskId: string; protocolHash: string; inputHash: string }[]): ExperimentTask[]
export declare function validateTaskGraph(tasks: ExperimentTask[]): void
```

- [ ] 首个测试构造 prepare→baseline→formal：准备完成但 inputHash 变化不能满足 baseline 前置条件；图有环必须拒绝。

```ts
assert.deepEqual(readyTasks(tasks, [completedPrepare]).map(t => t.id), ['baseline'])
assert.throws(() => validateTaskGraph(cyclicTasks), /TASK_GRAPH_CYCLE/)
assert.ok(!readyTasks(tasks, [{ ...completedPrepare, inputHash: 'changed' }])
  .some(t => t.id === 'baseline'))
```

tasks 中 prepare/baseline/formal 的 JobSpec 使用 B3 完整 fixture，stage/inputHash/protocolHash 与完成项一致；cyclicTasks 将 prepare.dependsOn 指向 formal。

- [ ] 冻结 TaskGraph：依赖、可执行命令、输入来源、输出类型/大小、validator 和预算都写 manifest；开发任务和正式任务区分 split/exposure。任意节点依赖内容变化使该节点及后继失效，不能只按文件名缓存。
- [ ] 将模型工作拆为生成受约束的执行计划/代码与实际 job 执行。planner 产出 command + argv，后端按数组 spawn；禁止把自然语言计划直接当 shell 拼接执行。已有 sandbox/能力校验继续适用。
- [ ] 两 runner 调用统一 runtime adapter：提交后可返回 waiting 状态，后续调度 inspect/collect。每个 task 通过 validator 后才进入 completed；job 退出码 0 不能替代产物核验。
- [ ] 幂等准入使用 `(attemptId,artifactManifestHash,validatorVersion)`；先持久化收集回执，再提交 ResearchStore，最后确认 outbox 消费。崩溃重放查询该准入 key，不重复生成 evidence。无需跨 SQLite/ResearchStore 假装有一个全局事务。
- [ ] paired_sign_test_v1 保持现有独立单位约束；benchmark adapter 暂缓，不作为本任务依赖。未知 validator ID 只能 unknown/exploratory，不能以 LLM 判断替代。
- [ ] 从 committed 状态生成 HANDOFF.md：目标、snapshot、协议、待处理 job、冲突、下一动作、预算和来源；它只是视图，恢复读取规范存储。候选/任务/作业三类状态在 ResearchTree 中相互链接。
- [ ] 构建后运行两个新增测试以及 B0 四路径测试。覆盖节点 7 后恢复、指标篡改、缺 baseline、协议缩水、重复结果、有效阴性、OOM 和 unknown job。
- [ ] 提交 `feat(experiment): execute protocol task graphs through durable jobs`。

## B 完成标准

- [ ] 一次实验观察和一次文献检索能共同进入 successor 输入，且能从保存的 manifest 重建当时的 prompt。
- [ ] 不依赖单次模型会话持续存活；控制器重启能接管已知 job，无法确定的 job 明确暂停。
- [ ] 预算/取消/幂等/角色边界通过故障测试；未开展 C4 实际持续运行前只声明这些已测行为。
