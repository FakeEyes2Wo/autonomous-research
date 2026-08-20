#!/usr/bin/env python3
"""drawio MCP 绘制验证脚本（AI 全权版 + reflexion）。

1. search_shapes 拉取候选图标资源。
2. 生成 Agent（AI）自行决定布局 / 分组 / 图标取舍 / 配色，产出 draw.io XML。
3. Critic Agent（AI，fresh context）检查：
   - 图标与节点语义、论文架构图场景是否匹配；
   - 布局 / 分组 / 标签 / 一致性是否为 publication quality。
4. Critic 判定 REVISE 时，把 issue 反馈给生成 Agent 重画（reflexion，默认 ≤3 轮）。
5. 最终 XML 交给 hosted drawio MCP create_diagram，再用本机 draw.io CLI 导出。

程序只做 XML 良构性检查，不硬编码布局、分组、style、routing。

Usage (repo root):
    $env:PYTHONPATH='src'
    python docs/autoresearch/verify_exp/scripts/render_structure_drawio.py --rounds 3
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from xml.etree import ElementTree as ET

from athena.core.agent import AgentContext, create_agent, settings
from athena.core.thread_models import AthenaThread, AthenaTurn
from athena.core.tool import ToolRegistry
from athena.memory.context_manager import ContextManager
from pydantic_ai.messages import ModelResponse, TextPart

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

DRAWIO_MCP_URL = "https://mcp.draw.io/mcp"
DRAWIO_CLI = r"C:\Users\80163\AppData\Local\Microsoft\WinGet\Links\DrawIO.exe"

GENERATOR_SYSTEM = """You are an expert scientific-figure designer producing draw.io XML.
You receive a markdown prompt for a paper-level architecture diagram plus a list of candidate
icon styles from the draw.io shape library.

You have full design authority. Decide yourself:
- the best layout (rows, columns, hub-and-spoke, layered, mixed...);
- whether/how to group nodes (containers, swimlanes, or no groups);
- which candidate icon styles to use, replace, or drop — icons must match the node's meaning
  and must look appropriate in a paper architecture figure;
- colors, sizes, fonts, edge styles.

