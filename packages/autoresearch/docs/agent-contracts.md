# Agent Contracts

所有角色 Agent 通过 `providers/agent-provider.ts` 统一调度。当前实现使用 DSH `ctx.subagents.start('spawn', ...)`。

## 角色

| Role | 输入 | 输出 |
|---|---|---|
| rubric-generator | candidate, profile | `{ rubric: string }` |
| rubric-reviewer | candidate, profile, rubric | `{ ok: boolean, issues: string[], revised?: string }` |
| idea-generator | candidate, profile, rubric, tree | `{ hypotheses: IdeaDraft[], eda_request? }` |
| idea-falsifiability | ideaPackage | `{ testable_implication, unobservable_variables, is_falsifiable }` |
| idea-reviewer | ideaPackage + perspective | `{ perspective, critique, unaddressed_risks, fatal_flaw_found }` |
| hypothesis-reviser | tree, cycle | `{ summary, hypotheses: RevisionDraft[] }` |
| planner | tree, rubric, cycle | `{ plan: string }` |
| research-worker | runDir, cycle, plan, tree | `{ status: 'completed'\|'failed', summary, artifacts }` |
| evidence-agent | runDir, cycle, tree | `{ summary: string }` |
| supervisor | tree, rubric, plan, cycle | `{ action: 'continue'\|'revise'\|'finish'\|'fail', reason }` |
| writer | runDir, evidence_chain | `{ summary: string }` |

## 升级路径

后续可把 one-shot subagent 换成 `ctx.agents.create()` 的持久化 Agent，只需替换 `providers/` 实现。
