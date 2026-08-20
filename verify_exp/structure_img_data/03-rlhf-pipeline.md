---
title: "RLHF Preference Optimization Pipeline"
kind: architecture
nodes:
  - "SFT Model|llm"
  - "Sampling|dice"
  - "Reward Model|scale"
  - "Preference Data|database"
  - "Policy Update|loop"
  - "Evaluation|chart"
edges:
  - "SFT Model -> Sampling"
  - "Sampling -> Reward Model"
  - "Preference Data -> Reward Model"
  - "Reward Model -> Policy Update"
  - "Policy Update -> SFT Model"
  - "SFT Model -> Evaluation"
groups:
  - "Data: Preference Data"
  - "Training Loop: SFT Model, Sampling, Reward Model, Policy Update"
  - "Evaluation: Evaluation"
annotations:
  - "Policy Update: PPO / DPO / GRPO"
style: academic-minimal
---
Paper-level diagram of a reinforcement learning from human feedback loop: a policy samples completions, a reward model scores them, the policy is updated, and the loop repeats. Emphasize the cyclic edge back to the policy. Use dashed group containers for data, training loop, and evaluation. Editable text only, no external images.
