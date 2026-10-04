"""Small shared pieces: the never-raise guard, canonical JSON and hashing, JSON for app values."""
from __future__ import annotations

import dataclasses
import functools
import hashlib
import json
import logging
import threading
from typing import Any, Callable, TypeVar

log = logging.getLogger("agentlab")

_seen: set[tuple[str, str]] = set()
_seen_lock = threading.Lock()


def log_once(function: str, reason: str, *, level: int = logging.DEBUG) -> None:
    """Log one line per (function, reason) per process, so a bad call in a loop doesn't flood."""
    key = (function, reason)
    with _seen_lock:
        if key in _seen:
            return
        _seen.add(key)
    log.log(level, "agentlab.%s: %s", function, reason)


def reset_log_once() -> None:
    with _seen_lock:
        _seen.clear()


F = TypeVar("F", bound=Callable[..., Any])


def never_raises(fn: F) -> F:
    """The runtime contract: a helper catches everything, logs once and returns None."""
    name = fn.__name__

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 - the contract is that app code never sees our errors
            log_once(name, f"{type(e).__name__}: {e}")
            return None

    return wrapper  # type: ignore[return-value]


def canonical(obj: Any) -> bytes:
    """The one canonical JSON encoding every Agent Lab hash is taken over (SPEC.md 8.5)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def hash_obj(obj: Any) -> str:
    return sha256_hex(canonical(obj))


def _default(o: Any) -> Any:
    """JSON for the values apps actually pass: pydantic models, dataclasses, sets, bytes."""
    dump = getattr(o, "model_dump", None)
    if callable(dump):
        return dump(mode="json")
    if dataclasses.is_dataclass(o) and not isinstance(o, type):
        return dataclasses.asdict(o)
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    if isinstance(o, bytes):
        return o.decode("utf-8", "replace")
    return str(o)


def to_jsonable(value: Any) -> Any:
    """A plain-JSON copy of an app value (pydantic models and dataclasses become dicts)."""
    return json.loads(json.dumps(value, default=_default, ensure_ascii=False))


def dumps(value: Any) -> str:
    return json.dumps(value, default=_default, ensure_ascii=False)
