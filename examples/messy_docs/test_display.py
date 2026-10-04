"""The documents display is deterministic and follows the files, with no model anywhere in it.

Each test builds the messy folder fresh in a temp dir, runs the real app (stock loaders, splitter,
BM25, the scripted model) with the agentlab library capturing spans, reads the spans with the
bench's own OTLP reader (exactly what a live bench or `bench.record` does), and builds the
display model from what the bench received.
"""
from __future__ import annotations

import json
import shutil
import sys
import warnings
from pathlib import Path

import pytest

warnings.filterwarnings("ignore", category=DeprecationWarning)

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))          # the bench's adapters/ (stdlib only)

from adapters import otlp  # noqa: E402
from agentlab.testing import capture, to_otlp_json  # noqa: E402

import display  # noqa: E402
import make_corpus  # noqa: E402
from messy_support.graph import make_builder  # noqa: E402
from messy_support.ingest import build_index, clean_filename, document_title  # noqa: E402
from agentlab.langgraph import instrument  # noqa: E402
from messy_support.graph import APP  # noqa: E402
from run_queries import QUERIES  # noqa: E402

HELPDESK = Path.home() / "working_dir/agent-lab/request-queue/demo/bench-recordings/req-011-approved.recording.jsonl"


def run(docs: Path, question: str) -> list[dict]:
    with capture(service_name="messy-support") as spans:
        graph = instrument(make_builder(index=build_index(docs)).compile(), app=APP)
        graph.invoke({"question": question})
    state = otlp.TraceState()
    events = state.ingest(to_otlp_json(spans))
    info = state.run_info(events[0]["run_id"])
    return display.documents_step(state.maps[info["map_hash"]], events, node="retrieve")


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    return make_corpus.build(tmp_path / "docs")


def strip(model: list[dict]) -> list[dict]:
    return json.loads(json.dumps(model))


# ---- determinism ------------------------------------------------------------------------------
@pytest.mark.parametrize("slug,question", QUERIES)
def test_same_input_same_display(tmp_path: Path, slug: str, question: str):
    a = run(make_corpus.build(tmp_path / "a"), question)
    b = run(make_corpus.build(tmp_path / "b"), question)
    assert strip(a) == strip(b)


def test_ties_between_duplicate_files_break_the_same_way_every_time(docs: Path):
    """The exact duplicate ties the original on score; the order is (-score, id), never argsort's."""
    first = run(docs, QUERIES[0][1])[0]["documents"]
    for _ in range(3):
        assert [d["file"] for d in run(docs, QUERIES[0][1])[0]["documents"]] == [d["file"] for d in first]


# ---- the display follows the files, and nothing else --------------------------------------------
def test_renaming_a_file_changes_only_that_document(docs: Path):
    q = QUERIES[3][1]                                           # the loaner question: scan_0042.pdf
    before = run(docs, q)[0]
    (docs / "scan_0042.pdf").rename(docs / "Loaner program.pdf")
    after = run(docs, q)[0]
    b = {d["file"]: d for d in before["documents"]}
    a = {d["file"]: d for d in after["documents"]}
    assert "scan_0042.pdf" in b and "Loaner program.pdf" in a
    assert b["scan_0042.pdf"]["title"] == "scan 0042"          # untitled PDF: the file name, cleaned
    assert a["Loaner program.pdf"]["title"] == "Loaner program"
    old, new = b.pop("scan_0042.pdf"), a.pop("Loaner program.pdf")
    assert b == a                                               # every other document identical
    for p, q2 in zip(old["passages"], new["passages"]):
        assert p["id"].replace("scan_0042.pdf", "Loaner program.pdf") == q2["id"]
        assert {k: v for k, v in p.items() if k != "id"} == {k: v for k, v in q2.items() if k != "id"}
    assert before["counts"] == after["counts"]


def test_splitting_a_file_adds_a_document(docs: Path):
    src = docs / "Refund Policy FINAL_v2.md"
    head, tail = src.read_text().split("## How to process it", 1)
    src.write_text(head)
    (docs / "Refund processing steps.md").write_text("# Refund processing steps\n\n## How to process it" + tail)
    before_docs = 25
    model = run(docs, "Once the warehouse scans the box, when do we issue the refund?")[0]
    assert model["counts"]["documents"] == before_docs + 1
    files = [d["file"] for d in model["documents"]]
    assert "Refund processing steps.md" in files
    split = next(d for d in model["documents"] if d["file"] == "Refund processing steps.md")
    assert split["title"] == "Refund processing steps"          # its own first heading
    assert all(p["of"] == split["passages_total"] for p in split["passages"])


def test_an_empty_file_is_not_a_document_the_bench_can_see(docs: Path):
    """untitled.md has no text, so no passage and no item: 26 files, 25 documents. (REPORT.md: the
    library would need to report files, not just passages, to count it.)"""
    assert len([p for p in docs.rglob("*") if p.is_file()]) == 26
    assert run(docs, QUERIES[0][1])[0]["counts"]["documents"] == 25


# ---- the helpdesk: one document, numbered sections, from the same code -------------------------
@pytest.mark.skipif(not HELPDESK.exists(), reason="the helpdesk recording isn't on this machine")
def test_helpdesk_is_one_document_with_numbered_sections():
    model = display.from_recording(HELPDESK, node="retrieve")[0]
    assert model["layout"] == "sections"
    assert model["counts"]["documents"] == 1 and model["counts"]["items"] == 16
    assert [s["face"] for s in model["sections"]] == ["Preamble"] + [str(i) for i in range(1, 16)]
    assert model["line"].startswith("Searched Northwire Technologies")


def test_dates_and_years_are_not_section_numbers():
    topo = {"sources": [{"id": "s", "title": "Notes", "kind": "documents", "description": "",
                         "items": [{"id": "a", "title": "2023-01-15 shipping notes"},
                                   {"id": "b", "title": "2024 rates"}, {"id": "c", "title": "Holiday hours"}]}]}
    events = [{"event_type": "retrieval", "node": "r", "ts": 1.0, "data": {"source": "s", "hits": [{"id": "a", "text": "x"}]}}]
    m = display.documents_step(topo, events)[0]
    assert m["layout"] == "documents"


def test_a_folder_with_one_numbered_file_is_still_a_document_list(docs: Path):
    """faq.md has '## 1.' headings, but it is one file among 25: no grid."""
    assert run(docs, "Do you price match?")[0]["layout"] == "documents"


# ---- title rules -----------------------------------------------------------------------------
@pytest.mark.parametrize("meta,text,name,want", [
    ("Kestrel Kitchen Limited Warranty", "", "Warranty Terms.pdf", ("Kestrel Kitchen Limited Warranty", "metadata")),
    ("untitled", "LOANER UNIT PROGRAM", "scan_0042.pdf", ("scan 0042", "filename")),
    ("Microsoft Word - CC_Handbook_2022_rev3.docx", "Welcome", "Employee Handbook - Customer Care (2022).pdf",
     ("Employee Handbook - Customer Care", "filename")),
    (None, "# Refund Policy\n\ntext", "Copy of Refund Policy FINAL_v2.md", ("Refund Policy", "heading")),
    ("", "Kettle shows E2", "kb-article-1187.html", ("kb-article-1187", "filename")),
    (None, "x", "escalation matrix v3 FINAL FINAL.docx", ("escalation matrix", "filename")),
])
def test_title_precedence(meta, text, name, want):
    assert document_title(meta, text, name) == want


def test_clean_filename_keeps_dates():
    assert clean_filename("2023-01-15 shipping notes.txt") == "2023-01-15 shipping notes"
