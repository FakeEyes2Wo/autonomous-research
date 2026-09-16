# 证据驱动的实验想法循环与上下文管理规范

更新日期：2026-09-12。文档类型：流程与数据契约规范。适用范围：AutoResearch 的 `research_run` 与 `experiment_run`。

本规范定义目标行为；对应运行时实现仍须按第 9 节验收。基础设施复用、记忆机制及通用状态模型见[自动化科研通式](general-form.md)，包括有效性相对研究目标、科研/被测 Agent 双记忆隔离及数据曝光规则。返回[文档目录](../README.md)。

## 1. 目标与参考依据

失败报告必须成为下一轮研究的结构化输入。每轮先审查数据有效性，再更新主张、生成可证伪假设、选择可区分竞争解释的实验。原始失败、被否定的主张和历史协议不得因结果不理想而覆盖或删除；按明确保留策略归档。

参考案例位于 `D:/teskdesk/TEST paper/2026-09-10-failure-aware-memory`。该路径仅说明本地案例来源，不是运行依赖；以下文档于设计阶段只读核验：

- `input/idea.md`：长期研究问题与首篇论文约束。
- `docs/HANDOFF.md`：基准天花板、执行器变更、完整 episode 成本问题；是历史交接，不能当最新状态。
- `docs/DEFECT_INFRA_AS_RESULT.md`：执行器未运行被记为任务失败，说明必须先判定测量是否有效。
- `docs/ACCUMULATED_EVIDENCE.md`：不同 treatment 版本不能直接混合；其按所有实验臂结果筛选任务的建议不能用于同批正式验证，以免选择偏差。
- `docs/RERUN_PLAN.md`：处理池污染、重建与续跑；复用旧单元必须进一步验证 treatment 和协议指纹一致。
- `docs/ROUND40_STATUS.md`：新数据纠正“门控从不触发”，手写数字与结果漂移，规范分析入口。
- `docs/RESULTS_DIGEST.md`：本次读取的结果快照；尚未独立重算原始数据。

快照中 A2−A1 为 −0.102，95% CI 为 [−0.296,+0.093]，预算匹配差异 6.0%，超出原定 5% 容差。还记录 13 个存在重复结果冲突的单元、9 条 harness-fault、12 条 unscored。它不支持“失败记忆有收益”，也不能据此证明“失败记忆普遍有害”或等效。缺格与重复冲突的具体计数口径须由原始 manifest 核验，不能直接按摘要猜测补跑范围。

## 2. 当前代码与方案选择

当前完整 research runner 已有 evidence → reflexion → insight → idea generation；但 fail 分支仍终止。experiment runner 的 revise 分支增加 planVersion，没有显式的主张修订步骤。failure-reflexion 保存记录和报告索引；HypothesisPool 主要保存 statement/status/evidence_ids，缺少完整版本继承和判定记录。treeSummary 序列化整棵树；policy/context 已有预算和按行裁剪，应沿用预算能力并升级为按证据记录选择。

可选方案：

1. 仅强化提示词：改动小，但无法保证失败报告被消费、版本可追踪或恢复不重复执行。
2. **推荐：在现有 runner 中增加共同的证据判定、研究修订与上下文组装步骤。** 保留现有角色和两种模式，以结构化记录控制转换。
3. 全面更换为研究图调度框架：更灵活，但迁移范围过大，不纳入本次。

## 3. 研究对象与版本

研究问题（idea）描述要解释的现象；主张（claim）描述拟建立或已建立的结论及适用范围；假设（hypothesis）描述下一实验可检验的预测，三者不得混为一句任务描述。

每个记录必须有 id、version、created_at、来源引用和内容 hash。修订创建新版本，不覆盖历史 statement。

