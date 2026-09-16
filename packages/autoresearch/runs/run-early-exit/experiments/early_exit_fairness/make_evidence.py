# -*- coding: utf-8 -*-
"""Consolidate per-model early-exit fairness results into a single evidence doc.

Reads the per-model ``results_*.json`` files written by run_experiment.py and
produces EVIDENCE.md (per-model tables plus a cross-backbone comparison) and a
cross_backbone.csv. This is the cycle-1 deliverable narrative, kept honest: the
findings are scoped to two small Qwen2.5 backbones and one benchmark setting.
"""
import csv
import json
from pathlib import Path

ART = Path(__file__).resolve().parent / "artifacts"
MODELS = ["Qwen/Qwen2.5-0.5B-Instruct", "Qwen/Qwen2.5-1.5B-Instruct"]
TAU = 0.60


def slug(model: str) -> str:
    return model.replace("/", "-").replace(".", "-")


def load(model: str) -> dict:
    with (ART / f"results_{slug(model)}.json").open("r", encoding="utf-8") as handle:
        return json.load(handle)


def md_table(headers: list[str], rows: list[list]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    for row in rows:
        lines.append("| " + " | ".join(str(v) for v in row) + " |")
    return lines


def model_section(model: str, data: dict) -> list[str]:
    head = data["stereotype_gap"]
    fd = data["full_depth_reference"]
    conf = data["confidence"]
    cal = data["calibration_fit"]
    cal_pos = data.get("calibrated_gate", {})
    sweep = data["gate_sweep"][str(TAU)]
    stereo = data.get("stereo_group_eval", {})

    lines = [f"### {model}", ""]
    lines += ["**Full-depth reference (no exit):** " + ", ".join(
        f"{k}={v['accuracy']}" for k, v in fd.items()) + "", ""]
    lines += ["**Trained-head confidence vs depth (clean_unseen):**"]
    lines += md_table(["layer", "mean_conf", "pct>=0.60", "pct>=0.75"],
                      [[l, c["mean_conf"], c["pct_conf_ge_0.60"], c["pct_conf_ge_0.75"]]
                       for l, c in conf["clean_unseen"].items()])
    lines += ["", "**Shared gate (tau=0.60) per-group, clean vs conflict:**"]
    for crit in ("clean_unseen", "conflict_unseen"):
        block = sweep[crit]
        lines += [f"*{crit}* (wgs_depth={block['wgs_depth']})"]
        lines += md_table(["group", "n", "mean_depth", "exit_acc", "ece", "brier"],
                          [[g, r["n"], r["mean_exit_depth"], r["exit_accuracy"], r["ece"], r["brier"]]
                           for g, r in block["per_group"].items()])
        lines += [""]
    lines += ["**Stereotype gap (clean vs conflict exit-accuracy):**"]
    lines += md_table(["group", "clean", "conflict", "gap"],
                      [[g, head["clean_acc"].get(g, 0.0), head["conflict_acc"].get(g, 0.0), head["gap"].get(g, 0.0)]
                       for g in sorted(set(list(head["clean_acc"]) + list(head["conflict_acc"])))])
    lines += ["", "**Referent stereotype-gender axis (exit-acc):**"]
    for crit in ("clean_unseen", "conflict_unseen"):
        block = stereo.get(crit, {})
        pg = block.get("per_group", {})
        if pg:
            lines += [f"*{crit}* (wgs_depth={block.get('wgs_depth')})"]
            lines += md_table(["group", "n", "mean_depth", "exit_acc", "ece"],
                              [[g, r["n"], r["mean_exit_depth"], r["exit_accuracy"], r["ece"]] for g, r in pg.items()])
            lines += [""]
    lines += ["**Per-group calibration (RC2 first cut):**"]
    lines += md_table(["group", "fitted_temp", "clean_ECE"],
                      [[g, c["temperature"], c["clean_ece"]] for g, c in cal.items()])
    lines += ["", "**After per-group temperature scaling (conflict_unseen):**"]
    block = cal_pos.get("conflict_unseen", {})
    pg = block.get("per_group", {})
    if pg:
        lines += md_table(["group", "n", "mean_depth", "exit_acc", "ece"],
                          [[g, r["n"], r["mean_exit_depth"], r["exit_accuracy"], r["ece"]] for g, r in pg.items()])
    lines += ["", ""]
    return lines


def cross_backbone_rows(models: list[str], datas: dict[str, dict]) -> list[dict]:
    rows = []
    for model in models:
        data = datas[model]
        head = data["stereotype_gap"]
        fd = data["full_depth_reference"]
        cal = data["calibration_fit"]
        block = data["gate_sweep"][str(TAU)]
        for crit in ("clean_unseen", "conflict_unseen"):
            for group, r in block[crit]["per_group"].items():
                rows.append({
                    "model": model, "split": crit, "group": group, "n": r["n"],
                    "mean_exit_depth": r["mean_exit_depth"], "exit_accuracy": r["exit_accuracy"],
                    "ece": r["ece"], "wgs_depth": block[crit]["wgs_depth"],
                    "full_depth_acc": fd[crit]["accuracy"],
                    "stereotype_gap": head["gap"].get(group, ""),
                    "calib_temp": cal.get(group, {}).get("temperature", ""),
                })
    return rows


def main() -> None:
    datas = {m: load(m) for m in MODELS}
    lines = [
        "# Early-Exit Fairness — Cycle-1 Evidence (run-early-exit)",
        "",
        "Real WinoBias type1 (pro=stereotype-consistent/clean, anti=stereotype-violating/conflict), "
        "split BY OCCUPATION into clean-calibration and unseen-conflictive occupation subsets. "
        "Adaptive-depth model: per-layer option-confidence gate (training-free per-layer LM head is the "
        "reportable signal; the trained per-layer heads are reported separately). Groups = pronoun gender "
        "{he, she}; referent occupation stereotype gender {M, F} is a secondary axis.",
        "",
        "```",
        f"backbones = {MODELS}",
        f"headline tau = {TAU} · seed 42 · type1",
        "```",
        "",
    ]
    for model in MODELS:
        lines += model_section(model, datas[model])
    lines += ["# Cross-backbone comparison (tau=0.60)", ""]
    lines += md_table(["model", "split", "group", "n", "mean_depth", "exit_acc", "ece", "wgs", "full_depth_acc"],
                      [[r["model"], r["split"], r["group"], r["n"], r["mean_exit_depth"], r["exit_accuracy"],
                        r["ece"], r["wgs_depth"], r["full_depth_acc"]] for r in cross_backbone_rows(MODELS, datas)])
    lines += [""]
    with (ART / "EVIDENCE.md").open("w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    with (ART / "cross_backbone.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(cross_backbone_rows(MODELS, datas)[0].keys()))
        writer.writeheader()
        writer.writerows(cross_backbone_rows(MODELS, datas))
    print("wrote", ART / "EVIDENCE.md", "and", ART / "cross_backbone.csv")


if __name__ == "__main__":
    main()
