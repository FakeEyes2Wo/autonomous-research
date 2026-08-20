"""Self-contained draw.io MCP diagram generator."""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

BASE_DIR = Path(__file__).resolve().parent
DRAWIO_MCP_URL = "https://mcp.draw.io/mcp"
DEFAULT_DRAWIO_CLI = Path(
    r"C:\Users\80163\AppData\Local\Microsoft\WinGet\Links\DrawIO.exe"
)
DEFAULT_CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
CANVAS_SPECS: dict[str, tuple[int, int]] = {
    "01-candidate-to-paper-pipeline": (1200, 800),
    "02-rag-system": (1200, 800),
    "03-rlhf-pipeline": (1200, 800),
    "04-diffusion-llm-training": (1200, 800),
    "05-multiturn-eval-harness": (1200, 800),
    "06-model-editing-framework": (1200, 800),
    "07-evidential-multiview-learning": (1200, 900),
    "08-transformer-succinctness": (960, 1200),
    "09-finetuning-influence-flow": (1200, 800),
    "10-agent-reflection-loop": (1200, 800),
}


@dataclass(frozen=True)
class NodeSpec:
    label: str
    icon: str


@dataclass(frozen=True)
class EdgeSpec:
    source: str
    target: str


@dataclass(frozen=True)
class GroupSpec:
    label: str
    members: tuple[str, ...]


@dataclass(frozen=True)
class DiagramSpec:
    stem: str
    title: str
    nodes: tuple[NodeSpec, ...]
    edges: tuple[EdgeSpec, ...]
    groups: tuple[GroupSpec, ...]
    annotations: tuple[str, ...]
    body: str


LAYOUT_ROWS: dict[str, tuple[tuple[str, ...], ...]] = {
    "01-candidate-to-paper-pipeline": (
        (
            "Candidate Intake",
            "Brainstorm",
            "Ideation",
            "Experiment Plan",
            "Experiment",
            "Evidence",
            "Claims & Outline",
            "Writing",
            "Review",
            "Packaging",
        ),
    ),
    "02-rag-system": (
        ("Corpus", "Encoder", "Vector Index"),
        ("Query", "Retriever", "Reranker", "Generator"),
    ),
    "03-rlhf-pipeline": (
        ("SFT Model", "Sampling", "Reward Model", "Policy Update", "Evaluation"),
        ("Preference Data",),
    ),
    "04-diffusion-llm-training": (
        (
            "Text Tokens",
            "Noising",
            "Denoiser",
            "Left-to-Right Decoder",
            "Reasoning Trace",
            "Answer",
        ),
    ),
    "05-multiturn-eval-harness": (
        (
            "Single-Turn Benchmarks",
            "Sharding",
            "Conversation Simulator",
            "LLM Under Test",
        ),
        ("User Model", "Aptitude Metric", "Reliability Metric"),
    ),
    "06-model-editing-framework": (
        ("Base LLM", "Edited LLM", "Preservation Check"),
        ("Edit Request", "Key-Value Mapping", "Null-Space Projection"),
    ),
    "07-evidential-multiview-learning": (
        ("View 1", "View-Specific Evidence", "Opinion Construction"),
        ("View 2", "Conflictive Aggregation", "Decision + Reliability"),
        ("View 3",),
    ),
    "08-transformer-succinctness": (
        ("Language Family", "Transformer", "Verification Problem"),
        ("LTL Formula",),
        ("RNN",),
        ("Finite Automaton",),
    ),
    "09-finetuning-influence-flow": (
        ("Training Example A", "Parameter Update", "Good Outputs"),
        ("Training Example B", "Probability Mass Shift", "Bad Outputs"),
    ),
    "10-agent-reflection-loop": (
        ("Planner", "Executor", "Observation", "Reflection", "Memory"),
        ("Task", "Next Action"),
    ),
}


POSITION_HINTS: dict[str, dict[str, tuple[float, float]]] = {
    "01-candidate-to-paper-pipeline": {
        "Candidate Intake": (0, 0),
        "Brainstorm": (1, 0),
        "Ideation": (2, 0),
        "Experiment Plan": (3, 0),
        "Experiment": (4, 0),
        "Evidence": (0, 1.5),
        "Claims & Outline": (1, 1.5),
        "Writing": (2, 1.5),
        "Review": (3, 1.5),
        "Packaging": (4, 1.5),
    },
    "02-rag-system": {
        "Corpus": (0, 0),
        "Encoder": (1, 0),
        "Vector Index": (2, 0),
        "Query": (0, 1.25),
        "Retriever": (1, 1.25),
        "Reranker": (2, 1.25),
        "Generator": (3, 1.25),
    },
    "03-rlhf-pipeline": {
        "SFT Model": (0, 0),
        "Sampling": (1, 0),
        "Reward Model": (2, 0),
        "Policy Update": (3, 0),
        "Evaluation": (4, 0),
        "Preference Data": (1.5, 1.25),
    },
    "04-diffusion-llm-training": {
        "Text Tokens": (0, 0),
        "Noising": (1, 0),
        "Denoiser": (2, 0),
        "Left-to-Right Decoder": (0, 1.5),
        "Reasoning Trace": (1, 1.5),
        "Answer": (2, 1.5),
    },
    "05-multiturn-eval-harness": {
        "Single-Turn Benchmarks": (0, 0),
        "Sharding": (1, 0),
        "Conversation Simulator": (2, 0),
        "LLM Under Test": (3, 0),
        "User Model": (1, 1.25),
        "Aptitude Metric": (3, 1.25),
        "Reliability Metric": (4, 1.25),
    },
    "06-model-editing-framework": {
        "Base LLM": (0, 0),
        "Edited LLM": (3, 0),
        "Preservation Check": (4, 0),
        "Edit Request": (0, 1.25),
        "Key-Value Mapping": (1, 1.25),
        "Null-Space Projection": (2, 1.25),
    },
    "07-evidential-multiview-learning": {
        "View 1": (0, 0),
        "View 2": (0, 1.25),
        "View 3": (0, 2.5),
        "View-Specific Evidence": (1, 1.25),
        "Opinion Construction": (2, 1.25),
        "Conflictive Aggregation": (3, 1.25),
        "Decision + Reliability": (4, 1.25),
    },
    "08-transformer-succinctness": {
        "Language Family": (0, 1.9),
        "Transformer": (1, 0),
        "LTL Formula": (1, 1.25),
        "RNN": (1, 2.5),
        "Finite Automaton": (1, 3.75),
        "Verification Problem": (2, 1.9),
    },
    "09-finetuning-influence-flow": {
        "Training Example A": (0, 0),
        "Training Example B": (0, 1.25),
        "Parameter Update": (1, 0.625),
        "Probability Mass Shift": (2, 0.625),
        "Good Outputs": (3, 0),
        "Bad Outputs": (3, 1.25),
    },
    "10-agent-reflection-loop": {
        "Planner": (1, 0),
        "Executor": (2, 0),
        "Observation": (3, 0),
        "Reflection": (4, 0),
        "Memory": (5, 0),
        "Task": (0, 1.25),
        "Next Action": (2, 1.25),
    },
}

