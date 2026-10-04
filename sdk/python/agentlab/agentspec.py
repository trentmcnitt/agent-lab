"""Open Agent Spec: the map read from the flow file itself.

    from agentlab import agentspec

    manifest = agentspec.manifest_from("flow.yaml")            # a bench-topology/0 map
    lab.verify(agentspec.instrumentation_from("flow.yaml"))    # in the app's tests

When an app is defined as an Agent Spec flow (https://github.com/oracle/agent-spec) and a runtime
executes that file, the file *is* the structure, so the map can't disagree with what runs:
- **Nodes** are the flow's nodes. A node's id is its Agent Spec component `id`, which is also the
  node name pyagentspec's LangGraph loader gives the node at runtime, so spans line up. A
  `FlowNode`'s subflow is read into it: inner nodes are `container/inner`, with `parent`.
- **Label, description and type** come from the component's `name`, `description` and
  `component_type` (an `LlmNode` is an AI step, a `BranchingNode` a rule, an `EndNode` the end).
  `steps={node_id: lab.step(...)}` adds Presentation words on top and overrides them.
- **Edges** are the control-flow edges. `from_branch: null` is the node's `next` branch. A node
  with only `next` gets plain edges; any other node's edges keep their branch names
  (`from_branch`), which is the vocabulary Agent Lab borrowed from Agent Spec.
- **Checks the file can fail** (R14, an error): an edge leaving from a branch its node doesn't
  declare (the language spec says it "must be set to one of the values in branches"; pyagentspec
  doesn't check it, and its LangGraph loader then fails at runtime with a KeyError), two edges
  leaving one branch (the spec allows one), and an edge naming a node its flow doesn't list.

Plain parsing, no pyagentspec: JSON, or YAML through PyYAML (the `agentlab[agentspec]` extra).
YAML 1.1's `yes`/`no`/`on`/`off` stay strings here, since branch names are often exactly those;
only `true`/`false` are booleans. Agent Spec Tracing is not read (it is an in-process span API,
not OpenTelemetry); see SPEC.md 8.5.

`python -m agentlab.agentspec FLOW [--verify] [--out FILE] [--register URL] [--app-id ID]` writes the
map, checks it, or registers it with a bench (`PUT /apps/<app_id>`, the declared-map tier).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Sequence

from .manifest import BranchSpec, Finding, Instrumentation, NodeSpec, Structure, VerificationError
from .words import App, StepWords, Story

__all__ = ["AgentSpecError", "structure_from", "instrumentation_from", "manifest_from", "main"]

NEXT = "next"            # Node.DEFAULT_NEXT_BRANCH in the language spec
DEFAULT = "default"      # BranchingNode.DEFAULT_BRANCH

# component_type -> (kind, actor). Anything not listed is a plain app step.
TYPES: dict[str, tuple[str, str]] = {
    "StartNode": ("step", "app"),
    "EndNode": ("terminal", "app"),
    "LlmNode": ("llm", "ai"),
    "AgentNode": ("llm", "ai"),
    "ToolNode": ("tool", "app"),
    "ApiNode": ("tool", "app"),
    "BranchingNode": ("step", "rule"),
    "InputMessageNode": ("gate", "person"),
    "OutputMessageNode": ("step", "app"),
}
SUBFLOW_TYPES = {"FlowNode"}     # nodes whose `subflow` is drawn inside them

class AgentSpecError(ValueError):
    """The file can't be read as an Agent Spec flow (not a flow, a dangling reference, bad YAML)."""


# ---------------------------------------------------------------- reading the file


