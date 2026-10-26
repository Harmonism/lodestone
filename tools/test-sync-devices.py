"""Headless end-to-end test of the devices that sync (October 23, 2026).

Usage: python3 tools/test-sync-devices.py [path/to/lodestone/app] [path/to/lodestone-sync-api.php]
(needs: php with pdo_sqlite; pip install playwright; playwright install chromium)

Two browsers stand for two devices on one harmonism.io account: a phone and a
computer. The app is served at http://localhost:8797/lodestone-app/ (a secure
context, as https is); /lodestone-sync-api.php is the real endpoint, run by
`php -S` with sign-in verification stubbed (a token "tok-<uuid>" is that
user). Every device thinks with "No model", so no model is needed. The
sign-in service is stood in for where a password is checked (page.route), as
the endpoint's sign-in verification is.
"""
import json, os, sqlite3, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "app"))
API = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "..", "harmonia-astro", "lodestone-sync-api.php"))
ROOT = tempfile.mkdtemp(prefix="lodestone-devices-test-")
PHPDIR = os.path.join(ROOT, "php"); os.mkdir(PHPDIR)
os.symlink(APP, os.path.join(ROOT, "lodestone-app"))
os.symlink(API, os.path.join(PHPDIR, "lodestone-sync-api.php"))
DB = os.path.join(ROOT, "sync.db")
with open(os.path.join(PHPDIR, "prepend.php"), "w") as f:
    f.write(f"""<?php
define('MSY_DB', {json.dumps(DB)});
define('MDA_CONFIG', {json.dumps(os.path.join(ROOT, 'none.php'))});
function verifySupabaseJWT($t) {{
  if (preg_match('/^tok-([0-9a-f-]{{20,}})$/', $t, $m)) return ['sub' => $m[1], 'email' => 't@example.org', 'exp' => time() + 3600];
  return false;
}}
""")
PORT, PHP_PORT = 8787, 8786
UID = "1b2c3d4e-0000-4000-8000-00000000abcd"
SB_KEY = "sb-zccplzknsbpdczfnwkwz-auth-token"
GOOD = "sk-or-v1-goodkeygoodkeygoodkey00"
PASS = "quiet river under cedar stones"
SECRET_WORDS = ["Presence", "Dharma", "MARKER-ALPHA", "MARKER-BETA"]


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass

    def _proxy(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None
        req = urllib.request.Request(f"http://127.0.0.1:{PHP_PORT}{self.path}", data=body, method=self.command,
                                     headers={k: v for k, v in self.headers.items() if k.lower() in ("authorization", "content-type")})
        try: r = urllib.request.urlopen(req); code, data = r.status, r.read()
        except urllib.error.HTTPError as e: code, data = e.code, e.read()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/lodestone-sync-api.php"): return self._proxy()
        return super().do_GET()
    do_POST = do_PUT = do_DELETE = _proxy


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    php = subprocess.Popen(["php", "-d", "auto_prepend_file=" + os.path.join(PHPDIR, "prepend.php"), "-S", f"127.0.0.1:{PHP_PORT}", "-t", PHPDIR],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    results = []
    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail)); print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)

    try:
      with sync_playwright() as p:
        b = p.chromium.launch()
        iphone = {k: v for k, v in p.devices["iPhone 13"].items() if k != "default_browser_type"}
        session = json.dumps({"access_token": "tok-" + UID, "refresh_token": "R1", "expires_at": int(time.time()) + 3600, "token_type": "bearer", "user": {"email": "t@example.org"}})
        errors = []
        signin = lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"access_token": "tok-" + UID, "refresh_token": "R2", "expires_in": 3600, "token_type": "bearer", "user": {"email": "t@example.org"}}))
        pages = {}
        for name, opts in (("phone", iphone), ("computer", {"viewport": {"width": 1280, "height": 860}})):
            ctx = b.new_context(**opts)
            ctx.add_init_script(f"try {{ localStorage.setItem({json.dumps(SB_KEY)}, {json.dumps(session)}); }} catch {{}}")
            pg = ctx.new_page()
            pg.on("pageerror", lambda e, n=name: errors.append(f"{n}: {e}"))
            pg.on("console", lambda m, n=name: m.type == "error" and not m.text.startswith("Failed to load resource") and errors.append(f"{n}: {m.text}"))
            pg.on("dialog", lambda d: d.accept())
            pg.route("**/auth/v1/token**", signin)
            pages[name] = pg
        A, B = pages["phone"], pages["computer"]
        base = f"http://localhost:{PORT}/lodestone-app/"

        def setup(pg, question):
            pg.goto(base)
            pg.wait_for_selector("#setup:not([hidden])")
            pg.wait_for_function("document.querySelectorAll('#tierChoices .choice').length > 0")
            pg.click("#tierChoices .choice:has-text('No model')")
            if pg.is_visible("#optSemantic"): pg.uncheck("#optSemantic")
            pg.click("#beginSetup")
            pg.wait_for_selector("#main:not([hidden])", timeout=90000)
            pg.wait_for_timeout(600)
            pg.fill("#input", question); pg.click("#sendBtn")
            pg.wait_for_function("!document.querySelector('#sendBtn').classList.contains('stop') && document.querySelectorAll('.msg.assistant').length >= 1", timeout=20000)
            pg.wait_for_timeout(800)
        js = lambda pg, code: pg.evaluate(f"(async () => {{ const store = await import('./js/store.js'); const unlock = await import('./js/unlock.js'); {code} }})()")
        count = lambda pg: js(pg, "return (await store.threads.list()).length;")
        def settings(pg):
            if pg.is_hidden("#drawerSettings"): pg.evaluate("[...document.querySelectorAll('#btnSettings, #btnSettingsSide')].find(b => b.offsetParent)?.click()")
            pg.wait_for_selector("#setSync:not([hidden])", timeout=8000); pg.wait_for_timeout(400)
        def close(pg): pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        def sync(pg):
            settings(pg)
            if pg.locator("#syncNow").count(): pg.click("#syncNow")
            pg.wait_for_function("(() => { const s = document.querySelector('#syncStatus').textContent; return /Synced|Not synced|Off/.test(s) && !document.querySelector('#syncNow')?.disabled; })()", timeout=20000)
            pg.wait_for_timeout(500)
            return pg.text_content("#syncStatus")
        names = lambda pg: [x.strip() for x in pg.locator("#syncBody .device-list .device-name b").all_text_contents()]
        def db(q, *a):
            c = sqlite3.connect(DB); r = c.execute(q, a).fetchall(); c.close(); return r

        # ── the phone starts the copy; its password opens it elsewhere ──────
        setup(A, "What is Presence? MARKER-ALPHA")
        settings(A); A.wait_for_selector("#syncNow", timeout=30000); sync(A)
        A.wait_for_selector("#syncBody .device-list .device", timeout=10000)
        check("the first device lists itself, named as a person would name it", names(A) == ["Safari on iPhone"], str(names(A)))
        check("it is marked as this device", "This device" in A.text_content("#syncBody .device.here"))
        A.wait_for_selector("#syncBody button:has-text('Use my password')", timeout=15000)
        A.fill("#syncBody input[placeholder='Your harmonism.io password']", PASS); A.click("#syncBody button:has-text('Use my password')")
        A.wait_for_function("document.querySelector('#syncBody').textContent.includes('Done: signing in on another device')", timeout=30000)
        check("no password field waits hidden under 'Lost a device?'", A.locator("#syncBody details.link-alt input[type=password]").count() == 0)
        close(A)

        # ── the computer is in by its password ──────────────────────────────
        B.goto(base); js(B, f"await unlock.stashPassword('t@example.org', {json.dumps(PASS)});")
        setup(B, "Tell me about Dharma. MARKER-BETA")
        settings(B); B.wait_for_selector("#syncNow", timeout=30000); sync(B)
        B.wait_for_function("document.querySelectorAll('#syncBody .device-list .device').length == 2", timeout=15000)
        check("the second device lists both, itself first", names(B) == ["Chrome on Linux", "Safari on iPhone"], str(names(B)))
        close(B); sync(A)
        A.wait_for_function("document.querySelectorAll('#syncBody .device-list .device').length == 2", timeout=15000)
        check("the first device lists the second after its next sync", names(A) == ["Safari on iPhone", "Chrome on Linux"], str(names(A)))
        meta = A.text_content("#syncBody .device:not(.here) small")
        check("another device shows when it last synced", "synced" in meta, meta)
        A.locator("#setSync").screenshot(path=os.path.join(ROOT, "devices-phone.png"))
        check("the existing password hint stays as it was on a device that holds the password", "Signing in with your harmonism.io password on another device" in A.text_content("#syncBody"))
        close(A)
        rows = db("SELECT rid, data FROM rec WHERE data IS NOT NULL")
        blob = " ".join(r[0] + " " + r[1] for r in rows)
        check("harmonism.io holds the device records but cannot read a name", not any(w in blob for w in ["iPhone", "Safari", "Chrome", "Linux", "device"]), f"{len(rows)} records")

        # ── renamed on the computer, the name reaches the phone ─────────────
        settings(B)
        B.click("#syncBody .device.here button:has-text('Rename')")
        B.fill("#syncBody .device.here input", "Study computer"); B.click("#syncBody .device.here button:has-text('Save')")
        B.wait_for_function("[...document.querySelectorAll('#syncBody .device-name b')].some(b => b.textContent === 'Study computer')", timeout=20000)
        check("this device is renamed here", names(B)[0] == "Study computer", str(names(B)))
        B.locator("#setSync").screenshot(path=os.path.join(ROOT, "devices-computer.png"))
        close(B); sync(A)
        A.wait_for_function("[...document.querySelectorAll('#syncBody .device-name b')].some(b => b.textContent === 'Study computer')", timeout=20000)
        check("and on the other device at its next sync", "Study computer" in names(A), str(names(A)))
        check("only this device offers Rename; another offers Remove", A.locator("#syncBody .device.here button:has-text('Remove')").count() == 0 and A.locator("#syncBody .device:not(.here) button:has-text('Rename')").count() == 0)
        close(A)

        # ── removed from the computer, the phone stops at its next sync ──────
        before = count(A)
        settings(B)
        B.click("#syncBody .device:not(.here) button:has-text('Remove')")
        B.wait_for_function("document.querySelectorAll('#syncBody .device-list .device').length == 1", timeout=20000)
        check("the removed device leaves the list at once", names(B) == ["Study computer"], str(names(B)))
        close(B)
        st = sync(A)
        check("the removed device stops syncing at its next sync, and says where it was removed", st.startswith("Off") and "removed" in st and "Study computer" in st, st)
        check("what it holds stays on it", count(A) == before, f"{count(A)} / {before}")
        check("it offers to turn sync on again, rather than coming back by itself", A.locator("#syncOn").count() == 1 and A.is_hidden("#syncBanner"))
        A.reload(); A.wait_for_selector("#main:not([hidden])", timeout=60000); A.wait_for_timeout(2500)
        on_again = js(A, "return (await (await import('./js/held.js')).syncer().conf()).on;")
        check("a reload does not let it back in by itself", on_again is False, str(on_again))
        close(A)

        # ── let in again, it is listed again ─────────────────────────────────
        settings(A); A.click("#syncOn")
        A.wait_for_selector("#syncNow", timeout=30000); sync(A)
        close(A); sync(B)
        B.wait_for_function("document.querySelectorAll('#syncBody .device-list .device').length == 2", timeout=15000)
        check("turned on again there, it is listed again", sorted(names(B)) == ["Safari on iPhone", "Study computer"], str(names(B)))
        check("a device's record written every sync does not pile up records on the server", len(db("SELECT rid FROM rec WHERE data IS NOT NULL")) < 40)

        # ── a lost device: the key changed from here, under the password ─────
        epoch0 = db("SELECT epoch FROM space")[0][0]
        settings(B)
        B.click("#syncBody details.link-alt summary:has-text('Lost a device?')")
        B.wait_for_selector("#syncBody details.link-alt input[type=password]", timeout=5000)
        B.fill("#syncBody details.link-alt input[type=password]", PASS); B.click("#syncBody details.link-alt button:has-text('Change the key')")
        B.wait_for_function("(() => { const e = document.querySelector('#syncBody .devices'); return e && document.querySelectorAll('#syncBody .device').length === 1; })()", timeout=40000)
        epoch1 = db("SELECT epoch FROM space")[0][0]
        check("Change the key starts the copy again under a new key, from this device", epoch1 != epoch0 and names(B) == ["Study computer"], f"{epoch0[:6]} → {epoch1[:6]} {names(B)}")
        check("the conversations are all still in the copy", len(db("SELECT rid FROM rec WHERE data IS NOT NULL")) >= 4)
        close(B)
        st = sync(A)
        check("another device finds the copy started again and stops", st.startswith("Off") or "started again" in st, st)
        close(A)
        A.reload(); A.wait_for_selector("#main:not([hidden])", timeout=60000); A.wait_for_timeout(4000)
        settings(A); st = sync(A)
        check("holding the current password, it opens the new copy by itself", st.startswith("On") and "Synced" in st, st)
        close(A); sync(B)
        B.wait_for_function("document.querySelectorAll('#syncBody .device-list .device').length == 2", timeout=15000)
        check("and is listed again, the list starting afresh with the new key", sorted(names(B)) == ["Safari on iPhone", "Study computer"], str(names(B)))
        check("no page errors", not errors, "; ".join(errors[:4]))
        b.close()
    finally:
        php.terminate(); srv.shutdown()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed · {ROOT}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
