{
  "insights": [
    {
      "wrongAssumption": "The interpreter assumed the gate/confidence signal came from a 'training-free per-layer LM-head confidence' and that the trained per-layer option-scoring heads collapsed into a 'confident-but-wrong' stereotype (conf 0.91-0.96, acc 0.18-0.38). The artifact data are actually produced by the trained heads (head-mode=trained) with conf 0.54-0.78 and exit-accuracy 0.46-0.71; no 0.91-0.96 / 0.18-0.38 value exists anywhere. The assumption that a mechanism's causal reading could be established by describing the pipeline in prose, without tracing each reported number to its exact measurement source, failed.",
      "researchQuestion": "When a gate/confidence signal may be computed from either a trained per-layer option-scoring head or a training-free LM-head proxy, which measurement actually drives exit behavior — and is an 'overconfidence plus below-chance accuracy' signature a genuine stereotype collapse or a small-data calibration/training artifact that depends on which probe produced it?",
      "methodFamilies": [
        "Early-exit confidence calibration (DeeBERT, FastBERT, PABEE, CALM)",
        "Confidence calibration under small data (temperature/Platt/isotonic scaling, ECE & Brier evaluation)",
        "Metric provenance & traceability (mapping each reported number to its generating code path)",
        "Trained-head vs training-free probe distributional-shift analysis"
      ],
      "divergencePoint": "The fork between attributing the exit-asymmetry to a 'trained-head stereotype collapse' (interpretive reading) vs. attributing it to the actual measured trained-head signal (provenance-traceable reading), where the two diverge in both value and causal meaning."
    },
    {
      "wrongAssumption": "The assumption that a depth-adaptive decoder favors a specific, model-independent group (a universal directional claim) failed: the favored group flips between backbones (Qwen2.5-0.5B favors she on clean / he on conflict; Qwen2.5-1.5B the reverse), and with only 2 of the required >=3 backbones measured the cross-backbone portability rule is unmet.",
      "researchQuestion": "What latent backbone property (scale, base-model competence, per-layer representation geometry, calibration curve) controls the SIGN of the adaptive-depth fairness asymmetry, so the direction becomes predictable rather than a model-specific accident?",
      "methodFamilies": [
        "Cross-model and cross-scale analysis of early-exit fairness (model scaling laws)",
        "Per-layer hidden-state geometry, anisotropy and linear-probing analysis",
        "Token-level dynamic depth routing / per-layer entropy-gated routing",
        "Group-conditional uncertainty and calibration-curve decomposition"
      ],
      "divergencePoint": "Posing a single universal direction of the exit-bias asymmetry vs. modeling the direction as a function of a latent capacity/geometry variable (a model-conditional effect rather than a scalar constant)."
    },
    {
      "wrongAssumption": "The assumption that a single scalar confidence gate / temperature / threshold can be fairness-neutral (reducing bias simultaneously for all groups) failed: the minimal verifier found the temperature direction is group-dependent (no single temperature reduces bias for both groups) and per-group calibration is strongly asymmetric (fitted temp 0.4 vs 3.0 at 0.5B, 1.5 vs 3.0 at 1.5B).",
      "researchQuestion": "What is the minimal parametric form of a group-conditional gate/temperature required to be conditions-neutral, and can any single shared scalar gate be made fairness-neutral given asymmetric per-group calibration?",
      "methodFamilies": [
        "Group-conditional / per-group temperature and vector scaling",
        "Multi-calibration and multi-accuracy post-hoc processing",
        "Fairness-constrained threshold optimization (equalized odds, Pareto fronts)",
        "Calibration-aware early-exit gating and thresholding"
      ],
      "divergencePoint": "A single shared scalar intervention vs. a group-conditional (multi-parameter) intervention — the hypothesis of a single fairness-neutral scalar gate is falsified by the group-dependent temperature direction."
    },
    {
      "wrongAssumption": "The assumption that the observed per-group asymmetry in exit-depth and exit-accuracy is attributable to the adaptive-depth mechanism independent of base-model competence failed: Qwen2.5-0.5B is near-chance at full depth (0.51-0.58), so part of the asymmetry reflects a weak base model, and without a matched-accuracy slice it is not separable.",
      "researchQuestion": "How do we separate a mechanism's fairness effect from base-model competence — is the adaptive-depth fairness asymmetry a property of residual-error allocation in the exit mechanism, or a byproduct of an underfit/near-chance base model?",
      "methodFamilies": [
        "Matched-accuracy / accuracy-controlled fairness slicing",
        "Bias-variance and competence-normalized fairness decomposition",
        "Low-vs-high-capacity (scaling) base-model comparison with ability matching",
        "Conditional-entropy / residual-error mediation analysis"
      ],
      "divergencePoint": "Attributing the fairness asymmetry to the allocator mechanism vs. to the base model's competence ceiling — the two are confounded and require a matched-capability control to disentangle."
    },
    {
      "wrongAssumption": "The assumption that pivoting from the quantization-bias root-cause design (a causal mediation of entropy->flip across backbones/widths) to the descriptive early-exit study could preserve the causal root-cause question failed: the original d3_04/d3_05 causal claim was never tested, and the early-exit result is descriptive (exit-depth, accuracy reversal) rather than a designed intervention with mediation analysis and cross-backbone consistency.",
      "researchQuestion": "Can a descriptive group-asymmetric readout be elevated to a causal mediation claim about WHICH mechanism produces a fairness gap, and how does a designed intervention + mediation (across backbones) differ from a correlation/descriptive readout?",
      "methodFamilies": [
        "Causal mediation analysis (Baron-Kenny, causal vertical / horizontal decomposition)",
        "Counterfactual intervention and do-calculus fairness testing",
        "Per-layer ablation and layer-wise attribution for root-cause localization",
        "Cross-family robustness and portability of causal estimates"
      ],
      "divergencePoint": "A descriptive group-asymmetric readout vs. a designed causal intervention plus mediation analysis — the pivot dropped the causal-identification design and the cross-backbone consistency requirement, leaving the original root-cause question open."
    }
  ]
}