# -*- coding: utf-8 -*-
"""Early-exit fairness experiment: clean -> unseen-conflict on real WinoBias.

Cycle-1 headline cell. Real WinoBias type1 pro (stereotype-consistent / clean) and
anti (stereotype-violating / conflictive) instances are split BY OCCUPATION, never
by random shuffle. Per-layer option-scoring heads are trained on clean data only
(base frozen); the shared-gate adaptive-depth mechanism is then evaluated on a
held-out conflictive occupation subset and a matched-novelty clean subset.

Produces artifacts/results.json, per_group.csv and EVIDENCE.md. Compute target:
Qwen2.5-0.5B-Instruct fits the 8.6GB GPU in fp16 with room for the tiny heads.
"""
import argparse
import csv
import json
import random
from pathlib import Path

import torch

from data import build_instances, unique_occupations
from early_exit import EarlyExitModel, ExitConfig, build_prompt, load_model
from metrics import evaluate_records, stereotype_gap, softmax2

OUT_DIR = Path(__file__).resolve().parent / "artifacts"
TEMP_GRID = [0.4, 0.6, 0.8, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0]


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments for the experiment run."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--type", default="type1", choices=["type1", "type2"])
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--tau", type=float, default=0.75)
    parser.add_argument("--tau-sweep", type=str, default="0.50,0.55,0.60,0.65,0.70,0.75,0.80")
    parser.add_argument("--head-mode", choices=["trained", "frozen"], default="trained")
    return parser.parse_args()


