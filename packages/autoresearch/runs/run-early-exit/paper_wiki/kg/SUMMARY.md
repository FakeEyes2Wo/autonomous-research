# Paper Knowledge Graph Summary

- nodes: 128
- edges: 180
- surveys: 11
- clusters: 7
- papers: 83
- directions: 3
- open problems: 24

## Clusters

- Early-Exit & Adaptive-Depth Computation in LLMs — open: Do different demographic groups exit at systematically different depths (exit-distribution disparity)?; Is the confidence/entropy that drives exit equally reliable across groups? (calibration disparity); Are accuracy-vs-depth curves different across groups, so a fixed threshold yields unequal quality? (layer-wise capability disparity); Can a learned exit router be trained to be group-fair?
- Speculative & Self-Speculative Decoding — open: Does the draft acceptance rate (and hence per-token compute saved) differ across demographic groups?; Does lossless verification preserve the exact output distribution for all groups, or only in aggregate?; Can self-speculative drafting be calibrated to be group-fair?
- LLM Inference Acceleration: Quantization, Pruning, KV-Cache & Attention — open: Which efficiency transform most changes per-group output quality?; Is dropping layers (a depth-budgeting primitive) fairness-neutral or does it hurt specific groups?; How do KV-cache eviction and quantization interact with adaptive depth fairness?
- Demographic Fairness & Bias in LLMs (Definitions, Metrics, Benchmarks) — open: Which fairness notion (parity, counterfactual, accuracy gap) best captures adaptive-inference harm?; How to measure per-group accuracy/quality gaps when computation is budgeted?; Do the standard benchmarks have enough coverage to detect early-exit- induced disparity?; How to aggregate accuracy and bias (the 'bias score' tension) in a fair-decision-aware way?
- Fairness of Model Compression (Quantization, Pruning, Distillation) — open: What is the general mechanism by which compression redistributes error onto minority groups, and does it transfer to depth-budgeted (early-exit) inference?; Can a fairness penalty be added to the compression/exit objective without hurting efficiency?; Is there a principled accuracy/efficiency/fairness trade-off curve, and how should it be exposed?
- Confidence Calibration & Uncertainty for LLMs — open: Is confidence calibrated differently across demographic groups, so a shared threshold exits at different true-error levels?; How to measure group-wise ECE for exit decisions?; Do selective-prediction / abstention methods perform differently per group?; Can temperature scaling or calibration be applied per-group before exiting?
- Layer-wise Representation Maturity & Interpretability — open: Do demographic attributes (gender, race, etc.) become linearly separable at different depths for different groups?; Is layer importance/contribution heterogeneous such that a fixed exit depth preserves different information for different groups?; How to operationalize 'representation maturity' (linear-separable / probe accuracy) as a per-group, per-layer metric?

## Surveys

- A Survey of Early Exit Deep Neural Networks in NLP (2025)
- Adaptive Inference through Early-Exit Networks: Design, Challenges and Directions (2021)
- Split Computing and Early Exiting for Deep Learning Applications: Survey and Research Challenges (2021)
- Taming the Titans: A Survey of Efficient LLM Inference Serving (2025)
- Towards Efficient Generative Large Language Model Serving: A Survey from Algorithms to Systems (2023)
- Speculative Decoding and Beyond: An In-Depth Survey of Techniques (2025)
- A Survey on Fairness in Large Language Models (2023)
- Bias and Fairness in Large Language Models: A Survey (2024)
- Fairness in Large Language Models: A Taxonomic Survey (2024)
- A Survey on Bias and Fairness in Machine Learning (2019)
- Calibration in Deep Learning: A Survey of the State-of-the-Art (2023)

## Directions

- Fairness of Depth-Adaptive Early-Exit Inference: Do depth-adaptive / early-exit LLM inference strategies, which allocate compute per token/instance, systematically under-serve specific demographic groups — i.e., do groups exhibit different exit-depth distributions, different accuracy-vs-depth curves, and resulting per-group quality gaps under a fixed exit threshold?
- Group-wise Calibration of the Confidence/Entropy Signal Driving Adaptive Exit: Is the confidence/uncertainty signal (entropy, logit margin) that gates early exit calibrated equally across demographic groups, so a shared threshold exits at the same true-error level for every group — and can per-group calibration (temperature scaling / abstention / selective prediction) make exit decisions group-fair?
- Do Compression and Depth-Budgeting Redistribute Error Onto Minority Groups Through a Shared Mechanism?: Does the mechanism by which model compression (quantization, pruning, distillation) redistributes error onto minority groups transfer to, and help explain, depth-budgeted (early-exit / adaptive-depth) inference — and is there a principled accuracy/efficiency/fairness trade-off curve that exposes it?
