// Shared by the native DSH shell and the standalone workbench.
export const RESEARCH_ACTIONS = [
  { id: 'generate', label: '开始研究', description: '明确问题、评价标准与完整验证计划', needsPaper: false },
  { id: 'design', label: '设计实验', description: '检查覆盖矩阵、分阶段计划与结论边界', needsPaper: false },
  { id: 'review', label: '审查证据', description: '核对正式验证、覆盖缺口和可支持的结论', needsPaper: false },
  { id: 'write', label: '撰写论文', description: '根据已有研究和证据生成论文', needsPaper: false },
  { id: 'refine', label: '改进论文', description: '修订当前已保存的论文', needsPaper: true },
];

export const RESEARCH_ROLES = [
  ['project-explorer', '项目探索'], ['paper-survey', '文献综述'], ['direction-select', '方向选择'],
  ['paper-frontier-miner', '前沿挖掘'], ['brainstorm', '头脑风暴'], ['coverage-reviewer', '覆盖审查'],
  ['rubric-generator', '评价标准'], ['idea-generator', '选题'], ['idea-reflexion', '选题复盘'],
  ['idea-query-planner', '选题检索规划'], ['idea-similarity-reviewer', '选题相似性审查'],
  ['planner', '研究规划'], ['minimal-verifier', '可行性试跑'], ['model-scout', '模型选择'],
  ['experiment-designer', '实验设计'], ['experiment-reflexion', '设计完整性审查'],
  ['research-worker', '研究执行'], ['evidence-agent', '证据整理'], ['supervisor', '监督决策'],
  ['result-reflexion', '结果复盘'], ['insight-abstractor', '洞见提炼'],
  ['paper-planner', '论文规划'], ['contract-negotiator', '论文验收约定'], ['writer', '论文写作'],
  ['figure-generator', '图表生成'], ['proof-checker', '证明检查'], ['claim-auditor', '结论审查'],
  ['citation-auditor', '引用审查'], ['kill-argument-reviewer', '关键论证审查'],
  ['paper-reviewer', '论文评审'], ['figure-reviewer', '图表评审'], ['paper-contract-reviewer', '验收审查'],
  ['layout-reviewer', '版式评审'], ['paper-polisher', '论文润色'],
];

export const WORKFLOW_LABELS = { minimal: '低调用流程', legacy: '完整研究流程' };
export const WORKFLOW_HELP = {
  minimal: '规划 → 研究执行 → 本地证据整理 → 监督决策；按策略触发结果审查。减少角色调度调用，仍须完成结论所需的科学验证。',
  legacy: '规划 → 可行性试跑 → 模型选择 → 实验设计与完整性审查 → 研究执行 → 证据整理与监督决策；各可选阶段按项目设置触发。',
};
export const VALIDATION_GUIDANCE = '试跑仅用于筛选与校准。正式验证须覆盖必要的基线、消融与对照、数据与划分、样本量与重复、指标、稳健性及失败结果。资源不足时保留缺口并明确结论边界。';

export function researchActionDisabled(kind, context = {}) {
  const action = RESEARCH_ACTIONS.find((item) => item.id === kind);
  return !action || !context.ready || Boolean(context.busy) || Boolean(action.needsPaper && !context.document) || Boolean(context.document && context.dirty);
}

export function researchPrompt(kind, document) {
  const paper = document?.relativePath ? `当前论文源文件：${JSON.stringify(document.relativePath)}（相对于当前项目）。请先读取文件。\n` : '';
  const integrity = '不要编造实验结果或引用；区分已执行的证据、计划中的工作和未验证的解释。';
  const coverage = '列出完整验证覆盖矩阵：基线、消融与对照、数据与划分、独立样本量与重复、指标、稳健性和失败结果；逐项标记纳入、分阶段、不适用或受阻，说明理由及对结论的影响。';
  const prompts = {
    generate: `请使用 AutoResearch 根据我们讨论的研究问题开展研究。先明确研究问题、目标总体与评价标准，再规划完整验证。${coverage}试跑仅用于筛选与校准，不能替代或缩小正式验证。预算不足时保留缺口，明确需要调整的范围或预算。正式运行使用项目下独立的 .runs 目录，按项目设置决定论文输出。${integrity}\n我的研究想法：`,
    design: `${paper}请基于当前研究问题和已有材料设计或审查实验。${coverage}执行可以分阶段，但保留完整路线和各阶段的证据、停止条件；正式实验冻结协议版本、指标、划分、种子和预算。试跑成功不等于设计完整或结论成立。${integrity}\n本轮实验要求：`,
    review: `${paper}请检查当前研究的论证与证据；如尚无论文，先读取已有研究记录。核对实验设计覆盖矩阵，区分设计完整性和实际执行状态，列出缺失、受阻及尚待完成的正式验证。试跑或 smoke check 不能证明研究结论。检查证据来源、失败与负面结果、复现记录和结论边界，给出下一步建议。${integrity}`,
    write: `${paper}请使用当前项目已完成的研究记录和证据撰写论文，保存 main.tex、参考文献及可用的 PDF。先核对结论与证据的对应关系，标明试跑、正式验证、未完成验证及局限；若证据不足，明确缺口和需要补充的验证。${integrity}\n论文要求：`,
    refine: `${paper}请结合此前对话改进这篇论文，先说明计划再修改源文件，保留已验证的结论和引用，标明尚未覆盖的验证与结论边界。完成后总结修改，并按需编译 PDF。不要重新运行已完成的研究来替代论文修订。${integrity}\n本轮修改要求：`,
  };
  return prompts[kind] || '';
}
