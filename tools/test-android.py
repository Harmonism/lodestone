"""Headless test of the Lodestone app for Android's web side and Lodestone Desktop's pairing.

Usage: python3 tools/test-android.py [path/to/lodestone/app] [path/to/lodestone/desktop/src]
(needs: node with the desktop's node_modules or `tar` on NODE_PATH; pip install playwright)

The Android shell itself cannot run here; what it adds to the page is stood in
for: window.Capacitor (isNativePlatform, the App plugin's launch URL and
appUrlOpen) and the "Lodestone-Android" user agent. Lodestone Desktop's phone server
runs without Electron (tools/desktop-phone-server.cjs): the real server.js,
pairing.js and syncstore.js, with a mock model. The app is served at
http://localhost:8795/lodestone-app/, the computer at http://127.0.0.1:47999,
which answers that origin as it answers https://harmonism.io in use.
"""
import json, os, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "app"))
SRC = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "desktop", "src"))
ROOT = tempfile.mkdtemp(prefix="lodestone-android-test-")
os.symlink(APP, os.path.join(ROOT, "lodestone-app"))
DATA = os.path.join(ROOT, "desktop-data"); os.mkdir(DATA)
PORT, DESK, CTL = 8795, 47999, 47998
ORIGIN = f"http://localhost:{PORT}"
BASE = f"http://127.0.0.1:{DESK}"
PASS = "seven cedars over the quiet lake"

CAP = """
window.Capacitor = { isNativePlatform: () => true, Plugins: { App: {
  _l: [], addListener(n, f) { if (n === 'appUrlOpen') this._l.push(f); return { remove() {} }; },
  getLaunchUrl: async () => (window.__launch ? { url: window.__launch } : null) } } };
window.__openLink = url => window.Capacitor.Plugins.App._l.forEach(f => f({ url }));
"""


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


def ctl(path):
    return json.loads(urllib.request.urlopen(f"http://127.0.0.1:{CTL}{path}").read())