def occupation_split(instances: list[dict], seed: int) -> tuple[set, set]:
    """Deterministically split unique referent occupations into train/test halves."""
    occs = unique_occupations(instances)
    rng = random.Random(seed)
    shuffled = list(occs)
    rng.shuffle(shuffled)
    mid = max(1, len(shuffled) // 2)
    return set(shuffled[:mid]), set(shuffled[mid:])


def build_splits(type_: str, seed: int) -> dict:
    """Construct the clean/unseen-conflict occupation-disjoint instance sets."""
    pro = build_instances("pro", type_)
    anti = build_instances("anti", type_)
    occ_train, occ_test = occupation_split(pro + anti, seed)
    return {
        "train_clean": [x for x in pro if x["gold_occ"] in occ_train],
        "clean_unseen": [x for x in pro if x["gold_occ"] in occ_test],
        "conflict_unseen": [x for x in anti if x["gold_occ"] in occ_test],
        "conflict_seen": [x for x in anti if x["gold_occ"] in occ_train],
        "n_occ_train": len(occ_train),
        "n_occ_test": len(occ_test),
    }


def fit_group_temperature(records: list[dict], tau: float, candidate_layers: list[int]) -> dict:
    """Fit a per-group temperature scalar that minimises exit ECE on clean records.

    RC2 first cut: a single temperature per group, fit on the clean calibration
    set, applied to the two-option logits before the gate so the exit maps to
    more equal per-group reliability.
    """
    groups = sorted({r["group"] for r in records})
    fitted = {}
    for group in groups:
        group_recs = [r for r in records if r["group"] == group]
        best_t, best_ece = 1.0, None
        for temp in TEMP_GRID:
            eval_res = evaluate_records(group_recs, tau, candidate_layers, {group: temp})
            ece_val = eval_res["per_group"][group]["ece"]
            if best_ece is None or ece_val < best_ece:
                best_t, best_ece = temp, ece_val
        fitted[group] = {"temperature": best_t, "clean_ece": best_ece}
    return fitted


def run(args: argparse.Namespace) -> dict:
    """Run the headline early-exit fairness experiment and write artifacts."""
    # Global deterministic seed so head initialisation and evaluation are stable.
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    split = build_splits(args.type, args.seed)
    tokenizer, model = load_model(ExitConfig(model_name=args.model, candidate_layers=[], train_layers=[],
                                             device="cuda" if torch.cuda.is_available() else "cpu"))
    # Candidate exit layers from the model depth: {L/4, L/2, 3L/4, L}.
    L = model.config.num_hidden_layers
    candidates = sorted({L // 4, L // 2, (3 * L) // 4, L})
    train_layers = [l for l in candidates if l != L]
    cfg = ExitConfig(model_name=args.model, candidate_layers=candidates, train_layers=train_layers,
                     device="cuda" if torch.cuda.is_available() else "cpu")
    em = EarlyExitModel(cfg, tokenizer, model)

    train_res = em.train_heads(split["train_clean"], epochs=args.epochs, lr=args.lr)
    torch.save(em.heads.state_dict(), OUT_DIR / "heads.pt")

    train_head = args.head_mode == "trained"
    scored = {
        "clean_unseen": em.score_instances(split["clean_unseen"], train_head=train_head),
        "conflict_unseen": em.score_instances(split["conflict_unseen"], train_head=train_head),
        "conflict_seen": em.score_instances(split["conflict_seen"], train_head=train_head),
    }

    # Confidence distribution of the trained heads (does the gate fire?).
    confidence = {}
    for key, recs in scored.items():
        per_layer = {}
        for layer in cfg.candidate_layers:
            confs = [softmax2(r["per_layer"][layer], 1.0)[0] for r in recs]
            per_layer[str(layer)] = {
                "mean_conf": round(sum(confs) / max(len(confs), 1), 4),
                "pct_conf_ge_0.60": round(sum(1 for c in confs if c >= 0.60) / max(len(confs), 1), 5),
                "pct_conf_ge_0.75": round(sum(1 for c in confs if c >= 0.75) / max(len(confs), 1), 5),
            }
        confidence[key] = per_layer

    # Full-depth reference accuracy (frozen LM head at the final layer, no exit).
    full_depth = {}
    last_layer = cfg.candidate_layers[-1]
    for key, recs in scored.items():
        corrects = [1 if softmax2(r["per_layer"][last_layer], 1.0)[1] == r["gold_idx"] else 0 for r in recs]
        full_depth[key] = {"n": len(recs), "accuracy": round(sum(corrects) / max(len(corrects), 1), 5)}

    # Shared-gate evaluation at the headline tau and a sweep.
    tau_sweep = [float(t) for t in args.tau_sweep.split(",")]
    sweep = {}
    for t in tau_sweep:
        sweep[str(t)] = {
            "clean_unseen": evaluate_records(scored["clean_unseen"], t, cfg.candidate_layers),
            "conflict_unseen": evaluate_records(scored["conflict_unseen"], t, cfg.candidate_layers),
            "conflict_seen": evaluate_records(scored["conflict_seen"], t, cfg.candidate_layers),
        }

    # Stereotype gap (matched-novelty clean vs conflict) at the headline tau.
    gap = stereotype_gap(scored["clean_unseen"], scored["conflict_unseen"], args.tau, cfg.candidate_layers)

    # Secondary group axis: referent occupation stereotype gender (M/F).
    stereo_records = {
        key: [{**r, "group": r["stereo_group"]} for r in recs] for key, recs in scored.items()
    }
    stereo_eval = {
        key: evaluate_records(stereo_records[key], args.tau, cfg.candidate_layers) for key in scored
    }

    # RC2 first cut: per-group temperature fit on clean, applied to conflict.
    temp_fit = fit_group_temperature(scored["clean_unseen"], args.tau, cfg.candidate_layers)
    temp_map = {g: v["temperature"] for g, v in temp_fit.items()}
    calibrated = {
        "conflict_unseen": evaluate_records(scored["conflict_unseen"], args.tau, cfg.candidate_layers, temp_map),
        "conflict_seen": evaluate_records(scored["conflict_seen"], args.tau, cfg.candidate_layers, temp_map),
    }

    summary = {
        "model": args.model,
        "type": args.type,
        "seed": args.seed,
        "tau": args.tau,
        "split": {k: v for k, v in split.items() if isinstance(v, int)},
        "train": train_res,
        "full_depth_reference": full_depth,
        "confidence": confidence,
        "gate_sweep": sweep,
        "stereotype_gap": gap,
        "stereo_group_eval": stereo_eval,
        "calibration_fit": temp_fit,
        "calibrated_gate": calibrated,
    }
    write_artifacts(summary, scored, cfg, args)
    return summary


def model_slug(model: str) -> str:
    """Sanitise a HF model name into a filesystem-safe slug."""
    return model.replace("/", "-").replace(".", "-")


def write_artifacts(summary: dict, scored: dict, cfg: ExitConfig, args: argparse.Namespace) -> None:
    """Persist per-model results.json, per_group.csv and a human-readable EVIDENCE.md."""
    slug = model_slug(args.model)
    with (OUT_DIR / f"results_{slug}.json").open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2, default=str)

    rows = []
    for key, recs in scored.items():
        ev = evaluate_records(recs, args.tau, cfg.candidate_layers)
        for group, gm in ev["per_group"].items():
            rows.append({"model": args.model, "split": key, "group": group, "n": gm["n"],
                         "mean_exit_depth": gm["mean_exit_depth"], "exit_accuracy": gm["exit_accuracy"],
                         "ece": gm["ece"], "brier": gm["brier"]})
    with (OUT_DIR / f"per_group_{slug}.csv").open("w", encoding="utf-8", newline="") as handle:
        fieldnames = ["model", "split", "group", "n", "mean_exit_depth", "exit_accuracy", "ece", "brier"]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    with (OUT_DIR / "EVIDENCE.md").open("w", encoding="utf-8") as handle:
        handle.write(render_evidence(summary, head_mode=args.head_mode))
    print("wrote artifacts to", OUT_DIR)


def render_evidence(summary: dict, head_mode: str = "frozen") -> str:
    """Render a structured evidence narrative from the result summary."""
    g = summary["stereotype_gap"]
    fd = summary.get("full_depth_reference", {})
    conf = summary.get("confidence", {})
    cal = summary.get("calibration_fit", {})
    cal_pos = summary.get("calibrated_gate", {})
    stereo = summary.get("stereo_group_eval", {})

    lines = [
        "# Early-Exit Fairness Evidence (run-early-exit / Cycle 1)",
        "",
        "## Run config",
        "",
        f"- Model: `{summary['model']}`",
        f"- Type: {summary['type']} · seed {summary['seed']} · headline tau {summary['tau']} · head mode: {head_mode}",
        "- Split: WinoBias real pro (clean) vs anti (conflict), split BY OCCUPATION (train/held-out), never random.",
        "",
        "## 1. Full-depth reference (no early exit, frozen final-layer head)",
        "",
        "| split | n | accuracy |",
        "|---|---|---|",
    ]
    for key in ("clean_unseen", "conflict_unseen", "conflict_seen"):
        if key in fd:
            lines.append(f"| {key} | {fd[key]['n']} | {fd[key]['accuracy']} |")

    lines += ["", "## 2. Trained-head confidence (does the gate fire?)", ""]
    for key in ("clean_unseen", "conflict_unseen"):
        if key in conf:
            lines.append(f"**{key}**")
            lines.append("| layer | mean_conf | pct_conf>=0.60 | pct_conf>=0.75 |")
            lines.append("|---|---|---|---|")
            for layer, row in conf[key].items():
                lines.append(f"| {layer} | {row['mean_conf']} | {row['pct_conf_ge_0.60']} | {row['pct_conf_ge_0.75']} |")
            lines.append("")

    lines += ["## 3. Per-group exit-depth and accuracy (shared gate)", ""]
    sweep = summary.get("gate_sweep", {})
    head_tau = str(summary["tau"])
    if head_tau in sweep:
        for crit in ("clean_unseen", "conflict_unseen"):
            block = sweep[head_tau].get(crit, {})
            pg = block.get("per_group", {})
            lines.append(f"**{crit}** (wgs_depth={block.get('wgs_depth')})")
            lines.append("| group | n | mean_depth | exit_acc | ece | brier |")
            lines.append("|---|---|---|---|---|---|")
            for group, row in pg.items():
                lines.append(f"| {group} | {row['n']} | {row['mean_exit_depth']} | "
                             f"{row['exit_accuracy']} | {row['ece']} | {row['brier']} |")
            lines.append("")

    lines += ["## 4. Stereotype gap (matched-novelty clean vs conflict, exit accuracy)", ""]
    lines.append("| group | clean acc | conflict acc | gap |")
    lines.append("|---|---|---|---|")
    for group in sorted(set(list(g["clean_acc"].keys()) + list(g["conflict_acc"].keys()))):
        lines.append(f"| {group} | {g['clean_acc'].get(group, 0.0)} | {g['conflict_acc'].get(group, 0.0)} | {g['gap'].get(group, 0.0)} |")

    lines += ["", "## 5. Referent stereotype-gender axis (M/F), exit accuracy", ""]
    for crit in ("clean_unseen", "conflict_unseen"):
        block = stereo.get(crit, {})
        pg = block.get("per_group", {})
        if pg:
            lines.append(f"**{crit}** (wgs_depth={block.get('wgs_depth')})")
            lines.append("| group | n | mean_depth | exit_acc | ece |")
            lines.append("|---|---|---|---|---|")
            for group, row in pg.items():
                lines.append(f"| {group} | {row['n']} | {row['mean_exit_depth']} | {row['exit_accuracy']} | {row['ece']} |")
            lines.append("")

    lines += ["## 6. Per-group calibration (RC2 first cut)", ""]
    lines.append("| group | fitted temp | clean ECE |")
    lines.append("|---|---|---|")
    for group, row in cal.items():
        lines.append(f"| {group} | {row['temperature']} | {row['clean_ece']} |")
    lines.append("")
    for crit in ("conflict_unseen", "conflict_seen"):
        block = cal_pos.get(crit, {})
        pg = block.get("per_group", {})
        if pg:
            lines.append(f"**{crit}** after per-group temperature scaling")
            lines.append("| group | n | mean_depth | exit_acc | ece |")
            lines.append("|---|---|---|---|---|")
            for group, row in pg.items():
                lines.append(f"| {group} | {row['n']} | {row['mean_exit_depth']} | {row['exit_accuracy']} | {row['ece']} |")
            lines.append("")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    result = run(parse_args())
    print(json.dumps({
        "stereotype_gap": result["stereotype_gap"],
        "calibration_fit": result["calibration_fit"],
    }, ensure_ascii=False, indent=2))