NODE_W = 170.0
NODE_H = 70.0
X_STEP = 245.0
Y_STEP = 142.0
MARGIN_X = 78.0
MARGIN_Y = 112.0
GROUP_COLORS = ("#DBEAFE", "#CCFBF1", "#FEF3C7", "#EDE9FE")
GROUP_STROKES = ("#60A5FA", "#2DD4BF", "#F59E0B", "#A78BFA")
ICON_BADGES = {
    "person": "USR",
    "lightbulb": "IDEA",
    "idea": "IDEA",
    "clipboard": "PLAN",
    "flask": "EXP",
    "database": "DB",
    "list": "LIST",
    "document": "DOC",
    "documents": "DOC",
    "magnifier": "FIND",
    "box": "PKG",
    "text": "TXT",
    "embedding": "VEC",
    "scale": "SCORE",
    "llm": "AI",
    "dice": "SAMPLE",
    "loop": "LOOP",
    "chart": "METRIC",
    "noise": "NOISE",
    "arrow": "DECODE",
    "path": "TRACE",
    "check": "OK",
    "scissors": "SPLIT",
    "chat": "CHAT",
    "edit": "EDIT",
    "key": "KEY",
    "matrix": "MATRIX",
    "image": "IMG",
    "audio": "AUDIO",
    "merge": "FUSE",
    "set": "SET",
    "formula": "LTL",
    "network": "RNN",
    "machine": "FSM",
    "gavel": "VERIFY",
    "flow": "SHIFT",
    "cross": "RISK",
    "inbox": "TASK",
    "plan": "PLAN",
    "gear": "ACT",
    "eye": "OBS",
    "mirror": "REFLECT",
}


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def parse_prompt(text: str, stem: str) -> DiagramSpec:
    """Parse the fixed frontmatter and reject malformed references."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing frontmatter")
    try:
        end = next(i for i, line in enumerate(lines[1:], 1) if line.strip() == "---")
    except StopIteration as exc:
        raise ValueError("unterminated frontmatter") from exc

    scalar: dict[str, str] = {}
    lists: dict[str, list[str]] = {
        "nodes": [],
        "edges": [],
        "groups": [],
        "annotations": [],
    }
    current: str | None = None
    for raw in lines[1:end]:
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith("- "):
            if current is None:
                raise ValueError("list item without section")
            lists[current].append(_unquote(stripped[2:]))
            continue
        if ":" not in stripped:
            raise ValueError(f"malformed frontmatter line: {stripped}")
        key, value = stripped.split(":", 1)
        key = key.strip()
        if key in lists:
            current = key
        else:
            current = None
            scalar[key] = _unquote(value)

    title = scalar.get("title", "").strip()
    if not title:
        raise ValueError("empty title")

    nodes: list[NodeSpec] = []
    for item in lists["nodes"]:
        if "|" not in item:
            raise ValueError(f"malformed node: {item}")
        label, icon = (part.strip() for part in item.split("|", 1))
        if not label or not icon:
            raise ValueError(f"malformed node: {item}")
        nodes.append(NodeSpec(label, icon))
    names = [node.label for node in nodes]
    if len(set(names)) != len(names):
        raise ValueError("duplicate node label")
    known = set(names)

    edges: list[EdgeSpec] = []
    for item in lists["edges"]:
        if "->" not in item:
            raise ValueError(f"malformed edge: {item}")
        source, target = (part.strip() for part in item.split("->", 1))
        if source not in known or target not in known:
            raise ValueError(f"edge references unknown node: {item}")
        edges.append(EdgeSpec(source, target))

    groups: list[GroupSpec] = []
    for item in lists["groups"]:
        if ":" not in item:
            raise ValueError(f"malformed group: {item}")
        label, raw_members = (part.strip() for part in item.split(":", 1))
        members = tuple(part.strip() for part in raw_members.split(",") if part.strip())
        unknown = set(members) - known
        if not label or not members:
            raise ValueError(f"malformed group: {item}")
        if unknown:
            raise ValueError(f"group references unknown node: {sorted(unknown)}")
        groups.append(GroupSpec(label, members))

    body = "\n".join(lines[end + 1 :]).strip()
    return DiagramSpec(
        stem=stem,
        title=title,
        nodes=tuple(nodes),
        edges=tuple(edges),
        groups=tuple(groups),
        annotations=tuple(lists["annotations"]),
        body=body,
    )


def _geometry(
    parent: ET.Element,
    *,
    x: float | None = None,
    y: float | None = None,
    width: float | None = None,
    height: float | None = None,
    relative: bool = False,
) -> ET.Element:
    attrs: dict[str, str] = {"as": "geometry"}
    if relative:
        attrs["relative"] = "1"
    for key, value in (("x", x), ("y", y), ("width", width), ("height", height)):
        if value is not None:
            attrs[key] = f"{value:g}"
    return ET.SubElement(parent, "mxGeometry", attrs)


def _positions(spec: DiagramSpec) -> dict[str, tuple[float, float]]:
    try:
        hints = POSITION_HINTS[spec.stem]
    except KeyError as exc:
        raise ValueError(f"missing layout hints for {spec.stem}") from exc
    names = {node.label for node in spec.nodes}
    if set(hints) != names:
        raise ValueError(f"layout hints do not cover {spec.stem}")
    return {
        label: (MARGIN_X + gx * X_STEP, MARGIN_Y + gy * Y_STEP)
        for label, (gx, gy) in hints.items()
    }


def _group_bounds(
    members: tuple[str, ...], positions: dict[str, tuple[float, float]]
) -> tuple[float, float, float, float]:
    xs = [positions[label][0] for label in members]
    ys = [positions[label][1] for label in members]
    left = min(xs) - 24
    top = min(ys) - 42
    right = max(xs) + NODE_W + 24
    bottom = max(ys) + NODE_H + 26
    return left, top, right - left, bottom - top


def _node_color(spec: DiagramSpec, label: str) -> str:
    for index, group in enumerate(spec.groups):
        if label in group.members:
            return GROUP_STROKES[index % len(GROUP_STROKES)]
    return "#64748B"


def build_drawio_xml(
    spec: DiagramSpec, shape_results: dict[str, list[dict[str, str]]]
) -> str:
    """Build editable, uncompressed draw.io XML without external resources."""
    del shape_results  # Search evidence is reported, not embedded as remote assets.
    positions = _positions(spec)
    max_x = max(x for x, _ in positions.values()) + NODE_W + MARGIN_X
    max_y = max(y for _, y in positions.values()) + NODE_H + 104

    mxfile = ET.Element(
        "mxfile",
        {
            "host": "app.diagrams.net",
            "agent": "codex-gen-from-scratch",
            "version": "26.0.16",
        },
    )
    diagram = ET.SubElement(mxfile, "diagram", {"id": spec.stem, "name": "Page-1"})
    model = ET.SubElement(
        diagram,
        "mxGraphModel",
        {
            "dx": "1200",
            "dy": "800",
            "grid": "1",
            "gridSize": "10",
            "guides": "1",
            "tooltips": "1",
            "connect": "1",
            "arrows": "1",
            "fold": "1",
            "page": "1",
            "pageScale": "1",
            "pageWidth": f"{max(1169, int(max_x)):d}",
            "pageHeight": f"{max(827, int(max_y)):d}",
            "math": "0",
            "shadow": "0",
        },
    )
    root = ET.SubElement(model, "root")
    ET.SubElement(root, "mxCell", {"id": "0"})
    ET.SubElement(root, "mxCell", {"id": "1", "parent": "0"})

    for index, group in enumerate(spec.groups):
        x, y, width, height = _group_bounds(group.members, positions)
        color = GROUP_COLORS[index % len(GROUP_COLORS)]
        stroke = GROUP_STROKES[index % len(GROUP_STROKES)]
        cell = ET.SubElement(
            root,
            "mxCell",
            {
                "id": f"group-{index + 1}",
                "value": f"<b>{html.escape(group.label)}</b>",
                "style": (
                    "rounded=1;whiteSpace=wrap;html=1;dashed=1;dashPattern=6 5;"
                    f"fillColor={color};fillOpacity=28;strokeColor={stroke};"
                    "strokeWidth=1.4;fontColor=#334155;fontSize=14;fontStyle=1;"
                    "fontFamily=Helvetica;"
                    "verticalAlign=top;spacingTop=10;align=left;spacingLeft=12;"
                ),
                "vertex": "1",
                "parent": "1",
                "athenaRole": "group",
            },
        )
        _geometry(cell, x=x, y=y, width=width, height=height)

    title = ET.SubElement(
        root,
        "mxCell",
        {
            "id": "title",
            "value": f"<b>{html.escape(spec.title)}</b>",
            "style": (
                "text;html=1;strokeColor=none;fillColor=none;align=left;"
                "verticalAlign=middle;fontColor=#0F172A;fontSize=20;fontStyle=1;"
                "fontFamily=Helvetica;"
            ),
            "vertex": "1",
            "parent": "1",
            "athenaRole": "title",
        },
    )
    _geometry(title, x=MARGIN_X - 24, y=30, width=max_x - 2 * MARGIN_X + 48, height=38)

    node_ids = {
        node.label: f"node-{index + 1}" for index, node in enumerate(spec.nodes)
    }
    for index, edge in enumerate(spec.edges):
        source_x, source_y = positions[edge.source]
        target_x, target_y = positions[edge.target]
        backward = target_x <= source_x
        style = (
            "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;"
            "jettySize=auto;html=1;strokeColor=#2563EB;strokeWidth=2;"
            "endArrow=block;endFill=1;"
        )
        if backward:
            style += "exitY=1;exitX=0.5;entryY=1;entryX=0.5;"
        elif abs(target_y - source_y) > NODE_H:
            style += "exitX=1;exitY=0.5;entryX=0;entryY=0.5;"
        edge_cell = ET.SubElement(
            root,
            "mxCell",
            {
                "id": f"edge-{index + 1}",
                "style": style,
                "edge": "1",
                "parent": "1",
                "source": node_ids[edge.source],
                "target": node_ids[edge.target],
                "athenaRole": "edge",
            },
        )
        _geometry(edge_cell, relative=True)

    for node in spec.nodes:
        x, y = positions[node.label]
        badge = ICON_BADGES.get(node.icon, node.icon.upper()[:8])
        color = _node_color(spec, node.label)
        value = (
            f"<b>{html.escape(node.label)}</b><br>"
            f'<font color="#64748B" size="2">{html.escape(badge)}</font>'
        )
        cell = ET.SubElement(
            root,
            "mxCell",
            {
                "id": node_ids[node.label],
                "value": value,
                "style": (
                    "rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;"
                    f"strokeColor={color};strokeWidth=1.8;fontColor=#1E293B;"
                    "fontSize=13;fontFamily=Helvetica;align=center;"
                    "verticalAlign=middle;spacing=8;"
                    "shadow=0;arcSize=14;"
                ),
                "vertex": "1",
                "parent": "1",
                "athenaRole": "node",
                "athenaLabel": node.label,
            },
        )
        _geometry(cell, x=x, y=y, width=NODE_W, height=NODE_H)

    for index, annotation in enumerate(spec.annotations):
        target, separator, detail = annotation.partition(":")
        if not separator or target.strip() not in positions:
            continue
        target = target.strip()
        x, y = positions[target]
        note = ET.SubElement(
            root,
            "mxCell",
            {
                "id": f"note-{index + 1}",
                "value": html.escape(detail.strip()),
                "style": (
                    "rounded=1;whiteSpace=wrap;html=1;fillColor=#F8FAFC;"
                    "strokeColor=#CBD5E1;dashed=1;fontColor=#475569;fontSize=10;"
                    "fontFamily=Helvetica;"
                    "align=center;verticalAlign=middle;"
                ),
                "vertex": "1",
                "parent": "1",
                "athenaRole": "annotation",
            },
        )
        _geometry(note, x=x, y=y + NODE_H + 12, width=NODE_W, height=32)

    ET.indent(mxfile, space="  ")
    return ET.tostring(mxfile, encoding="unicode", xml_declaration=False)


def _rect(cell: ET.Element) -> tuple[float, float, float, float] | None:
    geometry = cell.find("mxGeometry")
    if geometry is None:
        return None
    try:
        x = float(geometry.get("x", "0"))
        y = float(geometry.get("y", "0"))
        width = float(geometry.get("width", "0"))
        height = float(geometry.get("height", "0"))
    except ValueError:
        return None
    return x, y, width, height


def validate_drawio_xml(xml: str) -> dict[str, object]:
    """Validate editability, structure, external resources, and node overlap."""
    result: dict[str, object] = {
        "xml_ok": False,
        "reason": None,
        "vertices": 0,
        "edges": 0,
        "editable_labels": 0,
        "external_urls": re.findall(r"https?://[^\s\"'<>]+", xml),
        "node_overlaps": [],
    }
    try:
        mxfile = ET.fromstring(xml)
    except ET.ParseError as exc:
        result["reason"] = str(exc)
        return result

    cells = list(mxfile.iter("mxCell"))
    vertices = [cell for cell in cells if cell.get("vertex") == "1"]
    edges = [cell for cell in cells if cell.get("edge") == "1"]
    result["vertices"] = len(vertices)
    result["edges"] = len(edges)
    result["editable_labels"] = sum(
        bool(cell.get("value", "").strip()) for cell in vertices
    )

    nodes = [cell for cell in vertices if cell.get("athenaRole") == "node"]
    overlaps: list[list[str]] = []
    for index, first in enumerate(nodes):
        first_rect = _rect(first)
        if first_rect is None:
            continue
        ax, ay, aw, ah = first_rect
        for second in nodes[index + 1 :]:
            second_rect = _rect(second)
            if second_rect is None:
                continue
            bx, by, bw, bh = second_rect
            if ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by:
                overlaps.append(
                    [first.get("athenaLabel", ""), second.get("athenaLabel", "")]
                )
    result["node_overlaps"] = overlaps

    ids = {cell.get("id") for cell in cells}
    external_urls = result["external_urls"]
    valid = (
        mxfile.tag == "mxfile"
        and mxfile.find("./diagram/mxGraphModel/root") is not None
        and {"0", "1"} <= ids
        and len(nodes) >= 2
        and len(edges) >= 1
        and not external_urls
        and not overlaps
    )
    result["xml_ok"] = valid
    if not valid:
        result["reason"] = "draw.io structural requirements failed"
    return result


def _svg_tag(name: str) -> str:
    return f"{{{SVG_NS}}}{name}"


def _wrap_label(label: str, limit: int = 21) -> tuple[str, ...]:
    words = label.split()
    if len(label) <= limit or len(words) == 1:
        return (label,)
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and len(candidate) > limit:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    if len(lines) <= 2:
        return tuple(lines)
    return (" ".join(lines[:-1]), lines[-1])


def _svg_text(
    parent: ET.Element,
    lines: tuple[str, ...],
    *,
    x: float,
    y: float,
    size: int,
    weight: int = 400,
    color: str = "#1E293B",
    anchor: str = "middle",
) -> ET.Element:
    text = ET.SubElement(
        parent,
        _svg_tag("text"),
        {
            "x": f"{x:g}",
            "y": f"{y:g}",
            "font-family": "Helvetica, Arial, sans-serif",
            "font-size": str(size),
            "font-weight": str(weight),
            "fill": color,
            "text-anchor": anchor,
        },
    )
    line_height = size * 1.18
    start = -((len(lines) - 1) * line_height) / 2
    for index, line in enumerate(lines):
        tspan = ET.SubElement(
            text,
            _svg_tag("tspan"),
            {
                "x": f"{x:g}",
                "dy": f"{start if index == 0 else line_height:g}",
            },
        )
        tspan.text = line
    return text


def _edge_path(
    source: tuple[float, float],
    target: tuple[float, float],
    *,
    node_width: float,
    node_height: float,
    loop_y: float,
    detour: float,
) -> str:
    sx, sy = source
    tx, ty = target
    source_mid_y = sy + node_height / 2
    target_mid_y = ty + node_height / 2
    if tx <= sx and ty > sy + node_height:
        start_x = sx + node_width
        start_y = source_mid_y
        outer_x = start_x + 20
        end_x = tx + node_width / 2
        middle_y = (sy + node_height + ty) / 2
        return (
            f"M {start_x:g} {start_y:g} L {outer_x:g} {start_y:g} "
            f"L {outer_x:g} {middle_y:g} L {end_x:g} {middle_y:g} "
            f"L {end_x:g} {ty:g}"
        )
    if tx <= sx:
        start_x = sx + node_width / 2
        end_x = tx + node_width / 2
        bottom = loop_y + detour
        return (
            f"M {start_x:g} {sy + node_height:g} L {start_x:g} {bottom:g} "
            f"L {end_x:g} {bottom:g} L {end_x:g} {ty + node_height:g}"
        )
    start_x = sx + node_width
    end_x = tx
    if abs(target_mid_y - source_mid_y) < 1 and tx - sx > node_width * 2.2:
        bottom = max(sy, ty) + node_height + 38 + detour
        return (
            f"M {start_x:g} {source_mid_y:g} L {start_x + 24:g} {source_mid_y:g} "
            f"L {start_x + 24:g} {bottom:g} L {end_x - 24:g} {bottom:g} "
            f"L {end_x - 24:g} {target_mid_y:g} L {end_x:g} {target_mid_y:g}"
        )
    middle = (start_x + end_x) / 2
    return (
        f"M {start_x:g} {source_mid_y:g} L {middle:g} {source_mid_y:g} "
        f"L {middle:g} {target_mid_y:g} L {end_x:g} {target_mid_y:g}"
    )


def _native_node_colors(spec: DiagramSpec, label: str) -> tuple[str, str]:
    if label in {
        "Good Outputs",
        "Answer",
        "Decision + Reliability",
        "Preservation Check",
    }:
        return "#F0FDF4", "#16A34A"
    if label in {"Bad Outputs"}:
        return "#FEF2F2", "#DC2626"
    if label in {"Noising", "Reward Model", "Conflictive Aggregation"}:
        return "#FFFBEB", "#D97706"
    return "#FFFFFF", _node_color(spec, label)


def _native_layout(
    spec: DiagramSpec,
) -> tuple[dict[str, tuple[float, float]], float, float]:
    hints = POSITION_HINTS[spec.stem]
    canvas_width, canvas_height = CANVAS_SPECS[spec.stem]
    min_gx = min(x for x, _ in hints.values())
    max_gx = max(x for x, _ in hints.values())
    max_gy = max(y for _, y in hints.values())
    left = max(52.0, canvas_width * 0.045)
    right = canvas_width - left
    usable_width = right - left
    columns = max_gx - min_gx + 1
    node_width = max(86.0, min(168.0, usable_width / columns * 0.86))
    x_step = (
        0.0 if max_gx == min_gx else (usable_width - node_width) / (max_gx - min_gx)
    )

    node_height = 64.0
    area_top = 130.0
    area_height = canvas_height - area_top - 64.0
    if max_gy == 0:
        y_step = 0.0
        y_offset = area_top + (area_height - node_height) / 2
    else:
        max_y_step = 230.0 if canvas_height >= 1000 else 300.0
        y_step = min(max_y_step, (area_height - node_height) / max_gy)
        used_height = max_gy * y_step + node_height
        y_offset = area_top + (area_height - used_height) / 2
    positions = {
        label: (
            left + (gx - min_gx) * x_step,
            y_offset + gy * y_step,
        )
        for label, (gx, gy) in hints.items()
    }
    return positions, node_width, node_height


def _native_group_bounds(
    members: tuple[str, ...],
    positions: dict[str, tuple[float, float]],
    node_width: float,
    node_height: float,
) -> tuple[float, float, float, float]:
    xs = [positions[label][0] for label in members]
    ys = [positions[label][1] for label in members]
    left = min(xs) - 18
    top = min(ys) - 38
    right = max(xs) + node_width + 18
    bottom = max(ys) + node_height + 22
    return left, top, right - left, bottom - top


def build_native_svg(spec: DiagramSpec) -> str:
    """Render a publication-style SVG from the same spec and layout as draw.io."""
    positions, node_width, node_height = _native_layout(spec)
    backward_edges = [
        edge
        for edge in spec.edges
        if positions[edge.target][0] <= positions[edge.source][0]
    ]
    node_bottom = max(y for _, y in positions.values()) + node_height
    width, height = CANVAS_SPECS[spec.stem]
    loop_base = min(height - 70, node_bottom + 80)

    svg = ET.Element(
        _svg_tag("svg"),
        {
            "width": str(width),
            "height": str(height),
            "viewBox": f"0 0 {width} {height}",
            "role": "img",
            "aria-label": spec.title,
        },
    )
    defs = ET.SubElement(svg, _svg_tag("defs"))
    marker = ET.SubElement(
        defs,
        _svg_tag("marker"),
        {
            "id": "arrow",
            "viewBox": "0 0 10 10",
            "refX": "9",
            "refY": "5",
            "markerWidth": "7",
            "markerHeight": "7",
            "orient": "auto-start-reverse",
        },
    )
    ET.SubElement(
        marker, _svg_tag("path"), {"d": "M 0 0 L 10 5 L 0 10 z", "fill": "#2563EB"}
    )
    filter_node = ET.SubElement(
        defs,
        _svg_tag("filter"),
        {
            "id": "soft-shadow",
            "x": "-10%",
            "y": "-10%",
            "width": "120%",
            "height": "130%",
        },
    )
    ET.SubElement(
        filter_node,
        _svg_tag("feDropShadow"),
        {
            "dx": "0",
            "dy": "1",
            "stdDeviation": "1.2",
            "flood-color": "#0F172A",
            "flood-opacity": "0.09",
        },
    )
    ET.SubElement(
        svg, _svg_tag("rect"), {"width": "100%", "height": "100%", "fill": "#FFFFFF"}
    )

    annotation_targets = {
        target.strip()
        for annotation in spec.annotations
        for target, separator, _ in [annotation.partition(":")]
        if separator and target.strip() in positions
    }

    for index, group in enumerate(spec.groups):
        x, y, group_width, group_height = _native_group_bounds(
            group.members, positions, node_width, node_height
        )
        note_bottoms = [
            positions[target][1] + node_height + 10 + 32 + 16
            for target in group.members
            if target in annotation_targets
        ]
        if note_bottoms:
            group_height = max(group_height, max(note_bottoms) - y)
        ET.SubElement(
            svg,
            _svg_tag("rect"),
            {
                "x": f"{x:g}",
                "y": f"{y:g}",
                "width": f"{group_width:g}",
                "height": f"{group_height:g}",
                "rx": "14",
                "fill": GROUP_COLORS[index % len(GROUP_COLORS)],
                "fill-opacity": "0.32",
                "stroke": GROUP_STROKES[index % len(GROUP_STROKES)],
                "stroke-width": "1.3",
                "stroke-dasharray": "7 6",
                "data-role": "group",
                "data-label": group.label,
            },
        )
        _svg_text(
            svg,
            (group.label,),
            x=x + 14,
            y=y + 22,
            size=13,
            weight=600,
            color="#334155",
            anchor="start",
        )

    _svg_text(
        svg,
        (spec.title,),
        x=MARGIN_X - 24,
        y=46,
        size=20,
        weight=700,
        color="#0F172A",
        anchor="start",
    )
    ET.SubElement(
        svg,
        _svg_tag("line"),
        {
            "x1": f"{MARGIN_X - 24:g}",
            "y1": "66",
            "x2": f"{min(width - 54, MARGIN_X + 116):g}",
            "y2": "66",
            "stroke": "#2563EB",
            "stroke-width": "3",
            "stroke-linecap": "round",
        },
    )

    backward_index = 0
    for index, edge in enumerate(spec.edges):
        is_backward = positions[edge.target][0] <= positions[edge.source][0]
        detour = backward_index * 18 if is_backward else index * 1.5
        if is_backward:
            backward_index += 1
        ET.SubElement(
            svg,
            _svg_tag("path"),
            {
                "d": _edge_path(
                    positions[edge.source],
                    positions[edge.target],
                    node_width=node_width,
                    node_height=node_height,
                    loop_y=loop_base,
                    detour=detour,
                ),
                "fill": "none",
                "stroke": "#2563EB",
                "stroke-width": "2.1",
                "stroke-linecap": "round",
                "stroke-linejoin": "round",
                "marker-end": "url(#arrow)",
            },
        )

    for node in spec.nodes:
        x, y = positions[node.label]
        fill, stroke = _native_node_colors(spec, node.label)
        ET.SubElement(
            svg,
            _svg_tag("rect"),
            {
                "x": f"{x:g}",
                "y": f"{y:g}",
                "width": f"{node_width:g}",
                "height": f"{node_height:g}",
                "rx": "11",
                "fill": fill,
                "stroke": stroke,
                "stroke-width": "1.8",
                "filter": "url(#soft-shadow)",
            },
        )
        lines = _wrap_label(node.label, max(10, int(node_width / 7.2)))
        label_y = y + (29 if len(lines) == 1 else 26)
        _svg_text(
            svg,
            lines,
            x=x + node_width / 2,
            y=label_y,
            size=11 if node_width < 105 else 12,
            weight=600,
        )
        badge = ICON_BADGES.get(node.icon, node.icon.upper()[:8])
        badge_width = min(node_width - 12, max(30, 6 * len(badge) + 12))
        ET.SubElement(
            svg,
            _svg_tag("rect"),
            {
                "x": f"{x + (node_width - badge_width) / 2:g}",
                "y": f"{y + node_height - 21:g}",
                "width": f"{badge_width:g}",
                "height": "15",
                "rx": "7.5",
                "fill": "#F1F5F9",
            },
        )
        _svg_text(
            svg,
            (badge,),
            x=x + node_width / 2,
            y=y + node_height - 10,
            size=7,
            weight=600,
            color="#64748B",
        )

    for annotation in spec.annotations:
        target, separator, detail = annotation.partition(":")
        if not separator or target.strip() not in positions:
            continue
        x, y = positions[target.strip()]
        note_y = y + node_height + 10
        ET.SubElement(
            svg,
            _svg_tag("rect"),
            {
                "x": f"{x:g}",
                "y": f"{note_y:g}",
                "width": f"{node_width:g}",
                "height": "32",
                "rx": "8",
                "fill": "#F8FAFC",
                "stroke": "#CBD5E1",
                "stroke-width": "1",
                "stroke-dasharray": "4 4",
                "data-role": "annotation",
                "data-target": target.strip(),
            },
        )
        _svg_text(
            svg,
            _wrap_label(detail.strip(), max(12, int(node_width / 6.5))),
            x=x + node_width / 2,
            y=note_y + 19,
            size=8,
            color="#475569",
        )

    ET.indent(svg, space="  ")
    return ET.tostring(svg, encoding="unicode", xml_declaration=False)


def _tool_result_text(result: Any) -> tuple[str, bool]:
    dumped = result.model_dump() if hasattr(result, "model_dump") else result
    if not isinstance(dumped, dict):
        return "", True
    text = ""
    for block in dumped.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text = str(block.get("text", ""))
            break
    return text, bool(dumped.get("isError", False))


async def search_shapes(keywords: tuple[str, ...]) -> dict[str, object]:
    """Search native draw.io shapes directly through hosted MCP."""
    last_error: str | None = None
    for attempt in range(3):
        try:
            found: dict[str, list[dict[str, str]]] = {}
            async with streamablehttp_client(DRAWIO_MCP_URL) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    for keyword in keywords:
                        result = await session.call_tool(
                            "search_shapes", {"query": keyword, "limit": 4}
                        )
                        text, is_error = _tool_result_text(result)
                        if is_error:
                            raise RuntimeError(
                                text or f"search_shapes failed for {keyword}"
                            )
                        payload = json.loads(text) if text else []
                        found[keyword] = [
                            {
                                "title": str(item.get("title", "")),
                                "style": str(item.get("style", "")),
                            }
                            for item in payload[:4]
                            if isinstance(item, dict)
                        ]
            return {"ok": True, "shapes": found, "error": None}
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:  # MCP transports may raise ExceptionGroup.
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < 2:
                await asyncio.sleep(2.0 * (attempt + 1))
    return {"ok": False, "shapes": {}, "error": last_error}


async def create_diagram(xml: str) -> dict[str, object]:
    """Validate and echo draw.io XML through hosted MCP create_diagram."""
    last_error: str | None = None
    for attempt in range(3):
        try:
            async with streamablehttp_client(DRAWIO_MCP_URL) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool("create_diagram", {"xml": xml})
            text, is_error = _tool_result_text(result)
            payload = json.loads(text) if text else {}
            echoed = payload.get("xml") if isinstance(payload, dict) else None
            build_id = payload.get("_buildId") if isinstance(payload, dict) else None
            ok = not is_error and isinstance(echoed, str) and bool(echoed)
            return {
                "ok": ok,
                "xml": echoed if isinstance(echoed, str) else None,
                "build_id": build_id,
                "error": None if ok else text or "create_diagram returned no XML",
            }
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:  # MCP transports may raise ExceptionGroup.
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < 2:
                await asyncio.sleep(2.0 * (attempt + 1))
    return {"ok": False, "xml": None, "build_id": None, "error": last_error}


def validate_export_file(
    path: Path, fmt: str, *, expected_ratio: float | None = None
) -> dict[str, object]:
    """Check an exported file's signature and parseable structure."""
    result: dict[str, object] = {
        "ok": False,
        "file": path.name,
        "bytes": path.stat().st_size if path.exists() else 0,
        "dimensions": None,
        "page_points": None,
        "error": None,
    }
    if not path.exists() or path.stat().st_size == 0:
        result["error"] = "missing or empty file"
        return result
    try:
        if fmt == "png":
            data = path.read_bytes()
            if (
                len(data) < 24
                or data[:8] != b"\x89PNG\r\n\x1a\n"
                or data[12:16] != b"IHDR"
            ):
                raise ValueError("invalid PNG signature or IHDR")
            width = int.from_bytes(data[16:20], "big")
            height = int.from_bytes(data[20:24], "big")
            if width <= 0 or height <= 0:
                raise ValueError("invalid PNG dimensions")
            result["dimensions"] = [width, height]
        elif fmt == "svg":
            root = ET.parse(path).getroot()
            if not root.tag.endswith("svg"):
                raise ValueError("root is not svg")
        elif fmt == "pdf":
            data = path.read_bytes()
            if not data.startswith(b"%PDF-"):
                raise ValueError("invalid PDF signature")
            media_box = re.search(
                rb"/MediaBox\s*\[\s*0(?:\.0+)?\s+0(?:\.0+)?\s+"
                rb"([0-9.]+)\s+([0-9.]+)\s*\]",
                data,
            )
            if media_box is None:
                raise ValueError("PDF MediaBox missing")
            page_width = round(float(media_box.group(1)), 2)
            page_height = round(float(media_box.group(2)), 2)
            result["page_points"] = [page_width, page_height]
            actual_ratio = page_width / page_height
            if expected_ratio is not None and abs(actual_ratio - expected_ratio) > 0.02:
                raise ValueError(
                    "PDF aspect ratio does not match SVG: "
                    f"{actual_ratio:.3f} != {expected_ratio:.3f}"
                )
        else:
            raise ValueError(f"unsupported format: {fmt}")
    except (OSError, ET.ParseError, ValueError) as exc:
        result["error"] = str(exc)
        return result
    result["ok"] = True
    return result


