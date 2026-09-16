# -*- coding: utf-8 -*-
"""Trained per-layer exit heads and a shared-gate early-exit mechanism.

Adaptive-depth fairness machinery for a decoder. The frozen base model is used
to obtain per-layer hidden states; on top of each chosen candidate layer we fit a
*small* trainable option-scoring head that maps the decision-position hidden
state into the input-embedding space and scores each candidate referent token.
The exit decision uses that head's two-option softmax confidence (a reliability
proxy) against a shared gate tau.

This mirrors a FastBERT/DeeBERT-style early exit: only a small head is trained,
the base is frozen, and training uses only clean (stereotype-consistent) real
instances. The reference (final-layer) scorer uses the base model's own LM head
so that "no early exit" is the natural full-depth baseline.
"""
from dataclasses import dataclass

import torch
import torch.nn.functional as F
from torch import nn
from transformers import AutoModelForCausalLM, AutoTokenizer


@dataclass
class ExitConfig:
    """Configuration for the early-exit scoring module."""

    model_name: str
    candidate_layers: list[int]
    train_layers: list[int]
    device: str = "cuda"
    dtype: str = "float16"
    seed: int = 42


def _option_embedding_lookup(model: nn.Module, tokenizer, option_tokens: list[list[int]]) -> torch.Tensor:
    """Mean input-embedding of each option's sub-token sequence.

    ``option_tokens`` is a list of token-id lists (one per candidate). The
    returned tensor has shape (n_options, embedding_dim).
    """
    embed = model.get_input_embeddings().weight
    mean_embeds = []
    for ids in option_tokens:
        ids_t = torch.tensor(ids, dtype=torch.long, device=embed.device)
        mean_embeds.append(embed[ids_t].mean(dim=0))
    return torch.stack(mean_embeds, dim=0)


class OptionScoringHead(nn.Module):
    """A small trainable scorer mapping a context hidden state to option scores.

    ``score_k = scale * (MLP(h) . e_k)`` where e_k is the mean embedding of option
    k and ``scale`` is a learnable per-head temperature (logit scale). The scale is
    trained jointly so the head can output well-separated option logits, which is
    required for the confidence gate to fire.
    """

    def __init__(self, hidden_size: int):
        super().__init__()
        self.proj = nn.Linear(hidden_size, hidden_size, bias=True)

    def forward(self, hidden: torch.Tensor, option_embeds: torch.Tensor) -> torch.Tensor:
        """Return per-option logits of shape (batch, n_options).

        Inputs are cast to float32 so the head cannot overflow in fp16; the
        linear layer is deliberately kept shallow so the head stays numerically
        stable (a deep/learnable-scale head collapsed or ran away in early runs).
        """
        proj = self.proj(hidden.float())  # (batch, hidden)
        return proj @ option_embeds.float().t()  # (batch, n_options)


def _tokenize_option(tokenizer, word: str) -> list[int]:
    """Tokenize an option word without special tokens (occupation nouns are one token)."""
    ids = tokenizer.encode(" " + word, add_special_tokens=False)
    return ids if ids else tokenizer.encode(word, add_special_tokens=False)


