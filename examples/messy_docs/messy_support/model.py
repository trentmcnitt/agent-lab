"""A scripted chat model: a real LangChain `BaseChatModel` (so every callback and span is real),
whose answer is computed from the prompt. No API key.

It answers with the sentence, among the numbered passages, that shares the most words with the
question (ties: the earlier passage), and cites that passage's number.
"""
from __future__ import annotations

import re
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult

_PASSAGE = re.compile(r"^\[(\d+)\] (.*?)(?=^\[\d+\] |\Z)", re.M | re.S)
_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset("a an the and or to of in on at for is are do does what how can i we you it my our with be".split())


def _words(t: str) -> set[str]:
    return {w for w in _WORD.findall(t.lower()) if w not in _STOP}


class ChatScripted(BaseChatModel):
    model: str = "scripted-drive-1"

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None,
                  run_manager: Any = None, **kwargs: Any) -> ChatResult:
        prompt = "\n".join(str(m.content) for m in messages)
        q = re.search(r"Question: (.*)", prompt)
        qw = _words(q.group(1)) if q else set()
        best = (0, None, None)
        for m in _PASSAGE.finditer(prompt.split("Passages:", 1)[-1]):
            for sent in re.split(r"(?<=[.!?])\s+|\n+", m.group(2)):
                score = len(qw & _words(sent))
                if score > best[0]:
                    best = (score, m.group(1), sent.strip())
        text = f"{best[2]} [{best[1]}]" if best[1] else "I couldn't find that in the shared drive."
        msg = AIMessage(content=text, response_metadata={"model_name": self.model, "finish_reason": "stop"},
                        usage_metadata={"input_tokens": len(prompt) // 4, "output_tokens": len(text) // 4,
                                        "total_tokens": (len(prompt) + len(text)) // 4})
        return ChatResult(generations=[ChatGeneration(message=msg)])
