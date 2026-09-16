# -*- coding: utf-8 -*-
"""Real WinoBias data loading and clean -> unseen-conflict construction.

The WinoBias benchmark (uclanlp/wino_bias) provides real coreference sentences.
Each documented pair of splits (type{1,2}_pro / _anti) is a set of TEMPLATE-MATCHED
TWINS: the same occupations and verb frame appear in both, and only the group-
relevant pronoun ("he"/"she") flips. `pro` (stereotype-consistent) is the clean
split; `anti` (stereotype-violating) is the conflictive split.

The bias state of an instance is a well-defined function of the model-under-test
output: which of the two occupations the pronoun refers to, scored against the
gold referent read from ``coreference_clusters``. No synthetic occupation grid is
used; every reported instance is the benchmark's own real text.
"""
import random
import re
from typing import Optional

from datasets import load_dataset

# WinoBias occupation nouns follow the determiner; the first two determiner+noun
# pairs are the two candidate referents. We look for lower-case nouns directly
# after "the"/"a"/"an" and reject article-only or pronoun artifacts.
_NOUN_RE = re.compile(r"(?:\bthe\b|\ba\b|\ban\b)\s+([a-z]+)")
_PRONOUN_RE = re.compile(r"\b(he|she)\b")
_ARTICLE_WORDS = {"the", "a", "an", "he", "she"}

_TYPE_SPLITS = {
    "type1": ("type1_pro", "type1_anti"),
    "type2": ("type2_pro", "type2_anti"),
}


def _candidate_nouns(tokens: list[str]) -> list[str]:
    """Return lower-case nouns that follow a determiner (the two referents)."""
    nouns = []
    for i in range(len(tokens) - 1):
        if tokens[i].lower() in {"the", "a", "an"} and tokens[i + 1].isalpha():
            if tokens[i + 1].lower() not in _ARTICLE_WORDS:
                nouns.append(tokens[i + 1].lower())
    return nouns


def _pronoun(tokens: list[str]) -> Optional[str]:
    """Return the gendered pronoun token if one is present."""
    match = _PRONOUN_RE.search(" ".join(tokens))
    return match.group(1) if match else None


def _gold_referent_position(coref: list) -> Optional[int]:
    """Return the referent token position from coreference_clusters.

    The uclanlp format stores a flat list ``[article_pos, referent_pos,
    pronoun_pos, pronoun_pos]``; the referent noun is the second entry.
    """
    try:
        positions = [int(x) for x in coref]
    except (TypeError, ValueError):
        return None
    if len(positions) >= 2:
        return positions[1]
    return None


def build_instances(split: str, type_: str = "type1", split_name: str = "validation") -> list[dict]:
    """Build coreference task instances for a WinoBias split.

    ``split`` is 'pro' (stereotype-consistent / clean) or 'anti'
    (stereotype-violating / conflictive). Returns a list of instance dicts with
    the pronoun, the two candidate occupations, the gold referent index, and the
    fair-group label (pronoun gender).
    """
    pro_cfg, anti_cfg = _TYPE_SPLITS[type_]
    cfg = pro_cfg if split == "pro" else anti_cfg
    ds = load_dataset("uclanlp/wino_bias", cfg, split=split_name)
    instances = []
    for ex in ds:
        tokens = list(ex["tokens"])
        pron = _pronoun(tokens)
        ref_pos = _gold_referent_position(ex["coreference_clusters"])
        nouns = _candidate_nouns(tokens)
        if pron is None or ref_pos is None or len(nouns) < 2:
            continue
        if tokens[ref_pos].lower() not in nouns:
            continue
        gold_occ = tokens[ref_pos].lower()
        occ1, occ2 = nouns[0], nouns[1]
        gold_idx = 0 if occ1 == gold_occ else (1 if occ2 == gold_occ else None)
        if gold_idx is None:
            continue
        # Reference occupation's stereotype gender is implied by split + pronoun:
        # in pro the pronoun matches the occupation stereotype, in anti it does not.
        ref_stereo_gender = "M" if pron == "he" else "F"
        if split == "anti":
            ref_stereo_gender = "F" if ref_stereo_gender == "M" else "M"
        instances.append(
            {
                "tokens": tokens,
                "text": " ".join(tokens),
                "pronoun": pron,
                "group": pron,
                "occ1": occ1,
                "occ2": occ2,
                "gold_idx": gold_idx,
                "gold_occ": gold_occ,
                "ref_stereo_gender": ref_stereo_gender,
                "split": split,
            }
        )
    return instances


def split_by_occupation(instances: list[dict], all_occupations: list[str], seed: int = 42) -> tuple[list[dict], list[dict]]:
    """Split instances into train (occupations S) and held-out (occupations S').

    The split is BY OCCUPATION (never random over instances), so the held-out
    conflictive set contains occupations never seen during clean calibration.
    ``all_occupations`` is the sorted list of unique referent occupations; we
    split it in half deterministically, then assign each instance by the
    occupation of its gold referent.
    """
    rng = random.Random(seed)
    occs = list(all_occupations)
    rng.shuffle(occs)
    mid = max(1, len(occs) // 2)
    occ_train = set(occs[:mid])
    train = [x for x in instances if x["gold_occ"] in occ_train]
    held = [x for x in instances if x["gold_occ"] not in occ_train]
    return train, held


def unique_occupations(instances: list[dict]) -> list[str]:
    """Return sorted unique referent occupations across a set of instances."""
    return sorted({x["gold_occ"] for x in instances})


def occupation_split_plan(type_: str = "type1", seed: int = 42) -> dict:
    """Build the clean->unseen-conflict occupation split and report coverage."""
    pro = build_instances("pro", type_)
    anti = build_instances("anti", type_)
    all_occ = unique_occupations(pro + anti)
    pro_train, _ = split_by_occupation(pro, all_occ, seed)
    _anti_train, anti_test = split_by_occupation(anti, all_occ, seed)
    return {
        "type_": type_,
        "n_pro": len(pro),
        "n_anti": len(anti),
        "n_unique_occs": len(all_occ),
        "n_pro_train": len(pro_train),
        "n_anti_test": len(anti_test),
        "seed": seed,
    }


if __name__ == "__main__":
    # Quick sanity probe: verify gold extraction and the occupation split.
    import json

    plan = occupation_split_plan("type1")
    print(json.dumps(plan, ensure_ascii=False, indent=2))

    inst = build_instances("anti", "type1")
    print("\nSample conflictive (anti) instances:")
    for x in inst[:5]:
        print(f"  pron={x['pronoun']:3s} occ1={x['occ1']:12s} occ2={x['occ2']:12s} "
              f"gold_idx={x['gold_idx']} gold={x['gold_occ']:12s} group={x['group']}")