| 对象 | 必需内容 |
|---|---|
| Claim | statement、scope、parent_claim_ids、supporting_evidence_ids、opposing_evidence_ids、status、判定理由 |
| Hypothesis | claim_id/version、parent_hypothesis_ids、机制解释、竞争解释、预测观察、反证观察、测量与判定规则、适用范围、生成来源 |
| Protocol | hypothesis 版本、主指标、对照/消融、样本与 split、seed、预算单位和容差、停止规则、缺失/失败/重复处理、代码/数据/treatment/model 指纹 |
| Evidence | protocol_hash、attempt_id、原始 artifact/hash/行范围、分析代码 hash、有效性、样本量、效应/不确定性、split、exploratory/formal 标签 |
| FailureAnalysis | 失败类别、事实、原因假说、未知项、受影响证据与主张、建议动作、验证该诊断的最小实验 |
| RevisionDecision | 父版本、引用的 failure/evidence、旧判定、修订内容、备选假设、选择理由、下一协议、停止条件 |

Claim 状态：proposed、supported、refuted、inconclusive、superseded。缺乏显著收益不自动成为 refuted；按冻结的判定规则评价。多个冲突证据必须聚合并保留冲突，不能让最后写入者覆盖结论。

## 4. 循环与失败分类

正常顺序：intake → context → claim/hypothesis → protocol → preflight/pilot → freeze → execute → validate → assess → report → revise/replicate/repair/finish/pause。

report 是每轮产物，不天然等同研究终点。先生成结构化判定与失败分析，再生成 Markdown 展示，下一轮读取结构化记录及原始证据引用。

| 类别 | 主张处理 | 下一动作 |
|---|---|---|
| execution_error：API/进程/环境故障 | 通常不作为算法机制的反证；若协议研究端到端可靠性，则按预定规则纳入 | 修复并 smoke，按有界重试创建新 attempt |
| invalid_measurement：评分错误、泄漏、污染、错协议 | 受影响证据标记 invalid，撤销依赖它的支持 | 修复测量；科学定义改变时新建协议并重跑受影响单元 |
| insufficient_evidence：缺格、样本不足、区间太宽 | inconclusive | 原协议补齐或预先定义复现实验；禁止观察到显著为止 |
| hypothesis_refuted：有效数据满足预设反证规则 | 旧假设 refuted，保留反证 | 收缩主张、修订机制或提出竞争假设，进入新协议 |
| mixed_evidence：异质性/矛盾 | 保留适用边界与冲突 | 生成探索性分层假设，在新数据验证 |
| supported | 限定范围的支持 | 复现/机制消融；证据充分后写论文 |
| budget_exhausted / external_block | 记录未决，不判科学失败 | PAUSED 与可恢复交接 |

一次报告可以包含多种失败，分别关联受影响的数据子集。存在测量无效时，不能直接借这些数值修订科学机制。

故障、超时与缺失的纳入规则必须事先确定。处理本身导致的失败不能事后当作外因删除；有效性相对于目标主张判定，而非看到 error 就排除整行。

旧 supervisor 的 fail 进入分类器；用户明确终止、拒绝的动作、禁止的范围仍保持终止，不因自动循环绕过。无法归因或缺少必要证据时暂停并列出具体缺口。

## 5. 数据怎样生成新主张与实验

每轮必须完成以下有序动作：

1. 锁定证据快照并核验有效性；列出可用与不可用数据及原因。
2. 按旧协议判断每个假设；更新旧主张的支持范围，不回改成功标准。
3. 输出“观察事实 / 可能解释 / 尚未验证”三栏，不把 reflexion 自动升级为事实。
4. 生成至多 3 个候选：收缩范围、修订机制、竞争解释。每个必须引用具体证据，说明相对旧假设改变了什么。
5. 根据可区分性、可证伪性、成本与可执行性选择一个；没有实质变化的重复候选不自动重跑。
6. 先安排能区分候选解释的最小实验；可执行性通过后冻结正式协议。
7. 观察过的数据用于生成新假设时，新假设标记 exploratory；其正式验证使用未参与选假设的数据或与目标相符的预先定义的有效自适应分析方案。在相同题目上增加 seed 可以估计随机性，但不能消除根据这些题目选择假设造成的偏差。

针对参考项目的候选示例（均未被现有数据证实）：

- 原主张：“失败记忆在成本匹配下提高任务成功率”。当前快照应记为尚未支持，且关键比较预算门槛未通过。
- H1：“可核验且任务相关的失败教训比未经核验的教训更有效”。实验固定检索来源、内容长度和总 episode 预算，比较核验与未核验，并保留 placebo。
- H2：“不相关记忆造成干扰，适用性门控减少伤害”。在开发集确定门槛后冻结，在独立测试集比较同一池的门控/无门控，预定义 harm 与 abstention 指标。
- H3：“收益取决于记忆内容的任务相关性，失败/成功极性不是主要因素”。采用极性 × 相关性设计；无显著差异不能当作等效，等效结论需预设界限和相应设计。

