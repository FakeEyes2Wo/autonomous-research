from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import AsyncMock

CODEX_GEN = Path(__file__).resolve().parents[1]
INPUTS = CODEX_GEN / "inputs"
TEST_OUTPUTS = CODEX_GEN / "tests" / "_outputs"
sys.path.insert(0, str(CODEX_GEN))

import generate  # noqa: E402


class PromptParserTests(unittest.TestCase):
    def test_parse_first_prompt(self) -> None:
        parser = getattr(generate, "parse_prompt", None)
        self.assertIsNotNone(parser, "parse_prompt must be implemented")
        text = (INPUTS / "01-candidate-to-paper-pipeline.md").read_text(
            encoding="utf-8"
        )
        spec = parser(text, "01-candidate-to-paper-pipeline")
        self.assertEqual(spec.title, "Candidate-to-Paper Autonomous Research Pipeline")
        self.assertEqual(len(spec.nodes), 10)
        self.assertEqual(len(spec.edges), 9)
        self.assertEqual(len(spec.groups), 2)

    def test_all_inputs_reference_known_nodes(self) -> None:
        parser = getattr(generate, "parse_prompt", None)
        self.assertIsNotNone(parser, "parse_prompt must be implemented")
        self.assertEqual(len(list(INPUTS.glob("*.md"))), 10)
        for path in sorted(INPUTS.glob("*.md")):
            spec = parser(path.read_text(encoding="utf-8"), path.stem)
            names = {node.label for node in spec.nodes}
            self.assertTrue(
                all(
                    edge.source in names and edge.target in names for edge in spec.edges
                ),
                path.name,
            )
            self.assertTrue(
                all(set(group.members) <= names for group in spec.groups),
                path.name,
            )

    def test_rejects_dangling_edge(self) -> None:
        parser = getattr(generate, "parse_prompt", None)
        self.assertIsNotNone(parser, "parse_prompt must be implemented")
        text = """---
title: "Broken"
nodes:
  - "Known|box"
edges:
  - "Known -> Missing"
groups:
annotations:
---
Broken body.
"""
        with self.assertRaisesRegex(ValueError, "unknown node"):
            parser(text, "broken")


