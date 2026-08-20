---
title: "Multi-Turn LLM Evaluation Harness"
kind: architecture
nodes:
  - "Single-Turn Benchmarks|database"
  - "Sharding|scissors"
  - "Conversation Simulator|chat"
  - "User Model|person"
  - "LLM Under Test|llm"
  - "Aptitude Metric|chart"
  - "Reliability Metric|chart"
edges:
  - "Single-Turn Benchmarks -> Sharding"
  - "Sharding -> Conversation Simulator"
  - "User Model -> Conversation Simulator"
  - "Conversation Simulator -> LLM Under Test"
  - "LLM Under Test -> Conversation Simulator"
  - "Conversation Simulator -> Aptitude Metric"
  - "Conversation Simulator -> Reliability Metric"
groups:
  - "Environment: Single-Turn Benchmarks, Sharding, Conversation Simulator, User Model"
  - "Metrics: Aptitude Metric, Reliability Metric"
annotations:
  - "Sharding: at most one requirement per turn"
style: academic-minimal
---
Paper-level architecture of a simulated multi-turn evaluation environment. Existing single-turn instructions are sharded into pieces revealed one per turn; a user model interacts with the LLM under test; two metrics decompose performance into aptitude and reliability. Dashed group containers, cyclic conversation edge, editable text labels, no external images.
