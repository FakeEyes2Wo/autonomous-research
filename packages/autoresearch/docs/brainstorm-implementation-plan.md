# Brainstorm 实现现状

## 已实现

1. **程序化 paper wiki**
   - `writeWikis` 直接使用 `renderPaperWiki(paper)` 从 `PaperRecord` 生成 `paper_wiki/*.md`
   - 已移除 LLM `paper-wiki-writer` 调用路径和相关角色
   - 读取阶段返回更丰富字段并注入 wiki

2. **DSH 原生 subagent 生命周期**
   - 不再自实现超时 / AbortController / 终止语义
   - 短任务使用 one-shot `ctx.subagents.start`
   - 长任务（`research-worker`）迁移到 `startContinuable`
   - 通过 DSH `subagent/end` 事件收取最终结果

3. **topic-isolated brainstorm**
   - brainstorm 不再接收 seed / 特定课题 / 历史方向
   - 所有 brainstorm prompt 明确要求只使用 Plan 和检索结果

## 待办 / 调查

- 调查 DSH 原生 Agent 编排 vs 固定研究循环编排的效果
- 决定是否彻底移除 `SubagentRoleAgentProvider` 并改为 DSH Agent 直接编排

## 验证

- `npm run build` ✅
- `npm test` ✅ 56 项全部通过
