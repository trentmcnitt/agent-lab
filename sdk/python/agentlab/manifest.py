"""The manifest: an app's map, derived from its code, attached to every run (SPEC.md 8.5).

A framework integration reads its framework's graph into a `Structure` (nodes, plain edges and
branch maps, nothing worded) and hands it to `Instrumentation` with the app's words and facts.
Everything else happens here, the same for every framework: labels, kind and actor defaults,
edge words, sources, panels, the three hashes, code fingerprints and the verification rules that
run without a run (R0-R6, R12; SPEC.md 8.7).

The manifest is a `bench-topology/0` map, so the bench draws it with no new format.
"""
from __future__ import annotations

import copy
import inspect
import json
import os
import re
import textwrap
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from . import _corpora
from . import _state
from ._runtime import ManifestDoc
from ._util import canonical, hash_obj, sha256_hex
from .version import __version__
from .words import ACTORS, KINDS, App, Panel, StepWords, Story, words_of

START = "__start__"
END = "__end__"
LOCK_VERSION = "agentlab-lock/0"
APP_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")
KIND_FROM_ACTOR = {"ai": "llm", "person": "gate", "rule": "check"}
ACTOR_FROM_KIND = {"llm": "ai", "gate": "person", "check": "rule"}
GENERIC_PANELS = (
    {"id": "llm", "title": "Model calls", "event_types": ["llm_call"], "mode": "append", "audience": "engineering"},
    {"id": "tools", "title": "Tool calls", "event_types": ["tool_call"], "mode": "append", "audience": "engineering"},
    {"id": "errors", "title": "Errors", "event_types": ["error"], "mode": "append", "audience": "engineering"},
)


# ---------------------------------------------------------------- what an integration provides


@dataclass(frozen=True)
class NodeSpec:
    """One node as the framework knows it. `func` is the node's own function (where `@step`
    words and the docstring are read); `parent` is the containing node for a subgraph's node,
    whose id is then `parent/inner`.

    A framework whose definition already names and types its nodes (an Agent Spec flow file)
    passes those as `label`, `description`, `kind` and `actor`: defaults that `@step`/`steps=`
    words override. They come from the same file as the edges, so they have no fingerprint.
    A code-first framework (LangGraph) leaves them None."""
    id: str
    func: Callable[..., Any] | None = None
    parent: str | None = None
    label: str | None = None
    description: str | None = None
    kind: str | None = None
    actor: str | None = None


@dataclass(frozen=True)
class BranchSpec:
    """The branches out of `source`: `ends` maps each branch label to its target node id (END as
    "__end__"); every label kept, many-to-one included. `ends=None` means the framework can't
    say (an untyped router): R3. `router` is the function that picks, for fingerprints; a
    `Command`-returning node passes `ends={target: target}` and no router."""
    source: str
    ends: Mapping[Any, str] | None
    router: Callable[..., Any] | None = None


@dataclass(frozen=True)
class Structure:
    nodes: Sequence[NodeSpec]
    edges: Sequence[tuple[str, str]] = ()        # plain edges, START/END as "__start__"/"__end__"
    branches: Sequence[BranchSpec] = ()
    source: str = "code"                          # derived.from, e.g. "langgraph", "agentspec"
    framework: str | None = None                  # e.g. "langgraph 1.2.12"
    findings: Sequence["Finding"] = ()            # what the reader found wrong in the definition itself
    inputs: Sequence[str] | None = None           # the run input's field names, None = not known
    outputs: Sequence[str] | None = None          # the run output's field names, None = not known


# ---------------------------------------------------------------- findings


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str        # error | warning | info
    message: str
    node: str | None = None
    branch: str | None = None

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}

    def __str__(self) -> str:
        where = self.node or ""
        if self.branch is not None:
            where += f" → {self.branch}"
        return f"{self.code} {self.severity}{f' [{where}]' if where else ''}: {self.message}"


