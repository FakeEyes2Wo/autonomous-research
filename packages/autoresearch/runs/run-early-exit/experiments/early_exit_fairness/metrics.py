# -*- coding: utf-8 -*-
"""Metrics for the fairness-of-early-exit analysis.

Exposure measure: the two-option softmax confidence is a reliability proxy for
whether the exit decision is group-calibrated. All metrics operate on per-instance
records that carry the raw two-option logits at each candidate layer, so we can
re-evaluate under any shared gate tau and any per-group temperature without
re-running the model.
"""
import math
from collections import defaultdict

import torch
import torch.nn.functional as F


def mean(values: list[float]) -> float:
    """Arithmetic mean; 0.0 for an empty list."""
    if not values:
        return 0.0
    return sum(values) / len(values)


def median(values: list[float]) -> float:
    """Median of a numeric list; 0.0 for an empty list."""
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return float(ordered[mid])
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def softmax2(logits: torch.Tensor, temperature: float) -> tuple[float, int]:
    """Return (confidence, argmax index) from a length-2 logits vector.

    Confidence is the maximum of the temperature-scaled softmax over the two
    candidate referent tokens.
    """
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    probs = F.softmax(logits.double() / temperature, dim=-1)
    conf = float(probs.max().item())
    pred = int(probs.argmax(dim=-1).item())
    return conf, pred


def ece(confidences: list[float], corrects: list[int], n_bins: int = 10) -> float:
    """Expected calibration error over equal-width confidence bins.

    Returns the size-weighted mean absolute (mean confidence - mean accuracy).
    """
    if not confidences:
        return 0.0
    bins = defaultdict(list)
    for conf, corr in zip(confidences, corrects):
        bin_idx = min(int(conf * n_bins), n_bins - 1)
        bins[bin_idx].append((conf, corr))
    weights, diffs = [], []
    for pairs in bins.values():
        mean_conf = mean([c for c, _ in pairs])
        mean_corr = mean([float(c) for _, c in pairs])
        weights.append(len(pairs))
        diffs.append(abs(mean_conf - mean_corr))
    total = sum(weights)
    return sum(w * d for w, d in zip(weights, diffs)) / max(total, 1)


def brier(confidences: list[float], corrects: list[int]) -> float:
    """Brier score of the option-confidence against binary correctness."""
    if not confidences:
        return 0.0
    return mean([(conf - float(corr)) ** 2 for conf, corr in zip(confidences, corrects)])


def accuracy(corrects: list[int]) -> float:
    """Fraction correct; 0.0 for an empty list."""
    if not corrects:
        return 0.0
    return mean([float(c) for c in corrects])


def _exit_depth(record: dict, tau: float, candidate_layers: list[int], temperature: float) -> tuple[int, float, int]:
    """Return (exit_depth, exit_conf, exit_pred) for a record under a gate tau."""
    ordered = sorted(candidate_layers)
    for layer in ordered:
        conf, pred = softmax2(record["per_layer"][layer], temperature)
        if conf >= tau:
            return layer, conf, pred
    last = ordered[-1]
    conf, pred = softmax2(record["per_layer"][last], temperature)
    return last, conf, pred


