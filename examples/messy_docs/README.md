# Messy documents (a proof)

Does the bench's documents display hold up on the folder a real support team actually has, with no hand-typed lists and no AI-written labels? This example is that test.

- `make_corpus.py` writes `docs/`: 26 files a support team would plausibly have: `.md .txt .pdf .html .docx`, names like `Refund Policy FINAL_v2.md`, `Copy of Refund Policy FINAL_v2.md`, `refund policy (old).md`, `2023-01-15 shipping notes.txt`, `scan_0042.pdf` (metadata title "untitled"), a 24-page handbook PDF whose metadata title is `Microsoft Word - CC_Handbook_2022_rev3.docx`, a nearly empty `notes.txt`, an empty `untitled.md`. Byte-identical on every run.
- `messy_support/`: the app. Stock LangChain loaders (TextLoader, PyPDFLoader, BSHTMLLoader, Docx2txtLoader), `RecursiveCharacterTextSplitter` (500/50), `BM25Retriever`, a LangGraph graph (search → answer → check sources → send or hand off) with a scripted chat model (no API key). `ingest.py` reports the corpus with `lab.corpus` from the splitter's output and the loaders' metadata, and each search with `lab.retrieved`.
- `run_queries.py`: five questions, recorded through the bench's own recorder into `recordings/*.recording.jsonl`; the same five at Level 0 (OpenInference's LangChain instrumentor, no agentlab) into `recordings/level0-*.events.json`.
- `display.py`: the documents display model, built only from what the bench receives (map + events). The same function builds the helpdesk's numbered handbook and this folder.
- `make_display_data.py`: `recordings/display-data.json`, the models for the helpdesk step and each query.
- `test_display.py`: same input → same display; renaming a file changes only that document; splitting a file adds a document; title rules; dates aren't section numbers; the helpdesk stays one document with 16 sections.

```sh
cd examples/messy_docs
uv run python make_corpus.py
uv run python run_queries.py          # needs the bench's own env too (bench.record runs from the repo root)
uv run python make_display_data.py
uv run pytest -q
```

The write-up (plain English, the rules, what's guaranteed and what isn't) is in the business hub: `agent-lab/design/mockups/style/_proof/REPORT.md`.