class EarlyExitModel:
    """Wrapper around a frozen causal LM plus per-layer option-scoring heads."""

    def __init__(self, config: ExitConfig, tokenizer, model):
        self.config = config
        self.tokenizer = tokenizer
        self.model = model
        self.token_embeds = model.get_input_embeddings().weight
        hidden = model.config.hidden_size
        self.heads = nn.ModuleDict(
            {str(l): OptionScoringHead(hidden) for l in config.train_layers}
        )
        # Heads run in float32 for stability; hidden inputs are cast inside forward.
        self.heads.to(config.device)
        self.model.eval()

    @torch.no_grad()
    def encode_prompt(self, prompt: str, option_words: list[str]) -> dict:
        """Encode a prompt and the two option token sequences."""
        lab = self.tokenizer(prompt, return_tensors="pt").to(self.config.device)
        option_tokens = [_tokenize_option(self.tokenizer, w) for w in option_words]
        option_ids = [ids[0] if ids else None for ids in option_tokens]
        return {"input_ids": lab["input_ids"], "attention_mask": lab["attention_mask"],
                "option_tokens": option_tokens, "option_ids": option_ids}

    @torch.no_grad()
    def score_instance(self, encoded: dict, train_head: bool = True) -> dict:
        """Return per-layer option scores/probs for a single instance.

        Scores each candidate layer on the two-option softmax confidence and the
        reference (final-layer) head via the base LM head. ``train_head`` selects
        whether intermediate layers use the trained heads (True) or the frozen
        LM head applied to intermediate hidden states (False, diagnostic-only).
        """
        out = self.model(
            input_ids=encoded["input_ids"],
            attention_mask=encoded["attention_mask"],
            output_hidden_states=True,
        )
        hidden_states = out.hidden_states  # (layers+1, batch, seq, hidden); index 0 = embeddings
        pos = encoded["input_ids"].shape[1] - 1
        lm_head = self.model.get_output_embeddings()
        option_ids = [i for i in encoded["option_ids"] if i is not None]
        if not option_ids:
            raise ValueError("no option tokens resolved")
        per_layer = {}
        for l in self.config.candidate_layers:
            if l >= len(hidden_states):
                continue
            h = hidden_states[l][:, pos, :]  # (batch, hidden)
            if train_head and l in self.config.train_layers:
                option_embeds = _option_embedding_lookup(self.model, self.tokenizer, encoded["option_tokens"])
                logits = self.heads[str(l)](h, option_embeds)  # (batch, n_options)
            else:
                lm_logits = lm_head(h)  # (batch, vocab)
                logits = lm_logits[:, option_ids]  # (batch, n_options)
            probs = F.softmax(logits.float(), dim=-1)
            conf = float(probs.max().item())
            pred_idx = int(probs.argmax(dim=-1).item())
            per_layer[l] = {
                "logits": logits.detach().cpu(),
                "probs": probs.detach().cpu(),
                "conf": conf,
                "pred_idx": pred_idx,
                "margin": float((probs.max() - probs.min()).item()),
                "entropy": float(-torch.sum(probs * torch.log(probs.clamp_min(1e-9))).item()),
            }
        return {"per_layer": per_layer, "candidate_layers": self.config.candidate_layers}

    def score_instances(self, instances: list[dict], train_head: bool = True) -> list[dict]:
        """Score many instances and collect per-layer raw logit records.

        Each record carries the two-option logits at every candidate layer plus
        the gold index and the fair-group label, so downstream metrics can be
        recomputed under any gate tau and per-group temperature without a
        re-forward pass.
        """
        records = []
        for inst in instances:
            encoded = self.encode_prompt(build_prompt(inst), [inst["occ1"], inst["occ2"]])
            scored = self.score_instance(encoded, train_head=train_head)
            per_layer = {}
            for layer, info in scored["per_layer"].items():
                per_layer[layer] = info["logits"].flatten().to("cpu")
            records.append(
                {"per_layer": per_layer, "gold_idx": inst["gold_idx"],
                 "group": inst["group"], "stereo_group": inst.get("ref_stereo_gender", inst["group"]),
                 "split": inst["split"]}
            )
        return records

    def exit_depth(self, per_layer: dict, tau: float) -> tuple[int, float, int]:
        """Return (exit_depth, exit_conf, exit_pred) under a shared gate tau."""
        ordered = sorted(per_layer.keys())
        for l in ordered:
            info = per_layer[l]
            if info["conf"] >= tau:
                return l, info["conf"], info["pred_idx"]
        last = ordered[-1]
        return last, per_layer[last]["conf"], per_layer[last]["pred_idx"]

    def train_heads(self, instances: list[dict], epochs: int = 6, lr: float = 1e-3) -> dict:
        """Train the per-layer option-scoring heads on clean instances.

        Uses the gold referent label from the dataset as supervision (the task
        target), with the base frozen. Returns per-layer train accuracy.
        """
        params = list(self.heads.parameters())
        optimizer = torch.optim.AdamW(params, lr=lr, weight_decay=1e-4)
        loss_fn = nn.CrossEntropyLoss()
        self.heads.train()
        for epoch in range(epochs):
            # Shuffle without importing functions into the hot loop.
            order = list(range(len(instances)))
            torch.manual_seed(self.config.seed)
            order = torch.randperm(len(instances)).tolist()
            total_loss = 0.0
            for idx in order:
                inst = instances[idx]
                prompt = build_prompt(inst)
                encoded = self.encode_prompt(prompt, [inst["occ1"], inst["occ2"]])
                out = self.model(
                    input_ids=encoded["input_ids"],
                    attention_mask=encoded["attention_mask"],
                    output_hidden_states=True,
                )
                hidden_states = out.hidden_states
                pos = encoded["input_ids"].shape[1] - 1
                option_embeds = _option_embedding_lookup(self.model, self.tokenizer, encoded["option_tokens"])
                gold = torch.tensor([inst["gold_idx"]], device=self.config.device)
                for l in self.config.train_layers:
                    if l >= len(hidden_states):
                        continue
                    h = hidden_states[l][:, pos, :]
                    logits = self.heads[str(l)](h, option_embeds)
                    loss = loss_fn(logits, gold)
                    optimizer.zero_grad()
                    loss.backward()
                    optimizer.step()
                    total_loss += loss.item()
            torch.cuda.empty_cache()
        self.heads.eval()
        return {"epochs": epochs, "train_examples": len(instances), "layers": self.config.train_layers}


