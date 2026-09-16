---
title: "Agent Memory and Reflection Loop"
kind: architecture
nodes:
  - "Task|inbox"
  - "Planner|plan"
  - "Executor|gear"
  - "Observation|eye"
  - "Reflection|mirror"
  - "Memory|database"
  - "Next Action|loop"
edges:
  - "Task -> Planner"
  - "Planner -> Executor"
  - "Executor -> Observation"
  - "Observation -> Reflection"
  - "Reflection -> Memory"
  - "Memory -> Planner"
  - "Planner -> Next Action"
groups:
  - "Loop: Planner, Executor, Observation, Reflection, Memory"
  - "Boundary: Task, Next Action"
annotations:
  - "Reflection: verbal self-critique written to memory"
style: academic-minimal
---
Paper-level architecture of a reflective agent loop: plan, act, observe, reflect into memory, and replan. Emphasize the cycle from memory back to the planner. Two dashed containers, cyclic edges, editable text labels, no external images, academic minimal palette.