在这些机制实验前，先核验重复冲突、样本覆盖、处理池指纹和成本匹配。不能把待修复的旧矩阵直接视为新假设的验证数据。

## 6. 精细上下文管理

### 6.1 信息分层与权威性

L0：研究目标、用户约束、预算、冻结 rubric 和当前协议。每次必带，不可被历史总结改写。

L1：当前工作状态，包含 branch/cycle/stage、活动主张和假设版本、协议 hash、证据 snapshot、未决问题、下一动作、剩余预算。

L2：当前假设相关证据卡；支持、反对、无效测量和最近失败均检索。每张卡含数字、样本、区间、有效性及可回查出处。

L3：历史主张谱系、已否决方案、已确认工程教训和适用边界；按需选择，避免重复踩坑。

L4：原始日志、完整论文、逐行结果、代码版本。存放在文件中，按 artifact/行范围读取，不整批注入。

权威顺序：匹配当前协议的已提交证据快照及原始记录 > 同快照生成报告 > 历史交接文字。文件较新不自动权威；必须匹配协议和数据版本。矛盾不能用“最新摘要覆盖”静默处理。

### 6.2 每次角色调用的上下文包

保存 `context/<call-id>.json` 与可读渲染，记录 role、stage、输入对象版本、snapshot_id、选择/排除的 record ids、原因、预算、估算方法、内容 hash、压缩来源。

| 角色 | 必带上下文 |
|---|---|
| idea/hypothesis reviser | 目标约束、旧主张与判定、有效观察、反证、失败分类、已排除解释、可用资源 |
| planner/designer | 被选假设、竞争解释、最小区分实验、冻结规则、工程故障与恢复要求 |
| worker | 精确协议、执行范围、输入数据/代码版本、验收命令、产物目录；正式执行不接触受隔离的测试答案 |
| evidence/auditor | 协议、原始产物索引、数据覆盖/冲突/失败分类、预定统计与成本规则 |
| supervisor | 证据判定、候选修订、预算、停止条件、当前约束和冲突 |
| paper writer | 已提交快照、被允许的 claim 版本、数字引用表、局限及未完成比较 |

检索先按当前 hypothesis/claim/protocol 关联，再补齐反证和工程阻塞，最后加入历史相似教训。禁止只取正向证据或简单保留最早的 N 行。

### 6.3 预算、压缩与失效

沿用 maxInputTokens 及 tree/evidence/failure/paper 分类预算；有效输入容量还要扣除系统提示、工具描述和输出预留。优先使用匹配模型的 tokenizer；仅有估算时标明估算且预留余量，不承诺硬上界。

预算分配顺序：完整 L0 + 当前 L1 → 关键支持/反证和阻塞 → 相关历史 → 补充文献。按完整记录压缩/选择，禁止裁断 JSON、置信区间、否定条件或出处。必要记录仍放不下则分阶段读取或报告 context_insufficient，不能带缺失约束继续决策。

压缩结果是可重建缓存，必须列出 source ids/hashes、覆盖范围、未决矛盾和被省略记录。协议、数据快照、主张判定、处理池或约束变更均使依赖缓存失效。

不把完整聊天记录当长期记忆。每个步骤结束提交事实与决定，下一次由持久记录重新构建上下文。经验条目保存 observation、interpretation、validated_by、applies_when、does_not_apply_when；未经验证的原因解释不作为硬规则。

## 7. 持久化、续跑与报告

建议新增工件：

```text
research/claims.jsonl
research/hypotheses.jsonl
research/decisions.jsonl
cycles/<cycle-id>/protocol.json
cycles/<cycle-id>/attempts/<attempt-id>/manifest.json
cycles/<cycle-id>/evidence/<snapshot-id>/manifest.json
cycles/<cycle-id>/assessment.json
cycles/<cycle-id>/failure-analysis.json
cycles/<cycle-id>/revision.json
cycles/<cycle-id>/REPORT.md
context/<call-id>.json
CURRENT.json
HANDOFF.md
```

