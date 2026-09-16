---
title: "Diffusion Language Model Training and Reasoning"
kind: architecture
nodes:
  - "Text Tokens|text"
  - "Noising|noise"
  - "Denoiser|llm"
  - "Left-to-Right Decoder|arrow"
  - "Reasoning Trace|path"
  - "Answer|check"
edges:
  - "Text Tokens -> Noising"
  - "Noising -> Denoiser"
  - "Denoiser -> Left-to-Right Decoder"
  - "Left-to-Right Decoder -> Reasoning Trace"
  - "Reasoning Trace -> Answer"
groups:
  - "Training: Text Tokens, Noising, Denoiser"
  - "Inference: Left-to-Right Decoder, Reasoning Trace, Answer"
annotations:
  - "Denoiser: fixed-order vs arbitrary-order"
style: academic-minimal
---
Paper-level diagram contrasting training and inference of a diffusion language model. Training corrupts tokens and learns a denoiser; inference unfolds a reasoning trace left to right before producing an answer. Two dashed phase containers, editable text, orthogonal arrows with one accent color, no external assets.
