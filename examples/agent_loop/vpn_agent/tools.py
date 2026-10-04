"""The agent's three tools: real LangChain tools over a tiny in-memory helpdesk, each taking a
moment (a scaled sleep) so the bench's timeline has something to show."""
from __future__ import annotations

import os
import time

from langchain_core.tools import tool

SCALE = float(os.environ.get("AGENT_LOOP_TIME_SCALE", "1"))

KB = [
    {"id": "KB-114", "title": "Resetting your SecureLink VPN profile",
     "text": "If SecureLink drops every few minutes, reset the profile: SecureLink → Settings → Reset profile, then sign in again."},
    {"id": "KB-087", "title": "VPN drops on hotel and café Wi-Fi",
     "text": "Captive portals interrupt the tunnel; sign in to the Wi-Fi first, then connect."},
    {"id": "KB-201", "title": "Who can reset another user's VPN",
     "text": "Only IT can reissue a VPN certificate for another person."},
]
USERS = {"gtalvert": {"name": "Greg Talvert", "role": "operator", "vpn_profile": "securelink-std", "device": "MBP-0412"}}
DRAFTS: dict[str, dict] = {}


def _wait(seconds: float) -> None:
    time.sleep(seconds * SCALE)


@tool
def search_kb(query: str) -> list[dict]:
    """Search the IT knowledge base; the best matches first."""
    _wait(0.33)
    words = {w for w in query.lower().split() if len(w) > 2}
    scored = [(sum(w in (a["title"] + " " + a["text"]).lower() for w in words), a) for a in KB]
    hits = [dict(id=a["id"], title=a["title"], score=round(0.3 + 0.17 * s, 2)) for s, a in sorted(scored, key=lambda x: -x[0]) if s]
    return hits or [dict(id=a["id"], title=a["title"], score=0.1) for a in KB[:1]]


@tool
def get_user(handle: str) -> dict:
    """Look up a person in the directory by their Slack handle."""
    _wait(0.27)
    return USERS.get(handle, {"name": handle, "role": "unknown"})


@tool
def create_draft(thread: str, body: str) -> dict:
    """Save a draft reply in a Slack thread (it is not sent)."""
    _wait(0.85)
    draft_id = f"drf_{len(DRAFTS) + 0x8c21:04x}"
    DRAFTS[draft_id] = {"thread": thread, "body": body}
    return {"draft_id": draft_id, "status": "saved"}


TOOLS = [search_kb, get_user, create_draft]