class DrawioXmlTests(unittest.TestCase):
    def test_all_specs_build_valid_editable_xml(self) -> None:
        builder = getattr(generate, "build_drawio_xml", None)
        validator = getattr(generate, "validate_drawio_xml", None)
        self.assertIsNotNone(builder, "build_drawio_xml must be implemented")
        self.assertIsNotNone(validator, "validate_drawio_xml must be implemented")
        for path in sorted(INPUTS.glob("*.md")):
            spec = generate.parse_prompt(path.read_text(encoding="utf-8"), path.stem)
            xml = builder(spec, {})
            check = validator(xml)
            self.assertTrue(check["xml_ok"], (path.name, check))
            self.assertEqual(check["external_urls"], [], path.name)
            self.assertGreaterEqual(check["vertices"], len(spec.nodes), path.name)
            self.assertEqual(check["edges"], len(spec.edges), path.name)
            self.assertGreaterEqual(
                check["editable_labels"], len(spec.nodes) + 1, path.name
            )

    def test_layout_has_no_node_overlap(self) -> None:
        builder = getattr(generate, "build_drawio_xml", None)
        validator = getattr(generate, "validate_drawio_xml", None)
        self.assertIsNotNone(builder, "build_drawio_xml must be implemented")
        self.assertIsNotNone(validator, "validate_drawio_xml must be implemented")
        for path in sorted(INPUTS.glob("*.md")):
            spec = generate.parse_prompt(path.read_text(encoding="utf-8"), path.stem)
            check = validator(builder(spec, {}))
            self.assertEqual(check["node_overlaps"], [], path.name)

    def test_layout_hints_cover_each_node_once(self) -> None:
        layouts = getattr(generate, "LAYOUT_ROWS", None)
        self.assertIsNotNone(layouts, "LAYOUT_ROWS must be implemented")
        for path in sorted(INPUTS.glob("*.md")):
            spec = generate.parse_prompt(path.read_text(encoding="utf-8"), path.stem)
            laid_out = [label for row in layouts[path.stem] for label in row]
            self.assertCountEqual(laid_out, [node.label for node in spec.nodes])
            self.assertEqual(len(laid_out), len(set(laid_out)), path.name)

    def test_all_diagrams_use_publication_typography(self) -> None:
        for path in sorted(INPUTS.glob("*.md")):
            spec = generate.parse_prompt(path.read_text(encoding="utf-8"), path.stem)
            xml = generate.build_drawio_xml(spec, {})
            self.assertIn("fontFamily=Helvetica", xml, path.name)

    def test_native_svg_is_publication_ready(self) -> None:
        builder = getattr(generate, "build_native_svg", None)
        self.assertIsNotNone(builder, "build_native_svg must be implemented")
        path = INPUTS / "09-finetuning-influence-flow.md"
        spec = generate.parse_prompt(path.read_text(encoding="utf-8"), path.stem)
        svg = builder(spec)
        root = generate.ET.fromstring(svg)
        self.assertTrue(root.tag.endswith("svg"))
        self.assertIn("Helvetica", svg)
        self.assertIn("marker-end", svg)
        self.assertIn("Good Outputs", svg)
        self.assertIn("Bad Outputs", svg)
        self.assertNotIn("<image", svg)

    def test_all_native_canvases_use_approved_aspect_ratios(self) -> None:
        canvas_specs = getattr(generate, "CANVAS_SPECS", None)
        self.assertIsNotNone(canvas_specs, "CANVAS_SPECS must be implemented")
        approved = {round(16 / 9, 3), round(3 / 2, 3), round(4 / 3, 3), round(4 / 5, 3)}
        for path in sorted(INPUTS.glob("*.md")):
            spec = generate.parse_prompt(path.read_text(encoding="utf-8"), path.stem)
            root = generate.ET.fromstring(generate.build_native_svg(spec))
            width, height = canvas_specs[path.stem]
            self.assertEqual(root.get("width"), str(width), path.name)
            self.assertEqual(root.get("height"), str(height), path.name)
            self.assertIn(round(width / height, 3), approved, path.name)

    def test_multilevel_layouts_use_the_vertical_canvas(self) -> None:
        for path in sorted(INPUTS.glob("*.md")):
            spec = generate.parse_prompt(path.read_text(encoding="utf-8"), path.stem)
            positions, _, _ = generate._native_layout(spec)
            ys = [y for _, y in positions.values()]
            if max(ys) == min(ys):
                continue
            _, height = generate.CANVAS_SPECS[path.stem]
            self.assertGreaterEqual(
                (max(ys) - min(ys)) / height,
                0.40,
                f"{path.name} leaves too much unused vertical space",
            )

    def test_cross_row_transition_routes_from_node_side(self) -> None:
        path = INPUTS / "01-candidate-to-paper-pipeline.md"
        spec = generate.parse_prompt(path.read_text(encoding="utf-8"), path.stem)
        positions, node_width, node_height = generate._native_layout(spec)
        route = generate._edge_path(
            positions["Experiment"],
            positions["Evidence"],
            node_width=node_width,
            node_height=node_height,
            loop_y=700,
            detour=0,
        )
        expected_start = positions["Experiment"][0] + node_width
        self.assertTrue(route.startswith(f"M {expected_start:g} "), route)

    def test_group_container_includes_its_annotation(self) -> None:
        path = INPUTS / "01-candidate-to-paper-pipeline.md"
        spec = generate.parse_prompt(path.read_text(encoding="utf-8"), path.stem)
        root = generate.ET.fromstring(generate.build_native_svg(spec))
        rects = list(root.iter(f"{{{generate.SVG_NS}}}rect"))
        group = next(
            rect
            for rect in rects
            if rect.get("data-role") == "group"
            and rect.get("data-label") == "Idea & Experiment"
        )
        note = next(
            rect
            for rect in rects
            if rect.get("data-role") == "annotation"
            and rect.get("data-target") == "Experiment"
        )
        self.assertLessEqual(
            float(note.get("y")) + float(note.get("height")),
            float(group.get("y")) + float(group.get("height")),
        )


class ExportValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        TEST_OUTPUTS.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(TEST_OUTPUTS, ignore_errors=True)

    def test_validates_png_svg_and_pdf_signatures(self) -> None:
        validator = getattr(generate, "validate_export_file", None)
        self.assertIsNotNone(validator, "validate_export_file must be implemented")
        png = TEST_OUTPUTS / "sample.png"
        svg = TEST_OUTPUTS / "sample.svg"
        pdf = TEST_OUTPUTS / "sample.pdf"
        png.write_bytes(
            b"\x89PNG\r\n\x1a\n"
            + b"\x00\x00\x00\rIHDR"
            + (640).to_bytes(4, "big")
            + (360).to_bytes(4, "big")
            + b"\x08\x06\x00\x00\x00"
            + b"\x00\x00\x00\x00"
        )
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>', encoding="utf-8")
        pdf.write_bytes(b"%PDF-1.7\n1 0 obj<</MediaBox [0 0 900 600]>>endobj\n")
        self.assertEqual(validator(png, "png")["dimensions"], [640, 360])
        self.assertTrue(validator(svg, "svg")["ok"])
        pdf_check = validator(pdf, "pdf", expected_ratio=1.5)
        self.assertTrue(pdf_check["ok"])
        self.assertEqual(pdf_check["page_points"], [900.0, 600.0])

    def test_rejects_pdf_with_wrong_aspect_ratio(self) -> None:
        validator = getattr(generate, "validate_export_file", None)
        self.assertIsNotNone(validator, "validate_export_file must be implemented")
        pdf = TEST_OUTPUTS / "wide.pdf"
        pdf.write_bytes(b"%PDF-1.7\n1 0 obj<</MediaBox [0 0 1800 500]>>endobj\n")
        result = validator(pdf, "pdf", expected_ratio=1.5)
        self.assertFalse(result["ok"])
        self.assertIn("aspect ratio", result["error"])

    def test_export_handles_cli_stat_permission_error(self) -> None:
        exporter = getattr(generate, "export_drawio", None)
        self.assertIsNotNone(exporter, "export_drawio must be implemented")
        source = TEST_OUTPUTS / "sample.drawio"
        source.write_text("<mxfile/>", encoding="utf-8")
        with mock.patch.object(Path, "exists", side_effect=PermissionError("blocked")):
            result = exporter(source, Path("blocked-drawio.exe"))
        self.assertFalse(result["ok"])
        self.assertIn("PermissionError", result["error"])

    def test_png_export_uses_two_x_scale(self) -> None:
        exporter = getattr(generate, "export_drawio", None)
        self.assertIsNotNone(exporter, "export_drawio must be implemented")
        source = TEST_OUTPUTS / "sample.drawio"
        executable = TEST_OUTPUTS / "DrawIO.exe"
        source.write_text("<mxfile/>", encoding="utf-8")
        executable.write_bytes(b"exe")
        completed = subprocess.CompletedProcess([], 0, "", "")
        with (
            mock.patch.object(
                generate.subprocess, "run", return_value=completed
            ) as runner,
            mock.patch.object(
                generate,
                "validate_export_file",
                return_value={"ok": True, "error": None},
            ),
        ):
            result = exporter(source, executable)
        self.assertTrue(result["ok"])
        png_command = runner.call_args_list[0].args[0]
        self.assertIn("--scale", png_command)
        self.assertEqual(png_command[png_command.index("--scale") + 1], "2")

    def test_native_export_accepts_relative_output_path(self) -> None:
        exporter = getattr(generate, "export_native", None)
        self.assertIsNotNone(exporter, "export_native must be implemented")
        prompt = INPUTS / "01-candidate-to-paper-pipeline.md"
        spec = generate.parse_prompt(prompt.read_text(encoding="utf-8"), prompt.stem)
        relative_source = Path("codex_gen/tests/_outputs/sample.drawio")
        relative_source.write_text("<mxfile/>", encoding="utf-8")
        executable = TEST_OUTPUTS / "chrome.exe"
        executable.write_bytes(b"exe")
        completed = subprocess.CompletedProcess([], 0, "", "")
        with (
            mock.patch.object(generate.subprocess, "run", return_value=completed),
            mock.patch.object(
                generate,
                "validate_export_file",
                return_value={"ok": True, "error": None},
            ),
        ):
            result = exporter(spec, relative_source, executable)
        self.assertTrue(result["ok"])


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        shutil.rmtree(TEST_OUTPUTS, ignore_errors=True)
        TEST_OUTPUTS.mkdir(parents=True)

    async def asyncTearDown(self) -> None:
        shutil.rmtree(TEST_OUTPUTS, ignore_errors=True)

    @staticmethod
    def _fake_export(path: Path, drawio_cli: Path) -> dict[str, object]:
        del drawio_cli
        files: dict[str, str] = {}
        for fmt in ("png", "svg", "pdf"):
            target = path.with_suffix(f".{fmt}")
            target.write_bytes(b"test-export")
            files[fmt] = target.name
        return {"ok": True, "files": files, "formats": {}}

    async def test_pipeline_writes_required_evidence(self) -> None:
        runner = getattr(generate, "run_pipeline", None)
        self.assertIsNotNone(runner, "run_pipeline must be implemented")
        with (
            mock.patch.object(generate, "search_shapes", AsyncMock(return_value={})),
            mock.patch.object(
                generate,
                "create_diagram",
                AsyncMock(
                    return_value={
                        "ok": True,
                        "xml": None,
                        "build_id": "test-build",
                        "error": None,
                    }
                ),
            ),
            mock.patch.object(generate, "export_drawio", side_effect=self._fake_export),
        ):
            report = await runner(INPUTS, TEST_OUTPUTS, Path("DrawIO.exe"))
        self.assertEqual(report["total"], 10)
        self.assertEqual(report["mcp_passed"], 10)
        self.assertEqual(report["passed"], 10)
        stem = "01-candidate-to-paper-pipeline"
        self.assertTrue((TEST_OUTPUTS / f"{stem}.drawio").exists())
        self.assertTrue((TEST_OUTPUTS / f"{stem}.mcp.json").exists())
        self.assertTrue((TEST_OUTPUTS / f"{stem}.check.json").exists())
        evidence = json.loads(
            (TEST_OUTPUTS / f"{stem}.mcp.json").read_text(encoding="utf-8")
        )
        self.assertEqual(evidence["build_id"], "test-build")

    async def test_pipeline_can_retry_only_selected_stems(self) -> None:
        runner = getattr(generate, "run_pipeline", None)
        self.assertIsNotNone(runner, "run_pipeline must be implemented")
        selected = "05-multiturn-eval-harness"
        with (
            mock.patch.object(generate, "search_shapes", AsyncMock(return_value={})),
            mock.patch.object(
                generate,
                "create_diagram",
                AsyncMock(
                    return_value={
                        "ok": True,
                        "xml": None,
                        "build_id": "retry-build",
                        "error": None,
                    }
                ),
            ),
            mock.patch.object(generate, "export_drawio", side_effect=self._fake_export),
        ):
            report = await runner(
                INPUTS,
                TEST_OUTPUTS,
                Path("DrawIO.exe"),
                only_stems={selected},
            )
        self.assertEqual(report["total"], 1)
        self.assertEqual(report["passed"], 1)
        self.assertEqual(report["files"][0]["stem"], selected)

    async def test_retry_report_replaces_only_selected_records(self) -> None:
        merger = getattr(generate, "merge_reports", None)
        self.assertIsNotNone(merger, "merge_reports must be implemented")
        existing = {
            "files": [
                {"stem": "keep", "status": "PASS", "mcp": {"ok": True}},
                {"stem": "retry", "status": "FAIL", "mcp": {"ok": False}},
            ]
        }
        retried = {"files": [{"stem": "retry", "status": "PASS", "mcp": {"ok": True}}]}
        merged = merger(existing, retried)
        self.assertEqual(merged["total"], 2)
        self.assertEqual(merged["passed"], 2)
        self.assertEqual(merged["mcp_passed"], 2)
        self.assertEqual([item["stem"] for item in merged["files"]], ["keep", "retry"])

    async def test_pipeline_records_mcp_failure_without_stopping(self) -> None:
        runner = getattr(generate, "run_pipeline", None)
        self.assertIsNotNone(runner, "run_pipeline must be implemented")
        with (
            mock.patch.object(generate, "search_shapes", AsyncMock(return_value={})),
            mock.patch.object(
                generate,
                "create_diagram",
                AsyncMock(
                    return_value={
                        "ok": False,
                        "xml": None,
                        "build_id": None,
                        "error": "offline",
                    }
                ),
            ),
            mock.patch.object(generate, "export_drawio", side_effect=self._fake_export),
        ):
            report = await runner(INPUTS, TEST_OUTPUTS, Path("DrawIO.exe"))
        self.assertEqual(report["total"], 10)
        self.assertEqual(report["failed"], 10)
        self.assertTrue(
            all(item["mcp"]["error"] == "offline" for item in report["files"])
        )

    async def test_pipeline_preserves_mcp_success_when_export_raises(self) -> None:
        runner = getattr(generate, "run_pipeline", None)
        self.assertIsNotNone(runner, "run_pipeline must be implemented")
        with (
            mock.patch.object(generate, "search_shapes", AsyncMock(return_value={})),
            mock.patch.object(
                generate,
                "create_diagram",
                AsyncMock(
                    return_value={
                        "ok": True,
                        "xml": None,
                        "build_id": "preserved",
                        "error": None,
                    }
                ),
            ),
            mock.patch.object(
                generate,
                "export_drawio",
                side_effect=PermissionError("blocked export"),
            ),
            mock.patch.object(
                generate,
                "export_native",
                return_value={
                    "ok": False,
                    "backend": "native-svg-chrome",
                    "files": {},
                    "formats": {},
                    "error": "blocked fallback",
                },
            ),
        ):
            report = await runner(INPUTS, TEST_OUTPUTS, Path("DrawIO.exe"))
        self.assertEqual(report["mcp_passed"], 10)
        self.assertEqual(report["failed"], 10)
        self.assertTrue(
            all(item["mcp"]["build_id"] == "preserved" for item in report["files"])
        )

    async def test_pipeline_uses_native_fallback_when_drawio_export_fails(self) -> None:
        runner = getattr(generate, "run_pipeline", None)
        fallback = getattr(generate, "export_native", None)
        self.assertIsNotNone(runner, "run_pipeline must be implemented")
        self.assertIsNotNone(fallback, "export_native must be implemented")
        native_result = {
            "ok": True,
            "backend": "native-svg-chrome",
            "files": {"png": "x.png", "svg": "x.svg", "pdf": "x.pdf"},
            "formats": {},
            "error": None,
        }
        with (
            mock.patch.object(generate, "search_shapes", AsyncMock(return_value={})),
            mock.patch.object(
                generate,
                "create_diagram",
                AsyncMock(
                    return_value={
                        "ok": True,
                        "xml": None,
                        "build_id": "fallback",
                        "error": None,
                    }
                ),
            ),
            mock.patch.object(
                generate,
                "export_drawio",
                return_value={"ok": False, "error": "desktop blocked"},
            ),
            mock.patch.object(
                generate, "export_native", return_value=native_result
            ) as native,
        ):
            report = await runner(INPUTS, TEST_OUTPUTS, Path("DrawIO.exe"))
        self.assertEqual(report["passed"], 10)
        self.assertEqual(native.call_count, 10)
        self.assertTrue(
            all(
                item["export"]["backend"] == "native-svg-chrome"
                for item in report["files"]
            )
        )


if __name__ == "__main__":
    unittest.main()
