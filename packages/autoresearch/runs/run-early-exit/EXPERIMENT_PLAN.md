# Experiment Plan — Fairness of Depth-Adaptive / Early-Exit Inference under Clean→Unseen-Conflict Shift

Revision of `EXPERIMENT_DESIGN.md` in response to `EXPERIMENT_REFLEXION.md` (verdict: `revise`). The mechanism stays **adaptive-depth / early-exit** (what the scout was built for), using the **real cached data + real cached small-model ladder** that fit the 8.6GB GPU. This revision adds the three things the Reflexion flagged as the top internal-validity and generalizability threats: **(i) a difficulty-matched cleaner control** for the headline cells, **(ii) reliability-calibrated confidence** so the miscalibration-vs-capacity test is not confounded, and **(iii) an optional encoder cross-mechanism arm** (BERT-base + PABEE/DeeBERT) alongside the main modern-decoder ladder.

---

## 1. Hypothesis (root cause under validation; crisply "early-exit fairness")

> **H_root.** Under a shared confidence/entropy gate, the exit decision of a depth-adaptive / early-exit model is driven by the model's own confidence signal, which is **not reliability-calibrated equally across demographic groups**. Therefore adaptive-depth inference allocates different *effective depth* and *residual error* to different groups. Under a realistic **clean→unseen-conflict** shift this per-group depth-and-error gap **widens** and the group-bias gap **grows**. The root cause is **group-dependent miscalibration** of the exit signal — *not* a fixed, group-specific quality ceiling.

The d3 "quantization/compression amplifies bias" narrative is **demoted to an honest-negative descriptor** (GPTQ/AWQ kernels absent; 8-bit RTN was fairness-null in the minimal verifier; 4-bit was confounded by entropy collapse). The active thesis is exclusively early-exit fairness, so the premise stays coherent.

### Falsifiable claims
- **C1 (exit-depth disparity):** under a shared τ, mean exit-depth and the accuracy-vs-depth curve differ across demographic groups (per-group exit-depth gap ≠ 0).
- **C2 (shift-driven widening):** clean→unseen-conflict *widens* the per-group exit-depth gap and the per-group bias gap relative to clean.
- **C3 (root cause = miscalibration, not quality ceiling):** per-group re-calibration (per-group τ / temperature fit on clean, on **reliability-calibrated** confidence) collapses the accuracy-vs-depth and bias gap to ≈0 at matched accuracy; a *capacity* explanation would predict an irreducible residual.
- **C4 (cross-backbone portability):** sign of the per-group gap and the C3 verdict are consistent across ≥3 backbones and ≥3 datasets; null/opposite-sign cells are boundary conditions.

---

## 2. Mechanism (what the scout was built for)

