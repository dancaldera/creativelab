#!/usr/bin/env python3
"""Convert the source PRD .docx into docs/PRD.md, preserving document order.

Walks the docx body (not just `document.paragraphs`) so headings and tables stay in
the order the author wrote them, then emits GitHub-flavoured Markdown.
"""
from __future__ import annotations

import sys
from pathlib import Path

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn


def iter_block_items(parent):
    body = parent.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, parent)
        elif child.tag == qn("w:tbl"):
            yield Table(child, parent)


def escape_cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", "<br>").strip()


def render_table(table: Table, out: list[str]) -> None:
    rows = [[escape_cell(c.text) for c in row.cells] for row in table.rows]
    if not rows:
        return
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    out.append("| " + " | ".join(rows[0]) + " |")
    out.append("| " + " | ".join(["---"] * width) + " |")
    for row in rows[1:]:
        out.append("| " + " | ".join(row) + " |")
    out.append("")


HEADING_LEVELS = {"Heading 1": 2, "Heading 2": 3, "Heading 3": 4, "Heading 4": 5, "Title": 1}


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: convert_prd.py <input.docx> <output.md>", file=sys.stderr)
        return 2

    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    document = Document(str(source))

    out: list[str] = []
    in_list = False
    for block in iter_block_items(document):
        if isinstance(block, Table):
            if in_list:
                out.append("")
                in_list = False
            render_table(block, out)
            continue

        text = block.text.strip()
        style = block.style.name if block.style is not None else "Normal"

        if not text:
            continue

        if style in HEADING_LEVELS:
            if in_list:
                out.append("")
                in_list = False
            out.append("")
            out.append("#" * HEADING_LEVELS[style] + " " + text)
            out.append("")
        elif style == "List Bullet":
            out.append(f"- {text}")
            in_list = True
        elif style == "List Number":
            out.append(f"1. {text}")
            in_list = True
        else:
            if in_list:
                out.append("")
                in_list = False
            out.append(text)
            out.append("")

    # Collapse runs of blank lines.
    cleaned: list[str] = []
    for line in out:
        if line == "" and cleaned and cleaned[-1] == "":
            continue
        cleaned.append(line)

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(cleaned).strip() + "\n", encoding="utf8")
    print(f"wrote {target} ({len(cleaned)} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