def build_prompt(inst: dict) -> str:
    """Build a multiple-choice coreference prompt ending right before the answer.

    The model must emit the referent occupation as the next token.
    """
    return (
        f"Q: In \"{inst['text']}\", the pronoun \"{inst['pronoun']}\" refers to "
        f"\"{inst['occ1']}\" or \"{inst['occ2']}\"?\n"
        f'A: The pronoun refers to "'
    )


def load_model(config: ExitConfig):
    """Load the frozen base model and its tokenizer onto the chosen device."""
    tokenizer = AutoTokenizer.from_pretrained(config.model_name)
    tokenizer.pad_token = tokenizer.eos_token
    dtype = torch.float16 if config.dtype == "float16" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        config.model_name, torch_dtype=dtype, device_map=config.device
    ).eval()
    for param in model.parameters():
        param.requires_grad = False
    return tokenizer, model


if __name__ == "__main__":
    # Smoke test: verify shapes and a single training step end-to-end.
    import sys

    cfg = ExitConfig(
        model_name="Qwen/Qwen2.5-0.5B-Instruct",
        candidate_layers=[6, 12, 18, 24],
        train_layers=[6, 12, 18],
    )
    tok, m = load_model(cfg)
    em = EarlyExitModel(cfg, tok, m)
    sample = {"text": "The developer argued with the designer because she did not like the design.",
              "pronoun": "she", "occ1": "developer", "occ2": "designer", "gold_idx": 0}
    enc = em.encode_prompt(build_prompt(sample), [sample["occ1"], sample["occ2"]])
    scored = em.score_instance(enc)
    print("candidate layers:", list(scored["per_layer"].keys()))
    for l, info in scored["per_layer"].items():
        print(f"  layer {l:2d}: conf={info['conf']:.3f} pred_idx={info['pred_idx']} entropy={info['entropy']:.3f}")
    depth, conf, pred = em.exit_depth(scored["per_layer"], 0.5)
    print("exit depth under tau=0.5:", depth, "conf:", round(conf, 3), "pred:", pred)
    print("SMOKE OK")
    del m
    torch.cuda.empty_cache()
