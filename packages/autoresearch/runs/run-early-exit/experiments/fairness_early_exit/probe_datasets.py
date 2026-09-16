"""Feasibility probe: inspect the real cached datasets for the fairness-of-early-exit design."""
from datasets import load_dataset
import json

for name, split in [
    ("uclanlp/wino_bias", "train"),
    ("hirundo-io/bbq-gender-bias-multi-choice", "train"),
    ("hirundo-io/bbq-race-bias-multi-choice", "train"),
    ("AmazonScience/bold", "train"),
]:
    try:
        ds = load_dataset(name, split=split)
        print("=" * 20, name, "rows:", len(ds))
        print("columns:", ds.column_names)
        print("first:", json.dumps(ds[0], ensure_ascii=False)[:500])
    except Exception as e:
        print("=" * 20, name, "ERROR:", repr(e))
