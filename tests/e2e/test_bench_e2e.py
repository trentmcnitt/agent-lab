"""The bench in a real browser (Build spec v2, Tests: E2E). Fixtures in conftest.py.

Each test drives the page the way a visitor does and checks what they'd see; every page also
fails its test on any script error or console error (conftest.Watched)."""
from __future__ import annotations

import os
import re
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
    # &play=1: these tests watch it play (a recording otherwise opens paused on its first step).
    q = f"?replay={RECORDINGS.get(name, name)}&mode={mode}&speed={speed}&play=1" + ("" if pause else "&pause=0")
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
        out = p.inner_text("[data-p=status]")
        expect = {"hello-answer": "Answered", "req-012-approved": "approved by a person", "req-019": "Handed to a person"}[name]
        assert expect in out
        # The panel is on the last step, numbered; the step points at it across the divider.
        assert p.locator(".pres .gnode.focus").count() == 1
        assert p.locator("[data-p=bubble] .bb-num").count() == 1
        assert p.is_visible("[data-p=mk] .tab") and p.is_visible("[data-p=divider]") and p.is_visible("[data-p=notch]")
        # One more step forward is the recap: the four questions.
        p.keyboard.press("ArrowRight")
        p.wait_for_selector("[data-p=bubble] .rc")
        recap = p.inner_text("[data-p=bubble]").lower()
        for q in ("what did it do?", "what did it look at?", "how was it checked?", "did a person sign off?"):
            assert q in recap
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
    p.click(".topbar .viewtoggle button[data-v=engineering]")
    p.wait_for_selector("#bench.mode-engineering")
    assert p.is_visible(".eng") and p.evaluate("localStorage.getItem('bench.mode')") == "engineering"
    p.click(".topbar .viewtoggle button[data-v=presentation]")
    p.wait_for_selector("#bench.mode-presentation")
    p.evaluate("localStorage.removeItem('bench.mode')")


@pytest.mark.parametrize("width", [1920, 960])
def test_mode_switch_is_one_and_never_moves(page, site, width):
    # One switch, in the bar on top, at the same spot in both modes (a narrow Engineering header
    # used to wrap its own copy to the left of a second row).
    p = open_replay(page, site, "req-012-approved", "presentation")
    p.set_viewport_size({"width": width, "height": 900})
    assert p.locator(".viewtoggle").count() == 1
    box = lambda: p.locator(".viewtoggle").bounding_box()
    pres = box()
    p.click(".topbar .viewtoggle button[data-v=engineering]")
    p.wait_for_selector("#bench.mode-engineering")
    eng = box()
    assert abs(pres["x"] - eng["x"]) < 1 and abs(pres["y"] - eng["y"]) < 1, (pres, eng)
    assert pres["x"] + pres["width"] > width - 40, "the switch sits at the right"
    p.evaluate("localStorage.removeItem('bench.mode')")


# ---- step-through --------------------------------------------------------------------------
def now_title(p):
    return p.inner_text("[data-p=bubble] .bb-name")


def test_step_through_pauses_at_moments_and_steps_back(page, site):
    p = open_replay(page, site, "req-012-approved", "presentation", pause=True)
    # Play stops by itself at the first moment (the classify decision), with a Continue.
    p.wait_for_selector("[data-p=bubble] [data-act=play]", timeout=20_000)
    first = now_title(p)
    assert "Paused" in p.inner_text("[data-p=status]")
    p.click("[data-p=transport] [data-act=next]")
    p.wait_for_function("t => document.querySelector('[data-p=bubble] .bb-name').textContent !== t", arg=first, timeout=15_000)
    second = now_title(p)
    p.click("[data-p=transport] [data-act=back]")
    p.wait_for_function("t => document.querySelector('[data-p=bubble] .bb-name').textContent === t", arg=first, timeout=15_000)
    assert second != first
    # After stepping back it's paused (not at a moment): Play goes on to the next moment.
    p.click("[data-p=transport] [data-act=play]")
    p.wait_for_function("t => document.querySelector('[data-p=bubble] .bb-name').textContent !== t", arg=first, timeout=20_000)


def test_keys_step_and_a_single_step_reads_as_paused(page, site):
    p = open_replay(page, site, "req-012-approved", "presentation", pause=True)
    p.wait_for_selector("[data-p=bubble] [data-act=play]", timeout=20_000)
    first = now_title(p)
    p.keyboard.press("ArrowRight")
    # A single step never shows the Pause button: it is a step, not Play.
    assert p.locator("[data-p=transport] [data-act=pause]").count() == 0
    p.wait_for_function("t => document.querySelector('[data-p=bubble] .bb-name').textContent !== t", arg=first, timeout=15_000)
    p.keyboard.press("ArrowLeft")
    p.wait_for_function("t => document.querySelector('[data-p=bubble] .bb-name').textContent === t", arg=first, timeout=15_000)
    assert "▶ continue" in p.inner_text("[data-p=transport]").lower()


