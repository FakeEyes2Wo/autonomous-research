#!/usr/bin/env python3
"""Render and conservatively inspect every page of one PDF.

The output is a machine inspection sidecar. It records actual text/image
rectangles and page coverage, while leaving scientific evidence auditing to the
TypeScript claim/citation audit.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

Rect = tuple[float, float, float, float]


def rect_values(rect: object) -> list[float]:
    return [float(getattr(rect, name)) for name in ("x0", "y0", "x1", "y1")]


def intersection_area(left: Rect, right: Rect) -> float:
    width = max(0.0, min(left[2], right[2]) - max(left[0], right[0]))
    height = max(0.0, min(left[3], right[3]) - max(left[1], right[1]))
    return width * height


def area(rect: Rect) -> float:
    return max(0.0, rect[2] - rect[0]) * max(0.0, rect[3] - rect[1])


def outside(rect: Rect, width: float, height: float, tolerance: float = 0.5) -> bool:
    return rect[0] < -tolerance or rect[1] < -tolerance or rect[2] > width + tolerance or rect[3] > height + tolerance


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--render-dir", required=True)
    args = parser.parse_args()

    try:
        import fitz  # type: ignore
    except Exception as exc:
        print(json.dumps({"error": f"PyMuPDF unavailable: {exc}"}))
        return 2

    pdf_path = Path(args.pdf).resolve()
    render_dir = Path(args.render_dir).resolve()
    render_dir.mkdir(parents=True, exist_ok=True)
    document = fitz.open(pdf_path)
    pages: list[dict[str, object]] = []
    issues: list[dict[str, object]] = []
    expected_pages = document.page_count
    try:
        for index in range(expected_pages):
            page = document.load_page(index)
            rect = page.rect
            text_rects: list[Rect] = []
            for block in page.get_text("blocks"):
                # PyMuPDF includes image blocks in get_text("blocks"). Their
                # rectangles belong to imageRects and must not be compared as
                # text, otherwise every ordinary raster image overlaps itself.
                if len(block) > 6 and int(block[6]) != 0:
                    continue
                candidate = tuple(float(value) for value in block[:4])
                text_rects.append(candidate)  # type: ignore[arg-type]
            image_rects: list[Rect] = []
            for image in page.get_images(full=True):
                for image_rect in page.get_image_rects(image):
                    image_rects.append(tuple(rect_values(image_rect)))  # type: ignore[arg-type]

            for candidate in [*text_rects, *image_rects]:
                if outside(candidate, rect.width, rect.height):
                    issues.append({
                        "code": "PAGE_CONTENT_OVERFLOW",
                        "severity": "error",
                        "page": index + 1,
                        "detail": f"content rectangle exceeds page bounds: {candidate}",
                    })

            for text_index, text_rect in enumerate(text_rects):
                text_area = area(text_rect)
                if text_area <= 0:
                    continue
                for image_index, image_rect in enumerate(image_rects):
                    overlap = intersection_area(text_rect, image_rect)
                    if overlap / text_area >= 0.35:
                        issues.append({
                            "code": "SUSPECTED_TEXT_IMAGE_OVERLAP",
                            "severity": "warning",
                            "page": index + 1,
                            "detail": f"text object {text_index} overlaps image object {image_index} by {overlap / text_area:.2f}",
                        })

            image_path = render_dir / f"page-{index + 1:04d}.png"
            pixmap = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)
            pixmap.save(str(image_path))
            pages.append({
                "page": index + 1,
                "imagePath": str(image_path),
                "widthPt": float(rect.width),
                "heightPt": float(rect.height),
                "textBoxes": len(text_rects),
                "imageBoxes": len(image_rects),
                "textRects": [list(item) for item in text_rects],
                "imageRects": [list(item) for item in image_rects],
            })
    finally:
        document.close()

    complete = len(pages) == expected_pages and all(Path(str(page["imagePath"])).is_file() for page in pages)
    print(json.dumps({
        "schema": "autoresearch/paper-pdf-inspection/v1",
        "pages": pages,
        "issues": issues,
        "coverage": {
            "complete": complete,
            "renderedPages": len(pages),
            "pageCount": expected_pages,
            "visuallyReviewed": False,
        },
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