Output ONLY draw.io XML in a ```xml code fence. No explanation.

XML validity (the only hard rules):
- <mxfile><diagram><mxGraphModel><root> structure; root cells id="0" and id="1" parent="0".
- NO XML comments; escape & < > " in attribute values; unique ids.
- Vertex cells use vertex="1" parent="1" and contain <mxGeometry ... as="geometry"/>.
- Edge cells use edge="1" parent="1" source/target and contain <mxGeometry relative="1" as="geometry"/>.
- Every visible label is editable text (mxCell value attribute).
- Prefer publication-quality: balanced whitespace, no overlaps, consistent palette, readable labels.
"""

CRITIC_SYSTEM = """You are a harsh reviewer of paper-quality architecture diagrams.
You receive: (1) the original diagram prompt, (2) candidate icon styles that were available,
(3) the generated draw.io XML.

Review strictly:
1. Icon appropriateness: for every node that uses an icon/shape style, does that icon match the
   node's meaning AND the architecture-diagram context? Flag any irrelevant, misleading, toy-like,
   or oversized icon and suggest keep / replace / drop.
2. Layout: overlaps, alignment, whitespace, edge crossings, logical flow.
3. Grouping: are groups meaningful? is anything grouped that should not be?
4. Labels & readability: truncation, ambiguity, missing annotations.
5. Consistency: one visual language for shapes/colors/edges.

Return ONLY a JSON object (no markdown fences) with:
{
  "verdict": "PASS" | "REVISE",
  "issues": ["short actionable issue", ...],
  "icon_feedback": [{"node": "Label", "verdict": "keep|replace|drop", "why": "..."}, ...]
}
"""


def parse_frontmatter(text: str) -> dict:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing frontmatter")
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


def icon_keywords(data: dict) -> list[str]:
    kws = []
    for spec in data.get("nodes", []):
        parts = spec.split("|", 1)
        if len(parts) == 2 and parts[1].strip():
            kws.append(parts[1].strip())
    return list(dict.fromkeys(kws))


def extract_xml(text: str) -> str:
    m = re.search(r"```(?:xml)?\s*(.*?)```", text, flags=re.S)
    if m:
        text = m.group(1).strip()
    m = re.search(r"<mxfile.*</mxfile>", text, flags=re.S)
    if m:
        text = m.group(0)
    # drawio MCP 拒绝 XML comments；这是唯一允许的程序级清洗。
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    return text


def extract_json(text: str) -> dict:
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, flags=re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    return {}


def drawio_check(xml: str) -> dict:
    """只检查 XML 良构与最小结构；布局/风格全部交给 AI。"""
    if "<!--" in xml:
        return {"xml_ok": False, "reason": "contains XML comments"}
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        return {"xml_ok": False, "reason": str(e)}
    cells = [el for el in root.iter() if el.tag.endswith("mxCell")]
    vertices = [el for el in cells if el.get("vertex") == "1"]
    edges = [el for el in cells if el.get("edge") == "1"]
    ok = (
        root.tag.endswith("mxfile")
        and any(el.tag.endswith("mxGraphModel") for el in root.iter())
        and len(vertices) >= 2
        and len(edges) >= 1
    )
    return {"xml_ok": ok, "reason": None, "cells": len(cells),
            "vertices": len(vertices), "edges": len(edges)}


def last_assistant_text(memory: ContextManager) -> str:
    for msg in reversed(memory.items):
        if isinstance(msg, ModelResponse):
            for part in msg.parts:
                if isinstance(part, TextPart):
                    return part.content
                if getattr(part, "part_kind", None) == "text":
                    return getattr(part, "content", "")
    return ""


async def run_agent(agent, user_prompt: str, turn_id: str) -> str:
    memory = ContextManager()
    thread = AthenaThread(thread_id="drawio-ai", session_id="drawio-ai",
                          status="running", context_ref="drawio-ai")
    turn = AthenaTurn(turn_id=turn_id, thread_id="drawio-ai",
                      request_ref="drawio-prompt", status="running")
    cancel = asyncio.Event()

    async def emit(kind, ref, data=None):
        return None

    ctx = AgentContext(thread=thread, turn=turn, emit=emit, tools=agent.tools,
                       cancel=cancel, memory=memory, input_text=user_prompt)
    t0 = time.monotonic()
    await agent.run(ctx)
    raw = last_assistant_text(memory)
    return raw


async def drawio_search_shapes(keywords: list[str]) -> dict:
    shapes = {}
    if not keywords:
        return shapes
    last_error = None
    for _ in range(3):
        shapes = {}
        try:
            async with streamablehttp_client(DRAWIO_MCP_URL) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    for kw in keywords:
                        merged = []
                        for query in (kw, f"{kw} icon"):
                            try:
                                r = await session.call_tool("search_shapes", {"query": query, "limit": 4})
                                text = r.model_dump().get("content", [{}])
                                hits = json.loads(text[0].get("text", "[]")) if text else []
                                for h in hits[:4]:
                                    item = {"style": h.get("style", ""), "title": h.get("title", "")}
                                    if item not in merged:
                                        merged.append(item)
                            except BaseException as e:  # noqa: BLE001
                                if isinstance(e, (KeyboardInterrupt, SystemExit)):
                                    raise
                                shapes[kw] = {"error": str(e)}
                                break
                        if kw not in shapes:
                            shapes[kw] = merged[:4]
            if shapes and "_mcp_error" not in shapes:
                return shapes
        except BaseException as e:  # noqa: BLE001
            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                raise
            last_error = e
            await asyncio.sleep(1.5)
    shapes["_mcp_error"] = {"error": f"{type(last_error).__name__}: {last_error}"}
    return shapes


async def drawio_create(xml: str) -> dict:
    last_error = None
    for _ in range(3):
        try:
            async with streamablehttp_client(DRAWIO_MCP_URL) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool("create_diagram", {"xml": xml})
                    d = result.model_dump()
            text = ""
            for block in d.get("content") or []:
                if block.get("type") == "text":
                    text = block.get("text", "")
                    break
            parsed = {}
            try:
                parsed = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                parsed = {"raw_text": text[:2000]}
            return {
                "ok": not d.get("isError", False) and "xml" in parsed,
                "echo_xml": parsed.get("xml"),
                "build_id": parsed.get("_buildId"),
            }
        except BaseException as e:  # noqa: BLE001
            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                raise
            last_error = e
            await asyncio.sleep(2)
    return {"ok": False, "error": f"{type(last_error).__name__}: {last_error}", "build_id": None}


def export_with_cli(drawio_path: Path) -> dict:
    if not Path(DRAWIO_CLI).exists():
        return {"ok": False, "error": "drawio CLI missing"}
    out = {}
    for fmt in ("png", "svg", "pdf"):
        target = drawio_path.with_suffix(f".{fmt}")
        try:
            proc = subprocess.run(
                [DRAWIO_CLI, "--export", "--format", fmt, "--embed-diagram",
                 "--output", str(target), str(drawio_path)],
                capture_output=True, timeout=120,
            )
            out[fmt] = target.name if proc.returncode == 0 and target.exists() else None
        except BaseException:  # noqa: BLE001
            out[fmt] = None
    return {"ok": bool(out.get("png")), "files": out, "error": None if out.get("png") else "png export failed"}


async def main_async(args) -> int:
    base = Path(__file__).resolve().parent.parent  # verify_exp/
    data_dir = base / "structure_img_data"
    out_dir = base / "drawio_mcp"
    out_dir.mkdir(parents=True, exist_ok=True)

    model = args.model or settings.pro_model_name()
    generator = create_agent(model, ToolRegistry(), GENERATOR_SYSTEM,
                             max_turns=2, max_tokens=16384, temperature=0.3, name="drawio-gen")
    critic = create_agent(model, ToolRegistry(), CRITIC_SYSTEM,
                          max_turns=2, max_tokens=8192, temperature=0.1, name="drawio-critic")

    reports = []
    for md_path in sorted(data_dir.glob("*.md")):
        text = md_path.read_text(encoding="utf-8")
        data = parse_frontmatter(text)
        keywords = icon_keywords(data)
        shapes = await drawio_search_shapes(keywords)
        shapes_text = json.dumps(shapes, ensure_ascii=False, indent=2)

        xml, rounds_used, critic_verdict, icon_feedback, feedback = None, 0, None, [], None
        last_critic = {}
        for round_no in range(1, args.rounds + 1):
            user_prompt = (
                f"Diagram prompt:\n\n{text}\n\n"
                f"Candidate icon styles from search_shapes:\n{shapes_text}\n\n"
            )
            if feedback:
                user_prompt += f"Reviewer feedback. Fix these issues:\n{json.dumps(feedback, ensure_ascii=False, indent=2)}\n"
            raw = await run_agent(generator, user_prompt, f"gen-{md_path.stem}-{round_no}")
            xml = extract_xml(raw)
            check = drawio_check(xml)
            if not check["xml_ok"]:
                feedback = {"check": check}
                continue
            critic_input = (
                f"Diagram prompt:\n\n{text}\n\n"
                f"Candidate icon styles:\n{shapes_text}\n\n"
                f"Generated draw.io XML:\n{xml}\n"
            )
            critic_raw = await run_agent(critic, critic_input, f"critic-{md_path.stem}-{round_no}")
            last_critic = extract_json(critic_raw)
            critic_verdict = last_critic.get("verdict")
            icon_feedback = last_critic.get("icon_feedback", [])
            rounds_used = round_no
            if critic_verdict == "PASS":
                feedback = None
                break
            feedback = {"issues": last_critic.get("issues", []),
                        "icon_feedback": last_critic.get("icon_feedback", [])}

        mcp_result = {"ok": False, "error": None, "build_id": None}
        if xml is not None and drawio_check(xml)["xml_ok"]:
            mcp_result = await drawio_create(xml)

        final_xml = (mcp_result.get("echo_xml") if mcp_result.get("echo_xml") else xml) or ""
        stem = md_path.stem
        if final_xml:
            (out_dir / f"{stem}.drawio").write_text(final_xml, encoding="utf-8")
        (out_dir / f"{stem}.llm.txt").write_text(xml or "", encoding="utf-8")
        (out_dir / f"{stem}.critic.json").write_text(
            json.dumps(last_critic, ensure_ascii=False, indent=2), encoding="utf-8")
        (out_dir / f"{stem}.mcp.json").write_text(
            json.dumps({"ok": mcp_result.get("ok"), "build_id": mcp_result.get("build_id"),
                        "error": mcp_result.get("error"), "shapes": shapes},
                       ensure_ascii=False, indent=2),
            encoding="utf-8")

        export = export_with_cli(out_dir / f"{stem}.drawio") if final_xml else {"ok": False}
        final_check = drawio_check(final_xml) if final_xml else {"xml_ok": False, "reason": "no xml"}
        reports.append({
            "prompt": md_path.name,
            "title": data.get("title", ""),
            "rounds": rounds_used,
            "critic_verdict": critic_verdict,
            "icon_feedback": icon_feedback,
            "check": final_check,
            "mcp_ok": mcp_result.get("ok"),
            "mcp_error": mcp_result.get("error"),
            "build_id": mcp_result.get("build_id"),
            "shapes_queried": len(keywords),
            "drawio": f"{stem}.drawio" if final_xml else None,
            "export": export,
            "status": ("PASS" if final_check["xml_ok"] and mcp_result.get("ok")
                       and export.get("ok") else "FAIL"),
        })

    report_path = out_dir / "report.json"
    report_path.write_text(json.dumps({"files": reports}, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = sum(1 for r in reports if r.get("status") == "PASS")
    print(f"prompts={len(reports)} passed={passed} failed={len(reports) - passed}")
    print(f"out={out_dir} report={report_path.name}")
    return 0 if passed == len(reports) else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="")
    parser.add_argument("--rounds", type=int, default=3)
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
