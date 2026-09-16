# Field Survey Overview

## Found Surveys

- A Survey of Early Exit Deep Neural Networks in NLP (2025): Reviews early-exit methods for NLP models (encoder and decoder), including exit criteria (confidence, entropy, patience, hash), multi-exit architectures, training schemes (self-distillation, layer dropout), and efficiency/quality trade-offs, with a focus on NLP tasks and emerging LLM settings.
- Adaptive Inference through Early-Exit Networks: Design, Challenges and Directions (2021): Foundational survey of early-exit (adaptive inference) networks: where exits are placed, how the decision to exit is made, how accuracy and latency trade off, and the open design challenges and research directions.
- Split Computing and Early Exiting for Deep Learning Applications: Survey and Research Challenges (2021): Surveys split-computing (deploying neural networks across edge/cloud) and early-exit techniques together, covering when/where computation is offloaded or halted to reduce latency/resource use, and the open research challenges.
- Taming the Titans: A Survey of Efficient LLM Inference Serving (2025): Survey of efficient LLM inference serving, covering model-level optimizations (speculative decoding, quantization, pruning, dynamic depth) and system-level techniques (batching, KV-cache management, scheduling) for throughput/latency/cost.
- Towards Efficient Generative Large Language Model Serving: A Survey from Algorithms to Systems (2023): Comprehensive survey of generative LLM serving covering both algorithmic acceleration (speculative decoding, quantization, pruning, distillation) and systems (scheduling, batching, caching), and how they combine to reduce end-to-end inference cost.
- Speculative Decoding and Beyond: An In-Depth Survey of Techniques (2025): Deep survey of speculative decoding techniques (external draft models, self-speculative decoding, multi-token prediction, acceptance sampling) that accelerate LLM decoding while preserving output quality / distribution.
- A Survey on Fairness in Large Language Models (2023): Survey of fairness in LLMs: definitions, sources of bias in data/training/inference, evaluation methods and benchmarks, and mitigation approaches, with attention to generative and downstream-task settings.
- Bias and Fairness in Large Language Models: A Survey (2024): A highly cited survey of bias and fairness in LLMs that organizes the field into intrinsic (data/representation), contextual, and extrinsic (downstream-task) bias, cataloguing datasets, metrics, and debiasing methods and critiquing evaluation practice.
- Fairness in Large Language Models: A Taxonomic Survey (2024): Taxonomic survey of fairness in LLMs that maps fairness definitions, bias sources, evaluation methods, and mitigation approaches across the LLM life cycle (data, pre-training, fine-tuning, inference).
- A Survey on Bias and Fairness in Machine Learning (2019): Foundational survey of bias and fairness in machine learning: definitions, taxonomies of bias (in data, algorithm, user-interaction), fairness notions and metrics (parity, equalized odds, counterfactual), and mitigation (pre-, in-, post-processing).
- Calibration in Deep Learning: A Survey of the State-of-the-Art (2023): Survey of confidence calibration in deep learning: definitions of calibration (ECE, Brier), causes of miscalibration, post-hoc methods (temperature scaling, Platt, binning), and training-based calibration, with discussion of LLM frontiers.

## Cluster Map

- Early-Exit & Adaptive-Depth Computation in LLMs (C1)
  - source surveys: S1, S2, S3
  - open questions: Do different demographic groups exit at systematically different depths (exit-distribution disparity)?; Is the confidence/entropy that drives exit equally reliable across groups? (calibration disparity); Are accuracy-vs-depth curves different across groups, so a fixed threshold yields unequal quality? (layer-wise capability disparity); Can a learned exit router be trained to be group-fair?
- Speculative & Self-Speculative Decoding (C2)
  - source surveys: S6
  - open questions: Does the draft acceptance rate (and hence per-token compute saved) differ across demographic groups?; Does lossless verification preserve the exact output distribution for all groups, or only in aggregate?; Can self-speculative drafting be calibrated to be group-fair?
- LLM Inference Acceleration: Quantization, Pruning, KV-Cache & Attention (C3)
  - source surveys: S4, S5
  - open questions: Which efficiency transform most changes per-group output quality?; Is dropping layers (a depth-budgeting primitive) fairness-neutral or does it hurt specific groups?; How do KV-cache eviction and quantization interact with adaptive depth fairness?
- Demographic Fairness & Bias in LLMs (Definitions, Metrics, Benchmarks) (C4)
  - source surveys: S7, S8, S9, S10
  - open questions: Which fairness notion (parity, counterfactual, accuracy gap) best captures adaptive-inference harm?; How to measure per-group accuracy/quality gaps when computation is budgeted?; Do the standard benchmarks have enough coverage to detect early-exit- induced disparity?; How to aggregate accuracy and bias (the 'bias score' tension) in a fair-decision-aware way?
- Fairness of Model Compression (Quantization, Pruning, Distillation) (C5)
  - source surveys: -
  - open questions: What is the general mechanism by which compression redistributes error onto minority groups, and does it transfer to depth-budgeted (early-exit) inference?; Can a fairness penalty be added to the compression/exit objective without hurting efficiency?; Is there a principled accuracy/efficiency/fairness trade-off curve, and how should it be exposed?
- Confidence Calibration & Uncertainty for LLMs (C6)
  - source surveys: S11
  - open questions: Is confidence calibrated differently across demographic groups, so a shared threshold exits at different true-error levels?; How to measure group-wise ECE for exit decisions?; Do selective-prediction / abstention methods perform differently per group?; Can temperature scaling or calibration be applied per-group before exiting?
- Layer-wise Representation Maturity & Interpretability (C7)
  - source surveys: -
  - open questions: Do demographic attributes (gender, race, etc.) become linearly separable at different depths for different groups?; Is layer importance/contribution heterogeneous such that a fixed exit depth preserves different information for different groups?; How to operationalize 'representation maturity' (linear-separable / probe accuracy) as a per-group, per-layer metric?

## Coverage Gap

- No explicit coverage gap recorded.
