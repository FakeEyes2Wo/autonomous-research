{
  "models": [
    {
      "name": "BERT (BERT-base / BERT-large)",
      "family": "BERT (encoder Transformer)",
      "paper": "BERT Loses Patience (PABEE), AAAI 2021; DeeBERT, ACL 2020; FastBERT, ACL 2020; Improving Group Fairness in Knowledge Distillation via Laplace Approximation of Early Exits (arXiv 2505.01070)",
      "venue": "AAAI 2021 / ACL 2020 / arXiv",
      "year": "2020-2025",
      "why": "The canonical early-exit encoder backbone. PABEE/DeeBERT/FastBERT add per-layer exit heads to BERT and stop at a per-instance depth, and the closest prior work on the fairness of early exits (Laplace-based uncertainty reweighting for group fairness) benchmarks a BERT-based model on MultiNLI. It is the natural baseline for the 'exit-at-different-depth' mechanism the direction studies."
    },
    {
      "name": "GPT-2",
      "family": "GPT (decoder-only)",
      "paper": "Confident Adaptive Language Modeling (CALM), NeurIPS 2022; ANEE dynamic-inference wrapper (GitHub); Bias in Larger Models (p27)",
      "venue": "NeurIPS 2022 / GitHub",
      "year": "2022-2025",
      "why": "CALM is the canonical per-token, confidence-gated adaptive-depth method for decoder-only next-token LMs and is evaluated on GPT-2/OPT-scale base models. GPT-2 is also the standard test bed for training-free early-exit wrappers (ANEE) and for measuring scale-dependent bias, linking the exit-confidence mechanism to group disparity."
    },
    {
      "name": "OPT (OPT-125M / 1.3B / 2.7B / 6.7B)",
      "family": "OPT (decoder-only, Meta/AI)",
      "paper": "Confident Adaptive Language Modeling (CALM), NeurIPS 2022; OPT: Open Pre-trained Transformer Language Models",
      "venue": "NeurIPS 2022 / ACL 2022",
      "year": "2022",
      "why": "The decoder-only LMs CALM uses to demonstrate the risk-controlling, entropy-gated per-token exit threshold. Because compute is gated on the model's own softmax confidence, OPT-family backbones are the vehicle for studying whether that confidence signal (and hence exit depth) is group-calibrated."
    },
    {
      "name": "LLaMA family (LLaMA-7B, LLaMA-2, Llama-3.1-8B-Instruct, LLaMA-70B)",
      "family": "LLaMA (decoder-only, Meta)",
      "paper": "SimLens/SimExit (arXiv 2507.17618, LLaMA-7B); LayerSkip (arXiv 2404.16710); Hierarchical Group-Conditional Conformal Risk Control (arXiv 2607.24562, Llama-3.1-8B-Instruct); TIDE per-token early exit (arXiv 2603.21365, LLaMA-70B); structural pruning (p21, LLaMA-7B)",
      "venue": "arXiv / ACL 2024 / NeurIPS(approx)",
      "year": "2024-2026",
      "why": "The dominant open-weight decoder backbone for adaptive-depth/early-exit inference and for group-conditional calibration/risk-control fairness work. It pairs a modern LLM with both the early-exit mechanism and per-group conformal guarantees, making it the most transferable base model for studying compute-allocation fairness."
    },
    {
      "name": "Vicuna (Vicuna-7B / 13B / 33B)",
      "family": "LLaMA-based chat model (Vicuna)",
      "paper": "Medusa (arXiv 2401.10774, ICML 2024, Vicuna-7B/33B); SimLens/SimExit (arXiv 2507.17618, Vicuna-7B)",
      "venue": "ICML 2024 / arXiv",
      "year": "2024-2025",
      "why": "Instruction-tuned LLaMA variant widely used in adaptive-compute and self-speculative decoding benchmarks. Serving as the backbone for multi-head and hybrid early-exit methods, it provides a concrete instruction-tuned model for measuring per-group exit-depth and accuracy-vs-depth curves."
    },
    {
      "name": "Qwen family (Qwen3-4B, Qwen2.5-14B/32B, Qwen3-14B, Qwen-72B)",
      "family": "Qwen (decoder-only, Alibaba)",
      "paper": "HG-CRC group-conditional conformal risk control (arXiv 2607.24562, Qwen3-4B); SpecExit (arXiv 2509.24248, Qwen2.5/Qwen3 reasoning models); TIDE (arXiv 2603.21365, Qwen-72B); Two-dimensional early exit optimisation (arXiv 2604.18592)",
      "venue": "arXiv / ICML 2026",
      "year": "2025-2026",
      "why": "A leading open-weight family in the most recent early-exit/adaptive-depth and selective-prediction-fairness papers. It is used across scale and in reasoning-model settings (Qwen2.5/3), which is exactly where per-group compute allocation and group-conditional calibration are being audited."
    },
    {
      "name": "Gemma family (Gemma-2, Gemma-3-4B)",
      "family": "Gemma (decoder-only, Google)",
      "paper": "The Confidence Trap: Gender Bias and Predictive Certainty in LLMs / Gender-ECE (arXiv 2601.07806, Gemma-2); HG-CRC (arXiv 2607.24562, Gemma-3-4B)",
      "venue": "AAAI 2026 / arXiv",
      "year": "2026",
      "why": "Gemma models are the test bed for group-conditional confidence calibration: Gemma-2 is flagged as worst-calibrated on gender bias, and Gemma-3-4B is used in hierarchical group-conditional risk control. Directly relevant to whether a shared confidence gate exits at equal true-error across groups."
    },
    {
      "name": "DeepSeek-R1 (and R1-Distill-Qwen / R1-Distill-Llama)",
      "family": "DeepSeek (reasoning decoder-only)",
      "paper": "SpecExit: Accelerating Large Reasoning Model via Speculative Exit (arXiv 2509.24248), reasoning-model early-exit; DeepSeek-R1-Distill variants",
      "venue": "arXiv / ICML 2026",
      "year": "2025-2026",
      "why": "SpecExit targets long-form reasoning models through speculative/early exit, showing that adaptive-depth compute is now applied to reasoning outputs. Long-form reasoning is where token-level compute allocation and per-group quality gaps are most consequential for fairness studies."
    },
    {
      "name": "T5 (T5-family)",
      "family": "T5 (encoder-decoder, Google)",
      "paper": "Semantic/verbalized uncertainty calibration (e.g., Can LLMs Express Their Uncertainty / verbalized-confidence work using T5, p55)",
      "venue": "ICLR / arXiv",
      "year": "2023-2024",
      "why": "A common encoder-decoder backbone for confidence/uncertainty elicitation calibration studies, supplying the calibration machinery (temperature scaling, verbalized confidence) that governs a confidence-gated exit and that a group-wise calibration analysis needs to be compared against."
    },
    {
      "name": "Dense decoder Transformers across 1B-70B+ (including MoE and SSM variants)",
      "family": "General decoder Transformers (dense / MoE / SSM)",
      "paper": "The Diminishing Returns of Early-Exit Decoding in Modern LLMs (arXiv 2603.23701); Mixture-of-Depths (arXiv 2404.02258); Mixture-of-Recursions (arXiv 2507.10524, 135M-1.7B)",
      "venue": "arXiv / NeurIPS 2025",
      "year": "2024-2026",
      "why": "These cross-architecture sweeps quantify when adaptive depth is even feasible (dense > MoE/SSM; >20B base models). They establish that early-exit suitability is architecture/scale-dependent, which conditions any fairness result — a null fairness gap may be an artifact of low early-exit potential rather than true fairness."
    }
  ],
  "sources": [
    "https://arxiv.org/abs/2006.04152",
    "https://arxiv.org/abs/2004.12993",
    "https://arxiv.org/abs/2004.02178",
    "https://arxiv.org/abs/2207.07061",
    "https://arxiv.org/abs/2505.01070",
    "https://arxiv.org/abs/2507.17618",
    "https://arxiv.org/abs/2509.23666",
    "https://arxiv.org/abs/2603.23701",
    "https://arxiv.org/abs/2507.10524",
    "https://arxiv.org/abs/2404.02258",
    "https://arxiv.org/abs/2404.16710",
    "https://arxiv.org/abs/2401.10774",
    "https://arxiv.org/abs/2607.24562",
    "https://arxiv.org/abs/2601.07806",
    "https://arxiv.org/abs/2603.21365",
    "https://arxiv.org/abs/2509.24248",
    "https://arxiv.org/abs/2604.18592",
    "https://arxiv.org/abs/2603.01914",
    "https://arxiv.org/abs/2607.28966",
    "https://arxiv.org/abs/2509.15206",
    "https://arxiv.org/abs/2508.18088",
    "https://arxiv.org/abs/2501.19337",
    "https://ar5iv.labs.arxiv.org/html/2509.24248",
    "https://mlanthology.org/neurips/2025/sun2025neurips-curse/",
    "https://huggingface.co/papers/2603.23701"
  ]
}