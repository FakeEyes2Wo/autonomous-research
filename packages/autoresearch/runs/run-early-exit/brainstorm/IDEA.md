# IDEA

## selected
f2

## reformed_idea
d3_04 established that uncertainty (token-level entropy) drives social-bias flips in quantized LLMs — up to 21% of responses flip bias state with no aggregate change, and flips are 3-11x more likely under high uncertainty. Instead of re-measuring that correlation, f2 turns the same cheap entropy proxy into an **in-loop, group-conditional control lever**. Concretely: on one small open model, quantize with GPTQ/AWQ (8-bit and 4-bit) and measure **per-group flip-rate** and **per-group asymmetric shift** (worst-group gets +18.6% worse / -14.1% better, canceling in aggregate) under three conditions: (a) vanilla quantization, (b) an uncertainty-targeted group-conditional calibration/temperature gate applied at inference on the quantized model, and (c) a flip-aware (bias-aware) quantization weighting following the d3_02 Fair-GPTQ baseline. The contribution is a **causal-instrumental test** — does targeting the entropy proxy (via the gate) actually reduce flip-rate and worst-group asymmetric shift at matched compute? — and the headline output is whether the entropy proxy *predicts which weights/layers most amplify flips*, so the same cheap signal that measures the harm can also gate it. This differentiates from d3_02 (which optimizes quantization bias-aware *offline*) by making the inference-time entropy signal the *live controller*, and from d3_04 (correlation re-audit) by converting a known correlation into a testable intervention.

## evidence
- d3_04 (paper_wiki/d3_04.md): up to 21% of responses flip bias state with no aggregate change; flips 3-11x more likely under high uncertainty; asymmetric group shifts (+18.6% worse / -14.1% better) cancel in aggregate.
- d3_01 / d3_02 / d3_03 (paper_wiki/d3_01.md, d3_02.md, d3_03.md): d3 cluster frames "how quantization shapes/disparately skews bias" and provides the Fair-GPTQ bias-aware baseline to contrast against the entropy-gate lever.
- d3_05 (paper_wiki/d3_05.md): inference-acceleration (quantization/pruning/caching) changes bias in strategy- and model-specific, unpredictable ways — motivating per-model re-audit and an in-loop controller.
- p18 / p19 (paper_wiki/p18.md, p19.md): GPTQ and AWQ standard, public, low-cost quantization tooling requiring no custom training.
- d2_01 (paper_wiki/d2_01.md): token-level entropy is group-discriminative (differs by signaled race/gender), justifying it as the group-conditional in-loop gate signal.
- p51 / p54 (paper_wiki/p51.md, p54.md): temperature scaling and universal calibration machinery to make the shared entropy gate group-fair.
- p44 (paper_wiki/p44.md) / S7 (paper_wiki/S7.md): existing open benchmarks document quantization-induced bias inconsistency across vision-language and text models.

## cheap_test
Quantize one small open model (e.g. Qwen3-4B / Llama-3.1-8B-Instruct) to 8-bit and 4-bit with GPTQ/AWQ. Run PostTrainingBiasBench-style bias prompts; compute aggregate bias, flip-rate, per-group asymmetric deltas, and a token-level entropy proxy. Compare three arms — (a) vanilla quantization, (b) entropy-targeted group-conditional temperature gate, (c) Fair-GPTQ flip-aware weighting — reporting flip-rate and worst-group asymmetric shift under each. Pure forward passes, standard libs (GPTQ/AWQ), single GPU, no retraining.

## risks
- d3_04 notes group-specific shifts vary unpredictably across model families, so conclusions may not port beyond the chosen model.
- The uncertainty link is correlational at base; the intervention tests causality but a null (gate does not shrink flip-rate) must be reported honestly, not spun.
- Per-group asymmetric shift for open-ended generation is ill-defined (S7/S8); scope metrics carefully to the benchmark's defined groups.

## backups
- f1 (shared vs group-conditional calibrated exit threshold, per-group depth/ECE frontier, aggregate-vs-per-group cancellation diagnostic) as the policy-lever fallback.
- gap-b (isolate which of exit-depth allocation / calibration / layer-redundancy drives worst-group error into a detectable in-loop signal).
- n2 (representation-saturation stop rule as a Pareto-improving gate; reportable null).