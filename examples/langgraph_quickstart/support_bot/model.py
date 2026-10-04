"""A scripted chat model: a real LangChain `BaseChatModel`, so every callback and span is the real
thing, but its answers are computed from the prompt, so the example needs no API key.

Swap it for `ChatAnthropic(...)` or `ChatOpenAI(...)` and nothing else in the app changes.
"""
from __future__ import annotations

import json
import re
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult

_SNIPPET = re.compile(r"^\[(?P<id>[\w-]+)\] (?P<title>[^:]+): (?P<text>.+)$", re.M)


def _tokens(text: str) -> int:
    return max(1, len(text) // 4)


class ChatScripted(BaseChatModel):
    """Classifies by whether any FAQ snippet was supplied; answers by quoting the first one."""

    model: str = "scripted-support-1"

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None,
                  run_manager: Any = None, **kwargs: Any) -> ChatResult:
        prompt = "\n".join(str(m.content) for m in messages)
        snippets = list(_SNIPPET.finditer(prompt))
        if "Classify" in prompt:
            if snippets:
                first = snippets[0]
                body = {"category": "answer", "cited": [first["id"]],
                        "rationale": f"The FAQ entry \"{first['title']}\" covers this."}
            else:
                body = {"category": "escalate", "cited": [],
                        "rationale": "No FAQ entry matches the question, so a person should take it."}
            text = json.dumps(body)
        else:
            first = snippets[0] if snippets else None
            text = f"{first['text']} [{first['id']}]" if first else "I couldn't find that in the FAQ."
        message = AIMessage(content=text, response_metadata={"model_name": self.model, "finish_reason": "stop"},
                            usage_metadata={"input_tokens": _tokens(prompt), "output_tokens": _tokens(text),
                                            "total_tokens": _tokens(prompt) + _tokens(text)})
        return ChatResult(generations=[ChatGeneration(message=message)])
