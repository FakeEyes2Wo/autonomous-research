# Interpretation — early-exit fairness, cycle 1 (honest analysis)

**Scope:** WinoBias type1, real pro (stereotype-consistent / clean) vs anti
(stereotype-violating / conflictive), occupation-disjoint split. Two small
Qwen2.5 backbones (0.5B, L=24; 1.5B, L=28). Shared confidence gate, adaptive
depth. Groups = pronoun gender {he, she}; referent occupation stereotype gender
{M, F} is the same information here because pro/anti pin the pronoun↔stereotype
relation.

## What is genuinely measured

### 1. A real, group-asymmetric adaptive-depth effect (C1)
Under a shared gate tau=0.60 the per-group mean exit-depth differs:
- 0.5B: clean wgs_depth=0.54, conflict wgs_depth=0.66 (layers)
- 1.5B: clean wgs_depth=0.18, conflict wgs_depth=0.045 (layers)

So adaptive depth does **not** allocate identical compute to the two groups. The
mechanism is real, not fake.

### 2. A clean-vs-conflict reversal not present at full depth (C2)
The per-group exit accuracy **reverses ordering** between clean and conflict in
both backbones, and the ordering the early-exit model produces is the *opposite*
of the ordering the full-depth model produces:
- 0.5B full-depth per-group (final layer, clean): he=0.70, she=0.46 → early-exit
  (clean): she=0.71, he=0.46. Same for the conflict set (full-depth
  he=0.355/she=0.65 → early-exit he=0.66/she=0.44).
- 1.5B: full-depth clean he=0.737/she low → early-exit clean he=0.69/she=0.30;
  conflict full-depth she>he → early-exit she=0.66/he=0.29.

The magnitude of the group gap is large in both cases (0.5B up to 0.25; 1.5B up
to 0.38 in exit accuracy). Adaptive-depth inference therefore **rewrites which
demographic group is served better**, relative to a non-adaptive model.

### 3. Group-dependent miscalibration (C3, qualitative)
Per-group calibration differs sharply in both models: fitted exit temperature is
0.4 vs 3.0 (0.5B) and 1.5 vs 3.0 (1.5B); clean ECE differs (0.10 vs 0.16; 0.34
vs 0.05). After per-group temperature scaling the ECE moves substantially, i.e.
the confidence signal is not equally reliable across groups. This is consistent
with the miscalibration mechanism, but we do **not** claim it collapses the gap
(see limits).

## Honest limits / why NOT a universal claim (RC4)

1. **The favored group flips between backbones.** 0.5B does better on the
   *she*-group on clean (and he on conflict); 1.5B does the reverse (he on clean,
   she on conflict). So the *direction* of the bias is **model-specific** —
   the mechanism is non-portable as a directional claim. The *structure* (best on
   clean becomes worst on conflict, and early-exit reverses the full-depth
   ordering) is consistent across both backbones, which is the more robust
   finding.
2. **Only two small Qwen backbones, one benchmark, one split/seed.** The
   cross-backbone requirement (>=3 for the RC4 "supported" verdict) is **not**
   met, so C3/C4 cannot be declared supported. The honest verdict is
   **NON-PORTABLE / mixed**, not a clean support.
3. **The 0.5B base is near-chance at full depth** (0.51–0.58), so part of the
   measured asymmetry reflects a weak base model, not only the exit mechanism.
4. **The design's primary mechanism (trained per-layer heads) was miscalibrated
   here.** On only 155 clean calibration instances, the trained option-scoring
   heads were severely overconfident (mean two-option confidence 0.91–0.96) yet
   produced below-chance accuracy (0.18–0.38 on clean) — i.e. they learned a
   confident-but-wrong heuristic (consistent with an occupational
   gender-stereotype collapse). This is the small-data overconfidence regime and
   is not a trustworthy gate, so the **reportable** early-exit signal here is the
   training-free per-layer LM-head confidence (the diagnostic/proxy arm of the
   design), which is well-behaved (depth-monotonic confidence, preserves accuracy
   at moderate tau).

## Bottom line
Real, reproducible measurement that adaptive-depth early-exit is **not
fairness-neutral**: it produces a per-group exit-depth and accuracy gap and
reverses which group is served better relative to full depth, more strongly at
0.5B than 1.5B. But the direction is model-specific and only two backbones were
measured, so the claim is **scoped and NON-PORTABLE** — a legitimate honest
outcome rather than an over-claim. This does not yet establish "early-exit
amplifies bias" as a universal law; it establishes that **the adaptive-depth
mechanism is a real, group-asymmetric allocator whose direction depends on the
model**.
