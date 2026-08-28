# DSH Subagent 适配与 Continuable 迁移设计

> 背景：之前 `SubagentRoleAgentProvider` 自实现了超时/重试/终止语义，导致长任务被错误地标记为 FAILED。
> 本设计将子代理生命周期交还给 DSH 原生管理。

---

## 1. 核心认知

```text
wait_agent timeout
  = 父代理等待输入/结果的等待期限
  ≠ 子代理执行超时
  ≠ 自动 interrupt / shutdown
```

子代理在父代理等待超时后仍然运行。

---

## 2. 旧问题

```text
research-worker 启动
→ 本地 40 分钟 AbortController
→ SubagentTimeoutError
→ withRetry 再启动一次
→ 第二次超时
→ run FAILED（终态，无法 resume）
```

---

## 3. DSH 原生替代

| 能力 | DSH 原生 |
|---|---|
| 启动角色子代理 | `ctx.subagents.start` / `startContinuable` |
| 等待完成 | `SubagentRun.result` / `subagent/end` |
| 等待超时 | 只是父代理等待结束，不杀子代理 |
| 查询状态 | `listChildren` / `listDescendants` |
| 继续等待 | 再次 wait / 查询 |
| 主动停止 | `interrupt` / `interrupt_agent` |
| 唤醒/发消息 | `followup` / `send_message` |

---

## 4. 当前适配

### 4.1 短任务

继续使用 DSH one-shot：

```ts
const run = await runtime.start(providerName, {
  prompt,
  parent,
  signal,
  outputSchema,
})
const result = await run.result
await run.dispose()
```

### 4.2 长任务（research-worker）

迁移到 continuable：

```ts
const started = await runtime.startContinuable({
  provider,
  label: role,
  request: { prompt, parent },
  signal,
})
const end = await waitForEnd(started.childId)
```

通过 DSH `subagent/end` 事件获取：

```ts
ctx.on('subagent/end', (info) => {
  // info.id = childId
  // info.stopReason
  // info.lastAssistantMessage
})
```

---

## 5. Checkpoint 状态

| 层面 | 是否有 checkpoint |
|---|---|
| AutoResearch run state | 有（`state.json`，高层 phase） |
| Paper pipeline | 有（`pipeline_checkpoint.json`） |
| one-shot subagent | 无 |
| continuable subagent | 有 durable session |
| research-worker 内部执行 | 当前实现仍等待最终输出，进程重启后需要重新挂接 childId |

---

## 6. 已知限制

1. continuable 子代理不返回结构化 outputSchema，只返回最终 assistant message；
2. 当前 provider 在内存中等待 `subagent/end`；
3. 父进程重启后，等待者丢失；
4. 若要完整 resume，需要把 `childId` 持久化到 run state，并在恢复时重新监听/查询。

---

## 7. TODO

```text
需要调查 DSH 原生 Agent 编排 vs 固定研究循环编排的效果，
确定是否应彻底删除 SubagentRoleAgentProvider 并改为 DSH Agent 直接编排 subagent。
```

---

## 8. 后续建议

1. 长任务 childId 写入 `state.json`；
2. resume 时通过 `listDescendants` / `followup` 重新挂接；
3. 长实验拆分为可落盘的子任务；
4. 若 DSH 原生编排验证通过，再删除自研 ResearchRunner 循环。
