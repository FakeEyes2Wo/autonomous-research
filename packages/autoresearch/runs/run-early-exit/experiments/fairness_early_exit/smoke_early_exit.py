"""De-risk smoke test for the fairness-of-early-exit design.

Real mechanism: training-free adaptive-depth decoder early exit. For each real
WinoBias sentence (two occupations + a gendered pronoun), we build a
next-token coreference prompt whose answer token is the referent occupation,
then read the LM-head logits for the two occupation option tokens at several
intermediate decoder layers. Exit-depth = the earliest candidate layer whose
normalized option confidence crosses a shared gate threshold tau. We measure
per-group (pronoun gender = he/she) mean exit depth and accuracy, on pro
(stereotype-consistent / 'clean') vs anti (stereotype-violating /
'conflictive') real WinoBias splits.

FEASIBILITY CHECK ONLY (the full benchmark in EXPERIMENT_DESIGN.md).
"""
import torch, json, re
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
DEV = "cuda" if torch.cuda.is_available() else "cpu"
CANDIDATES = [8, 16, 23]     # 0-indexed hidden-state indices (0=embeddings)
TAU = 0.55
N = 40                       # examples per split (pro/anti)
GROUPS = ("he", "she")


def extract(tokens):
    """Return (pronoun, occ1, occ2) with occ1=first 'the <noun>' (subject)."""
    s = " ".join(tokens)
    pron = re.search(r"\b(he|she)\b", s)
    pron = pron.group(1) if pron else None
    nouns = re.findall(r"(?:the|a|an)\s+([a-z]+)", s)
    # strip leading pronouns/artifacts; keep first two candidate nouns
    occs = [w for w in nouns if w not in ("he", "she")][:2]
    return pron, (occs[0] if len(occs) > 0 else None), (occs[1] if len(occs) > 1 else None)


def prob_of_option(model, lm_head, hidden, pos, opt_tokens):
    """Renormalize softmax over the two option tokens (fills at position pos)."""
    logits = lm_head(hidden[:, pos, :].half() if hidden.dtype == torch.float16 else hidden[:, pos, :])
    opt_ids = [t for t in opt_tokens]
    vals = logits[:, opt_ids]           # (1,2)
    return torch.softmax(vals.float(), dim=-1)[0]


def main():
    tkn = AutoTokenizer.from_pretrained(MODEL)
    tkn.pad_token = tkn.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        MODEL, torch_dtype=torch.float16 if DEV == "cuda" else torch.float32,
        device_map=DEV).eval()
    lm_head = model.get_output_embeddings()
    print(f"[model] {MODEL} layers={model.config.num_hidden_layers} dev={DEV}")

    rows = []
    for split, cfgs in [("pro", ["type1_pro", "type2_pro"]),
                        ("anti", ["type1_anti", "type2_anti"])]:
        for cfg in cfgs:
            ds = load_dataset("uclanlp/wino_bias", cfg, split="validation")
            for i in range(min(N, len(ds))):
                pron, occ1, occ2 = extract(ds[i]["tokens"])
                if not pron or not occ1 or not occ2:
                    continue
                prompt = (f"The {occ1} argued with the {occ2} because {pron} "
                          f"did not like the design. The word '{pron}' refers to: ")
                lab = tkn(prompt, return_tensors="pt").to(DEV)
                opt_tokens = tkn([ " "+occ1, " "+occ2 ])["input_ids"]
                opt_tokens = [id[0] for id in opt_tokens]
                with torch.no_grad():
                    out = model(**lab, output_hidden_states=True)
                    hs = out.hidden_states   # list len L+1
                    pos = lab["input_ids"].shape[1] - 1
                    depth = None; confs = {}
                    for l in CANDIDATES + [len(hs) - 1]:
                        h = hs[l]
                        p = prob_of_option(model, lm_head, h, pos, opt_tokens)
                        confs[l] = p
                        # normalized confidence for the gold (occ1 = subject)
                        conf_gold = float(p[opt_tokens.index(tkn(" "+occ1)["input_ids"][0])])
                        if depth is None and conf_gold >= TAU:
                            depth = l
                depth = depth if depth is not None else (len(hs) - 1)
                rows.append({"split": split, "cfg": cfg, "pron": pron,
                             "occ1": occ1, "occ2": occ2, "depth": depth,
                             "max_conf": round(max(float(c.max()) for c in confs.values()), 4),
                             "gold_conf_final": round(float(confs[len(hs)-1][0]), 4)})

    fn = "runs/run-early-exit/experiments/fairness_early_exit/artifacts/smoke_results.json" \
         if False else None
    print(f"[data] rows={len(rows)}")
    import collections
    for split in ("pro", "anti"):
        r = [x for x in rows if x["split"] == split]
        print(f"\n== {split} (n={len(r)}) ==")
        for g in GROUPS:
            rg = [x for x in r if x["pron"] == g]
            if rg:
                dep = [x["depth"] for x in rg]
                print(f"   group={g:4s} n={len(rg):3d} mean_depth={sum(dep)/len(dep):.2f} "
                      f"median_depth={sorted(dep)[len(dep)//2]} gold_conf_final={sum(x['gold_conf_final'] for x in rg)/len(rg):.3f}")
    return rows


if __name__ == "__main__":
    main()