# ---- open a source --------------------------------------------------------------------------
def test_open_a_source_shows_the_text_the_ai_was_given(page, site):
    p = open_replay(page, site, ANSWER, "presentation")
    wait_done(p, "presentation")
    # The search step's callout shows the source's items as tiles; a given one opens to its text.
    p.click(".pres .gnode[data-node=retrieve]")
    tile = p.locator("[data-p=bubble] .bb-tile.st-given").first
    assert tile.count(), "no source item was given to the AI"
    assert "given to the AI" in p.inner_text("[data-p=bubble] .bb-countline")
    tile.click()
    item = p.locator(".b-item")
    item.wait_for()
    assert "given to the AI, word for word" in item.inner_text()
    assert len(item.locator("pre.io").inner_text()) > 40


# ---- "What the AI was given" overlay ---------------------------------------------------------
def test_given_overlay_opens_and_closes(page, site):
    p = open_replay(page, site, "req-012-approved", "presentation")
    wait_done(p, "presentation")
    # Only a step where the AI was asked something offers it; the last step (the app's) doesn't.
    assert p.locator("[data-p=bubble] [data-act=given]").count() == 0
    p.click(".pres .gnode[data-node=propose_action]")
    p.click("[data-p=bubble] [data-act=given]")
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
    p.click("[data-p=bubble] [data-act=given]")
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
    bench.locator("[data-p=status]", has_text="Waiting for a person to approve").wait_for(timeout=40_000)
    app.get_by_role("button", name="Approve").click()
    bench.locator("[data-p=status]", has_text="approved by a person").wait_for(timeout=40_000)
    bench.locator(".ps-key[data-act=recap]").click()
    assert "Approved" in bench.locator("[data-p=bubble]").inner_text()
    bench.locator(".ps-key[data-act=recap]").click()
    # The app's replay keeps the recording's times: the work reads as the bench's own replay does (7.x s).
    assert re.search(r"AI work\s+7\.\d s", bench.locator("[data-p=bottom]").inner_text())
    # Step through it here, paced like a recording, then back to following the app.
    bench.locator("[data-p=transport] [data-act=stepthrough]").click()
    bench.locator("[data-p=bubble] [data-act=play]").wait_for(timeout=20_000)     # paused at the first moment
    assert "Paused" in bench.locator("[data-p=status]").inner_text()
    bench.locator("[data-p=transport] [data-act=follow]").click()
    bench.locator("[data-p=status]", has_text="approved by a person").wait_for(timeout=10_000)
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
    p.click(".topbar .viewtoggle button[data-v=presentation]")
    p.wait_for_selector("#bench.mode-presentation")
    assert p.locator(".topbar [data-p=inferred]").is_visible()
    assert "reset my VPN password" in p.inner_text("[data-p=req]")
    p.wait_for_function("() => (document.querySelector(\"[data-p=bubble] .bb-name\") || {}).textContent", timeout=10_000)
    assert "didn’t come this way" not in p.inner_text("[data-p=bubble]")
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