def export_drawio(path: Path, drawio_cli: Path) -> dict[str, object]:
    """Export one draw.io file to PNG, SVG, and PDF with local Draw.io."""
    formats: dict[str, dict[str, object]] = {}
    files: dict[str, str | None] = {}
    try:
        cli_exists = drawio_cli.exists()
    except OSError as exc:
        return {
            "ok": False,
            "files": {fmt: None for fmt in ("png", "svg", "pdf")},
            "formats": {},
            "error": f"{type(exc).__name__}: {exc}",
        }
    if not cli_exists:
        return {
            "ok": False,
            "files": {fmt: None for fmt in ("png", "svg", "pdf")},
            "formats": {},
            "error": f"Draw.io CLI missing: {drawio_cli}",
        }
    for fmt in ("png", "svg", "pdf"):
        target = path.with_suffix(f".{fmt}")
        try:
            command = [
                str(drawio_cli),
                "--export",
                "--format",
                fmt,
                "--embed-diagram",
            ]
            if fmt == "png":
                command.extend(["--scale", "2"])
            command.extend(["--output", str(target), str(path)])
            process = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            check = validate_export_file(target, fmt)
            check.update(
                {
                    "returncode": process.returncode,
                    "stdout": process.stdout[-1000:],
                    "stderr": process.stderr[-1000:],
                }
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            check = {
                "ok": False,
                "file": target.name,
                "bytes": 0,
                "dimensions": None,
                "returncode": None,
                "stdout": "",
                "stderr": "",
                "error": f"{type(exc).__name__}: {exc}",
            }
        formats[fmt] = check
        files[fmt] = target.name if check["ok"] else None
    return {
        "ok": all(bool(check["ok"]) for check in formats.values()),
        "backend": "drawio-desktop",
        "files": files,
        "formats": formats,
        "error": None,
    }


def export_native(
    spec: DiagramSpec, drawio_path: Path, chrome: Path = DEFAULT_CHROME
) -> dict[str, object]:
    """Export native SVG and convert it to 2x PNG and vector PDF with Chrome."""
    drawio_path = drawio_path.resolve()
    svg_path = drawio_path.with_suffix(".svg")
    png_path = drawio_path.with_suffix(".png")
    pdf_path = drawio_path.with_suffix(".pdf")
    svg = build_native_svg(spec)
    svg_path.write_text(svg + "\n", encoding="utf-8")
    svg_root = ET.fromstring(svg)
    width = int(float(svg_root.get("width", "1200")))
    height = int(float(svg_root.get("height", "800")))
    formats: dict[str, dict[str, object]] = {
        "svg": validate_export_file(svg_path, "svg")
    }
    files: dict[str, str | None] = {"svg": svg_path.name, "png": None, "pdf": None}
    try:
        chrome_exists = chrome.exists()
    except OSError as exc:
        return {
            "ok": False,
            "backend": "native-svg-chrome",
            "files": files,
            "formats": formats,
            "error": f"{type(exc).__name__}: {exc}",
        }
    if not chrome_exists:
        return {
            "ok": False,
            "backend": "native-svg-chrome",
            "files": files,
            "formats": formats,
            "error": f"Chrome missing: {chrome}",
        }

    profile_dir = drawio_path.parent / f".chrome-{spec.stem}"
    html_path = drawio_path.parent / f".{spec.stem}.print.html"
    html_path.write_text(
        (
            '<!doctype html><html><head><meta charset="utf-8"><style>'
            f"@page{{size:{width}px {height}px;margin:0}}"
            "html,body{margin:0;padding:0;background:#fff;width:100%;height:100%}"
            "svg{display:block;width:100%;height:100%}"
            f"</style></head><body>{svg}</body></html>"
        ),
        encoding="utf-8",
    )
    common = [
        str(chrome),
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        f"--user-data-dir={profile_dir}",
    ]
    commands = {
        "png": common
        + [
            "--force-device-scale-factor=2",
            f"--window-size={width},{height}",
            "--run-all-compositor-stages-before-draw",
            f"--screenshot={png_path}",
            svg_path.as_uri(),
        ],
        "pdf": common
        + [
            "--no-pdf-header-footer",
            f"--print-to-pdf={pdf_path}",
            html_path.as_uri(),
        ],
    }
    try:
        for fmt, command in commands.items():
            target = png_path if fmt == "png" else pdf_path
            try:
                process = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=90,
                    check=False,
                )
                check = validate_export_file(
                    target,
                    fmt,
                    expected_ratio=(width / height if fmt == "pdf" else None),
                )
                check.update(
                    {
                        "returncode": process.returncode,
                        "stdout": process.stdout[-1000:],
                        "stderr": process.stderr[-1000:],
                    }
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                check = {
                    "ok": False,
                    "file": target.name,
                    "bytes": 0,
                    "dimensions": None,
                    "returncode": None,
                    "stdout": "",
                    "stderr": "",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            formats[fmt] = check
            files[fmt] = target.name if check["ok"] else None
    finally:
        html_path.unlink(missing_ok=True)
        shutil.rmtree(profile_dir, ignore_errors=True)
    ok = all(bool(formats[fmt]["ok"]) for fmt in ("png", "svg", "pdf"))
    return {
        "ok": ok,
        "backend": "native-svg-chrome",
        "files": files,
        "formats": formats,
        "error": None if ok else "native SVG conversion failed",
    }


def _write_json(path: Path, payload: object) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


async def run_pipeline(
    inputs_dir: Path,
    outputs_dir: Path,
    drawio_cli: Path,
    export_backend: str = "auto",
    only_stems: set[str] | None = None,
) -> dict[str, object]:
    """Generate all diagrams independently and return a summary report."""
    outputs_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, object]] = []
    prompt_paths = sorted(inputs_dir.glob("*.md"))
    if only_stems is not None:
        prompt_paths = [path for path in prompt_paths if path.stem in only_stems]
    for prompt_path in prompt_paths:
        stem = prompt_path.stem
        record: dict[str, object] = {"stem": stem, "prompt": prompt_path.name}
        try:
            spec = parse_prompt(prompt_path.read_text(encoding="utf-8"), stem)
            keywords = tuple(dict.fromkeys(node.icon for node in spec.nodes))
            shape_search = await search_shapes(keywords[:1])
            if "ok" in shape_search:
                await asyncio.sleep(1.5)
            shape_payload = shape_search.get("shapes", shape_search)
            if not isinstance(shape_payload, dict):
                shape_payload = {}
            xml = build_drawio_xml(spec, shape_payload)
            precheck = validate_drawio_xml(xml)
            if not precheck["xml_ok"]:
                raise ValueError(f"pre-MCP XML validation failed: {precheck}")

            mcp = await create_diagram(xml)
            echoed = mcp.get("xml")
            final_xml = echoed if isinstance(echoed, str) and echoed else xml
            final_check = validate_drawio_xml(final_xml)
            drawio_path = outputs_dir / f"{stem}.drawio"
            drawio_path.write_text(final_xml + "\n", encoding="utf-8")
            mcp_evidence = {
                "ok": bool(mcp.get("ok")),
                "build_id": mcp.get("build_id"),
                "error": mcp.get("error"),
                "shape_search": shape_search,
            }
            if export_backend == "native":
                export = export_native(spec, drawio_path)
            else:
                try:
                    export = export_drawio(drawio_path, drawio_cli)
                except (KeyboardInterrupt, SystemExit):
                    raise
                except BaseException as exc:
                    export = {
                        "ok": False,
                        "files": {fmt: None for fmt in ("png", "svg", "pdf")},
                        "formats": {},
                        "error": f"{type(exc).__name__}: {exc}",
                    }
            if export_backend == "auto" and not export.get("ok"):
                desktop_error = export.get("error")
                export = export_native(spec, drawio_path)
                export["fallback_from"] = desktop_error
            check_evidence = {
                "xml": final_check,
                "export": export,
            }
            _write_json(outputs_dir / f"{stem}.mcp.json", mcp_evidence)
            _write_json(outputs_dir / f"{stem}.check.json", check_evidence)
            status = (
                "PASS"
                if final_check["xml_ok"] and mcp_evidence["ok"] and export["ok"]
                else "FAIL"
            )
            record.update(
                {
                    "title": spec.title,
                    "status": status,
                    "drawio": drawio_path.name,
                    "mcp": mcp_evidence,
                    "check": final_check,
                    "export": export,
                }
            )
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            error = f"{type(exc).__name__}: {exc}"
            record.update(
                {
                    "status": "FAIL",
                    "mcp": {"ok": False, "build_id": None, "error": error},
                    "check": {"xml_ok": False, "reason": error},
                    "export": {"ok": False, "error": "not attempted"},
                }
            )
            _write_json(outputs_dir / f"{stem}.mcp.json", record["mcp"])
            _write_json(outputs_dir / f"{stem}.check.json", record["check"])
        records.append(record)

    passed = sum(record.get("status") == "PASS" for record in records)
    mcp_passed = sum(bool(record.get("mcp", {}).get("ok")) for record in records)
    return {
        "total": len(records),
        "passed": passed,
        "failed": len(records) - passed,
        "mcp_passed": mcp_passed,
        "files": records,
    }