def _yaml_loader() -> Any:
    try:
        import yaml
    except ImportError as e:  # pragma: no cover - the extra is missing
        raise AgentSpecError("reading YAML needs PyYAML: install agentlab[agentspec]") from e

    class Loader(yaml.SafeLoader):
        pass

    bool_tag = "tag:yaml.org,2002:bool"
    Loader.yaml_implicit_resolvers = {
        first: [(tag, rx) for tag, rx in resolvers if tag != bool_tag]
        for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }
    Loader.add_implicit_resolver(bool_tag, re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"), list("tTfF"))
    Loader.load_document = staticmethod(lambda text: yaml.load(text, Loader=Loader))  # noqa: S506 - SafeLoader
    return Loader


def _load(source: Any) -> tuple[dict, str]:
    """The parsed document and a name for messages."""
    if isinstance(source, Mapping):
        return dict(source), "<flow>"
    path = Path(source)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise AgentSpecError(f"can't read {path}: {e}") from e
    try:
        if path.suffix.lower() == ".json":
            doc = json.loads(text)
        else:
            doc = _yaml_loader().load_document(text)
    except AgentSpecError:
        raise
    except Exception as e:  # noqa: BLE001 - any parse error is the file's
        raise AgentSpecError(f"{path} is not valid {'JSON' if path.suffix.lower() == '.json' else 'YAML'}: {e}") from e
    if not isinstance(doc, dict):
        raise AgentSpecError(f"{path} does not hold an Agent Spec component")
    return doc, str(path)


class _Refs:
    """Every `$referenced_components` entry in the document. Ids are unique across levels in Agent
    Spec (pyagentspec rejects a duplicate), so one table resolves every `$component_ref`."""

    def __init__(self, doc: Any, where: str):
        self.where = where
        self.table: dict[str, Any] = {}
        self._collect(doc)

    def _collect(self, value: Any) -> None:
        if isinstance(value, dict):
            refs = value.get("$referenced_components")
            if isinstance(refs, dict):
                for key, component in refs.items():
                    if key in self.table and self.table[key] != component:
                        raise AgentSpecError(f"{self.where}: component id {key!r} is defined twice")
                    self.table[key] = component
            for v in value.values():
                self._collect(v)
        elif isinstance(value, list):
            for v in value:
                self._collect(v)

    def get(self, value: Any) -> Any:
        seen: set[str] = set()
        while isinstance(value, dict) and "$component_ref" in value:
            key = value["$component_ref"]
            if key in seen:
                raise AgentSpecError(f"{self.where}: circular reference through {key!r}")
            seen.add(key)
            if key not in self.table:
                raise AgentSpecError(f"{self.where}: $component_ref {key!r} has no entry in $referenced_components")
            value = self.table[key]
        return value


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _branch(value: Any) -> str:
    return NEXT if value is None else str(value)


def _end_branches(flow: Mapping, refs: _Refs) -> list[str]:
    out = []
    for raw in flow.get("nodes") or ():
        node = refs.get(raw)
        if isinstance(node, dict) and node.get("component_type") == "EndNode":
            out.append(_branch(node.get("branch_name")))
    return out


def _declared_branches(node: Mapping, refs: _Refs) -> list[str]:
    """The node's branches as written, else as pyagentspec would infer them."""
    written = node.get("branches")
    if isinstance(written, list) and written:
        return [str(b) for b in written]
    ctype = node.get("component_type")
    if ctype == "EndNode":
        return []
    if ctype == "BranchingNode":
        mapping = node.get("mapping") if isinstance(node.get("mapping"), dict) else {}
        return sorted({DEFAULT, *map(str, mapping.values())})
    if ctype in SUBFLOW_TYPES:
        sub = refs.get(node.get("subflow"))
        ends = sorted(set(_end_branches(sub, refs))) if isinstance(sub, dict) else []
        return ends or [NEXT]
    return [NEXT]


def _quote(names: Sequence[str]) -> str:
    return ", ".join(repr(n) for n in names) or "none"


def _read_flow(flow: Mapping, refs: _Refs, prefix: str, parent: str | None,
               nodes: list[NodeSpec], edges: list[tuple[str, str]], branches: list[BranchSpec],
               findings: list[Finding]) -> None:
    by_id: dict[str, dict] = {}
    for raw in flow.get("nodes") or ():
        node = refs.get(raw)
        if not isinstance(node, dict) or not isinstance(node.get("id"), str):
            raise AgentSpecError(f"{refs.where}: a node of flow {flow.get('name')!r} has no id")
        by_id.setdefault(node["id"], node)          # a node listed twice is one node

    def nid(raw_id: str) -> str:
        return prefix + raw_id

    for raw_id, node in by_id.items():
        ctype = node.get("component_type")
        kind, actor = TYPES.get(ctype, ("step", "app"))
        nodes.append(NodeSpec(id=nid(raw_id), parent=parent, label=_text(node.get("name")),
                              description=_text(node.get("description")), kind=kind, actor=actor))
        if ctype in SUBFLOW_TYPES:
            sub = refs.get(node.get("subflow"))
            if isinstance(sub, dict) and sub.get("component_type") == "Flow":
                _read_flow(sub, refs, nid(raw_id) + "/", nid(raw_id), nodes, edges, branches, findings)

    outs: dict[str, list[tuple[str, str]]] = {}
    for raw in flow.get("control_flow_connections") or ():
        edge = refs.get(raw)
        if not isinstance(edge, dict):
            continue
        src, dst = refs.get(edge.get("from_node")), refs.get(edge.get("to_node"))
        src_id = src.get("id") if isinstance(src, dict) else None
        dst_id = dst.get("id") if isinstance(dst, dict) else None
        name = edge.get("name") or edge.get("id") or "?"
        if src_id not in by_id or dst_id not in by_id:
            missing = src_id if src_id not in by_id else dst_id
            findings.append(Finding("R14", "error", f"control-flow edge {name!r} names node {missing!r}, "
                                                    f"which flow {flow.get('name')!r} doesn't list"))
            continue
        outs.setdefault(src_id, []).append((_branch(edge.get("from_branch")), dst_id))

    for src_id, exits in outs.items():
        declared = _declared_branches(by_id[src_id], refs)
        only_next = declared == [NEXT] and all(branch == NEXT for branch, _ in exits)
        ends: dict[str, str] = {}
        for branch, dst_id in exits:
            if branch not in declared:
                findings.append(Finding("R14", "error", f"an edge leaves from branch {branch!r}, which this node "
                                                        f"doesn't have (its branches: {_quote(declared)})",
                                        node=nid(src_id), branch=branch))
            if branch in ends:
                findings.append(Finding("R14", "error", f"a second edge leaves from branch {branch!r} (to {dst_id!r}; "
                                                        f"the first goes to {ends[branch].rsplit('/', 1)[-1]!r}): "
                                                        "Agent Spec allows one, so the runtime takes only one of them",
                                        node=nid(src_id), branch=branch))
                edges.append((nid(src_id), nid(dst_id)))     # still drawn, without a branch name
                continue
            ends[branch] = nid(dst_id)
            if only_next:
                edges.append((nid(src_id), nid(dst_id)))     # a node with one way out: a plain edge
        if not only_next:
            branches.append(BranchSpec(source=nid(src_id), ends=ends))


# ---------------------------------------------------------------- public


def _parse(source: Any) -> tuple[dict, Structure]:
    doc, where = _load(source)
    refs = _Refs(doc, where)
    flow = refs.get(doc)
    ctype = flow.get("component_type") if isinstance(flow, dict) else None
    if ctype != "Flow":
        raise AgentSpecError(f"{where} is {'a ' + ctype if ctype else 'not a component'}, not a Flow: "
                             "Agent Lab draws flows (an agent on its own is one step)")
    nodes: list[NodeSpec] = []
    edges: list[tuple[str, str]] = []
    branches: list[BranchSpec] = []
    findings: list[Finding] = []
    _read_flow(flow, refs, "", None, nodes, edges, branches, findings)
    version = doc.get("agentspec_version")
    structure = Structure(nodes=nodes, edges=edges, branches=branches, source="agentspec",
                          framework=f"agentspec {version}" if version else "agentspec",
                          findings=tuple(findings))
    return flow, structure


def structure_from(source: Any) -> Structure:
    """The flow's structure (nodes, edges, branches, and what's wrong with the file itself).

    `source` is a path to a `.json`/`.yaml` flow file, or an already parsed dict. Raises
    `AgentSpecError` when it isn't a readable Agent Spec flow."""
    return _parse(source)[1]


def instrumentation_from(source: Any, *, app: App | None = None,
                         steps: Mapping[str, StepWords] | None = None, story: Story | None = None,
                         corpora: Sequence[str] | None = None,
                         lock: str | os.PathLike | None = None) -> Instrumentation:
    """The flow's map with any words added; pass it to `lab.verify(...)` in a test.

    - `app`: defaults to `App(name=<flow name>, description=<flow description>)`.
    - `steps`: `{node_id: lab.step(...)}`, Presentation words keyed by Agent Spec component id
      (`container/inner` inside a `FlowNode`). They override the file's names and types.
    - `story`, `corpora`, `lock`: as for `agentlab.langgraph.instrument`; a relative path is
      taken from the working directory."""
    flow, structure = _parse(source)
    if app is None:
        app = App(name=_text(flow.get("name")) or "Agent Spec flow", description=_text(flow.get("description")))
    return Instrumentation(structure, app=app, story=story, steps=steps, corpora=corpora, lock=lock)


def manifest_from(source: Any, **kwargs: Any) -> dict:
    """The flow's map as a `bench-topology/0` manifest (SPEC.md 8.5); keywords as for
    `instrumentation_from`. Findings are in `manifest["derived"]["warnings"]`; it never raises
    for them (use `lab.verify(instrumentation_from(...))` for that)."""
    return instrumentation_from(source, **kwargs).manifest()


# ---------------------------------------------------------------- CLI


def _register(base_url: str, manifest: dict) -> str:
    url = f"{base_url.rstrip('/')}/apps/{manifest['app']['id']}"
    body = json.dumps({"topology": manifest, "story": None}).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="PUT", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - an operator-given URL
        response.read()
    return url


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m agentlab.agentspec",
                                     description="Agent Lab's map of an Open Agent Spec flow file.")
    parser.add_argument("flow", help="the flow file (.json, .yaml or .yml)")
    parser.add_argument("--out", help="write the map here instead of printing it")
    parser.add_argument("--verify", action="store_true", help="fail (exit 1) when the file has errors")
    parser.add_argument("--register", metavar="URL",
                        help="register the map with a bench, e.g. http://127.0.0.1:8790 (PUT /apps/<app_id>)")
    parser.add_argument("--app-id", help="the app id (default: from the flow's name); a runtime's runs join "
                                         "this map when their OTel service.name equals it")
    args = parser.parse_args(argv)
    try:
        app = None
        if args.app_id:
            flow, _ = _parse(args.flow)
            app = App(name=_text(flow.get("name")) or "Agent Spec flow", id=args.app_id,
                      description=_text(flow.get("description")))
        inst = instrumentation_from(args.flow, app=app)
    except AgentSpecError as e:
        print(f"agentlab: {e}", file=sys.stderr)
        return 2
    report = inst.report()
    if args.verify:
        if report.errors:
            print(VerificationError(report), file=sys.stderr)
            return 1
        print(report, file=sys.stderr)
    manifest = inst.manifest()
    text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    elif not args.register:
        sys.stdout.write(text)
    if args.register:
        try:
            url = _register(args.register, manifest)
        except (urllib.error.URLError, OSError) as e:
            print(f"agentlab: couldn't register with {args.register}: {e}", file=sys.stderr)
            return 3
        print(f"agentlab: registered {url}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
