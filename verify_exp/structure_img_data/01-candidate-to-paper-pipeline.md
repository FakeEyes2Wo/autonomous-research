---
title: "Candidate-to-Paper Autonomous Research Pipeline"
kind: architecture
nodes:
  - "Candidate Intake|person"
  - "Brainstorm|lightbulb"
  - "Ideation|idea"
  - "Experiment Plan|clipboard"
  - "Experiment|flask"
  - "Evidence|database"
  - "Claims & Outline|list"
  - "Writing|document"
  - "Review|magnifier"
  - "Packaging|box"
edges:
  - "Candidate Intake -> Brainstorm"
  - "Brainstorm -> Ideation"
  - "Ideation -> Experiment Plan"
  - "Experiment Plan -> Experiment"
  - "Experiment -> Evidence"
  - "Evidence -> Claims & Outline"
  - "Claims & Outline -> Writing"
  - "Writing -> Review"
  - "Review -> Packaging"
groups:
  - "Idea & Experiment: Candidate Intake, Brainstorm, Ideation, Experiment Plan, Experiment"
  - "Paper: Evidence, Claims & Outline, Writing, Review, Packaging"
annotations:
  - "Experiment: Athena / external / none"
  - "Review: verify-trace + 3 audits"
style: academic-minimal
---
Paper-level architecture diagram of an end-to-end autonomous research system that turns one vague human idea into a paper. Ten stages flow left to right. Use two dashed group containers for the Idea & Experiment phase and the Paper phase. Icons are optional; every label must be editable text. Layered left-to-right layout, orthogonal edges, no crossing edges, white background, dark gray text, one accent color for arrows.