def evaluate_records(records: list[dict], tau: float, candidate_layers: list[int],
                     temp_by_group: dict | None = None) -> dict:
    """Per-group and overall early-exit metrics under a shared gate.

    ``temp_by_group`` optionally maps group -> temperature (RC2 first cut); when
    absent, temperature is 1.0. Returns per-group exit-depth, exit accuracy, ECE
    and Brier of the exit-confidence signal, plus the worst-group exit-depth gap.
    """
    temp_by_group = temp_by_group or {}
    by_group: dict[str, list] = defaultdict(list)
    for record in records:
        by_group[record["group"]].append(record)

    per_group = {}
    for group, group_records in by_group.items():
        temp = temp_by_group.get(group, 1.0)
        depths, confs, corrects, correct_by_layer = [], [], [], defaultdict(int)
        for record in group_records:
            depth, conf, pred = _exit_depth(record, tau, candidate_layers, temp)
            depths.append(depth)
            confs.append(conf)
            corrects.append(1 if pred == record["gold_idx"] else 0)
            for layer in candidate_layers:
                _, pred_l = softmax2(record["per_layer"][layer], temp)
                correct_by_layer[layer] += 1 if pred_l == record["gold_idx"] else 0
        n = len(group_records)
        layer_accuracy = {
            str(layer): round(correct_by_layer[layer] / max(n, 1), 5) for layer in candidate_layers
        }
        per_group[group] = {
            "n": n,
            "mean_exit_depth": round(mean(depths), 4),
            "median_exit_depth": round(median(depths), 4),
            "exit_accuracy": round(accuracy(corrects), 5),
            "ece": round(ece(confs, corrects), 5),
            "brier": round(brier(confs, corrects), 5),
            "layer_accuracy": layer_accuracy,
        }

    depths_all = [d for record in records for d in [_exit_depth(record, tau, candidate_layers,
                                                                 temp_by_group.get(record["group"], 1.0))[0]]]
    overall_mean = mean(depths_all)
    wgs_depth = max((abs(per_group[g]["mean_exit_depth"] - overall_mean) for g in per_group), default=0.0)
    correct_all = []
    for record in records:
        _, _, pred = _exit_depth(record, tau, candidate_layers, temp_by_group.get(record["group"], 1.0))
        correct_all.append(1 if pred == record["gold_idx"] else 0)
    return {
        "per_group": per_group,
        "overall": {
            "n": len(records),
            "mean_exit_depth": round(overall_mean, 4),
            "exit_accuracy": round(accuracy(correct_all), 5),
        },
        "wgs_depth": round(wgs_depth, 5),
    }


def stereotype_gap(clean_records: list[dict], conflict_records: list[dict], tau: float,
                   candidate_layers: list[int], temp_by_group: dict | None = None) -> dict:
    """Pro(clean)-vs-anti(conflict) exit-accuracy stereotype gap, per group.

    A positive gap (clean accuracy - conflict accuracy) means the model leans on
    the occupational stereotype to resolve the pronoun, so the conflictive case
    is harder. Reported per group (pronoun gender) and aggregated.
    """
    clean = evaluate_records(clean_records, tau, candidate_layers, temp_by_group)["per_group"]
    conflict = evaluate_records(conflict_records, tau, candidate_layers, temp_by_group)["per_group"]
    groups = sorted(set(list(clean.keys()) + list(conflict.keys())))
    gap = {}
    for g in groups:
        gap[g] = round(clean.get(g, {}).get("exit_accuracy", 0.0) - conflict.get(g, {}).get("exit_accuracy", 0.0), 5)
    return {"clean_acc": {g: clean.get(g, {}).get("exit_accuracy", 0.0) for g in groups},
            "conflict_acc": {g: conflict.get(g, {}).get("exit_accuracy", 0.0) for g in groups},
            "gap": gap}


if __name__ == "__main__":
    # Simple usage example: softmax2 confidence, ECE, and a small gate evaluation.
    import torch

    logits = torch.tensor([2.0, 0.0])
    print("softmax2:", softmax2(logits, 1.0))
    print("ece(conf=[0.9,0.6,0.4], correct=[1,1,0]) =",
          round(ece([0.9, 0.6, 0.4], [1, 1, 0]), 5))
    recs = [
        {"per_layer": {6: torch.tensor([2.0, 0.0]), 24: torch.tensor([2.0, 0.0])}, "gold_idx": 0, "group": "he"},
        {"per_layer": {6: torch.tensor([0.0, 1.5]), 24: torch.tensor([0.0, 1.5])}, "gold_idx": 1, "group": "she"},
    ]
    print("evaluate_records:", evaluate_records(recs, 0.5, [6, 24]))