1. **Primary — per-instance layer early-exit with trained per-layer heads (FastBERT/DeeBERT-style, frozen base).**
   - For a decoder with `L` layers, attach linear heads at `L_cand = {⌊L/4⌋, ⌊L/2⌋, ⌊3L/4⌋, L}` (self-distilled; the `L` head = the base's own head). For `L=28`: `{7,14,21,28}`; for `L=24` (Qwen2.5-0.5B): `{6,12,18,24}`.
   - Heads trained on **CLEAN** real data only, base frozen.
   - At inference, exit at the earliest candidate layer whose **reliability-calibrated** confidence/margin crosses a **shared** gate τ.
   - `exit-depth` = that layer; `accuracy-vs-depth` = per-layer head accuracy; `depth budget` = mean exit-depth.
2. **Secondary — CALM-style per-token entropy gate** (confidence-gated per-token computation) for generation tasks (BOLD); per-group budget of entropy-gated tokens.

The **training-free** proxy (final LM-head on intermediate hidden states) is a *diagnostic only* — the smoke test showed it gives near-chance confidence (≈0.25 on the 2-option task) and rarely exits early, which is why **trained per-layer heads** are primary.

---

## 3. Real datasets & real conflict construction (no synthetic grid)

| Dataset (cached, real) | Clean (train/calib) | Unseen-conflictive (test) | Group(s) | Real conflict source |
|---|---|---|---|---|
| **WinoBias** (`type{1,2}_pro`/`_anti`) | `pro` (stereotype-consistent pronoun) | `anti` (stereotype-violating pronoun), held-out occupation subset `S'` | pronoun gender {he,she}; occupation-stereotype gender {M,F} | Real stereotype-violating coreference (male-stereotyped occupation with `she`); gold from `coreference_clusters`. **pro/anti are template-matched twins (same occupations/verb frame, only the pronoun flips) → built-in difficulty control.** |
| **BBQ** (`heegyu/bbq` fetchable; `hirundo-io/bbq-*` cached fallback) | disambiguated (stereotype-consistent) items | ambiguous items (gold=`Not enough information`, biased pick=`stereotyped_answer`); held-out category = **race/ethnicity** | gender, race, nationality | Real ambiguous questions that induce a stereotype-biased pick. |
| **BOLD** (`AmazonScience/bold`; cached, split=`train`) | stereotype-consistent bios | stereotype-violating real (person-gender × occupation) bios in held-out domains | gender {American_actors, American_actresses}, race, profession | Real bios where the person's gender/race is opposite the occupation's stereotype; bias scored from the model's own generation. |

**Conflict construction invariant:** every conflictive instance is the benchmark's own **real** text. No synthetic occupation×pronoun×verb grid is used for any reported metric.

---

## 4. Realistic split protocol + difficulty-matched control (responds to Reflexion risk #1)

- **WinoBias:** fit on `pro` occupations in `S`; test on `anti` in held-out `S'` (novel occupations at deployment) + within-domain pro→anti. The paired pro/anti twins give a template-matched controlled comparison.
- **BBQ:** fit on clean gender+nationality (disambiguated, non-cue); test on conflictive **held-out category = race/ethnicity** + ambiguous gender/nationality (same source). In-cache fallback for the conflict set: the all-ambiguous `hirundo-io/bbq-*`; clean pool then drawn from a cross-benchmark clean set (WinoBias `pro` + BOLD stereotype-consistent bios).
- **BOLD:** fit on stereotype-consistent bios in domains `D`; test on stereotype-violating bios in held-out domains `D'`.

**Difficulty-matched cleaner subset (headline cells).** Define per-instance difficulty `d(x)` on a **fixed-capacity reference** (base model's last-layer head, no early exit) as the normalized NLL of the gold token(s), plus surface controls (length, distractor count, word frequency) — independent of the exit mechanism and the group signal.
- WinoBias: pro/anti already template-matched; record `d(x)` per twin and **report** `Δ_KS(d)` to confirm balance.
- BBQ & BOLD: from the clean pool select a **difficulty-matched subset C\*** whose `d(x)` distribution matches the conflict pool (nearest-neighbour in (NLL, length) or matched deciles). Headline clean-vs-conflict cells use `C*`. Report the balance (KS statistic / histogram overlap); if balance is poor (KS rejects α=0.05), **downgrade the cell** as difficulty-confounded rather than impute.
- Matched-difficulty cells are further sliced to **equal per-group accuracy**, so any residual gap is measured at fixed difficulty AND fixed accuracy.

Fitted components (heads, τ, per-group calibration) are fit on **clean** only; clean and conflict sets are **disjoint in source/domain/occupation/category**. Worst-group is fixed by the pre-declared max rule, never post hoc.

---

## 5. Backbones (from scout; cached; fit 8.6GB fp16)

**Main (recent decoder; the scout's pointer for the newest adaptive-depth/calibration work):**
- Qwen2.5-0.5B-Instruct (2024, L=24) · Qwen2.5-1.5B-Instruct (2024, L=28, scale) · Qwen3-0.6B (2025-26, L=28) · Qwen3-1.7B (2025-26, L=28) · DeepSeek-R1-Distill-Qwen-1.5B (2025-26, L=28, reasoning setting). — 5 backbones (≥3 required).

**Encoder cross-mechanism (secondary/validation arm):** BERT-base-uncased with per-layer PABEE/DeeBERT exit heads (classic early-exit encoder; **baseline**, not main). Fetchable (network verified up). If the fetch fails, this is a stated scope limit (decoder-only generalization).

**Classic baselines (non-main, only if fetchable & fits):** GPT-2 (CALM per-token gate baseline), T5 (calibration machinery baseline).

---

## 6. Metrics

Exit-depth (per-group mean/median/distribution, accuracy-vs-depth AUC, between-group Δexit, WGS_depth). Accuracy (per-group task accuracy, accuracy-conditional-on-depth). Bias (per-group stereotype/regard, biased-pick rate, pro-vs-anti stereotype gap; WGS_bias = max_g|Δbias_g| + aggregate-vs-per-group cancellation diagnostic). Shift (Δexit-depth gap, Δbias gap clean→conflict, matched-accuracy slice). Calibration (per-group ECE/Brier of the exit-confidence signal, reliability curves, **ECE before/after per-group temperature scaling**, calibration-adjusted gap). Mechanism/compute (mean layers/tokens before exit, % early-exit, per-layer head calibration, quality/PPL monitor, `d(x)` + KS balance diagnostic).

---

## 7. Root-cause validation & inference protocol (cross-backbone)

- **RC1 (descriptive, anti-cherry-pick):** full factorial (backbone × dataset × group × split); per-group exit-depth/accuracy-vs-depth/bias/ECE. **BH-FDR q=0.05** within each dataset family; effect sizes + 95% bootstrap CIs; all cells reported.
- **RC2 (calibration vs capacity, on RELIABILITY-CALIBRATED confidence):** fit a single per-group temperature scalar on CLEAN per-layer-head logits so the exit decision maps to equal per-group **reliability** (equal true-error). Then fit per-group τ_g (clean) to equalize per-group accuracy on the conflict test. Residual collapses → miscalibration; persists at matched accuracy+difficulty+reliability → capacity ceiling. Regime per (dataset, backbone).
- **RC3 (mediation):** per-instance exit-depth-error `E_i ~ group + reliability-calibrated confidence + accuracy`; report β_G (group direct) vs the confidence-mediated share of between-group variance (ΔR²) to probe the "shared uncertainty signal" mechanism.
- **RC4 (portability / honest negative):** pre-declared rule — "root cause = group-dependent miscalibration" is **SUPPORTED** iff RC2 collapses in ≥2/3 of (dataset,backbone) cells and no cell is significantly opposite-sign; else **NON-PORTABLE**. Enforced honest negatives: (a) early-exit is fairness-neutral → report as a robustness/negative result; (b) gap driven by quality degradation → report a quality-floor driver, pivot to lossless/speculative exits or model-level interventions; (c) small-family results don't transfer → restrict claims to the small-decoder family.

**Anti-cheat:** pre-register C1–C4 primary endpoints; 3 seeds {42,123,7} on the headline; fixed denominators; no tuning on conflict/eval set; worst-group by max rule; no result-conditional subsetting.

---

## 8. How this revision addresses the Reflexion feedback

| Reflexion risk | Response in this revision |
|---|---|
| **GROUP-vs-DIFFICULTY CONFOUND (top threat)** | Added explicit **difficulty-matched control** (§4): WinoBias pro/anti template twins + CSA-matched clean subset C\* for BBQ/BOLD; KS-balance diagnostic; matched-difficulty AND matched-accuracy slices; poor-balance cells downgraded (not imputed). |
| **TRAINED-HEAD CONFIDENCE NOT CALIBRATED (confounds RC2)** | Added **reliability calibration**: per-group temperature scaling of per-layer-head logits on CLEAN so the exit maps to equal true-error; report ECE before/after; cells where reliability cannot be matched are labelled, not imputed. |
| **MODEL CURRENCY / NARROW FAMILY (no Gemma/LLaMA/BERT)** | Added **encoder cross-mechanism arm** (BERT-base + PABEE/DeeBERT heads, fetchable since network is up) as a secondary baseline; kept the main ladder as 5 recent Qwen/DeepSeek decoders. Gemma/LLaMA flagged for a cloud run; claims restricted to the small-decoder family. |
| **BACKBONE FAMILY/SCALE CONFINEMENT** | Cross-backbone validation is met with margin (5 decoders, ≥3 required); extension ladder (≥3-4B, encoder) noted as a cloud run; all claims scoped to the small-decoder family. |
| **PREMISE COHERENCE / DEFERRED QUANTIZATION (d3)** | Thesis made crisply **"early-exit fairness"**; the quantization-amplifies-bias narrative is an **honest-negative descriptor** (out of scope; kernels absent; 8-bit already null). |
| **PER-GROUP SMALL n / NON-CERTIFIABILITY** | Per-group n + 95% bootstrap CIs; under-sampled cells marked **non-certifiable**; deliverable shifts toward an audit (per-dataset×model×group fairness registry). |
| **MULTIPLICITY / false-fairness-positive** | Pre-registered endpoints; BH-FDR q=0.05; bootstrap CIs; worst-group-by-max-rule; **RC4 honest-negative rule strictly enforced** (SPORT/non-portable or negative, never spun). |

---

## 9. De-risk evidence gathered (this session)

- GPU: **RTX 4070 Laptop, 8188 MiB** (~8.0GB usable). Python 3.11.6.
- Libs: `torch`/`transformers`/`datasets`/`accelerate`/`scipy`/`sklearn`/`numpy`/`pandas` present; `bitsandbytes`/`gptqmodel`/`autoawq`/`auto_gptq` **all absent**.
- Cached datasets: WinoBias (`type1/2_pro` & `_anti`, 396 val+test each); BBQ `hirundo-io/bbq-{gender,race,nationality}` (gender 2832 / race 3440 / nationality 1540 — **all ambiguous**; `heegyu/bbq` public & fetchable adds disambiguated clean + `context_condition`); BOLD (7201; split=`train`).
- Cached backbones ≤1.7B: Qwen2.5-0.5B/1.5B-Instruct, Qwen3-0.6B/1.7B, DeepSeek-R1-Distill-Qwen-1.5B. (No BERT-base / LLaMA / Gemma / 7-9B cached.) BERT-base-uncased is **fetchable** (HTTP 200).
- Layer counts: Qwen2.5-0.5B=24; all others=28 → candidate exit layers `{6,12,18,24}` / `{7,14,21,28}`.
- Network to `huggingface.co` and `pypi.org` is **up** (HTTP 200, ~5s), so the small encoder fetch and the `heegyu/bbq` disambiguated pool are feasible; large (≥3-4B) model downloads remain OOM-bounded on this GPU.

---

## 10. Open limitations (go to the human-facing failure report)

1. Hardware caps the in-memory scale axis at ≤1.7B; ≥3-4B / 7-70B require a cloud run → frontier-scale extrapolation bounded.
2. Quantization/d3 compression-bias claim is **not** tested (no kernels); it is carried as an honest-negative descriptor. Active thesis = early-exit fairness.
3. Trained per-layer head confidence (even temperature-scaled) is a proxy, not true confidence; RC2 validity depends on matched reliability, which is measured and, where unmatched, reported (not imputed).
4. Per-group n is small after held-out category/domain/occupation splits; under-sampled groups are reported **non-certifiable** (not imputed).
5. Different bias-state definitions across BOLD/BBQ/WinoBias → per-measure-per-dataset reporting, sign-consistency only, no combined WGS/FDR.
6. "Unseen-conflict" = held-out category/domain/occupation (realistic, not exhaustive of adversarial/temporal stereotype inversion).
7. Group-vs-text-difficulty confound is controlled (template twins + difficulty-matched subset C\*) but not eliminated for every cell; poor-balance cells are downgraded, and this is reported rather than hidden.
8. Encoder cross-mechanism arm (BERT-base) is a classic baseline and fetch-dependent; without it, generalization is established across decoder (Qwen/DeepSeek) backbones only.
