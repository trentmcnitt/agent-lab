"""A scripted chat model that behaves like a tool-using agent: a real LangChain `BaseChatModel`, so
every callback and span is the real thing, but its moves are computed from the conversation, so the
example needs no API key. Swap in `ChatAnthropic(...).bind_tools(TOOLS)` and the app is unchanged.

Its loop for one request: ask to search the knowledge base; with the articles, ask for two things in
one answer (look up the person, save a draft reply), which the app runs at the same time; then write
the final reply and stop.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from .tools import SCALE


def _tokens(text: str) -> int:
    return max(1, len(text) // 4)


class ChatScriptedAgent(BaseChatModel):
    model: str = "scripted-agent-1"

    @property
    def _llm_type(self) -> str:
        return "scripted-agent"

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None,
                  run_manager: Any = None, **kwargs: Any) -> ChatResult:
        prompt = "\n".join(str(m.content) for m in messages)
        results = {m.name: m.content for m in messages if isinstance(m, ToolMessage)}
        turn = sum(isinstance(m, AIMessage) for m in messages)
        question = next((str(m.content) for m in messages if m.type == "human"), "")
        handle = (re.search(r"@(\w+)", question) or re.search(r"from (\w+)", question))
        handle = handle.group(1) if handle else "unknown"
        calls: list[dict] = []
        if "search_kb" not in results:
            time.sleep(0.82 * SCALE)
            text, calls = "", [{"name": "search_kb", "args": {"query": "vpn reset"}, "id": f"toolu_{turn}a"}]
        elif "create_draft" not in results:
            time.sleep(1.52 * SCALE)
            best = json.loads(results["search_kb"])[0] if results["search_kb"].startswith("[") else {"id": "KB-114"}
            body = f"Hi, a reset usually fixes this: SecureLink → Settings → Reset profile, then sign in again ({best['id']})."
            text, calls = "", [{"name": "get_user", "args": {"handle": handle}, "id": f"toolu_{turn}a"},
                               {"name": "create_draft", "args": {"thread": "#helpdesk-requests/1790571233.4419", "body": body},
                                "id": f"toolu_{turn}b"}]
        else:
            time.sleep(2.77 * SCALE)
            user = json.loads(results.get("get_user") or "{}")
            first = (user.get("name") or "there").split()[0]
            text = (f"Hi {first}, a reset usually fixes this: SecureLink → Settings → Reset profile, then sign in "
                    "again (KB-114). Still dropping? Reply here and IT will reissue it.")
        finish = "tool_use" if calls else "end_turn"
        message = AIMessage(content=text, tool_calls=calls,
                            response_metadata={"model_name": self.model, "finish_reason": finish},
                            usage_metadata={"input_tokens": _tokens(prompt) + 1200, "output_tokens": _tokens(text + json.dumps(calls)),
                                            "total_tokens": _tokens(prompt) + 1200 + _tokens(text + json.dumps(calls))})
        return ChatResult(generations=[ChatGeneration(message=message)])
