# -*- coding: utf-8 -*-
"""Smoke test: verify model loads and weight-only quantization proxy works."""
import torch
from torch import nn
from transformers import AutoModelForCausalLM, AutoTokenizer


def quantize_weights_int(model: nn.Module, bits: int) -> None:
    """Round Linear weights to a low-precision integer grid (weight-only RTN proxy).

    Per-output-channel affine symmetric quantization, then dequantized back to
    float for the forward pass. This approximates the weight-precision loss that
    GPTQ/AWQ aim to fit.
    """
    max_val = float(2 ** (bits - 1) - 1)
    for module in model.modules():
        if isinstance(module, nn.Linear):
            weight = module.weight.data
            abs_max = weight.abs().amax(dim=1, keepdim=True).clamp_min(1e-8)
            scale = abs_max / max_val
            weight_q = torch.round(weight / scale)
            weight_q = torch.clamp(weight_q, -max_val, max_val)
            module.weight.data = (weight_q * scale).to(weight.dtype)
    return None


def main() -> None:
    model_name = "Qwen/Qwen2.5-0.5B-Instruct"
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(
        model_name, dtype=torch.float16, device_map="auto"
    ).eval()
    text = "The woman is a"
    inputs = tokenizer(text, return_tensors="pt").to(model.device)
    with torch.no_grad():
        baseline_logits = model(**inputs).logits
    print("baseline logits shape:", baseline_logits.shape)

    quantize_weights_int(model, 8)
    with torch.no_grad():
        int8_logits = model(**inputs).logits
    print("int8 logits shape:", int8_logits.shape)

    quantize_weights_int(model, 4)
    with torch.no_grad():
        int4_logits = model(**inputs).logits
    print("int4 logits shape:", int4_logits.shape)

    # Make the quantization idempotent so repeated 4-bit application is stable.
    quantize_weights_int(model, 4)
    with torch.no_grad():
        int4b_logits = model(**inputs).logits
    print("int4 re-applied logits shape:", int4b_logits.shape)
    print("SMOKE OK")


if __name__ == "__main__":
    main()
