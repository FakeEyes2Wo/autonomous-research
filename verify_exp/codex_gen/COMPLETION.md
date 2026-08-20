# Codex draw.io MCP Generation Completion

Completed on 2026-08-20.

## Result

- Final report: 10 total, 10 passed, 0 failed, 10 MCP passed.
- MCP build ID for all diagrams: `42835e3@2026-08-02T20:17:10.515Z`.
- Artifacts: 10 editable `.drawio`, 10 two-timescale `.png`, 10 vector `.svg`, 10 vector `.pdf`, 10 `.mcp.json`, and 10 `.check.json` files.
- Export backend: native academic SVG rendered to PNG/PDF with headless Chrome. Draw.io Desktop was unavailable in this environment; each editable `.drawio` was still validated by the hosted draw.io MCP `create_diagram` call.
- No `FAILURES.md` remains because all final records pass.

## Publication layout

- Eight landscape figures use 3:2 canvases at 1200x800; PNG exports are 2400x1600.
- The dense multi-view figure uses 4:3 at 1200x900; its PNG is 2400x1800.
- The vertical hierarchy uses 4:5 at 960x1200; its PNG is 1920x2400.
- Typography is Helvetica/Arial with a restrained blue/teal/amber scientific palette, semantic green/red outcomes, orthogonal connectors, editable labels, and no external image URLs.
- Multi-level layouts reserve at least 40% of canvas height for node-level separation, avoiding compressed content and excessive unused vertical space.

## Generation evidence

The final full run reached 9/10 because the hosted MCP transiently disconnected on `05-multiturn-eval-harness`; all ten local exports succeeded. The failed MCP record was then retried selectively:

```text
python codex_gen/generate.py --retry-failed
total=10 passed=10 failed=0 mcp_passed=10
exit code: 0
```

This retry replaced only the failed record in `report.json`; the other nine successful final-layout records were preserved.

## Fresh verification evidence

```text
python -m unittest discover -s codex_gen/tests -v
Ran 23 tests in 0.245s
OK
exit code: 0
```

```text
python codex_gen/generate.py --verify-only
verify total=10 passed=10 failed=0
exit code: 0
```

The final directory count was 10 drawio, 10 PNG, 10 SVG, 10 PDF, 10 MCP JSON, and 10 check JSON files. `git diff --check -- codex_gen` returned no errors.

## Visual inspection

All 10 PNGs were inspected in a two-column contact sheet, followed by original-resolution checks of the denser and asymmetric figures. Text is readable, node boxes are present, annotations remain inside their groups, connectors are visible, and no clipping or node overlap was observed. The temporary contact sheet and generation logs were removed after inspection.

## Repository instruction note

`codex_docs/CURRENT.md` is absent from this workspace, so there was no active plan pointer to update. The pre-existing changes to `../../../.gitignore` and the untracked `../../../scripts/prepare_examples_article.py` were preserved and not modified by this task.
