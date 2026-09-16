"""Inspect WinoBias coreference_clusters to extract the gold referent."""
from datasets import load_dataset
import json
ds = load_dataset("uclanlp/wino_bias", "type1_pro", split="validation")
ex = ds[0]
print("tokens:", ex["tokens"])
print("pos_tags:", ex["pos_tags"])
print("coreference_clusters:", json.dumps(ex["coreference_clusters"], ensure_ascii=False))
print("word_number:", ex["word_number"])
print("predicate_lemma:", ex["predicate_lemma"])
print("verbal_predicates:", ex["verbal_predicates"])
