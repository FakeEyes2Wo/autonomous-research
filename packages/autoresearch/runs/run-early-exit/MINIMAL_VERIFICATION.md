{
  "feasibility": "uncertain",
  "minimalEvidence": [
    "Single 0.5B model (Qwen2.5-0.5B-Instruct, fp16) vs weight-only int8/int4 quant (per-channel RTN proxy), PostTrainingBiasBench-inspired gender-occupation LM probe, 2 templates averaged, pure forward passes.",
    "8-bit: negligible bias shift on the probe — woman Δ=-0.007, man Δ=-0.002, group asymmetry |Δw-Δm|=0.006, aggregate Δ=-0.004 nats, 0/2 attribute flips.",
    "4-bit: large group-asymmetric shift — woman Δ=-0.765 vs man Δ=-0.081 (asymmetry 0.684), aggregate bias Δ=-0.423, but with sharp entropy collapse (woman 0.98->0.60, man 1.42->0.35 nats) indicating a generic quality-degradation confound.",
    "Temperature gate (arm b) has strong leverage: per-group stereotype gap moves from ~0.88->0.23 (woman) but -0.57->+0.14 (man) across temp 0.6->1.5, so the gate direction is group-dependent and a group-conditional gate is genuinely needed, but no single temperature reduces bias for both groups.",
    "Environment limitation: no GPTQ/AWQ kernels or bitsandbytes installed, so quantization was simulated with RTN (more destructive than GPTQ/AWQ, which reconstructs to preserve outputs) — real GPTQ/AWQ 8-bit/4-bit would likely show an even smaller effect than observed."
  ],
  "artifacts": [
    "runs/run-early-exit/experiments/minimal_verify/run_experiment.py",
    "runs/run-early-exit/experiments/minimal_verify/artifacts/results.json",
    "runs/run-early-exit/experiments/minimal_verify/artifacts/per_attribute.csv",
    "runs/run-early-exit/experiments/minimal_verify/artifacts/EVIDENCE.md",
    "runs/run-early-exit/experiments/minimal_verify/smoke_test.py"
  ],
  "reason": "The cheapest decisive sub-claim — does quantization cause a measurable group-asymmetric bias shift, and does a temperature gate provide a lever — was tested on a single small model (Qwen2.5-0.5B-Instruct) using a synthetic gender-occupation attribute probe with pure forward passes (no retraining, no GPTQ/AWQ kernels available, so weight-only RTN int8/int4 was used as a proxy). Result is mixed. At 8-bit — the realistic production vehicle the idea targets — there is effectively no measured bias shift (asymmetry 0.006 nats, 0 flips), which undermines the premise that quantizing with 8-bit GPTQ/AWQ amplifies bias. At 4-bit there IS a large, group-asymmetric shift (woman -0.77 vs man -0.08), but it coincides with a sharp entropy collapse, i.e. generic quality degradation, so the fairness interpretation is confounded; and since naive RTN is more destructive than GPTQ/AWQ reconstruction, the real method would likely show even less. The temperature gate (arm b) does provide a real per-group lever, but its direction is group-dependent, so neither inference is conclusive. Given a single 0.5B model, two gender groups, a 16-attribute synthetic probe (not the real BBQ/PostTrainingBiasBench benchmark), two templates, and no GPTQ/AWQ kernels, a cheap experiment cannot establish the hypothesis. Therefore: not clearly feasible (the 8-bit result is null and the 4-bit effect is confounded and RTN-specific) but not infeasible either (a measurable asymmetric effect and a group-conditional gate lever exist) — uncertain."
}