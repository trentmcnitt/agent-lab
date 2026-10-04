"""Trusted story files for apps built with the `agentlab` library (SPEC.md 8.6).

A story is JavaScript the viewer runs, so it never comes from telemetry: a run's map names the
story it was built with by sha256, and the operator names the files they trust in
AGENT_LAB_STORIES. Both the live bench and `bench.record` read them here.
"""
from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path

log = logging.getLogger("bench.stories")


def trusted_stories(spec: str | None = None) -> dict[str, Path]:
    """AGENT_LAB_STORIES="<app_id>=<path>[;<app_id>=<path>…]" (or `spec`) -> {app_id: path}."""
    out: dict[str, Path] = {}
    for part in (os.environ.get("AGENT_LAB_STORIES", "") if spec is None else spec).split(";"):
        app_id, sep, path = part.partition("=")
        if sep and app_id.strip() and path.strip():
            out[app_id.strip()] = Path(path.strip()).expanduser()
        elif part.strip():
            log.warning("AGENT_LAB_STORIES: ignoring %r (expected <app_id>=<path>)", part)
    return out


DEV_NOTE = ("dev mode: the story file changed since this run was built; showing it as it is now "
            "(AGENT_LAB_STORIES_DEV is set, so the hash isn't enforced)")


def dev_mode() -> bool:
    """AGENT_LAB_STORIES_DEV=1: while writing a story, serve the trusted file as it is now even when
    it differs from the one a run was built with, so an edit shows on a reload without re-running
    the app. Never for recordings (`bench.record` always enforces the hash)."""
    return os.environ.get("AGENT_LAB_STORIES_DEV", "").strip().lower() in ("1", "true", "yes", "on")


def read_story(path: Path | None, app_id: str, want: str, *, dev: bool = False) -> tuple[str | None, str]:
    """The story at `path` if its sha256 is `want`: (source, "ok"), else (None, why). With `dev`, a
    file that differs is still served: (source, DEV_NOTE)."""
    if path is None:
        return None, f"no story file is trusted for {app_id} (set AGENT_LAB_STORIES={app_id}=<path>)"
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return None, f"the story file for {app_id} can't be read ({exc.strerror or exc})"
    if hashlib.sha256(raw).hexdigest() != want:
        if dev:
            return raw.decode("utf-8", errors="replace"), DEV_NOTE
        return None, "story file differs from the one this run was built with"
    return raw.decode("utf-8", errors="replace"), "ok"
