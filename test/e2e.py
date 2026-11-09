"""End-to-end check of the deployed site in real Chromium.

Serves web/ locally, lets the page download the model from Hugging Face like a
user would, records from a fake microphone fed with a Ukrainian sample, then
transcribes the same sample as an imported file. Saves screenshots to screens/.
Usage: python test/e2e.py <web-dir> <wav-file>
"""
import functools
import http.server
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

web_dir, wav = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
shots = Path("screens")
shots.mkdir(exist_ok=True)

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(web_dir))
handler.log_message = lambda *a: None
server = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

with sync_playwright() as p:
    # A persistent profile, like a real user's browser (storage quota, cache).
    ctx = p.chromium.launch_persistent_context(
        "profile",
        args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={wav}",
            "--autoplay-policy=no-user-gesture-required",
        ],
        viewport={"width": 1280, "height": 860},
        permissions=["microphone"],
    )
    browser = ctx
    page = ctx.new_page()
    page.on("console", lambda m: print(f"[console.{m.type}] {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

    page.goto("http://127.0.0.1:8765/")
    page.wait_for_selector("#setup:not([hidden])")
    page.screenshot(path=shots / "1-setup.png")

    t0 = time.time()
    page.click("#load-model")
    page.wait_for_timeout(4000)
    page.screenshot(path=shots / "2-downloading.png")
    page.wait_for_function(
        """() => document.querySelector('#engine-state').dataset.state === 'ready'
               || (!document.querySelector('#error').hidden && !document.querySelector('#load-model').disabled)""",
        timeout=15 * 60 * 1000,
    )
    if page.get_attribute("#engine-state", "data-state") != "ready":
        page.screenshot(path=shots / "3-error.png")
        raise SystemExit("model failed to load: " + page.inner_text("#error"))
    print(f"model ready after {time.time() - t0:.0f} s")
    print("storage:", page.evaluate("navigator.storage.estimate().then(e => JSON.stringify(e))"))
    print("notice:", page.inner_text("#error") if page.is_visible("#error") else "-")
    page.screenshot(path=shots / "3-ready.png")

    # Live recording from the fake microphone.
    page.select_option("#language", "uk")
    page.click("#record")
    page.wait_for_timeout(16000)
    page.screenshot(path=shots / "4-recording.png")
    print("pace:", page.inner_text("#pace"))
    page.click("#stop")
    page.wait_for_selector("#sheet-actions:not([hidden])", timeout=120000)
    live_text = page.inner_text("#lines")
    print("LIVE TEXT:", live_text)
    page.screenshot(path=shots / "5-recorded.png", full_page=True)

    # File import.
    page.set_input_files("#file-input", str(wav))
    page.wait_for_selector("#file-progress:not([hidden])", timeout=30000)
    page.wait_for_selector("#file-progress", state="hidden", timeout=300000)
    file_text = page.inner_text("#lines")
    print("FILE TEXT:", file_text)
    page.screenshot(path=shots / "6-file.png", full_page=True)

    # Reload: the model must come from the cache and the archive must survive.
    t0 = time.time()
    page.reload()
    page.wait_for_selector('#engine-state[data-state="ready"]', timeout=5 * 60 * 1000)
    print(f"reload ready after {time.time() - t0:.0f} s; recordings: {page.locator('#recordings li').count()}")
    page.set_viewport_size({"width": 400, "height": 860})
    page.click("#recordings li button")
    page.wait_for_timeout(500)
    page.screenshot(path=shots / "7-mobile.png", full_page=True)

    browser.close()

ok = "країн" in live_text.lower() and "країн" in file_text.lower()
print("E2E OK" if ok else "E2E FAILED: text missing")
sys.exit(0 if ok else 1)