@dataclass(frozen=True)
class VerifyReport:
    findings: tuple[Finding, ...]
    fingerprints: Mapping[str, str] = field(default_factory=dict)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warning"]

    @property
    def infos(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "info"]

    @property
    def ok(self) -> bool:
        return not self.errors

    def __str__(self) -> str:
        if not self.findings:
            return "agentlab: the words match the code (no findings)"
        head = (f"agentlab: {len(self.errors)} error(s), {len(self.warnings)} warning(s), "
                f"{len(self.infos)} note(s)")
        order = {"error": 0, "warning": 1, "info": 2}
        lines = [f"  {f}" for f in sorted(self.findings, key=lambda f: order[f.severity])]
        return "\n".join([head, *lines])


class VerificationError(AssertionError):
    """Raised by `verify` (an AssertionError, so a test that calls it fails with the report)."""

    def __init__(self, report: VerifyReport):
        self.report = report
        super().__init__(str(report))


# ---------------------------------------------------------------- helpers


def humanize(node_id: str) -> str:
    """The technical label: the last path segment, underscores as spaces."""
    return node_id.rsplit("/", 1)[-1].replace("_", " ")


def branch_id(label: Any) -> str:
    """A path map key as a branch id: bools are "True"/"False", anything else str()."""
    if isinstance(label, bool):
        return "True" if label else "False"
    return str(label)


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9_.-]+", "-", text.lower()).strip("-_.")
    return s or "app"


def source_hash(fn: Any) -> str | None:
    """sha256 of a function's source, dedented, trailing whitespace stripped; None if unknown."""
    if fn is None:
        return None
    try:
        src = inspect.getsource(inspect.unwrap(fn))
    except (OSError, TypeError):
        return None
    lines = [line.rstrip() for line in textwrap.dedent(src).splitlines()]
    return sha256_hex("\n".join(lines).strip("\n"))


def own_doc(fn: Any) -> str | None:
    """The function's own docstring (not its class's, e.g. functools.partial's)."""
    if fn is None:
        return None
    doc = inspect.getdoc(fn)
    if not doc or doc == inspect.getdoc(type(fn)):
        return None
    return doc


def _sorted_dicts(items: Iterable[dict]) -> list[dict]:
    return sorted(items, key=canonical)


# ---------------------------------------------------------------- the instrumentation


