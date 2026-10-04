"""Load a folder the way most teams would, split it, index it, and report it to Agent Lab.

Loading and splitting are stock LangChain: a loader per file type (TextLoader, PyPDFLoader,
BSHTMLLoader, Docx2txtLoader), RecursiveCharacterTextSplitter, BM25Retriever. Nothing is cleaned
up by hand and no list is typed: everything the bench shows comes from the loaders' own metadata
(`source`, `page`, `title`) and the splitter's output.

The part that would move into the library is `passages()` + `report_corpus()`: given LangChain
`Document`s, it decides each passage's id, its document, the document's title and the passage's
location, by fixed rules (documented in the proof's REPORT.md and below). It never calls a model.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import agentlab as lab
from langchain_community.document_loaders import BSHTMLLoader, Docx2txtLoader, PyPDFLoader, TextLoader
from langchain_community.retrievers import BM25Retriever
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

CORPUS_ID = "support-drive"
CHUNK_SIZE = 500
CHUNK_OVERLAP = 50

LOADERS = {".md": TextLoader, ".txt": TextLoader, ".pdf": PyPDFLoader, ".html": BSHTMLLoader, ".docx": Docx2txtLoader}


# ---- title rules: explicit metadata title > first heading > cleaned file name -------------------
_JUNK_TITLE = re.compile(r"^(untitled|unspecified|document\d*|title|none|null)$|^microsoft (word|excel|powerpoint) - |"
                         r"\.(docx?|pdf|txt|md|html?|pptx?|xlsx?)$", re.I)
_MD_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", re.M)


def clean_filename(name: str) -> str:
    """'Copy of Refund Policy FINAL_v2.md' -> 'Refund Policy'. Dates, words and case are kept."""
    stem = Path(name).stem
    stem = stem.replace("_", " ")
    stem = re.sub(r"^\s*copy of\s+", "", stem, flags=re.I)
    stem = re.sub(r"\b(final|v\d+|rev\d+|copy|draft)\b", " ", stem, flags=re.I)
    stem = re.sub(r"\(\s*\d+\s*\)$", "", stem.strip())                  # "report (2)"
    stem = re.sub(r"\s+", " ", stem).strip(" -_.")
    return stem or Path(name).stem or name


def document_title(meta_title: str | None, text: str, file_name: str) -> tuple[str, str]:
    """(title, where it came from): 'metadata', 'heading' or 'filename'."""
    t = (meta_title or "").strip()
    if t and not _JUNK_TITLE.search(t):
        return t, "metadata"
    m = _MD_HEADING.search(text)
    if m and m.group(1).strip():
        return m.group(1).strip(), "heading"
    return clean_filename(file_name), "filename"


# ---- loading and splitting -------------------------------------------------------------------
def load_folder(root: Path) -> list[Document]:
    """Every supported file under `root`, in sorted path order (a glob's order isn't stable)."""
    out: list[Document] = []
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        loader = LOADERS.get(path.suffix.lower())
        if loader is None:
            continue
        for d in loader(str(path)).load():
            d.metadata["source"] = path.relative_to(root).as_posix()      # stable, machine-independent
            out.append(d)
    return out


@dataclass(frozen=True)
class Passage:
    id: str              # "<file>#<n>": the document is everything before the last '#'
    file: str
    title: str           # the document's title, by the rules above
    title_from: str
    n: int               # 1-based, in document order
    of: int              # passages in this document
    page: int | None     # 1-based PDF page, when the loader says
    text: str


def passages(docs: list[Document]) -> list[Passage]:
    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP, add_start_index=True)
    chunks = splitter.split_documents(docs)
    by_file: dict[str, list[Document]] = {}
    for c in chunks:
        by_file.setdefault(c.metadata["source"], []).append(c)
    # Every file is a document, even one that produced no passage (empty): it can't be found, but
    # it is still in the folder, so it still counts as searched. It gets no item (nothing to cite).
    titles: dict[str, tuple[str, str]] = {}
    for d in docs:
        f = d.metadata["source"]
        if f not in titles:
            first_text = "\n".join(x.page_content for x in docs if x.metadata["source"] == f)
            titles[f] = document_title(d.metadata.get("title"), first_text, Path(f).name)
    out: list[Passage] = []
    for f in sorted(by_file):
        cs = sorted(by_file[f], key=lambda c: (c.metadata.get("page", 0), c.metadata.get("start_index", 0)))
        for i, c in enumerate(cs, start=1):
            page = c.metadata.get("page")
            out.append(Passage(id=f"{f}#{i}", file=f, title=titles[f][0], title_from=titles[f][1], n=i, of=len(cs),
                               page=page + 1 if isinstance(page, int) else None, text=c.page_content))
    return out


def files_in(docs: list[Document]) -> list[str]:
    return sorted({d.metadata["source"] for d in docs})


def report_corpus(ps: list[Passage], files: list[str], title: str) -> None:
    """The corpus, from the index's own passages: one item per passage, titled by its document."""
    lab.corpus(CORPUS_ID, title=title, items=[(p.id, p.title) for p in ps],
               description=(f"A shared folder of {len(files)} files. For each question a keyword search hands the AI "
                            "the 4 best-matching passages; it never sees the rest."))


class StableBM25(BM25Retriever):
    """BM25Retriever, ranked by (-score, id): its own argsort breaks ties (duplicate files tie
    exactly) in an order that isn't guaranteed, and a display has to be the same every time."""

    def _get_relevant_documents(self, query: str, *, run_manager=None) -> list[Document]:
        scores = self.vectorizer.get_scores(self.preprocess_func(query))
        order = sorted(range(len(self.docs)), key=lambda i: (-float(scores[i]), self.docs[i].metadata["id"]))
        out = []
        for i in order[: self.k]:
            d = self.docs[i]
            out.append(Document(page_content=d.page_content, id=d.metadata["id"],
                                metadata={**d.metadata, "score": round(float(scores[i]), 4)}))
        return out


_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset("a an the and or to of in on at for is are do does what how can i we you it my our with be".split())


def preprocess(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP]


@dataclass
class Index:
    files: list[str]
    passages: list[Passage]
    retriever: StableBM25

    def by_id(self, pid: str) -> Passage:
        return next(p for p in self.passages if p.id == pid)


def build_index(root: Path, k: int = 4, title: str = "Support shared drive") -> Index:
    docs = load_folder(root)
    ps = passages(docs)
    files = files_in(docs)
    report_corpus(ps, files, title)
    lc_docs = [Document(page_content=p.text, id=p.id,
                        metadata={"id": p.id, "source": p.file, "title": p.title, "passage": p.n, "passages": p.of,
                                  **({"page": p.page} if p.page else {})}) for p in ps]
    retriever = StableBM25.from_documents(lc_docs, k=k, preprocess_func=preprocess)
    return Index(files=files, passages=ps, retriever=retriever)
