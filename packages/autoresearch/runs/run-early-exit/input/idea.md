## Direction

Reformed research direction

## A-priori ideas

- Quantize one small open model (e.g. Qwen3-4B / Llama-3.1-8B-Instruct) to 8-bit and 4-bit with GPTQ/AWQ. Run PostTrainingBiasBench-style bias prompts; compute aggregate bias, flip-rate, per-group asymmetric deltas, and a token-level entropy proxy. Compare three arms — (a) vanilla quantization, (b) entropy-targeted group-conditional temperature gate, (c) Fair-GPTQ flip-aware weighting — reporting flip-rate and worst-group asymmetric shift under each. Pure forward passes, standard libs (GPTQ/AWQ), single GPU, no retraining.
