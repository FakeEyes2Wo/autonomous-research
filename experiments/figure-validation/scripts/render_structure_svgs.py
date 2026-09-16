#!/usr/bin/env python3
"""LLM-gen-SVG verification script using athena.core.agent.Agent.

Reads structure_img_data/*.md prompts, calls the Athena core Agent (DeepSeek/OpenAI
configured through `.env` / config.toml) to generate SVG code, renders each SVG to PNG
(PyMuPDF) and runs structural checks.

Usage (from repo root, needs src on PYTHONPATH):
    $env:PYTHONPATH='src'
    python experiments/figure-validation/scripts/render_structure_svgs.py [--attempts 2]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

from athena.core.agent import AgentContext, create_agent, settings
from athena.core.thread_models import AthenaThread, AthenaTurn
from athena.core.tool import ToolRegistry
from athena.memory.context_manager import ContextManager
from pydantic_ai.messages import ModelResponse, TextPart

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

PALETTES = {
    "academic-minimal": {
        "bg": "#ffffff", "node_fill": "#ffffff", "node_stroke": "#333333",
        "text": "#333333", "edge": "#2563eb", "group_stroke": "#6b7280",
        "annot": "#6b7280",
    },
    "colorblind-minimal": {
        "bg": "#f8fafc", "node_fill": "#ffffff", "node_stroke": "#1f2937",
        "text": "#111827", "edge": "#0f766e", "group_stroke": "#475569",
        "annot": "#64748b",
    },
}
DEFAULT_STYLE = "academic-minimal"

NODE_W, NODE_H, GAP_X, GAP_Y = 150, 46, 30, 64
COLS = 4

SYSTEM_PROMPT = """You are an expert scientific-figure generator.
You receive a markdown prompt describing a paper-level architecture diagram.
Output ONLY one SVG document, wrapped in a ```svg code fence. No explanations.

Hard constraints:
- Valid standalone SVG with xmlns, width/height AND viewBox.
- Every visible label is an editable <text> element (no text converted to paths/images).
- No <image> elements, no external URLs, no scripts, no <foreignObject>.
- Colors: use only the palette tokens given below.
- Fonts: sans-serif only. Font sizes 10-14px.
- Nodes: rounded or square rectangles with 1.5-2px stroke; same-size siblings; aligned rows/columns.
- Edges: orthogonal paths with a single arrow marker, 1.5-2px, accent color; avoid crossings.
- Groups: dashed or thin solid containers with a small top-left label.
- Annotations: small gray text under the annotated node.
- No gradients, no shadows, no decorative junk.
- Keep the figure publication-quality and compact (max 1600x1200).
"""


def esc(text: str) -> str:
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;").replace("'", "&apos;")
    )


def parse_frontmatter(text: str) -> dict:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing frontmatter: first line must be ---")
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        raise ValueError("unterminated frontmatter")
    data: dict = {"nodes": [], "edges": [], "groups": [], "annotations": []}
    current = None
    for raw in lines[1:end]:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("- "):
            if current:
                data[current].append(line[2:].strip().strip('"'))
            continue
        if ":" in line and not line.startswith("  "):
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key in ("nodes", "edges", "groups", "annotations"):
                current = key
            else:
                current = None
                data[key] = val
    return data


def structural_check(svg_text: str) -> dict:
    try:
        root = ET.fromstring(svg_text)
    except ET.ParseError as e:
        return {"xml_ok": False, "viewbox": False, "editable_texts": 0,
                "external_refs": False, "bounds_ok": False, "error": str(e)}
    viewbox = "viewBox" in root.attrib
    texts = [el for el in root.iter() if el.tag.endswith("text")]
    ext = any(
        el.tag.endswith("image") and (el.get("{http://www.w3.org/1999/xlink}href") or el.get("href"))
        for el in root.iter()
    )
    bounds_ok = True
    if viewbox:
        parts = [float(x) for x in root.attrib["viewBox"].split()]
        if len(parts) == 4 and parts[2] > 0 and parts[3] > 0:
            w, h = parts[2], parts[3]
            stripped = re.sub(r"#[0-9a-fA-F]{3,8}", " ", svg_text)
            stripped = re.sub(r"https?://\S+", " ", stripped)
            numbers = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", stripped)]
            bounds_ok = max(numbers, default=0) <= max(w, h)
    return {"xml_ok": True, "viewbox": viewbox, "editable_texts": len(texts),
            "external_refs": ext, "bounds_ok": bounds_ok, "error": None}


def extract_svg(text: str) -> str:
    m = re.search(r"```(?:svg|xml)?\s*(.*?)```", text, flags=re.S)
    if m:
        text = m.group(1).strip()
    m = re.search(r"<svg.*</svg>", text, flags=re.S)
    if m:
        return m.group(0)
    return text


def last_assistant_text(memory: ContextManager) -> str:
    for msg in reversed(memory.items):
        if isinstance(msg, ModelResponse):
            for part in msg.parts:
                if isinstance(part, TextPart):
                    return part.content
                if getattr(part, "part_kind", None) == "text":
                    return getattr(part, "content", "")
    return ""


async def llm_generate_svg(agent, prompt_md: str, style: str, attempt_no: int, feedback: str | None = None) -> dict:
    palette = PALETTES.get(style, PALETTES[DEFAULT_STYLE])
    user_prompt = (
        f"Style: {style}\nPalette tokens: {json.dumps(palette)}\n\n"
        f"Diagram prompt:\n\n{prompt_md}\n"
    )
    if feedback:
        user_prompt += f"\nYour previous SVG failed these checks:\n{feedback}\nFix the SVG and output it again."

    memory = ContextManager()
    turn = AthenaTurn(
        turn_id=f"svg-{style}-{attempt_no}",
        thread_id="svg-verify",
        request_ref="svg-prompt",
        status="running",
    )
    thread = AthenaThread(
        thread_id="svg-verify", session_id="svg-verify", status="running", context_ref="svg-verify"
    )
    cancel = asyncio.Event()

    async def emit(kind, ref, data=None):
        return None

    ctx = AgentContext(
        thread=thread,
        turn=turn,
        emit=emit,
        tools=agent.tools,
        cancel=cancel,
        memory=memory,
        input_text=user_prompt,
    )
    t0 = time.monotonic()
    await agent.run(ctx)
    raw = last_assistant_text(memory)
    return {
        "raw": raw,
        "svg": extract_svg(raw),
        "model": agent.model.model_name,
        "seconds": round(time.monotonic() - t0, 1),
    }


def preflight_endpoint() -> None:
    """LLM 端点连通性预检：不可达就 fail fast，不让 Agent 重试拖时间。

    401/403 也算连通（未带鉴权的 /models 会拒绝）；只有网络层错误才 fail fast。
    """
    url = f"{settings.base_url().rstrip('/')}/models"
    try:
        req = Request(url, headers={"User-Agent": "athena-verify"})
        with urlopen(req, timeout=15):
            pass
    except HTTPError as e:
        if e.code in (401, 403):
            return
        print(f"LLM endpoint check failed: {url} (HTTP {e.code})", file=sys.stderr)
        raise SystemExit(2)
    except Exception as e:  # noqa: BLE001
        print(f"LLM endpoint unreachable: {url} ({type(e).__name__}: {e})", file=sys.stderr)
        print("Fix BASE_URL/network, or run this script on a machine that can reach the LLM API.", file=sys.stderr)
        raise SystemExit(2)


async def main_async(args) -> int:
    base = Path(__file__).resolve().parent.parent  # experiments/figure-validation/
    data_dir = (Path(args.data_dir) if Path(args.data_dir).is_absolute() else base / args.data_dir)
    out_dir = (Path(args.out_dir) if Path(args.out_dir).is_absolute() else base / args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    preflight_endpoint()
    model = args.model or settings.pro_model_name()
    agent = create_agent(
        model,
        ToolRegistry(),
        SYSTEM_PROMPT,
        max_turns=2,
        max_tokens=16384,
        temperature=0.2,
        name="svg-gen",
    )

    reports = []
    for md_path in sorted(data_dir.glob("*.md")):
        text = md_path.read_text(encoding="utf-8")
        data = parse_frontmatter(text)
        style = data.get("style") or DEFAULT_STYLE
        svg_text, llm_used, attempts_used, llm_error = None, False, 0, None
        feedback = None
        for attempt in range(1, args.attempts + 1):
            try:
                result = await llm_generate_svg(agent, text, style, attempt, feedback)
                svg_text = result["svg"]
                llm_used = True
                attempts_used = attempt
                checks = structural_check(svg_text)
                if checks["xml_ok"] and checks["viewbox"] and checks["editable_texts"] > 0 and checks["bounds_ok"]:
                    break
                feedback = json.dumps(checks, ensure_ascii=False)
            except Exception as e:  # noqa: BLE001
                llm_error = f"{type(e).__name__}: {e}"
                break

        svg_path = out_dir / (md_path.stem + ".svg")
        svg_path.write_text(svg_text, encoding="utf-8")
        (out_dir / (md_path.stem + ".llm.txt")).write_text(
            result.get("raw", "") if llm_used else "", encoding="utf-8"
        )

        checks = structural_check(svg_text)
        png_ok, png_error, png_path = False, None, out_dir / (md_path.stem + ".png")
        if fitz is not None:
            try:
                doc = fitz.open(str(svg_path))
                if doc.page_count:
                    pix = doc[0].get_pixmap(matrix=fitz.Matrix(1.5, 1.5))
                    pix.save(str(png_path))
                    png_ok = True
                doc.close()
            except Exception as e:  # noqa: BLE001
                png_error = str(e)
        ok = (checks["xml_ok"] and checks["viewbox"] and checks["editable_texts"] > 0
              and not checks["external_refs"] and checks["bounds_ok"])
        reports.append({
            "prompt": md_path.name,
            "title": data.get("title", ""),
            "style": style,
            "llm_used": llm_used,
            "attempts": attempts_used,
            "model": model if llm_used else "native-svg",
            "llm_error": llm_error,
            "svg": svg_path.name,
            "png": png_path.name if png_ok else None,
            "checks": checks,
            "png_ok": png_ok,
            "png_error": png_error,
            "status": "PASS" if ok and png_ok else "FAIL",
        })

    report_path = out_dir / "report.json"
    report_path.write_text(json.dumps({"files": reports}, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = sum(1 for r in reports if r.get("status") == "PASS")
    llm_passed = sum(1 for r in reports if r.get("status") == "PASS" and r.get("llm_used"))
    print(f"prompts={len(reports)} passed={passed} llm_passed={llm_passed} failed={len(reports) - passed}")
    print(f"out={out_dir} report={report_path.name}")
    return 0 if passed == len(reports) else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="structure_img_data")
    parser.add_argument("--out-dir", default="structure_img_out")
    parser.add_argument("--model", default="")
    parser.add_argument("--attempts", type=int, default=2)
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
