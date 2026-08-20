# Fixture：固定架构图描述

本描述是 drawio MCP 能力验证的唯一固定输入。所有臂必须只使用这段描述与 `fixture/figure_spec.json`，不得自行改写内容。

## 描述

Draw an architecture diagram of an autonomous research pipeline named "candidate-to-paper".

Stages (left to right): Candidate Intake, Brainstorm, Ideation, Experiment Plan, Experiment, Evidence, Claims & Outline, Writing, Review, Packaging.

Grouping: the first five stages belong to "Idea & Experiment"; the last five belong to "Paper".

Icons: use a person icon for Candidate Intake, a lightbulb icon for Brainstorm, a flask icon for Experiment, a database icon for Evidence, and a document icon for Paper outputs.

Edges: Candidate Intake → Brainstorm → Ideation → Experiment Plan → Experiment → Evidence → Claims & Outline → Writing → Review → Packaging.

Annotations: add a small note under Experiment: "Athena / external / none"; under Review: "verify-trace + 3 audits".

Layout: layered left-to-right; two group containers for the two phases; edges orthogonal; no crossing edges if possible.

Style: white background, dark gray text, one accent color for arrows, no external images, all labels editable text.
