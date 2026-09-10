# README Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the root README a coherent Chinese public entrance for AutoResearch and add portable, honestly labelled settings/workbench screenshots with reproducible provenance.

**Architecture:** Keep the public explanation self-contained or linked only to the tracked package guides and conversational-workbench guide. Reuse the existing Web browser harnesses and temporary fixtures to produce three checked-in PNGs, then record exact commands, outputs, labels, limitations, and parent evidence in a verification draft so screenshots never imply a real model run or an unverified live deployment.

**Tech Stack:** Markdown, PNG, Node.js 22, npm, `@athena/autoresearch-web` browser harnesses, Chromium/Edge headless CDP.

## Global Constraints

- Owned files only: `README.md`; `docs/assets/autoresearch/settings.png`; `docs/assets/autoresearch/workbench-desktop.png`; `docs/assets/autoresearch/workbench-mobile.png`; `docs/assets/autoresearch/README.md`; `docs/drafts/2026-09-10-readme-screenshots-verification.md`.
- Record the actual current commands in the report: `npm --prefix packages/autoresearch-web run build`, `npm --prefix packages/autoresearch-web test`, `npm --prefix packages/autoresearch-web run test:browser`, and `npm --prefix packages/autoresearch-web run test:workbench:browser`; the latter two emit screenshots in temporary profiles that are copied into the owned asset paths. Current parent evidence is core `155/155` with typecheck passed and Web `60/60` passed; do not require rerunning those suites or their builds.
- Label `test/browser-render.test.mjs` output as a temporary settings browser smoke/mock fixture and `test/workbench-browser.mjs` output as a temporary mock-host browser fixture; do not call either a real DSH, real provider, real model, or real research result.
- Do not inspect, read, write, screenshot, or otherwise use the prior generated reference project; do not run a live-profile acceptance against it.
- Do not rerun models or research, send model requests, change provider configuration/runtime behavior, alter dependencies or lockfiles, or modify package/build/test harnesses.
- Browser/DSH child processes must be started hidden (`windowsHide: true` or equivalent) and cleaned up; request escalation if sandbox/browser restrictions prevent the required offline capture.
- Root `README.md` must be a complete Chinese public entrance covering installation/use; core versus optional Web/CPA; minimal versus legacy (full) mode; the workflow; engineering-experiment layout; scientific protocol; the legacy pre-work design and proceed-or-`PAUSED` boundary; outputs, resume, and troubleshooting; and code/config/log provenance. It must explain the settings surface and conversational LaTeX/PDF workbench, provide copy-paste commands, link the three assets with meaningful alt text/captions, distinguish local test/mock evidence from live deployment and real research, and make no promise of registry publication or latest DSH support. Links may target the tracked `packages/autoresearch/README.md`, `packages/autoresearch-web/README.md`, `docs/drafts/2026-09-10-conversational-workbench-guide.md`, this delivery's asset README and verification record, or self-contained text.
- Parent agent alone performs visual inspection/acceptance of all PNGs and any git/release operation; this plan has no commit step.

---

### Task 1: README documentation and screenshot capture deliverable

**Files:**
- Modify: `README.md`
- Create: `docs/assets/autoresearch/settings.png`
- Create: `docs/assets/autoresearch/workbench-desktop.png`
- Create: `docs/assets/autoresearch/workbench-mobile.png`
- Create: `docs/assets/autoresearch/README.md`
- Create: `docs/drafts/2026-09-10-readme-screenshots-verification.md`

**Interfaces:** The settings image comes from `test/browser-render.test.mjs`; desktop/mobile workbench images come from `test/workbench-browser.mjs`. Documentation consumes only repository-relative asset links and the command/output facts emitted by those harnesses.

- [x] Run `npm --prefix packages/autoresearch-web run test:browser` with its existing hidden Chromium/Edge process, locate the reported temporary `dsh-autoresearch-settings.png`, and copy it to `docs/assets/autoresearch/settings.png`.
- [x] Run `npm --prefix packages/autoresearch-web run test:workbench:browser` with its existing hidden browser process, locate the reported temporary `workbench-desktop.png` and `workbench-mobile.png`, and copy the suitable outputs to the matching `docs/assets/autoresearch/` paths; preserve the temporary fixture semantics.
- [x] Because the stock mobile screenshot is not suitable for a public README, author a temporary ignored capture adapter with `apply_patch` outside the six owned deliverables; it composes existing built UI and harness behavior only and does not modify app code, tests, runtime behavior, dependencies, or locks.
- [x] Check that all three files are non-empty PNGs and that desktop/mobile imagery corresponds to the harness viewport names; record dimensions, command output, temporary artifact provenance, and `status: passed` evidence in `docs/drafts/2026-09-10-readme-screenshots-verification.md`.
- [x] Write `docs/assets/autoresearch/README.md` with asset purpose, source harness, exact reproduction commands, fixture/mock labels, and the fact that no model request or research rerun was made.
- [x] Rewrite the root README as the complete Chinese public entrance specified in Global Constraints, using relative links and self-contained explanations for installation/use, core/optional Web/CPA boundaries, minimal/legacy workflow, engineering layout, scientific protocol and the mode-specific pre-work gate, outputs/resume/troubleshooting, and code/config/log provenance; add the screenshot section with useful alt text/captions and explicit local fixture/mock wording, and link only allowed tracked guides plus the verification draft.

### Task 2: Review, verification, and release handoff

**Files:**
- Review: `README.md`
- Review: `docs/assets/autoresearch/settings.png`
- Review: `docs/assets/autoresearch/workbench-desktop.png`
- Review: `docs/assets/autoresearch/workbench-mobile.png`
- Review: `docs/assets/autoresearch/README.md`
- Review: `docs/drafts/2026-09-10-readme-screenshots-verification.md`

- [x] Review the captured command output and the parent evidence recorded in Global Constraints; do not rerun the four commands (`npm --prefix packages/autoresearch-web run build`, `npm --prefix packages/autoresearch-web test`, `npm --prefix packages/autoresearch-web run test:browser`, `npm --prefix packages/autoresearch-web run test:workbench:browser`) as a Task 2 gate, and do not broaden into model/research or live-profile runs.
- [x] Search the six owned files for placeholders, absolute machine paths or names from the prior generated reference project, provider credentials, stale untracked-doc links, claims of real model/research execution, claims that mock fixtures are live DSH, or claims of registry publication/latest DSH support; remove such wording while preserving honest provenance.
- [x] Parent agent visually inspects all three PNGs for readable content, correct settings/workbench states, desktop/mobile framing, and no credentials or unrelated project data; the main agent records the visual decision in the verification report.
- [x] Hand off the owned files and evidence for the parent agent's only git status/diff/release decision; no worker commit, push, tag, or release step is part of this plan.