def merge_reports(
    existing: dict[str, object], retried: dict[str, object]
) -> dict[str, object]:
    """Replace retried records while preserving the original report order."""
    replacements = {
        item["stem"]: item
        for item in retried.get("files", [])
        if isinstance(item, dict) and "stem" in item
    }
    files: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in existing.get("files", []):
        if not isinstance(item, dict) or "stem" not in item:
            continue
        stem = str(item["stem"])
        files.append(replacements.get(stem, item))
        seen.add(stem)
    files.extend(item for stem, item in replacements.items() if stem not in seen)
    passed = sum(item.get("status") == "PASS" for item in files)
    mcp_passed = sum(bool(item.get("mcp", {}).get("ok")) for item in files)
    return {
        "total": len(files),
        "passed": passed,
        "failed": len(files) - passed,
        "mcp_passed": mcp_passed,
        "files": files,
    }


def verify_outputs(inputs_dir: Path, outputs_dir: Path) -> dict[str, object]:
    """Verify all expected artifacts without calling MCP or Draw.io again."""
    records: list[dict[str, object]] = []
    required = ("drawio", "png", "svg", "pdf", "mcp.json", "check.json")
    for prompt in sorted(inputs_dir.glob("*.md")):
        stem = prompt.stem
        missing = [
            suffix
            for suffix in required
            if not (outputs_dir / f"{stem}.{suffix}").exists()
        ]
        xml_check = {"xml_ok": False, "reason": "missing drawio"}
        if not missing and (outputs_dir / f"{stem}.drawio").exists():
            xml_check = validate_drawio_xml(
                (outputs_dir / f"{stem}.drawio").read_text(encoding="utf-8")
            )
        canvas_width, canvas_height = CANVAS_SPECS[stem]
        exports = {
            "png": validate_export_file(outputs_dir / f"{stem}.png", "png"),
            "svg": validate_export_file(outputs_dir / f"{stem}.svg", "svg"),
            "pdf": validate_export_file(
                outputs_dir / f"{stem}.pdf",
                "pdf",
                expected_ratio=canvas_width / canvas_height,
            ),
        }
        if exports["png"].get("dimensions") != [
            canvas_width * 2,
            canvas_height * 2,
        ]:
            exports["png"]["ok"] = False
            exports["png"]["error"] = "PNG dimensions do not match 2x canvas"
        mcp_ok = False
        mcp_path = outputs_dir / f"{stem}.mcp.json"
        if mcp_path.exists():
            try:
                mcp_ok = bool(
                    json.loads(mcp_path.read_text(encoding="utf-8")).get("ok")
                )
            except (OSError, json.JSONDecodeError):
                mcp_ok = False
        ok = (
            not missing
            and bool(xml_check["xml_ok"])
            and mcp_ok
            and all(item["ok"] for item in exports.values())
        )
        records.append(
            {
                "stem": stem,
                "ok": ok,
                "missing": missing,
                "xml": xml_check,
                "mcp_ok": mcp_ok,
                "exports": exports,
            }
        )
    passed = sum(record["ok"] for record in records)
    return {
        "total": len(records),
        "passed": passed,
        "failed": len(records) - passed,
        "files": records,
    }


