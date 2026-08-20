---
title: "LLM Finetuning Influence Flow"
kind: architecture
nodes:
  - "Training Example A|document"
  - "Training Example B|document"
  - "Parameter Update|matrix"
  - "Probability Mass Shift|flow"
  - "Good Outputs|check"
  - "Bad Outputs|cross"
edges:
  - "Training Example A -> Parameter Update"
  - "Training Example B -> Parameter Update"
  - "Parameter Update -> Probability Mass Shift"
  - "Probability Mass Shift -> Good Outputs"
  - "Probability Mass Shift -> Bad Outputs"
groups:
  - "Learning: Training Example A, Training Example B, Parameter Update"
  - "Effect: Probability Mass Shift, Good Outputs, Bad Outputs"
annotations:
  - "Probability Mass Shift: influence redistributed across outputs"
style: academic-minimal
---
Paper-level conceptual figure for a learning-dynamics analysis: training examples influence a parameter update that shifts probability mass between outputs, strengthening some good outputs but also some bad ones. Show two examples converging, then diverging into good and bad outcomes. Editable text, clean edges, academic minimal style.
