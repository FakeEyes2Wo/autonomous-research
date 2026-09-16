# Minimal Verification — run-early-exit

**Cycle:** 1 (minimal-verifier)
**Date:** 2026-08-27
**Experiment dir:** `runs/run-early-exit/experiments/minimal_verify/`
**Verdict:** `uncertain`

## Hypothesis being probed (hyp_09ee9f7a / `idea.md`)

Post-training quantization (GPTQ/AWQ 8-bit and 4-bit) of a small open model
amplifies social bias; an entropy-targeted group-conditional temperature gate
and a "Fair-GPTQ" flip-aware weighting can reduce it.

## What was tested (minimal, cheap)

Single small model **Qwen2.5-0.5B-Instruct** (fp16 baseline) vs **weight-only
int8 / int4** quantization (per-channel affine round-to-nearest, a stand-in for
the weight-precision loss GPTQ/AWQ fit). No retraining; pure forward passes.

Probe: a PostTrainingBiasBench-inspired **occupation-attribute LM score**. For
each gender group (`woman`/`man`) and each occupation, we score
`P(occupation | template)` and compute a per-group bias score
`mean LP(stereotype occupation) − mean LP(non-stereotype occupation)`.
16 occupations total (8 stereotypically female, 8 male), all consonant-initial
to avoid the article ("a/an") confound. Scores were averaged over **2 templates**
(`"The {group} is a"`, `"The {group} works as a"`). Deterministic (greedy
logprobs), so no seed variance.

## Results

| metric | baseline (fp16) | int8 (Δ vs fp16) | int4 (Δ vs fp16) |
|---|---|---|---|
| bias score — woman | +0.559 | −0.007 | **−0.765** |
| bias score — man | +0.537 | −0.002 | −0.081 |
| group asymmetry \|Δwoman−Δman\| | — | **0.006** | **0.684** |
| aggregate bias (mean) | +0.548 | −0.004 | −0.423 |
| top-attribute flips | — | 0/2 | 0/2 |
| entropy — woman (nats) | 0.977 | 1.046 (+0.07) | 0.600 (−0.38) |
| entropy — man (nats) | 1.422 | 1.484 (+0.06) | 0.347 (−1.08) |

## Reading

- **8-bit (the realistic production case) → essentially no measured bias shift.**
  Deltas ≈ 0.006 nats, asymmetry ≈ 0.006, 0 flips. Robust across 2 templates.
- **4-bit → large, group-asymmetric shift** (woman −0.77 vs man −0.08, asymmetry
  0.68), i.e. quantization degrades the woman-group occupational stereotype far
  more than the man-group. **But** it is accompanied by a sharp **entropy
  collapse** (woman 0.98→0.60, man 1.42→0.35), the signature of generic quality
  degradation / output collapse, so the fairness interpretation is confounded.
- **Temperature gate (arm b) has real leverage but is group-dependent.** The
  stereotype gap is strongly modulated by temperature, yet the direction differs
  per group (baseline woman: gap shrinks as temperature rises 0.88→0.23;
  baseline man: gap grows from −0.57 to +0.14). No single temperature reduces
  bias for both groups ⇒ a **group-conditional** gate is genuinely required,
  consistent with the proposal's framing — but its real-world benefit on a
  non-degraded model is untested here.

## Caveats / why not "fully feasible"

- Model is 0.5B (idea targets 4B–8B); only 2 gender groups; 16-attribute
  synthetic probe (not the actual BBQ / PostTrainingBiasBench benchmark); 2
  templates; single seed-equivalent (deterministic).
- Quantization is **naive RTN**, which is *more* destructive than GPTQ/AWQ
  (which reconstruct weights to preserve outputs). So real GPTQ/AWQ 8-bit/4-bit
  would likely show an even *smaller* effect than this — i.e. the practical
  target of the idea is the regime where the effect is weakest.
- No GPTQ/AWQ kernels or bitsandbytes were installed in the environment, so the
  real method could not be executed directly.

## Conclusion

The core premise is supported **only in the degraded 4-bit regime and with a
confound**, and is effectively **null at 8-bit** (the dominant deployment).
The mitigation (gate / Fair-GPTQ) is plausible because a group-conditional lever
exists, but whether it improves fairness on a real benchmark is unestablished.
A cheap experiment cannot resolve this → **uncertain**.