def _resolve_inside_base(value: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = BASE_DIR / candidate
    resolved = candidate.resolve()
    if resolved != BASE_DIR and BASE_DIR not in resolved.parents:
        raise ValueError(f"path must stay inside {BASE_DIR}: {value}")
    return resolved


def _write_failures(report: dict[str, object], failures_path: Path) -> None:
    failed = [item for item in report.get("files", []) if item.get("status") != "PASS"]
    if not failed:
        failures_path.unlink(missing_ok=True)
        return
    lines = ["# Generation Failures", ""]
    for item in failed:
        lines.extend(
            [
                f"## {item.get('stem', 'unknown')}",
                "",
                f"- MCP: {item.get('mcp', {}).get('error')}",
                f"- XML: {item.get('check', {}).get('reason')}",
                f"- Export: {item.get('export', {}).get('error')}",
                "",
            ]
        )
    failures_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", default="inputs")
    parser.add_argument("--outputs", default="outputs")
    parser.add_argument("--report", default="report.json")
    parser.add_argument("--drawio-cli", default=str(DEFAULT_DRAWIO_CLI))
    parser.add_argument(
        "--export-backend",
        choices=("auto", "desktop", "native"),
        default="native",
    )
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    args = parser.parse_args()

    try:
        inputs_dir = _resolve_inside_base(args.inputs)
        outputs_dir = _resolve_inside_base(args.outputs)
        report_path = _resolve_inside_base(args.report)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2

    if args.verify_only:
        report = verify_outputs(inputs_dir, outputs_dir)
        print(
            f"verify total={report['total']} passed={report['passed']} failed={report['failed']}"
        )
        return 0 if report["total"] == 10 and report["failed"] == 0 else 1

    if args.retry_failed:
        if not report_path.exists():
            print(
                f"cannot retry without an existing report: {report_path}",
                file=sys.stderr,
            )
            return 2
        try:
            existing_report = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"cannot read existing report: {exc}", file=sys.stderr)
            return 2
        failed_stems = {
            str(item.get("stem"))
            for item in existing_report.get("files", [])
            if item.get("status") != "PASS" and item.get("stem")
        }
        if failed_stems:
            retried = asyncio.run(
                run_pipeline(
                    inputs_dir,
                    outputs_dir,
                    Path(args.drawio_cli),
                    export_backend=args.export_backend,
                    only_stems=failed_stems,
                )
            )
            report = merge_reports(existing_report, retried)
        else:
            report = existing_report
    else:
        report = asyncio.run(
            run_pipeline(
                inputs_dir,
                outputs_dir,
                Path(args.drawio_cli),
                export_backend=args.export_backend,
            )
        )
    _write_json(report_path, report)
    _write_failures(report, BASE_DIR / "FAILURES.md")
    print(
        f"total={report['total']} passed={report['passed']} failed={report['failed']} "
        f"mcp_passed={report['mcp_passed']}"
    )
    return 0 if report["total"] == 10 and report["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
