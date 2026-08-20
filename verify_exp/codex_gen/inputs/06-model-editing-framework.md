---
title: "Null-Space Constrained Model Editing Framework"
kind: architecture
nodes:
  - "Base LLM|llm"
  - "Edit Request|edit"
  - "Key-Value Mapping|key"
  - "Null-Space Projection|matrix"
  - "Edited LLM|llm"
  - "Preservation Check|check"
edges:
  - "Base LLM -> Key-Value Mapping"
  - "Edit Request -> Key-Value Mapping"
  - "Key-Value Mapping -> Null-Space Projection"
  - "Null-Space Projection -> Edited LLM"
  - "Edited LLM -> Preservation Check"
groups:
  - "Edit Pipeline: Edit Request, Key-Value Mapping, Null-Space Projection"
  - "Verification: Base LLM, Edited LLM, Preservation Check"
annotations:
  - "Null-Space Projection: preserves unrelated knowledge"
style: academic-minimal
---
Paper-level method figure for a model editing approach that applies changes only in a null space so unrelated knowledge is preserved. Show the base model feeding both the edit pipeline and the final preservation check. Two dashed groups, matrix-style node, editable text, orthogonal arrows, academic minimal style.