# ---- a library app, live: the run's own map, the declared request and reply -------------------
def test_a_langgraph_app_live_draws_the_map_its_run_carried(page, live_bench):
    """The page is open before the app ever runs (no map yet: Level 0). The quickstart's run
    carries its map; the page switches to it and reads the request and reply the app declared."""
    if not shutil.which("uv"):
        pytest.skip("uv not installed")
    p = page.page
    p.goto(f"{live_bench}/?app=support-assistant&mode=presentation")
    p.wait_for_selector("#bench.mode-presentation")
    example = ROOT / "examples/langgraph_quickstart"
    env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
    r = subprocess.run(["uv", "run", "--quiet", "--project", str(example), "python", "-m", "support_bot",
                        "How do I reset my password?"], cwd=example, env={**env, "AGENT_LAB_URL": live_bench},
                       capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr[-2000:]
    # The run's own map (its words), not an inferred one.
    p.locator(".pres .gnode[data-node=check_grounding]").wait_for(timeout=15_000)
    assert not p.locator(".pres [data-p=inferred]").is_visible()
    p.locator("[data-p=status]", has_text="Finished").wait_for(timeout=15_000)
    # The declared fields: the request, and the reply rather than the whole final state as JSON.
    assert "How do I reset my password?" in p.inner_text("[data-p=req]")
    reply = p.locator("[data-p=bubble] .bb-quote.reply")
    reply.wait_for(timeout=15_000)
    said = r.stdout.strip().splitlines()[-1]
    assert " ".join(reply.inner_text().split()) == " ".join(said.split()), (reply.inner_text(), said)
    # Engineering: the map's own checks (from the app's verify, and from this run) are clean.
    p.click(".topbar .viewtoggle button[data-v=engineering]")
    checks = p.locator(".eng .panel", has_text="Checks on this map")
    checks.wait_for()
    assert checks.locator(".mc-error, .mc-warning").count() == 0, checks.inner_text()
    p.evaluate("localStorage.removeItem('bench.mode')")


# ---- the stage: deep links, the presenter's keys, the recap ------------------------------------
def test_deep_link_opens_paused_at_the_gate_with_the_exact_proposal(page, site):
    w = page
    w.page.goto(f"{site}/bench/?replay={RECORDINGS['req-012-approved']}&mode=presentation&at=approval_gate")
    p = w.page
    p.wait_for_selector("[data-p=bubble] .bb-proposal.waiting")
    assert "Waiting for a person" in p.inner_text("[data-p=status]")
    bub = p.inner_text("[data-p=bubble]")
    assert "pressed in the app, not here" in bub
    assert "Approved by" not in bub, "nothing after the pause is shown"
    # The sign-off's node is the focus; the earlier steps are numbered in run order.
    assert "gatewait" in p.get_attribute(".pres .gnode[data-node=approval_gate]", "class")
    assert p.inner_text(".pres .gnode[data-node=ingest] .s-num") == "1"


def test_presenter_keys_map_only_and_recap(page, site):
    w = page
    w.page.goto(f"{site}/bench/?replay={RECORDINGS['req-012-approved']}&mode=presentation&at=classify")
    p = w.page
    p.wait_for_selector("[data-p=bubble] .bb-card.chosen")
    p.keyboard.press("m")
    p.wait_for_selector("#bench.p-maponly")
    assert not p.is_visible("[data-p=bubble]")
    p.keyboard.press("m")
    p.wait_for_selector("[data-p=bubble] .bb-card.chosen")
    p.keyboard.press("r")
    p.wait_for_selector("[data-p=bubble] .rc")
    p.keyboard.press("ArrowLeft")   # back out of the recap first
    p.wait_for_selector("[data-p=bubble] .bb-card.chosen")
    # Space is the clicker's "next".
    first = now_title(p)
    p.keyboard.press(" ")
    p.wait_for_function("t => document.querySelector('[data-p=bubble] .bb-name').textContent !== t", arg=first, timeout=15_000)


# ---- a presenter with a clicker (usability round v3/6) ------------------------------------------
def test_a_recording_opens_paused_on_step_one_and_every_press_counts(page, site):
    w = page
    w.page.goto(f"{site}/bench/?replay={RECORDINGS['req-012-approved']}&mode=presentation")
    p = w.page
    p.wait_for_selector("[data-p=bubble] .bb-num")
    # Paused on the first step (the pill holds the state only), with the keys one press away in
    # the footer: the presenter talks first.
    assert p.inner_text("[data-p=bubble] .bb-num") == "1"
    status = p.inner_text("[data-p=status]")
    assert "Paused at step 1" in status and "PageDown" not in status
    assert "PageDown" in p.get_attribute(".ps-help", "title")
    p.wait_for_timeout(1200)
    assert p.inner_text("[data-p=bubble] .bb-num") == "1", "it doesn't play by itself"
    # Two quick presses are two steps (a clicker double-tap), not one press lost.
    p.keyboard.press("PageDown")
    p.keyboard.press("PageDown")
    p.wait_for_function("document.querySelector('[data-p=bubble] .bb-num').textContent === '3'", timeout=10_000)
    # Home: back to the first step; ? lists the keys.
    p.keyboard.press("Home")
    p.wait_for_function("document.querySelector('[data-p=bubble] .bb-num').textContent === '1'", timeout=10_000)
    p.keyboard.press("?")
    p.wait_for_selector("[data-p=bubble] .ps-keys")
    assert "PageDown" in p.inner_text("[data-p=bubble] .ps-keys")
    p.keyboard.press("Escape")
    p.wait_for_selector("[data-p=bubble] .ps-keys", state="detached")


def test_the_recap_scrolls_from_the_keyboard_and_the_whole_request_shows(page, site):
    w = page
    w.page.set_viewport_size({"width": 1280, "height": 620})
    w.page.goto(f"{site}/bench/?replay=recordings/req-021.recording.jsonl&mode=presentation&at=end&recap=1")
    p = w.page
    p.wait_for_selector("[data-p=bubble] .rc")
    # The request is never cut: a trick at its end is the point of this one.
    assert "ignore" in p.inner_text("[data-p=req]").lower()
    room = p.evaluate("(() => { const b = document.querySelector('[data-p=bubble]'); return b.scrollHeight - b.clientHeight; })()")
    if room > 0:
        p.keyboard.press("PageDown")
        p.wait_for_function("document.querySelector('[data-p=bubble]').scrollTop > 0")
        assert p.locator("[data-p=bubble] .rc").count() == 1, "PageDown scrolls the recap before it does anything else"
    recap = p.inner_text("[data-p=bubble]").lower()
    assert "why, in the ai" in recap and "not needed this time" in recap


def test_try_another_starts_the_new_request_at_its_first_step(page, site):
    w = page
    w.page.goto(f"{site}/bench/?replay={RECORDINGS['req-012-approved']}&mode=presentation&at=classify&recap=1")
    p = w.page
    p.wait_for_selector("[data-p=picker] select")
    p.select_option("[data-p=picker] select", "recordings/req-021.recording.jsonl")
    p.wait_for_url(re.compile(r"req-021"))
    assert "at=" not in p.url and "recap=" not in p.url
    p.wait_for_selector("[data-p=bubble] .bb-num")
    assert p.inner_text("[data-p=bubble] .bb-num") == "1"


@pytest.mark.parametrize("size", [(1920, 1080), (960, 720)])
def test_stage_boxes_fit_their_words_and_edges_show_a_shaft(page, site, size):
    # Every box holds its name (at most two lines, never clipped) and its line under it, inside the
    # box; and an edge between stacked boxes is longer than its arrowhead.
    p = page.page
    p.set_viewport_size({"width": size[0], "height": size[1]})
    p.goto(f"{site}/bench/?replay={RECORDINGS['req-012-approved']}&mode=presentation&at=end")
    p.wait_for_selector("[data-p=transport] button.main[data-act=restart]", timeout=30_000)
    bad = p.evaluate("""() => [...document.querySelectorAll('.ps-map .snode')].filter(n => {
        const gl = n.querySelector('.gl'), m = n.querySelector('.s-meta'), r = n.getBoundingClientRect();
        return gl.scrollHeight > gl.clientHeight + 1 || (m.textContent && m.getBoundingClientRect().bottom > r.bottom + 0.5);
      }).map(n => n.dataset.node)""")
    assert bad == [], bad
    # The straight edge from the first step to the second: its length on screen beats the arrowhead's.
    shaft = p.evaluate("""() => {
        const a = document.querySelector('.ps-map .gnode[data-node=ingest]').getBoundingClientRect();
        const b = document.querySelector('.ps-map .gnode[data-node=retrieve]').getBoundingClientRect();
        const m = document.querySelector('.ps-map marker#parr-t'), k = a.height / document.querySelector('.ps-map .gnode[data-node=ingest]').offsetHeight;
        return (b.top - a.bottom) - Number(m.getAttribute('markerWidth')) * k;
      }""")
    assert shaft >= 8, f"edge shaft {shaft:.1f}px"
    # The footer's words are never under its controls.
    over = p.evaluate("""() => {
        const c = document.querySelector('.ps-ctl').getBoundingClientRect();
        return [...document.querySelectorAll('[data-p=bottom] .fi')].filter(e => {
          const r = e.getBoundingClientRect();
          return r.right > c.left + 1 && r.left < c.right - 1 && r.bottom > c.top + 1 && r.top < c.bottom - 1;
        }).map(e => e.textContent)
      }""")
    assert over == [], over


# ---- S4: calls inside one step, documents grouped by file ------------------------------------------
def test_an_agent_loop_step_lists_its_calls_in_order_in_both_modes(page, site):
    p = page.page
    p.set_viewport_size({"width": 1920, "height": 1080})
    p.goto(f"{site}/bench/?replay=examples/agent-loop.recording.jsonl&mode=presentation&at=end")
    p.wait_for_selector("[data-p=transport] button.main[data-act=restart]", timeout=30_000)
    assert "6 calls" in p.inner_text(".pres .gnode[data-node=research] .s-meta")
    p.click(".pres .gnode[data-node=research]")
    p.wait_for_selector("[data-p=bubble] .bb-call")
    calls = p.locator("[data-p=bubble] .bb-call")
    assert calls.count() == 6
    assert [calls.nth(i).locator(".who2").inner_text().lower() for i in range(6)] == ["ai", "tool", "ai", "tool", "tool", "ai"]
    assert p.locator("[data-p=bubble] .same").count() == 2, "the two tools asked for at once are marked"
    assert "inside this step" in p.inner_text("[data-p=strip]")
    p.click(".viewtoggle button[data-v=engineering]")     # the selected step carries over
    rows = p.locator(".eng .wf details.wfr")
    rows.first.wait_for()
    assert rows.count() == 6
    rows.nth(2).locator("summary").click()
    assert "asked for" in rows.nth(2).inner_text()
    p.evaluate("localStorage.removeItem('bench.mode')")
