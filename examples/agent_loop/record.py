"""Re-records ../agent-loop.recording.jsonl: one run's spans -> OTLP/JSON -> the bench's own recorder.

    uv run python record.py
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

os.environ["AGENT_LOOP_TIME_SCALE"] = "1"      # real-looking timings (the test runs them fast)

from agentlab.testing import capture, to_otlp_json  # noqa: E402

from test_agent_loop import Q  # noqa: E402
from vpn_agent import build_graph  # noqa: E402

HERE = Path(__file__).resolve().parent
BENCH = HERE.parents[1]


def main() -> None:
    with capture(service_name="vpn-agent") as spans:
        build_graph().invoke({"question": Q})
    tmp = HERE / "agent-loop.otlp.json"
    tmp.write_text(json.dumps(to_otlp_json(spans)))
    try:
        subprocess.run(["uv", "run", "--quiet", "python", "-m", "bench.record", "--otlp", str(tmp), "--out", str(BENCH / "examples"),
                        "--name", "agent-loop", "--title", "My VPN keeps dropping", "--group", "An agent loop inside one step",
                        "--t0", "1790710000"], cwd=BENCH, check=True)
    finally:
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