核心谱系和 attempt 追加保存；CURRENT 是可重建活动指针，HANDOFF 和 Markdown 报告由相同提交状态生成。

同一个 transition 使用稳定 decision id，先写产物、校验 hash、再原子提交指针；崩溃恢复检测未提交产物，避免同一修订添加两次。每 run 单写者；首版使用文件工件。

恢复付费或远程 job 时先查询后端状态与执行回执。状态未知时标记 unknown 并暂停该 job 的重新发起，不能仅因本地缺少完成记录就重复执行；不承诺未知后端的 exactly-once 执行。

续跑复用键包括 hypothesis_version、protocol_hash、code/data/treatment/model 指纹、instance/arm/seed。只有已完成且有效、指纹兼容的单元才能跳过。工程修复需明确证明哪些已有结果仍有效，不能仅靠同名目录或 scored=True 复用。

同一个单元的重复 attempt 都保留；冲突按冻结规则处理，不能挑成功值或默认最后写入值。无法判定时标记冲突，阻止依赖它的正式结论。

运行中报告标记 provisional，并绑定行清单或稳定数据快照。正式表格、主张审计和论文共用同一 snapshot_id；更新数据后重新生成并验证，不手改数字。

旧 FAILURE_REPORT 通过显式导入形成新研究分支，保存原报告 hash 与来源 run；不修改已终止历史 run。只有文字而无数据时，先恢复/验证证据，其内容只能作为待验证诊断。

## 8. 自动循环边界与接入范围

预算使用现有全局 token/role-call/实验预算，在所有修订与 retry 间累计，不能开新版本清零。工程重试沿用现有有界策略；科学修订另有可配置上限，并受现有 maxCycles/maxRounds 总限约束。

相同协议与失败签名连续重现、没有新的诊断或变化时不重复执行。预算用尽或没有可区分且可执行的候选时 PAUSED，并保存恢复所需信息。不得以“直到获得支持”为循环停止规则。

完整与 minimal 模式使用同一记录、分类和转换规则；minimal 允许一次现有角色调用返回联合 assessment/revision，避免强制增加多轮角色调用。

接入位置：core 负责谱系和持久化；service 的共同步骤负责验证/判定/修订；policy/context 负责记录级组装；两个 runner 调用共同步骤；prompts 规定输出结构；报告读取已提交快照。前端本次只需展示现有报告和状态，不重做工作台。

旧数据使用兼容读取；缺失 provenance 标记 unknown，不能伪造为 formal。ResearchTree 与 HypothesisPool 作为派生视图同步，统一由同一提交版本更新，避免互相覆盖。

## 9. 实施验收标准

1. 有效反证 → 旧假设保留并被判定 → 带父版本和证据的新假设 → 新协议 → 下一轮执行。
2. API/评分故障 → 按协议分类并工程修复或暂停；不会把未执行或无效测量误记为算法机制的反证。协议定义的端到端可靠性结果仍按原规则统计。
3. 无显著差异 → inconclusive；不会自动声称等效或普遍无效。
4. 预算不匹配、污染、不同 treatment 版本、重复冲突可阻止相关正式主张。
5. 极小上下文预算下仍保留必要约束、反证和引用；放不下时显式阻止决策。
6. 旧 HANDOFF 与新证据冲突时，以版本校验处理并保留纠正记录。
7. 任一提交点中断后恢复，已确认完成的实验不重复执行、同一假设修订不重复提交、预算不重置；无法确认的远程 job 显式保持 unknown 并等待状态核验。
8. 数据更新使旧摘要和论文数字失效；同一报告的表格与主张必须来自同一快照。
9. research_run / experiment_run 的 legacy（完整）与 minimal 路径都验证上述关键转换。
10. 用确定性测试 fixture 验证流程，再运行相关现有单元/集成检查；实际付费科学实验在实现验证后按既有用户范围和预算执行。

实施记录应逐项关联验收结果、协议/数据版本和验证命令；流程测试与实际科学结论分开记录。相关记忆效果评估见[自动化科研通式](general-form.md)第 13 节。
