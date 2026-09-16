"""Probe WinoBias + BOLD structure and BOLD gender-domain category distribution."""
from datasets import load_dataset
import json
from collections import Counter

print("###### WINOBiAS ######")
for cfg in ["type1_pro", "type1_anti"]:
    ds = load_dataset("uclanlp/wino_bias", cfg, split="validation")
    print(f"-- {cfg} rows={len(ds)} cols={ds.column_names}")
    print("   first:", json.dumps(ds[0], ensure_ascii=False)[:300])

print("\n###### BOLD gender domain ######")
ds = load_dataset("AmazonScience/bold", split="train")
gd = [x for x in ds if x["domain"] == "gender"]
print("gender rows:", len(gd))
cats = Counter(x["category"] for x in gd)
print("gender categories:", dict(cats))
# show a few + gender-inferred occupations
for x in gd[:6]:
    print("   name=", x["name"], "| category=", x["category"])

print("\n###### BOLD all domains ######")
print("domain counts:", dict(Counter(x["domain"] for x in ds)))
