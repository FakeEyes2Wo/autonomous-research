# Architecture

```text
DSH
├─ Agent / Subagent / Goal / Workflow
├─ Tools / Skills / Model Routing
└─ AutoResearchService
   ├─ core/       ResearchTree + state + deterministic rules
   ├─ domain/     candidate/rubric/plan/action/evidence/decision/paper
   ├─ agents/     role agents (Rubric, Planner, Worker, Evidence, Supervisor, Writer)
   ├─ service/    orchestration + recovery
   ├─ tools/      DSH tool definitions
   └─ export/     evidence_chain.json + reports
```

原则：

- `AutoResearchService` 是顶层状态唯一写者。
- Agent 建议必须经过状态推进和恢复检查后才能生效。
- 不实现 DAG / EventBus / 任务队列 / 数据库。
- 所有写入通过原子 JSON。
