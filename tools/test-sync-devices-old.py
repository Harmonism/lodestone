"""Headless end-to-end test of an older Lodestone syncing with one that lists devices.

Usage: python3 tools/test-sync-devices-old.py [path/to/lodestone/app] [path/to/lodestone-sync-api.php]
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
ROOT = tempfile.mkdtemp(prefix="lodestone-devices-old-")
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
PORT, PHP_PORT = 8777, 8776
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


OLD = os.path.join(APP, "js") + "/"   # the code as it was before the device list: the .bak-2026-10-23-devices files

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
        for name, opts in (("phone", iphone), ("old", {"viewport": {"width": 1280, "height": 860}}), ("laptop", {"viewport": {"width": 1280, "height": 860}})):
            ctx = b.new_context(**opts)
            ctx.add_init_script(f"try {{ localStorage.setItem({json.dumps(SB_KEY)}, {json.dumps(session)}); }} catch {{}}")
            pg = ctx.new_page()
            pg.on("pageerror", lambda e, n=name: errors.append(f"{n}: {e}"))
            pg.on("console", lambda m, n=name: m.type == "error" and not m.text.startswith("Failed to load resource") and errors.append(f"{n}: {m.text}"))
            pg.on("dialog", lambda d: d.accept())
            pg.route("**/auth/v1/token**", signin)
            if name == "old":   # Lodestone Desktop 1.13.2 and every web app opened before the update: the code as it was
                def serve_old(f):
                    body = open(OLD + f + ".bak-2026-10-23-devices").read()
                    return lambda r: r.fulfill(status=200, content_type="text/javascript", body=body)
                for f in ("sync.js", "main.js"): pg.route(f"**/lodestone-app/js/{f}*", serve_old(f))
            pages[name] = pg
        A, B, C = pages["phone"], pages["old"], pages["laptop"]
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

        # ── a new phone starts the copy; an older Lodestone joins by the password ─
        setup(A, "What is Presence? MARKER-ALPHA")
        settings(A); A.wait_for_selector("#syncNow", timeout=30000); sync(A)
        A.wait_for_selector("#syncBody button:has-text('Use my password')", timeout=15000)
        A.fill("#syncBody input[placeholder='Your harmonism.io password']", PASS); A.click("#syncBody button:has-text('Use my password')")
        A.wait_for_function("document.querySelector('#syncBody').textContent.includes('Done: signing in on another device')", timeout=30000)
        close(A)
        B.goto(base); js(B, f"await unlock.stashPassword('t@example.org', {json.dumps(PASS)});")
        setup(B, "Tell me about Dharma. MARKER-BETA")
        check("the older Lodestone really runs the code as it was", B.locator("#syncBody .device-list").count() == 0 and js(B, "return typeof (await import('./js/sync.js')).deviceGuess") == "undefined")
        settings(B); B.wait_for_selector("#syncNow", timeout=30000); st = sync(B)
        check("the older Lodestone syncs a copy that holds device records", "Synced" in st, st)
        close(B)
        for _ in range(2): sync(A); close(A); sync(B); close(B)
        check("the older Lodestone has both conversations", count(B) == 2, str(count(B)))
        check("the new one too", count(A) == 2, str(count(A)))
        held_rec = js(B, "return JSON.stringify(await store.kv.get('sync:devices'))")
        check("the older Lodestone keeps nothing of the device records (it neither shows nor resends them)", held_rec in (None, "null"), str(held_rec))
        n1 = len(db("SELECT rid FROM rec WHERE data IS NOT NULL")); s1 = db("SELECT MAX(seq) FROM rec")[0][0]
        sync(B); close(B); sync(B); close(B)
        s2 = db("SELECT MAX(seq) FROM rec")[0][0]
        check("the older Lodestone writes nothing back on later syncs", s2 == s1, f"seq {s1} → {s2}")
        settings(A)
        check("the new one lists only itself until the older one updates", names(A) == ["Safari on iPhone"], str(names(A)))
        check("and says so", "older Lodestone appears once it updates" in A.text_content("#syncBody .devices"))
        close(A)
        # Renamed on the new one while the older one syncs: nothing breaks on either.
        settings(A); A.click("#syncBody .device.here button:has-text('Rename')")
        A.fill("#syncBody .device.here input", "Pocket"); A.click("#syncBody .device.here button:has-text('Save')"); A.wait_for_timeout(1500); close(A)
        st = sync(B); close(B)
        check("the older Lodestone still syncs after a device record changed", "Synced" in st and "Not synced" not in st, st)
        # A third device, new, sees the new phone but not the older one.
        C.goto(base); js(C, f"await unlock.stashPassword('t@example.org', {json.dumps(PASS)});")
        setup(C, "A question on the laptop.")
        settings(C); C.wait_for_selector("#syncNow", timeout=30000); sync(C)
        C.wait_for_function("document.querySelectorAll('#syncBody .device-list .device').length == 2", timeout=15000)
        check("a third device lists itself and the new phone", sorted(names(C)) == ["Chrome on Linux", "Pocket"], str(names(C)))
        check("one Sync panel, drawn once", C.locator("#syncBody .devices").count() == 1 and C.locator("#syncNow").count() == 1)
        check("the third device holds all three conversations", count(C) == 3, f"{count(A)} {count(B)} {count(C)}")
        check("no page errors", not errors, "; ".join(errors[:4]))
        b.close()
    finally:
        php.terminate(); srv.shutdown()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed · {ROOT}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
