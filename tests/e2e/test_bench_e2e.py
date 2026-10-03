"""The bench in a real browser (Build spec v2, Tests: E2E). Fixtures in conftest.py.

Each test drives the page the way a visitor does and checks what they'd see; every page also
fails its test on any script error or console error (conftest.Watched)."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

RECORDINGS = {
    "hello-answer": "examples/hello-answer.recording.jsonl",
    "req-012-approved": "recordings/req-012-approved.recording.jsonl",   # a ticket, approved at the gate
    "req-019": "recordings/req-019.recording.jsonl",                     # handed to a person
}
ANSWER = "recordings/req-005.recording.jsonl"                             # an answer: handbook text given to the AI
HELPDESK_APP = ROOT.parent / "agent-lab/request-queue/dist/slack-helpdesk/index.html"
MODES = ("presentation", "engineering")


def open_replay(w, site, name, mode, pause=False, speed=4):
    q = f"?replay={RECORDINGS.get(name, name)}&mode={mode}&speed={speed}" + ("" if pause else "&pause=0")
    w.page.goto(f"{site}/bench/{q}")
    w.page.wait_for_selector(f"#bench.mode-{mode}")
    return w.page


def wait_done(page, mode):
    if mode == "presentation":
        page.wait_for_selector("[data-p=transport] button.main[data-act=restart]", timeout=30_000)
    else:
        page.wait_for_function("document.getElementById('cPlay').textContent === 'Replay'", timeout=30_000)


def no_hscroll(page):
    return page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")


# ---- both modes, three recordings ------------------------------------------------------------
@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("name", list(RECORDINGS))
def test_replay_plays_to_the_end(page, site, name, mode):
    p = open_replay(page, site, name, mode)
    wait_done(p, mode)
    if mode == "presentation":
        out = p.inner_text("[data-p=outcome]")
        expect = {"hello-answer": "Answered", "req-012-approved": "approved by a person", "req-019": "Handed to a person"}[name]
        assert expect in out
        rows = p.inner_text("[data-p=rows]")
        for q in ("What it looked at", "How it was checked", "Who signed off"):
            assert q in rows
        # Hidden in Presentation: tokens, raw JSON, the event log.
        assert "tokens" not in p.inner_text(".pres") and not p.is_visible(".eng")
    else:
        assert p.is_visible(".eng") and not p.is_visible(".pres")
        assert "model i/o" in p.inner_text(".eng").lower()
        assert p.locator(".eng .gnode").count() > 3


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("name", ["hello-answer", "req-012-approved"])
def test_no_horizontal_scroll_at_390(phone, site, name, mode):
    p = open_replay(phone, site, name, mode)
    wait_done(p, mode)
    assert no_hscroll(p), "horizontal scroll at 390 px"


def test_mode_toggle_switches_and_is_remembered(page, site):
    p = open_replay(page, site, "hello-answer", "presentation")
    wait_done(p, "presentation")
    p.click(".pres .viewtoggle button[data-v=engineering]")
    p.wait_for_selector("#bench.mode-engineering")
    assert p.is_visible(".eng") and p.evaluate("localStorage.getItem('bench.mode')") == "engineering"
    p.click(".eng .viewtoggle button[data-v=presentation]")
    p.wait_for_selector("#bench.mode-presentation")
    p.evaluate("localStorage.removeItem('bench.mode')")


# ---- step-through --------------------------------------------------------------------------
def now_title(p):
    return p.inner_text("[data-p=now] .p-nowhead b")


def test_step_through_pauses_at_moments_and_steps_back(page, site):
    p = open_replay(page, site, "req-012-approved", "presentation", pause=True)
    # Play stops by itself at the first moment (the classify decision), with a Continue.
    p.wait_for_selector("[data-p=now] [data-act=play]", timeout=20_000)
    first = now_title(p)
    assert "Paused" in p.inner_text("[data-p=outcome]")
    p.click("[data-p=transport] [data-act=next]")
    p.wait_for_function("t => document.querySelector('[data-p=now] .p-nowhead b').textContent !== t", arg=first, timeout=15_000)
    second = now_title(p)
    p.click("[data-p=transport] [data-act=back]")
    p.wait_for_function("t => document.querySelector('[data-p=now] .p-nowhead b').textContent === t", arg=first, timeout=15_000)
    assert second != first
    # After stepping back it's paused (not at a moment): Play goes on to the next moment.
    p.click("[data-p=transport] [data-act=play]")
    p.wait_for_function("t => document.querySelector('[data-p=now] .p-nowhead b').textContent !== t", arg=first, timeout=20_000)


def test_keys_step_and_a_single_step_reads_as_paused(page, site):
    p = open_replay(page, site, "req-012-approved", "presentation", pause=True)
    p.wait_for_selector("[data-p=now] [data-act=play]", timeout=20_000)
    first = now_title(p)
    p.keyboard.press("ArrowRight")
    # A single step never shows the Pause button: it is a step, not Play.
    assert p.locator("[data-p=transport] [data-act=pause]").count() == 0
    p.wait_for_function("t => document.querySelector('[data-p=now] .p-nowhead b').textContent !== t", arg=first, timeout=15_000)
    p.keyboard.press("ArrowLeft")
    p.wait_for_function("t => document.querySelector('[data-p=now] .p-nowhead b').textContent === t", arg=first, timeout=15_000)
    assert "▶ Continue" in p.inner_text("[data-p=transport]")


# ---- open a source --------------------------------------------------------------------------
def test_open_a_source_shows_the_text_the_ai_was_given(page, site):
    p = open_replay(page, site, ANSWER, "presentation")
    wait_done(p, "presentation")
    p.click("[data-act=row][data-arg=looked]")
    tile = p.locator(".tile.st-given").first
    assert tile.count(), "no source item was given to the AI"
    tile.click()
    item = p.locator(".p-item")
    item.wait_for()
    assert "given to the AI, word for word" in item.inner_text()
    assert len(item.locator("pre.io").inner_text()) > 40


# ---- "What the AI was given" overlay ---------------------------------------------------------
def test_given_overlay_opens_and_closes(page, site):
    p = open_replay(page, site, "req-012-approved", "presentation")
    wait_done(p, "presentation")
    # Only a step where the AI was asked something offers it; the last step (the app's) doesn't.
    assert p.locator("[data-p=now] [data-act=given]").count() == 0
    p.click(".pres .gnode[data-node=propose_action]")
    p.click("[data-p=now] [data-act=given]")
    ov = p.locator("[data-p=overlay]")
    ov.wait_for(state="visible")
    text = ov.inner_text().lower()   # (role labels are styled uppercase)
    assert "what the ai was given" in text and "what the app sent it" in text and "what it answered" in text
    assert "{" not in text.split("\n")[0]
    assert ov.locator("mark").count() > 0, "retrieved handbook text should be highlighted in the prompt"
    # The ticket step's answer form (from params.json_schema) and its JSON answer, as rows.
    assert "the form it had to fill in" in text and "action type" in text
    assert ov.locator(".g-call.focus .g-answer dt", has_text="title").count() == 1
    assert '{"action_type"' not in ov.locator(".g-call.focus").inner_text()   # the raw JSON is folded away
    p.click("[data-p=overlay] .p-close")
    ov.wait_for(state="hidden")
    p.click("[data-p=now] [data-act=given]")
    ov.wait_for(state="visible")
    p.keyboard.press("Escape")
    ov.wait_for(state="hidden")


# ---- the shell, side by side, synced by postMessage -------------------------------------------
def test_shell_side_by_side_follows_the_app(page, site):
    if not HELPDESK_APP.exists():
        pytest.skip("helpdesk static app not built (request-queue: uv run scripts/export_static.py --out dist/slack-helpdesk)")
    p = page.page
    p.goto(f"{site}/bench/shell/?sync=1&app=/apps/slack-helpdesk/&home=/&back=/lab/&title=Slack%20Helpdesk%20Agent")
    app = p.frame_locator("#appFrame")
    bench = p.frame_locator("#benchFrame")
    bench.locator("#bench.mode-presentation").wait_for()
    app.get_by_role("button", name="req-012").click()
    # The bench follows the app's run to the gate, then the approval made in the app.
    bench.locator("[data-p=outcome]", has_text="Waiting for a person to approve").wait_for(timeout=40_000)
    app.get_by_role("button", name="Approve").click()
    bench.locator("[data-p=outcome]", has_text="approved by a person").wait_for(timeout=40_000)
    assert "Approved" in bench.locator("[data-p=rows]").inner_text()
    # The app's replay keeps the recording's times: the work reads the same as the bench's own replay (7.7 s).
    assert "AI work: 7.7 s" in bench.locator("[data-p=bottom]").inner_text()
    # Step through it here, paced like a recording, then back to following the app.
    bench.locator("[data-p=transport] [data-act=stepthrough]").click()
    bench.locator("[data-p=now] [data-act=play]").wait_for(timeout=20_000)     # paused at the first moment
    assert "Paused" in bench.locator("[data-p=outcome]").inner_text()
    bench.locator("[data-p=transport] [data-act=follow]").click()
    bench.locator("[data-p=outcome]", has_text="approved by a person").wait_for(timeout=10_000)
    assert bench.locator("[data-p=transport] [data-act=stepthrough]").count() == 1


# ---- Level 0: a real Pydantic AI app, no map, no bench code ----------------------------------
def test_level0_pydantic_ai_draws_an_inferred_map(page, live_bench):
    if not shutil.which("uv"):
        pytest.skip("uv not installed (the example is a PEP 723 script)")
    env = dict(os.environ, OTEL_EXPORTER_OTLP_ENDPOINT=live_bench, OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf",
               OTEL_SERVICE_NAME="level0-e2e", OTEL_BSP_SCHEDULE_DELAY="100")
    r = subprocess.run(["uv", "run", "--quiet", "examples/level0_pydantic_ai.py", "How do I reset my VPN password?"],
                       cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    if r.returncode != 0 and ("Failed to fetch" in r.stderr or "network" in r.stderr.lower()):
        pytest.skip("the example's dependencies couldn't be fetched (offline?)")
    assert r.returncode == 0, r.stderr[-2000:]
    assert "From the handbook" in r.stdout
    p = page.page
    p.goto(f"{live_bench}/?app=level0-e2e&mode=engineering")
    p.wait_for_selector("#bench.mode-engineering")
    chat = p.locator(".eng .gnode[data-node='chat helpdesk']")
    chat.wait_for(timeout=15_000)
    assert p.locator(".eng [data-f=inferred]").is_visible(), "should say the map is inferred"
    nodes = p.eval_on_selector_all(".eng .gnode", "els => els.map(e => e.getAttribute('data-node'))")
    assert any(n.startswith("execute_tool") for n in nodes), nodes
    # The path is lit: the model call and the tool call ran (children of the root agent span are steps).
    p.wait_for_function("() => /\\bdone\\b/.test(document.querySelector(\".eng .gnode[data-node='chat helpdesk']\").className)", timeout=10_000)
    tool = [n for n in nodes if n.startswith("execute_tool")][0]
    p.wait_for_function("t => /\\bdone\\b/.test(document.querySelector(`.eng .gnode[data-node='${t}']`).className)", arg=tool, timeout=10_000)
    assert p.locator(".eng .edge.taken").count() >= 2
    io = p.locator(".eng .panel", has_text="Model I/O")
    io.locator(".pbody", has_text="reset my VPN password").wait_for(timeout=10_000)
    # And Presentation draws the same inferred map with the request on top.
    p.click(".eng .viewtoggle button[data-v=presentation]")
    p.wait_for_selector("#bench.mode-presentation")
    assert p.locator(".pres [data-p=inferred]").is_visible()
    assert "reset my VPN password" in p.inner_text("[data-p=req]")
    p.wait_for_function("() => document.querySelector(\"[data-p=now] .p-nowhead b\").textContent !== ''", timeout=10_000)
    assert "didn’t run" not in p.inner_text("[data-p=now]")
    assert "AI cost not known" in p.inner_text("[data-p=bottom]"), "an unpriced model is unknown, never free"
    p.evaluate("localStorage.removeItem('bench.mode')")
    # Another app's runs stay off this app's page.
    r = subprocess.run(["uv", "run", "--quiet", "examples/level0_pydantic_ai.py", "Where is the printer?"], cwd=ROOT,
                       env={**env, "OTEL_SERVICE_NAME": "level0-other"}, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-2000:]
    p.goto(f"{live_bench}/?app=level0-e2e&mode=engineering")
    p.wait_for_selector(".eng .gnode")
    p.wait_for_timeout(800)
    assert "printer" not in p.inner_text(".eng select[data-f=runs]").lower()