class Instrumentation:
    """One app's derived map plus its words: built once, at `instrument()` time.

    Integrations construct it and expose it as an attribute named `agentlab_instrumentation` on
    what `instrument()` returns (directly, or on a callback handler in the returned graph's
    config), which is how `verify(graph)` and `lock(graph)` find it.
    """

    def __init__(self, structure: Structure, *, app: App, story: Story | None = None,
                 steps: Mapping[str, StepWords] | None = None, corpora: Sequence[str] | None = None,
                 lock: str | os.PathLike | None = None):
        self.structure = structure
        self.app = app
        self.story = story
        self.steps = dict(steps or {})
        self.corpora = None if corpora is None else tuple(corpora)
        self.lock_path = Path(lock) if lock is not None else None
        self._cache_lock = threading.Lock()
        self._cache: tuple[Any, ManifestDoc] | None = None
        self._build()

    # -- the static part (structure, words, findings), rebuilt only by lock()

    def _build(self) -> None:
        s = self.structure
        findings: list[Finding] = list(s.findings)
        node_ids = [n.id for n in s.nodes]
        specs = {n.id: n for n in s.nodes}
        known = set(node_ids)
        funcs = {n.id: n.func for n in s.nodes}
        parents = {n.id: n.parent for n in s.nodes if n.parent}

        # exits per node, branch ids per node
        exits: dict[str, list[str]] = {n: [] for n in node_ids}
        for a, b in s.edges:
            if a in exits:
                exits[a].append(b)
        branches: dict[str, dict[str, str]] = {}
        unknown: set[str] = set()
        routers: dict[str, list[Any]] = {}
        many_to_one: set[str] = set()
        for br in s.branches:
            if br.source == START:
                continue
            if br.ends is None:
                unknown.add(br.source)
                continue
            mapping = branches.setdefault(br.source, {})
            targets: list[str] = []
            for label, target in br.ends.items():
                bid = branch_id(label)
                mapping.setdefault(bid, target)
                targets.append(target)
            if len(set(targets)) < len(targets):
                many_to_one.add(br.source)
            routers.setdefault(br.source, []).append(br.router or funcs.get(br.source))
            exits.setdefault(br.source, []).extend(targets)
        has_end_node = any(END in m.values() for m in branches.values())
        all_ids = node_ids + ([END] if has_end_node else [])

        # words: one place per node
        words: dict[str, StepWords] = {}
        for n in s.nodes:
            w = words_of(n.func)
            if w is not None:
                words[n.id] = w
        for key, w in self.steps.items():
            if key not in known and not (key == END and has_end_node):
                findings.append(Finding("R1", "error", f"steps= names {key!r}, which is not a node of this graph", node=key))
                continue
            if key in words:
                findings.append(Finding("R1", "error", "worded in both @step and steps=; keep one", node=key))
            words[key] = w

        nodes: list[dict] = []
        for nid in all_ids:
            w = words.get(nid)
            spec = specs.get(nid)
            label = "end" if nid == END else (spec.label if spec is not None and spec.label else humanize(nid))
            entry: dict[str, Any] = {"id": nid, "label": label}
            if spec is not None and spec.description:
                entry["description"] = spec.description
            actor = kind = None
            if w is not None:
                if w.label:
                    entry["plain_label"] = w.label
                if w.says:
                    entry["description"] = w.says
                if w.moment is not None:
                    entry["moment"] = bool(w.moment)
                if w.not_needed:
                    entry["x-not-needed"] = w.not_needed
                if w.actor is not None:
                    if w.actor in ACTORS:
                        actor = w.actor
                    else:
                        findings.append(Finding("R0", "error", f"actor {w.actor!r} is not one of {', '.join(ACTORS)}", node=nid))
                if w.kind is not None:
                    if w.kind in KINDS:
                        kind = w.kind
                    else:
                        findings.append(Finding("R0", "error", f"kind {w.kind!r} is not one of {', '.join(KINDS)}", node=nid))
            doc = own_doc(funcs.get(nid))
            if doc:
                entry["doc"] = doc
            if kind is None and actor is None and spec is not None:
                # the definition's own typing, unless the words typed the node themselves
                kind = spec.kind if spec.kind in KINDS else None
                actor = spec.actor if spec.actor in ACTORS else None
            if kind is None:
                if actor is not None:
                    kind = KIND_FROM_ACTOR.get(actor, "step")
                elif nid == END:
                    kind = "terminal"
                elif nid not in unknown and exits.get(nid) and all(t == END for t in exits[nid]):
                    kind = "terminal"
                else:
                    kind = "step"
            entry["kind"] = kind
            # Who does the step, only when something says so: the words, the definition, or a kind
            # that implies it. Otherwise the field is left out and the viewer reads it from the run
            # (a step that called the AI is the AI's), so a zero-word hookup never claims "the app"
            # for a step that called the model (SPEC 8.5).
            actor = actor or ACTOR_FROM_KIND.get(kind)
            if actor:
                entry["actor"] = actor
            if nid in parents:
                entry["parent"] = parents[nid]
            if nid in unknown:
                entry["branches_unknown"] = True
                findings.append(Finding("R3", "error", "branches unknown: add a path_map or a Literal return type", node=nid))
            nodes.append(entry)

        # edges
        edges: list[dict] = []
        seen: set[tuple] = set()

        def add(edge: dict) -> None:
            key = (edge["from"], edge["to"], edge.get("from_branch"))
            if key not in seen:
                seen.add(key)
                edges.append(edge)

        for a, b in s.edges:
            if a == START or b == END:
                continue
            add({"from": a, "to": b})
        for src, mapping in branches.items():
            pw = words[src].paths if src in words else {}
            for bid, target in mapping.items():
                edge: dict[str, Any] = {"from": src, "to": target, "from_branch": bid}
                if bid in pw:
                    edge["plain_label"] = pw[bid].label
                    if pw[bid].says:
                        edge["description"] = pw[bid].says
                add(edge)

        # R2 / R5 / R12 on branches and words
        for nid, w in words.items():
            valid = set(branches.get(nid, {}))
            for bid in w.paths:
                if bid not in valid:
                    have = ", ".join(sorted(valid)) or "none"
                    findings.append(Finding("R2", "error", f"paths names branch {bid!r}; this node's branches are: {have}", node=nid, branch=bid))
        for nid in sorted(many_to_one):
            findings.append(Finding("R5", "info", "two branches lead to the same step: pass decision(branch=...) so the bench lights the right one", node=nid))
        for nid in node_ids:
            if nid not in words:
                findings.append(Finding("R12", "info", "no words: shown by its code name", node=nid))
            pw = words[nid].paths if nid in words else {}
            for bid in branches.get(nid, {}):
                if bid not in pw:
                    findings.append(Finding("R12", "info", "branch has no words", node=nid, branch=bid))

        # app facts
        app = self.app
        never: list[str] = []
        if app.never is not None:
            types, wmap = list(app.never.types), dict(app.never.words)
            missing = [t for t in types if t not in wmap]
            extra = [k for k in wmap if k not in types]
            if missing or extra:
                parts = []
                if missing:
                    parts.append(f"no words for {', '.join(map(repr, missing))}")
                if extra:
                    parts.append(f"words for {', '.join(map(repr, extra))}, which the list doesn't have")
                findings.append(Finding("R4", "error", "never(): " + "; ".join(parts)))
            never = [wmap[t] for t in types if t in wmap]
        actions = [{"id": a.id, "title": a.title, "description": a.description} for a in app.actions]

        # which input/output fields a person reads (R15: they must be fields the graph has)
        io: dict[str, Any] = {}
        declared = [("request", app.request, s.inputs, "input"), ("reply", app.reply, s.outputs, "output")]
        declared += [("requester", f, s.inputs, "input") for f in app.requester]
        for key, fld, have, side in declared:
            if not fld:
                continue
            if have is not None and fld not in have:
                fields = ", ".join(sorted(have)) or "none"
                findings.append(Finding("R15", "error", f"App.{key} names {fld!r}, which is not a field of the "
                                                        f"graph's {side} (its fields: {fields})"))
                continue
            if key == "requester":
                io.setdefault("requester", []).append(str(fld))
            else:
                io[key] = str(fld)

        # story and panels
        story_entry = None
        story_sha = None
        panels: list[dict] = []
        if self.story is not None:
            try:
                story_sha = sha256_hex(Path(self.story.file).read_bytes())
            except OSError as e:
                findings.append(Finding("R0", "error", f"story file can't be read: {e}"))
            # A node may be named by its function (rename-proof: the name can't go stale) or by its id.
            by_func = {id(f): nid for nid, f in funcs.items() if f is not None}

            def node_id(ref: Any) -> str | None:
                if isinstance(ref, str):
                    return ref
                f = ref
                while f is not None:
                    if id(f) in by_func:
                        return by_func[id(f)]
                    f = getattr(f, "__wrapped__", None)
                return None

            def resolve(refs: Any, what: str) -> list[str]:
                out = []
                for ref in refs:
                    nid = node_id(ref)
                    if nid is None:
                        name = getattr(ref, "__qualname__", None) or repr(ref)
                        findings.append(Finding("R1", "error", f"{what} names the function {name}, which is no step of this graph"))
                    elif nid not in known:
                        findings.append(Finding("R1", "error", f"{what} names node {nid!r}, which is not in this graph", node=nid))
                    else:
                        out.append(nid)
                return out

            resolve(self.story.reads, "the story's reads")
            for p in self.story.panels:
                resolve(p.nodes, f"panel {p.id!r}")
                panels.append(_panel(p, [node_id(r) or getattr(r, "__qualname__", str(r)) for r in p.nodes]))
        story_ids = {p["id"] for p in panels}
        panels += [dict(g) for g in GENERIC_PANELS if g["id"] not in story_ids]

        # fingerprints (A8 / SPEC 8.7)
        current: dict[str, str | None] = {}
        for nid, w in words.items():
            if nid == END:
                continue
            current[f"node:{nid}"] = source_hash(funcs.get(nid))
            if w.paths and nid in branches:
                parts = [source_hash(r) or "" for r in routers.get(nid, [])]
                current[f"paths:{nid}"] = sha256_hex("\n".join(parts) + "\n" + canonical(branches[nid]).decode())
        locked = self._read_lock()
        fingerprints: dict[str, str] = {}
        for key, value in sorted(current.items()):
            if value is None or locked is None or key not in locked:
                fingerprints[key] = "unconfirmed"
            elif locked[key] == value:
                fingerprints[key] = "confirmed"
            else:
                fingerprints[key] = "changed"
                kind_, _, nid = key.partition(":")
                what = "this step's code" if kind_ == "node" else "this step's branches"
                findings.append(Finding("R6", "warning", f"wording last confirmed against an earlier version of {what}; "
                                                         f"re-read it, then run agentlab lock", node=nid))
        unconfirmed = sorted(k for k, v in fingerprints.items() if v == "unconfirmed")
        if unconfirmed:
            why = "no lock file" if self.lock_path is None or locked is None else "not in the lock file"
            findings.append(Finding("R12", "info", f"{len(unconfirmed)} wording(s) unconfirmed ({why}): {', '.join(unconfirmed)}"))

        structure_payload = {
            "nodes": _sorted_dicts({k: v for k, v in n.items() if k in ("id", "parent", "branches_unknown")} for n in nodes),
            "edges": _sorted_dicts({k: v for k, v in e.items() if k in ("from", "to", "from_branch")} for e in edges),
        }
        words_payload = {
            "app": {k: getattr(app, k) for k in ("name", "description", "privacy_note", "track_record", "baseline")},
            **({"io": io} if io else {}),     # only when declared, so an app without it hashes as before
            "steps": {nid: _words_json(w) for nid, w in sorted(words.items())},
            "docs": {n["id"]: n["doc"] for n in nodes if "doc" in n},
            "actions": actions, "never": never, "panels": [p for p in panels if p["id"] in story_ids],
            "story": story_sha,
        }
        node_facts = {n.id: f for n in s.nodes
                      if (f := {k: v for k in ("label", "description", "kind", "actor")
                                if (v := getattr(n, k)) is not None})}
        if node_facts:      # only frameworks that name their nodes; a LangGraph hash never moves
            words_payload["node_facts"] = dict(sorted(node_facts.items()))
        self._current_fingerprints = current
        self._static = {
            "nodes": nodes, "edges": edges, "actions": actions, "never": never, "panels": panels, "io": io,
            "story_sha": story_sha, "findings": tuple(findings), "fingerprints": fingerprints,
            "hashes": {"structure": hash_obj(structure_payload), "words": hash_obj(words_payload)},
        }
        with self._cache_lock:
            self._cache = None

    def _read_lock(self) -> dict | None:
        if self.lock_path is None:
            return None
        try:
            data = json.loads(self.lock_path.read_text())
        except (OSError, ValueError):
            return None
        fps = data.get("fingerprints") if isinstance(data, dict) else None
        return fps if isinstance(fps, dict) else None

    # -- the per-run part

    def app_id(self) -> str:
        if self.app.id:
            return self.app.id if APP_ID.match(self.app.id) else slug(self.app.id)
        return slug(_state.STATE.service_name or self.app.name)

    def findings(self) -> tuple[Finding, ...]:
        extra = ()
        if self.app.id and not APP_ID.match(self.app.id):
            extra = (Finding("R0", "error", f"App.id {self.app.id!r} must match {APP_ID.pattern}; "
                                            f"using {slug(self.app.id)!r}"),)
        return self._static["findings"] + extra

    def report(self) -> VerifyReport:
        return VerifyReport(findings=self.findings(), fingerprints=dict(self._static["fingerprints"]))

    def _sources(self) -> tuple[int, list[dict]]:
        version, corpora = _corpora.snapshot()
        wanted = self.corpora
        return version, [c.source for c in corpora if wanted is None or c.id in wanted]

    def manifest(self) -> dict:
        """The manifest as a run starting now would carry it (a copy: safe to change)."""
        return copy.deepcopy(self._manifest(self._sources()[1]))

    def _manifest(self, sources: list[dict]) -> dict:
        st, app = self._static, self.app
        app_entry: dict[str, Any] = {"id": self.app_id(), "name": app.name}
        for key in ("description", "privacy_note", "track_record", "baseline"):
            value = getattr(app, key)
            if value:
                app_entry[key] = value
        if st["io"]:
            app_entry["io"] = copy.deepcopy(st["io"])
        m: dict[str, Any] = {"v": "bench-topology/0", "app": app_entry, "nodes": st["nodes"], "edges": st["edges"]}
        if sources:
            m["sources"] = sources
        if st["actions"]:
            m["actions"] = st["actions"]
        if st["never"]:
            m["never"] = st["never"]
        m["panels"] = st["panels"]
        if st["story_sha"]:
            m["story"] = {"id": app_entry["id"], "sha256": st["story_sha"]}
        derived: dict[str, Any] = {"from": self.structure.source, "library": f"agentlab {__version__}"}
        if self.structure.framework:
            derived["framework"] = self.structure.framework
        derived["hashes"] = {**st["hashes"], "corpora": hash_obj(sources)}
        derived["warnings"] = [f.to_json() for f in self.findings()]
        derived["fingerprints"] = dict(st["fingerprints"])
        m["derived"] = derived
        return m

    def manifest_doc(self) -> ManifestDoc:
        """The manifest encoded for the wire, re-encoded only when the corpora or app id change."""
        version, sources = self._sources()
        key = (version, self.app_id())
        with self._cache_lock:
            if self._cache is not None and self._cache[0] == key:
                return self._cache[1]
        body = canonical(self._manifest(sources))
        doc = ManifestDoc(json=body.decode("utf-8"), hash=sha256_hex(body))
        with self._cache_lock:
            self._cache = (key, doc)
        return doc

    # -- lock

    def write_lock(self) -> Path:
        """Record the current fingerprints as confirmed (a deliberate act, like a snapshot update)."""
        if self.lock_path is None:
            raise ValueError("no lock file: pass instrument(..., lock='agentlab.lock.json')")
        entries = {k: v for k, v in sorted(self._current_fingerprints.items()) if v is not None}
        self.lock_path.write_text(json.dumps({"v": LOCK_VERSION, "fingerprints": entries}, indent=2, sort_keys=True) + "\n")
        self._build()
        return self.lock_path


