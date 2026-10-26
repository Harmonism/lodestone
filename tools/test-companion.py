"""What 1.13 adds after the best AI companions, on the web app (phone mode, OpenRouter mocked):
the care layer (an indirect phrase, a sentence only the meaning model recognises, an ordinary
sentence left alone, the crisis gate still first), the pause bell after three hours of a sitting
and kept from the model, recall of an earlier conversation (named under the answer, forgotten on
request), key memories ("remember that…"), and the weekly review. The conversation by voice is in
test-web-parity.py, after its download of the speech model.

Usage: python3 tools/test-companion.py   (needs playwright and openssl; reuses test-web-parity.py's
cache of the speech model's files and the sample recording in ~/.cache/lodestone-tests/)"""
import importlib.util, json, os, ssl, subprocess, sys, tempfile, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "app"); TP = os.path.join(HERE, "test-phone.py")
REV = "2d67713f236afa48a18992566e7647f6ca848e13"
CACHE = os.path.expanduser("~/.cache/lodestone-tests")
WHISPER = os.path.join(CACHE, "whisper-small"); WAV = os.path.join(CACHE, "jfk.wav")
if not os.path.exists(os.path.join(WHISPER, "onnx", "decoder_model_merged_quantized.onnx")):
    print("Run tools/test-web-parity.py once first: it downloads the speech model's files this test reuses."); sys.exit(2)
sys.argv = [TP, APP]
spec = importlib.util.spec_from_file_location("tp", TP); tp = importlib.util.module_from_spec(spec); spec.loader.exec_module(tp)
calls = []

class Files(SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=WHISPER, **k)
    def log_message(s, *a): pass
    def end_headers(s): s.send_header("Access-Control-Allow-Origin", "*"); super().end_headers()

def https_files():
    d = tempfile.mkdtemp(); key, crt = os.path.join(d, "k.pem"), os.path.join(d, "c.pem")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "1", "-subj", "/CN=127.0.0.1"], check=True, capture_output=True)
    hs = ThreadingHTTPServer(("127.0.0.1", 8443), Files)
    cx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); cx.load_cert_chain(crt, key); hs.socket = cx.wrap_socket(hs.socket, server_side=True)
    threading.Thread(target=hs.serve_forever, daemon=True).start()

LONG = ("This week your words kept returning to your mother's treatment and to the breath practice. "
        "The morning practice held on four days; on the others the hospital took the hours. "
        "Your Wheel shows Presence ready to rise, if you agree. What would it mean to rest inside the waiting this week?")

