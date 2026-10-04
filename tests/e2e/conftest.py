"""End-to-end fixtures: a real browser against real servers the tests start and stop themselves.

    uv run pytest tests/e2e -q

Servers (ports 8815-8819 only):
- 8816: a static site laid out like the public lab: the bench's static export at /bench/ (the
  examples plus the helpdesk's recordings) and the helpdesk's static app at /apps/slack-helpdesk/.
- 8815: a live bench (uvicorn) with empty, temporary log and apps dirs, for Level 0.

Everything skips cleanly when Playwright, a Chromium build, or the helpdesk checkout is missing.
"""
from __future__ import annotations

import glob
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HELPDESK = ROOT.parent / "agent-lab/request-queue"
STATIC_PORT, LIVE_PORT = 8816, 8815

sync_api = pytest.importorskip("playwright.sync_api", reason="playwright not installed (uv sync --dev)")


def _wait_port(port: int, proc: subprocess.Popen, timeout: float = 20) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            raise RuntimeError(f"server on {port} exited with {proc.returncode}")
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise RuntimeError(f"nothing listening on {port} after {timeout}s")


def _stop(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def _port_free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


@pytest.fixture(scope="session")
def browser():
    """Chromium. Playwright's own build if installed; else the newest Chromium any Playwright
    version left in the cache (the pinned revision often lags what's on disk); else skip."""
    with sync_api.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as first:  # noqa: BLE001  (missing browser build; try the cache)
            cache = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or Path.home() / "Library/Caches/ms-playwright")
            cands = sorted(glob.glob(str(cache / "chromium_headless_shell-*/*/chrome-headless-shell")), reverse=True)
            if not cands:
                cache = Path.home() / ".cache/ms-playwright"
                cands = sorted(glob.glob(str(cache / "chromium_headless_shell-*/*/chrome-headless-shell")), reverse=True)
            b = None
            for exe in cands:
                try:
                    b = p.chromium.launch(executable_path=exe)
                    break
                except Exception:  # noqa: BLE001
                    continue
            if b is None:
                pytest.skip(f"no Chromium for Playwright ({first.__class__.__name__}); run: uv run playwright install chromium")
        yield b
        b.close()


@pytest.fixture(scope="session")
def site(tmp_path_factory):
    """The lab's layout, static: /bench/ and /apps/slack-helpdesk/. Base URL."""
    recs = HELPDESK / "demo/bench-recordings"
    if not recs.exists():
        pytest.skip("helpdesk checkout not beside the bench")
    if not _port_free(STATIC_PORT):
        pytest.skip(f"port {STATIC_PORT} is busy")
    root = tmp_path_factory.mktemp("site")
    subprocess.run([sys.executable, "scripts/export_static.py", "--out", str(root / "bench"), "--recordings", str(recs)],
                   cwd=ROOT, check=True, capture_output=True)
    app = HELPDESK / "dist/slack-helpdesk"
    if app.exists():
        shutil.copytree(app, root / "apps/slack-helpdesk")
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(STATIC_PORT), "--bind", "127.0.0.1", "--directory", str(root)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        _wait_port(STATIC_PORT, proc)
        yield f"http://127.0.0.1:{STATIC_PORT}"
    finally:
        _stop(proc)


@pytest.fixture(scope="session")
def live_bench(tmp_path_factory):
    """A live bench with no apps registered. Base URL."""
    if not _port_free(LIVE_PORT):
        pytest.skip(f"port {LIVE_PORT} is busy")
    tmp = tmp_path_factory.mktemp("live")
    env = dict(os.environ, BENCH_LOG_DIR=str(tmp / "log"), BENCH_APPS_DIR=str(tmp / "apps"), BENCH_RECORDINGS_DIR=str(tmp / "rec"),
               BENCH_MAPS_DIR=str(tmp / "maps"))
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "bench.server:app", "--port", str(LIVE_PORT), "--host", "127.0.0.1",
                             "--log-level", "warning"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        _wait_port(LIVE_PORT, proc)
        yield f"http://127.0.0.1:{LIVE_PORT}"
    finally:
        _stop(proc)


# Resource 404s are expected and harmless here: a static export has no /topologies, http.server
# has no favicon, and Level 0 asks for a map that was never registered. Script errors are not.
IGNORED = ("Failed to load resource", "favicon")


class Watched:
    """A page plus the errors it logged."""

    def __init__(self, page):
        self.page, self.errors = page, []
        page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: m.type == "error" and not any(s in m.text for s in IGNORED)
                and self.errors.append(f"console: {m.text}"))


@pytest.fixture
def page(browser):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    w = Watched(ctx.new_page())
    yield w
    ctx.close()
    assert not w.errors, "\n".join(w.errors)


@pytest.fixture
def phone(browser):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    w = Watched(ctx.new_page())
    yield w
    ctx.close()
    assert not w.errors, "\n".join(w.errors)
