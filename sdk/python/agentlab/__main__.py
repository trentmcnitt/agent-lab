"""`python -m agentlab lock MODULE:FACTORY` and `python -m agentlab verify MODULE:FACTORY [--strict]`.

FACTORY() must return an instrumented graph (what `agentlab.langgraph.instrument` returns).
"""
from __future__ import annotations

import argparse
import importlib
import sys

from .manifest import VerificationError
from ._tooling import lock, verify


def _load(target: str):
    module_name, _, attr = target.partition(":")
    if not module_name or not attr:
        raise SystemExit(f"expected MODULE:FACTORY, got {target!r}")
    sys.path.insert(0, "")
    factory = getattr(importlib.import_module(module_name), attr)
    return factory()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m agentlab")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_lock = sub.add_parser("lock", help="confirm the current wording against the current code")
    p_lock.add_argument("target", metavar="MODULE:FACTORY")
    p_verify = sub.add_parser("verify", help="check the words against the code")
    p_verify.add_argument("target", metavar="MODULE:FACTORY")
    p_verify.add_argument("--strict", action="store_true", help="also fail on wording whose code changed (R6)")
    args = parser.parse_args(argv)
    graph = _load(args.target)
    if args.cmd == "lock":
        path = lock(graph)
        print(f"agentlab: wrote {path}")
        return 0
    try:
        report = verify(graph, strict=args.strict)
    except VerificationError as e:
        print(e.report, file=sys.stderr)
        return 1
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
