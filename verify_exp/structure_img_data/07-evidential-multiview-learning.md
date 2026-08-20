---
title: "Evidential Conflictive Multi-View Learning"
kind: architecture
nodes:
  - "View 1|image"
  - "View 2|audio"
  - "View 3|text"
  - "View-Specific Evidence|scale"
  - "Opinion Construction|chat"
  - "Conflictive Aggregation|merge"
  - "Decision + Reliability|check"
edges:
  - "View 1 -> View-Specific Evidence"
  - "View 2 -> View-Specific Evidence"
  - "View 3 -> View-Specific Evidence"
  - "View-Specific Evidence -> Opinion Construction"
  - "Opinion Construction -> Conflictive Aggregation"
  - "Conflictive Aggregation -> Decision + Reliability"
groups:
  - "Inputs: View 1, View 2, View 3"
  - "Fusion: View-Specific Evidence, Opinion Construction, Conflictive Aggregation"
annotations:
  - "Conflictive Aggregation: common vs view-specific reliability"
style: academic-minimal
---
Paper-level architecture of a multi-view learning method that handles conflicting views. Three views produce evidence, opinions are built per view, then a conflict-aware aggregation outputs both a decision and its reliability. Three parallel input nodes converging into a fusion block; editable text; no external images.