def req(method, path, body=None, headers=None):
    r = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers or {})
    try:
        x = urllib.request.urlopen(r); return x.status, dict(x.headers), x.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    desk = subprocess.Popen(["node", os.path.join(HERE, "desktop-phone-server.cjs"), SRC, APP, str(DESK), str(CTL), DATA, ORIGIN],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert desk.stdout.readline().strip() == "ready", "desktop server did not start"
    results = []
    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail)); print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)

    # ── the computer, from the network ──────────────────────────────────────
    st, h, b = req("OPTIONS", "/munai-sync", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true"})
    check("the app's origin may reach the sync route, private network included", st == 204 and h.get("Access-Control-Allow-Origin") == ORIGIN and h.get("Access-Control-Allow-Private-Network") == "true", str(st))
    st, h, b = req("OPTIONS", "/munai-sync", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    check("another origin may not", st == 405 and "Access-Control-Allow-Origin" not in h, str(st))
    st, h, b = req("GET", "/lodestone-app/", headers={"Origin": ORIGIN})
    check("the app's origin gets no CORS on the rest of the server", "Access-Control-Allow-Origin" not in h)
    st, h, b = req("GET", "/munai-sync?meta=1")
    check("sync needs a paired phone's token", st == 401, str(st))
    st, h, b = req("POST", "/munai-pair", {"code": "000000"})
    check("no code open, no pairing", st == 403 and b"No pairing code" in b)
    good = ctl("/code")["code"]
    wrong = [c for c in ("123450", "123451", "123452", "123453", "999999", "888888") if c != good][:5]
    for c in wrong: st, h, b = req("POST", "/munai-pair", {"code": c})
    check("five wrong codes end the code", st == 403 and b"Too many" in b, b.decode()[:120])
    st, h, b = req("POST", "/munai-pair", {"code": good})
    check("…and the right one no longer works until the computer shows a new one", st == 403 and b"No pairing code" in b)
    check("nothing was paired by guessing", ctl("/paired") == [])

    with sync_playwright() as p:
        br = p.chromium.launch()
        pixel = {k: v for k, v in p.devices["Pixel 7"].items() if k != "default_browser_type"}
        pixel["user_agent"] = pixel["user_agent"] + " Lodestone-Android"
        errors = []
        def phone(launch=None, cap=True):
            ctx = br.new_context(**pixel)
            if cap: ctx.add_init_script(CAP + (f"window.__launch = {json.dumps(launch)};" if launch else ""))
            pg = ctx.new_page()
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("console", lambda m: m.type == "error" and not m.text.startswith("Failed to load resource") and errors.append(m.text))
            pg.on("dialog", lambda d: d.accept())
            return pg
        js = lambda pg, code: pg.evaluate(f"(async () => {{ const store = await import('./js/store.js'); {code} }})()")
        def settings(pg):
            if pg.is_hidden("#drawerSettings"): pg.click("#btnSettings")
            pg.wait_for_selector("#setSync:not([hidden])", timeout=8000); pg.wait_for_timeout(300)
        def close(pg): pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        def wait_synced(pg, t=15000):
            pg.wait_for_function("/Synced|Not synced|Off/.test(document.querySelector('#syncStatus').textContent)", timeout=t)
            return pg.text_content("#syncStatus")

        # ── phone A pairs by typing the code ────────────────────────────────
        A = phone()
        A.goto(ORIGIN + "/lodestone-app/")
        A.wait_for_selector("#setup:not([hidden])")
        A.wait_for_function("document.querySelectorAll('#tierChoices .choice').length > 0")
        A.click("#tierChoices .choice:has-text('computer')")
        check("in the app, My computer is a pairing form, not a pointer", A.is_visible("#pairBase") and A.is_visible("#pairCode") and A.is_disabled("#beginSetup"))
        code = ctl("/code")["code"]
        A.fill("#pairBase", f"127.0.0.1:{DESK}"); A.fill("#pairCode", "111111" if code != "111111" else "222222"); A.click("#pairGo")
        A.wait_for_function("document.querySelector('#pairMsg').textContent.includes('not the code')", timeout=8000)
        check("a wrong code is refused with the computer's own words", True, A.text_content("#pairMsg"))
        A.fill("#pairCode", code); A.click("#pairGo")
        A.wait_for_selector("#pairForget", timeout=8000)
        check("the right code pairs, and Begin is allowed", "Test Mac" in A.text_content("#phoneComputer") and not A.is_disabled("#beginSetup"), A.text_content("#phoneComputer")[:90])
        stored = js(A, "const v = await store.kv.get('secret:computer'); return v && v.ct ? 'ciphertext' : JSON.stringify(v);")
        check("the token is kept encrypted on the phone", stored == "ciphertext", stored)
        check("the computer lists the paired phone, by the phone's name", len(ctl("/paired")) == 1 and ctl("/paired")[0]["name"] == "Pixel 7", str(ctl("/paired")))
        if A.is_visible("#optSemantic"): A.uncheck("#optSemantic")
        A.click("#beginSetup")
        A.wait_for_selector("#main:not([hidden])", timeout=90000); A.wait_for_timeout(500)
        A.fill("#input", "What is Presence? MARKER-A"); A.click("#sendBtn")
        A.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].some(b => b.textContent.includes('Answer from the computer'))", timeout=20000)
        check("the phone thinks with the computer's model", True)
        badge = lambda pg: (pg.text_content("#engineBadge"), pg.get_attribute("#engineBadge", "class"), pg.eval_on_selector("#engineBadge", "b => getComputedStyle(b).color"))
        t, cls, green = badge(A)
        check("a computer running its own model: 'thinking on your computer', in green", t == "thinking on your computer" and "live" in cls and "rented" not in cls, f"{t} · {cls} · {green}")
        A.click("#modelChip"); A.wait_for_timeout(500)
        menu = A.text_content("#modelMenu")
        check("the model menu offers the paired computer", "Lodestone Desktop · Test Mac" in menu and "nothing leaves your network" in menu)
        A.keyboard.press("Escape"); A.wait_for_timeout(200)
        ctl("/where/openrouter.ai")
        A.fill("#input", "And Dharma?"); A.click("#sendBtn")
        A.wait_for_function("document.querySelector('#engineBadge').textContent === 'thinking on OpenRouter'", timeout=20000)
        t, cls, violet = badge(A)
        check("a computer that rents: the badge names the provider, not in green", "rented" in cls and violet != green, f"{t} · {cls} · {violet}")
        A.click("#modelChip"); A.wait_for_timeout(500)
        menu = A.text_content("#modelMenu")
        check("the model menu says the computer rents", "rents from OpenRouter" in menu and "nothing leaves your network" not in menu.split("No model")[0].split("Test Mac")[0][-60:], menu[:200])
        A.keyboard.press("Escape"); A.wait_for_timeout(200)
        st, h, b = req("GET", "/munai-pair")
        check("the computer says where its model runs", json.loads(b).get("where") == "openrouter.ai", b.decode()[:120])
        ctl("/where/")
        A.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        A.wait_for_function("document.querySelector('#engineBadge').textContent === 'thinking on your computer'", timeout=10000)
        check("back to its own model: the phone says so on returning to the app", True)

        # ── phone A turns on sync through the computer ──────────────────────
        settings(A)
        check("Sync offers the account or the computer", A.is_visible("#syncVia-account") and A.is_visible("#syncVia-computer"))
        A.check("#syncVia-computer"); A.wait_for_selector("#syncOn")
        check("the computer route says nothing goes to harmonism.io", "Nothing goes to harmonism.io" in A.text_content("#syncBody"))
        A.click("#syncOn"); A.wait_for_selector("#syncPass2")
        A.fill("#syncPass", PASS); A.fill("#syncPass2", PASS); A.click("#syncGo")
        A.wait_for_selector("#syncNow", timeout=30000)
        st = wait_synced(A)
        check("on, through the computer, synced", "through Test Mac" in st and "Synced" in st and "on Test Mac" in st, st)
        rec = json.load(open(os.path.join(DATA, "records.json")))
        blob = json.dumps(rec)
        check("the computer keeps ciphertext only", len([r for r in rec["rec"].values() if r["data"]]) >= 1 and "MARKER-A" not in blob and "Presence" not in blob)
        close(A)

        # ── phone B pairs from the QR link and joins ────────────────────────
        code = ctl("/code")["code"]
        link = f"lodestone://pair?u={urllib.parse.quote(BASE, safe='')}&c={code}&n=Test%20Mac"
        B = phone(launch=link)
        B.goto(ORIGIN + "/lodestone-app/")
        B.wait_for_selector("#pairForget", timeout=15000)
        pressed = B.eval_on_selector_all("#tierChoices .choice[aria-pressed=true] strong", "ns => ns.map(n => n.textContent)")
        check("the QR link pairs the app and chooses the computer", any("computer" in x for x in pressed) and not B.is_disabled("#beginSetup"), str(pressed))
        if B.is_visible("#optSemantic"): B.uncheck("#optSemantic")
        B.click("#beginSetup"); B.wait_for_selector("#main:not([hidden])", timeout=90000); B.wait_for_timeout(500)
        settings(B); B.check("#syncVia-computer"); B.wait_for_selector("#syncOn"); B.click("#syncOn")
        B.wait_for_selector("#syncPass")
        check("the second phone finds the copy on the computer", "already has a synced copy" in B.text_content("#syncStatus") and B.is_hidden("#syncPass2"), B.text_content("#syncStatus"))
        B.fill("#syncPass", PASS); B.click("#syncGo"); B.wait_for_selector("#syncNow", timeout=30000); wait_synced(B)
        n = js(B, "return (await store.threads.list()).length;")
        shown = B.evaluate("[...document.querySelectorAll('.msg .body')].map(b => b.textContent).join(' ')")
        check("phone B has phone A's conversation, through the computer", n == 1 and "MARKER-A" in shown, f"{n} threads")
        close(B)

        # ── a link opened while the app is running ──────────────────────────
        code = ctl("/code")["code"]
        before = len(ctl("/paired"))
        js(B, "await (await import('./js/phone.js')).secrets.del('computer');")
        link = f"lodestone://pair?u={urllib.parse.quote(BASE, safe='')}&c={code}&n=Test%20Mac"
        B.evaluate(f"window.__openLink({json.dumps(link)})")
        B.wait_for_function("document.querySelector('#toast') && document.querySelector('#toast').textContent.includes('Paired with Test Mac')", timeout=10000)
        check("a pairing link opened while the app runs pairs it too", len(ctl("/paired")) == before + 1, str(len(ctl("/paired"))))

        # ── the computer forgets a phone ────────────────────────────────────
        for d in ctl("/paired"): ctl("/forget/" + d["id"])
        settings(A); A.click("#syncNow"); A.wait_for_timeout(1500)
        st = A.text_content("#syncStatus")
        check("a forgotten phone is told to pair again", "Pair it again" in st or "pair it again" in st, st)
        close(A)

        # ── a page without the bridge reloads once, not forever ─────────────
        C = phone(cap=False)
        C.goto(ORIGIN + "/lodestone-app/"); C.wait_for_selector("#setup:not([hidden])", timeout=20000); C.wait_for_timeout(800)
        flag = C.evaluate("sessionStorage.getItem('munai-bridge-reload')")
        check("the app's page without its bridge is reloaded once, then opens", flag == "1" and C.is_visible("#tierChoices"))

        check("no page errors", not errors, "; ".join(errors[:5]))
        br.close()
    desk.terminate(); srv.shutdown()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed · {ROOT}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    import urllib.parse
    main()