def _words_json(w: StepWords) -> dict:
    out = {k: v for k, v in (("label", w.label), ("says", w.says), ("actor", w.actor), ("kind", w.kind),
                             ("moment", w.moment), ("not_needed", w.not_needed)) if v is not None}
    if w.paths:
        out["paths"] = {b: {k: v for k, v in (("label", p.label), ("says", p.says)) if v is not None}
                        for b, p in sorted(w.paths.items())}
    return out


def _panel(p: Panel, nodes: list[str]) -> dict:
    out: dict[str, Any] = {"id": p.id, "title": p.title, "event_types": list(p.event_types)}
    if p.plain_title:
        out["plain_title"] = p.plain_title
    if nodes:
        out["nodes"] = nodes
    if p.mode != "latest":
        out["mode"] = p.mode
    out["audience"] = p.audience
    if p.story:
        out["story"] = True
    if p.fields:
        out["fields"] = [dict(f) for f in p.fields]
    return out


def find(obj: Any) -> Instrumentation | None:
    """The Instrumentation behind `obj`: itself, its `agentlab_instrumentation` attribute, or a
    callback handler carrying one in its `config["callbacks"]` (what LangGraph's
    `with_config(callbacks=[...])` makes)."""
    if isinstance(obj, Instrumentation):
        return obj
    found = getattr(obj, "agentlab_instrumentation", None)
    if isinstance(found, Instrumentation):
        return found
    config = getattr(obj, "config", None)
    callbacks = config.get("callbacks") if isinstance(config, Mapping) else None
    handlers = getattr(callbacks, "handlers", callbacks)
    for handler in handlers or ():
        found = getattr(handler, "agentlab_instrumentation", None)
        if isinstance(found, Instrumentation):
            return found
    return None