def main():
    srv = ThreadingHTTPServer(("127.0.0.1", tp.PORT), tp.H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    https_files()
    res = []
    def check(n, ok, d=""): res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + n + (f" — {d}" if d else ""), flush=True)
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={WAV}", "--autoplay-policy=no-user-gesture-required"])
        ctx = b.new_context(viewport={"width": 1280, "height": 900})
        ctx.add_init_script("try { localStorage.setItem('lodestone-signin-ask', 'never'); } catch {}")
        ctx.grant_permissions(["microphone"], origin=f"http://localhost:{tp.PORT}")
        page = ctx.new_page(); errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.dismiss() if "write it out through" in d.message else d.accept())
        def orouter(route):
            req = route.request
            if req.method == "OPTIONS": return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
            body = json.loads(req.post_data or "{}"); calls.append(body)
            sysm = body.get("messages", [{}])[0].get("content", "")
            last = str(body.get("messages", [{}])[-1].get("content", ""))
            # 1.13.2: on a suspected moment the model reads it, and marks it when it is real (here, the two sentences that are)
            real = '<care_check level="ask">' in sysm and ("better off without me" in last or "waiting for it to be over" in last)
            words = ["ready"] if body.get("max_tokens") == 10 else [LONG] if "weekly review" in str(sysm) else ["Are you thinking of ending your life? Please tell someone now.\n[[care]]"] if real else ["An answer."]
            route.fulfill(status=200, content_type="text/event-stream", headers={"Access-Control-Allow-Origin": "*"}, body=tp.sse(words))
        page.route("https://openrouter.ai/**", orouter)
        def huggingface(route):
            u = route.request.url
            pre = f"https://huggingface.co/Xenova/whisper-small/resolve/{REV}/"
            if not u.startswith(pre): return route.fulfill(status=404)
            route.continue_(url="https://127.0.0.1:8443/" + u[len(pre):])
        page.route("https://huggingface.co/**", huggingface)
        page.goto(f"http://localhost:{tp.PORT}/lodestone-app/"); page.wait_for_selector("#setup:not([hidden])")
        check("the setup says Lodestone is an AI, for adults, and links the safety protocol", "is an AI, not a person" in page.text_content("#aiNotice") and "minors" in page.text_content("#aiNotice") and page.get_attribute("#aiNotice a", "href") == "safety.html")
        r = page.request.get(f"http://localhost:{tp.PORT}/lodestone-app/safety.html")
        check("the safety protocol is published with the app", r.ok and "Three layers" in r.text() and "pause bell" in r.text())
        page.wait_for_function("document.querySelectorAll('#tierChoices .choice').length > 0"); page.wait_for_timeout(400)
        page.click("#tierChoices .choice:has(strong:has-text('OpenRouter'))"); page.fill("#orKey", tp.GOOD)
        page.wait_for_function("document.querySelector('#orStatus').textContent.includes('works')", timeout=8000)
        page.check("#optSemantic"); page.click("#beginSetup"); page.wait_for_selector("#main:not([hidden])", timeout=180000)
        page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('OpenRouter')", timeout=20000)
        # the meaning model must be loaded for the meaning layer and for recall
        page.wait_for_function("/hybrid/.test(document.querySelector('#engineBadge').title)", timeout=240000)
        n_ans = lambda: page.evaluate("document.querySelectorAll('.msg.assistant:not(.notice) .body').length")
        def send(t, expect_call=True):
            k = n_ans(); n = len(calls); page.fill("#input", t); page.click("#sendBtn")
            page.wait_for_function(f"document.querySelectorAll('.msg.assistant:not(.notice) .body').length > {k}", timeout=60000); page.wait_for_timeout(700)
            return calls[-1] if len(calls) > n else None
        def new_thread():
            page.keyboard.press("Control+n"); page.wait_for_timeout(500)

        # ── the care layer
        body = send("Honestly, everyone would be better off without me.")
        sysm = body["messages"][0]["content"]
        check("an indirect phrase: the model is told to read it, and to mark it if real", '<care_check level="ask">' in sysm and "[[care]]" in sysm)
        page.wait_for_selector(".msg.notice.care", timeout=5000)
        care = page.text_content(".msg.notice.care")
        check("the model marked it: the app shows the crisis line beneath the answer", "befrienders" in care.lower() or "📞" in care, care[:160])
        check("the mark itself is never shown", "[[care" not in page.text_content("#chat"))
        check("Edit still reaches the exchange, past the notice (Retry retired, 1.14.1)", page.locator(".msg.user button.last-only:has-text('Edit')").count() == 1)
        body = send("I've stopped seeing a future for myself at all, I'm just waiting for it to be over.")
        check("a sentence no phrase catches: recognised by its meaning", "<care_check" in body["messages"][0]["content"])
        # 1.13.2: a short reply at a dinner read 0.98 once, and the line was shown under a plain answer
        new_thread(); notices = page.evaluate("document.querySelectorAll('.msg.notice.care').length")
        send("Friends of my wife, we are at a resto. What should I talk about?")
        body = send("I already know them")
        check("'I already know them' at a dinner: no care check, no crisis line", "<care_check" not in body["messages"][0]["content"] and page.evaluate("document.querySelectorAll('.msg.notice.care').length") == notices)
        body = send("I'm tired of my job and want to quit, how do I find my dharma?")
        check("an ordinary sentence is left alone", "<care_check" not in body["messages"][0]["content"])
        check("the care line is never sent to the model", "befrienders" not in json.dumps(body["messages"][1:]).lower())
        n = len(calls)
        k = n_ans(); page.fill("#input", "I want to kill myself"); page.click("#sendBtn")
        page.wait_for_function(f"document.querySelectorAll('.msg.assistant:not(.notice) .body').length > {k}", timeout=20000); page.wait_for_timeout(500)
        check("the crisis gate still answers first, with no model", len(calls) == n and page.evaluate("document.querySelector('.msg.assistant.crisis') !== null"))

        # 1.13.1: the gate reads a phone's apostrophe and a long journal to its end; plain words refer, ambiguous ones only ask
        n = len(calls)
        k = n_ans(); page.fill("#input", "I\u2019m going to kill myself tonight"); page.click("#sendBtn")
        page.wait_for_function(f"document.querySelectorAll('.msg.assistant:not(.notice) .body').length > {k}", timeout=20000); page.wait_for_timeout(400)
        check("a typographic apostrophe does not get past the crisis gate", len(calls) == n and page.evaluate("[...document.querySelectorAll('.msg.assistant.crisis')].length") >= 2)
        long = ("Today I walked by the river and thought about my work and my family. " * 90) + "I want to kill myself."
        k = n_ans(); page.fill("#input", long); page.click("#sendBtn")
        page.wait_for_function(f"document.querySelectorAll('.msg.assistant:not(.notice) .body').length > {k}", timeout=20000); page.wait_for_timeout(400)
        check("a journal of 6,000 characters ending in a crisis is read to its end", len(calls) == n)
        body = send("I want to die.")
        check("'I want to die' brings the crisis line", '<care_check level="refer">' in body["messages"][0]["content"])
        body = send("I'm tired of living in Paris, the rent is impossible.")
        check("'tired of living in Paris' asks the model to read closely, and shows no crisis line", '<care_check level="ask">' in body["messages"][0]["content"] or "<care_check" not in body["messages"][0]["content"])
        check("no crisis message reaches the model on a later turn", "kill myself" not in json.dumps(body["messages"][1:]).lower())

        # ── key memories
        new_thread()
        body = send("Remember that I am vegetarian and fast on Mondays.")
        notes = page.evaluate("(async () => (await (await import('./js/store.js')).kv.get('profile')).notes)()")
        check("'remember that…' keeps it in what Lodestone always knows, in their words", "I am vegetarian and fast on Mondays" in (notes or ""), notes)
        check("and the same turn's model has it, above anything inferred", "In their own words: what they asked you always to know" in body["messages"][0]["content"] and "vegetarian" in body["messages"][0]["content"])

        notes_before = page.evaluate("(async () => (await (await import('./js/store.js')).kv.get('profile')).notes)()")
        k = n_ans(); page.fill("#input", "Remember that I want to kill myself"); page.click("#sendBtn")
        page.wait_for_function(f"document.querySelectorAll('.msg.assistant:not(.notice) .body').length > {k}", timeout=20000); page.wait_for_timeout(500)
        send("Remember to breathe slowly when I panic, please.")
        notes_after = page.evaluate("(async () => (await (await import('./js/store.js')).kv.get('profile')).notes)()")
        check("a crisis said as 'remember that…' is never kept, nor 'remember to…'", notes_after == notes_before, notes_after)
        # ── recall across conversations: off by default where a rented model reads each turn, so chosen here
        page.evaluate("(async () => { const st = await import('./js/store.js'); const s = (await st.kv.get('settings')) || {}; s.recall = true; await st.kv.set('settings', s); })()")
        page.reload(); page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.wait_for_function("/hybrid/.test(document.querySelector('#engineBadge').title)", timeout=240000)
        new_thread()
        send("My mother Aicha starts her third cycle of chemotherapy on the second of November, at the Rabat clinic.")
        page.wait_for_timeout(6000)   # indexed in the background
        new_thread()
        body = send("How can I support my mother through her chemotherapy treatment next week?")
        sysm = body["messages"][0]["content"]
        check("a later conversation recalls what was said in an earlier one", "<earlier_conversations>" in sysm and "third cycle" in sysm, sysm[sysm.find("<earlier"):sysm.find("<earlier") + 300] if "<earlier" in sysm else "no block")
        check("the answer names the conversation it remembered from", page.locator(".sources.recalled").count() >= 1 and "Remembered from" in page.text_content(".sources.recalled"))
        page.click(".sources.recalled .rc-forget"); page.wait_for_timeout(800)
        new_thread()
        body = send("How can I support my mother through her chemotherapy treatment next week?")
        check("forgotten, it is not brought back", "third cycle" not in body["messages"][0]["content"])

        # ── the pause bell
        page.evaluate("(async () => { const st = await import('./js/store.js'); const now = Date.now(); await st.kv.set('sitting', { start: now - 3 * 3600e3 - 60e3, last: now - 60e3, bell: 0 }); })()")
        send("Thank you for staying with me through all of this.")
        page.wait_for_selector(".msg.notice.bell", timeout=5000)
        bell = page.text_content(".msg.notice.bell")
        check("three hours into a sitting, the pause bell says Lodestone is an AI and invites a pause", "I am an AI" in bell and "pause" in bell.lower())
        body = send("One more question about breath.")
        check("the bell rings once, and is never sent to the model", page.locator(".msg.notice.bell").count() == 1 and "I am an AI, not a person" not in json.dumps(body["messages"][1:]))

        # ── the weekly review
        page.evaluate("(async () => { const st = await import('./js/store.js'); const s = (await st.kv.get('settings')) || {}; s.review = { on: true, day: 0, hour: 18 }; await st.kv.set('settings', s); })()")
        page.reload(); page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.wait_for_function("/hybrid/.test(document.querySelector('#engineBadge').title)", timeout=240000)
        page.click("#btnMe"); page.wait_for_selector("#drawerMe:not([hidden])", timeout=15000)
        page.wait_for_function("!!document.querySelector('#reviewNow')", timeout=15000)
        check("Your path offers the weekly review, on when chosen", page.is_checked("#reviewOn"))
        n = len(calls)
        page.evaluate("document.querySelector('#reviewNow').click()")
        page.wait_for_function("document.querySelector('.msg.assistant .body') && document.querySelector('.msg.assistant .body').textContent.includes('rest inside the waiting')", timeout=30000)
        rv = calls[-1]["messages"][0]["content"] if len(calls) > n else ""
        check("the review is written from the week's material, into a conversation of its own", "<the_week>" in rv and "third cycle" in rv and "The week ·" in page.text_content("body"), rv[:120])

        # (a conversation by voice is checked in tools/test-web-parity.py, after the speech model's download there)
        check("no page errors", not errors, "; ".join(errors)[:400])
        b.close()
    print(f"{sum(res)} of {len(res)} passed")
    sys.exit(0 if all(res) else 1)
main()
