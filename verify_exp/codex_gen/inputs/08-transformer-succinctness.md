---
title: "Transformer Succinctness Hierarchy"
kind: architecture
nodes:
  - "Language Family|set"
  - "Transformer|llm"
  - "LTL Formula|formula"
  - "RNN|network"
  - "Finite Automaton|machine"
  - "Verification Problem|gavel"
edges:
  - "Language Family -> Transformer"
  - "Language Family -> LTL Formula"
  - "Language Family -> RNN"
  - "Language Family -> Finite Automaton"
  - "Transformer -> Verification Problem"
  - "LTL Formula -> Verification Problem"
  - "RNN -> Verification Problem"
  - "Finite Automaton -> Verification Problem"
groups:
  - "Equivalent Representations: Transformer, LTL Formula, RNN, Finite Automaton"
  - "Consequences: Verification Problem"
annotations:
  - "Transformer: exponentially more succinct"
style: academic-minimal
---
Paper-level illustration of a succinctness result: one language family has four equivalent representations of very different sizes, and the compactness gap makes verification problems hard. Show one input fanning out to four representations that all point to the verification consequence. Editable text, clean academic minimal style, no external assets.
