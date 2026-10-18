"""Headless end-to-end test of Lodestone sync.

Usage: python3 tools/test-sync.py [path/to/lodestone/app] [path/to/lodestone-sync-api.php]
(needs: php with pdo_sqlite; pip install playwright; playwright install chromium)

Two browsers stand for two devices on one harmonism.io account: a phone and a
computer. The app is served at http://localhost:8797/lodestone-app/ (a secure
context, as https is); /lodestone-sync-api.php is the real endpoint, run by
`php -S` with sign-in verification stubbed (a token "tok-<uuid>" is that
user). Both devices think with "No model", so no model is needed.
"""
import json, os, sqlite3, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "app"))
API = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "..", "harmonia-astro", "lodestone-sync-api.php"))
ROOT = tempfile.mkdtemp(prefix="lodestone-sync-test-")
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
PORT, PHP_PORT = 8797, 8796
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

    with sync_playwright() as p:
        b = p.chromium.launch()
        iphone = {k: v for k, v in p.devices["iPhone 13"].items() if k != "default_browser_type"}
        session = json.dumps({"access_token": "tok-" + UID, "refresh_token": "R1", "expires_at": int(time.time()) + 3600, "token_type": "bearer", "user": {"email": "t@example.org"}})
        devices = {}
        errors = []
        for name, opts in (("phone", iphone), ("computer", {"viewport": {"width": 1280, "height": 860}})):
            ctx = b.new_context(**opts)
            ctx.add_init_script(f"try {{ localStorage.setItem({json.dumps(SB_KEY)}, {json.dumps(session)}); }} catch {{}}")
            pg = ctx.new_page()
            pg.on("pageerror", lambda e, n=name: errors.append(f"{n}: {e}"))
            pg.on("console", lambda m, n=name: m.type == "error" and not m.text.startswith("Failed to load resource") and errors.append(f"{n}: {m.text}"))
            pg.on("dialog", lambda d: d.accept())
            devices[name] = pg
        A, B = devices["phone"], devices["computer"]
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

        js = lambda pg, code: pg.evaluate(f"(async () => {{ const store = await import('./js/store.js'); const phone = await import('./js/phone.js'); {code} }})()")
        count = lambda pg: js(pg, "return (await store.threads.list()).length;")
        def settings(pg):
            if pg.is_hidden("#drawerSettings"): pg.click("#btnSettings")
            pg.wait_for_selector("#setSync:not([hidden])", timeout=8000); pg.wait_for_timeout(400)
        def close(pg): pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        def wait_synced(pg, t=15000):
            pg.wait_for_function("(() => { const s = document.querySelector('#syncStatus').textContent; return /Synced|Not synced|Off/.test(s); })()", timeout=t)
            return pg.text_content("#syncStatus")
        def db(q, *a):
            c = sqlite3.connect(DB); r = c.execute(q, a).fetchall(); c.close(); return r

        # ── the phone turns sync on ──────────────────────────────────────────
        setup(A, "What is Presence? MARKER-ALPHA")
        js(A, f"await phone.secrets.set('openrouter', {json.dumps(GOOD)}); await store.kv.set('practices', [{{id:'p1', title:'Morning sitting'}}]);")
        settings(A)
        check("sync is off by default, saying memory is on this device only", "Off" in A.text_content("#syncStatus") and A.is_visible("#syncOn"), A.text_content("#syncStatus"))
        fine = A.text_content("#syncBody")
        check("the notice says it is kept on harmonism.io, encrypted, unreadable to Harmonia, and that a lost passphrase loses it",
              all(w in fine for w in ["keeps a copy", "harmonism.io", "encrypts", "Harmonia cannot read it", "forget the passphrase"]) and "as published" in fine)
        A.click("#syncOn"); A.wait_for_selector("#syncPass")
        check("first device is asked to choose a passphrase twice", A.is_visible("#syncPass2"), A.text_content("#syncStatus"))
        A.fill("#syncPass", "short"); A.fill("#syncPass2", "short"); A.click("#syncGo")
        A.wait_for_function("document.querySelector('#syncMsg').textContent.includes('ten characters')", timeout=5000)
        check("a short passphrase is refused", True)
        A.fill("#syncPass", PASS); A.fill("#syncPass2", PASS); A.check("#syncSetupKey"); A.click("#syncGo")
        A.wait_for_selector("#syncNow", timeout=30000)
        st = wait_synced(A)
        A.screenshot(path=os.path.join(ROOT, "sync-phone.png"), full_page=False)
        check("the phone is on and synced", "Synced" in st and "encrypted" in st, st)
        rows = db("SELECT rid, data FROM rec WHERE data IS NOT NULL")
        blob = " ".join(r[1] for r in rows) + " " + " ".join(r[0] for r in rows)
        check("the server holds records", len(rows) >= 3, f"{len(rows)} records")
        check("nothing readable reaches the server (text, key, names)", not any(w in blob for w in SECRET_WORDS + [GOOD, "practices", "profile", "openrouter"]))
        meta = db("SELECT uid, salt, chk FROM space")
        check("the space is kept under the account id, with a salt and a check value only", len(meta) == 1 and meta[0][0] == UID)
        close(A)

        # ── the computer joins ───────────────────────────────────────────────
        setup(B, "Tell me about Dharma. MARKER-BETA")
        js(B, "await store.kv.set('practices', [{id:'p2', title:'Evening walk'}]);")
        settings(B)
        B.click("#syncOn"); B.wait_for_selector("#syncPass")
        check("second device finds the synced copy and asks for its passphrase only", "already has a synced copy" in B.text_content("#syncStatus") and B.is_hidden("#syncPass2"), B.text_content("#syncStatus"))
        B.fill("#syncPass", "a wrong passphrase entirely"); B.click("#syncGo")
        B.wait_for_function("document.querySelector('#syncMsg').textContent.includes('does not open')", timeout=15000)
        check("a wrong passphrase is refused", True, B.text_content("#syncMsg"))
        B.fill("#syncPass", PASS); B.check("#syncSetupKey"); B.click("#syncGo")
        B.wait_for_selector("#syncNow", timeout=30000)
        wait_synced(B)
        check("the computer now has both conversations", count(B) == 2, str(count(B)))
        k = js(B, "return await phone.secrets.get('openrouter');")
        check("the OpenRouter key arrived, ticked on both", k == GOOD, str(k))
        pr = js(B, "return (await store.kv.get('practices')).map(p => p.id).sort();")
        check("practices merged by id on the computer", pr == ["p1", "p2"], str(pr))
        close(B)

        settings(A); A.click("#syncNow"); A.wait_for_timeout(300); wait_synced(A)
        check("the phone takes in the computer's conversation", count(A) == 2, str(count(A)))
        pr = js(A, "return (await store.kv.get('practices')).map(p => p.id).sort();")
        check("practices merged on the phone", pr == ["p1", "p2"], str(pr))
        close(A)

        # ── both devices add to the same conversation, then sync ─────────────
        tid = js(A, "return (await store.threads.list()).find(t => t.title.includes('Presence') || true).id;")
        tid = js(A, "const l = await store.threads.list(); const m = await Promise.all(l.map(async t => [t.id, (await store.messages.forThread(t.id)).some(x => x.content.includes('MARKER-ALPHA'))])); return m.find(x => x[1])[0];")
        add = lambda pg, text, ts: js(pg, f"await store.messages.add({{threadId:{json.dumps(tid)}, role:'user', content:{json.dumps(text)}, ts:{ts}}}); const t = await store.threads.get({json.dumps(tid)}); t.updated = {ts}; await store.threads.put(t);")
        now = int(time.time() * 1000)
        add(A, "Added on the phone", now + 1000)
        add(B, "Added on the computer", now + 2000)
        for pg in (A, B, A):
            settings(pg); pg.click("#syncNow"); pg.wait_for_timeout(300); wait_synced(pg); close(pg)
        msgs = lambda pg: js(pg, f"return (await store.messages.forThread({json.dumps(tid)})).map(m => m.content);")
        ma, mb = msgs(A), msgs(B)
        check("a conversation changed on both devices merges message by message",
              "Added on the phone" in ma and "Added on the computer" in ma and sorted(ma) == sorted(mb) and len(ma) == len(set(ma)), f"{len(ma)} vs {len(mb)}")
        shown = A.evaluate("[...document.querySelectorAll('.msg .body')].map(b => b.textContent).join(' ')")
        check("the open conversation on the phone shows the computer's message", "Added on the computer" in shown)

        # ── a deletion travels ───────────────────────────────────────────────
        other = js(B, f"return (await store.threads.list()).map(t => t.id).find(i => i !== {json.dumps(tid)});")
        js(B, f"await store.threads.remove({json.dumps(other)});")
        settings(B); B.click("#syncNow"); B.wait_for_timeout(300); wait_synced(B); close(B)
        settings(A); A.click("#syncNow"); A.wait_for_timeout(300); wait_synced(A); close(A)
        check("a conversation deleted on the computer is deleted on the phone", count(A) == 1 and count(B) == 1, f"{count(A)} / {count(B)}")

        # ── the key withdrawn ────────────────────────────────────────────────
        settings(A); A.uncheck("#syncKey"); A.wait_for_timeout(1500); wait_synced(A); close(A)
        n_before = len(db("SELECT rid FROM rec WHERE data IS NOT NULL"))
        settings(B); B.click("#syncNow"); B.wait_for_timeout(300); wait_synced(B)
        check("unticking the key on one device stops it travelling from the other, and keeps it on both",
              not B.is_checked("#syncKey") and js(B, "return await phone.secrets.get('openrouter');") == GOOD and js(A, "return await phone.secrets.get('openrouter');") == GOOD)
        close(B)

        # ── a reload syncs by itself ─────────────────────────────────────────
        js(B, "const l = await store.threads.list(); const t = l[0]; await store.messages.add({threadId:t.id, role:'user', content:'After reload', ts:Date.now()}); t.updated = Date.now(); await store.threads.put(t);")
        B.reload(); B.wait_for_selector("#main:not([hidden])", timeout=30000); B.wait_for_timeout(2500)
        A.reload(); A.wait_for_selector("#main:not([hidden])", timeout=30000); A.wait_for_timeout(2500)
        check("opening Lodestone syncs without a press", "After reload" in msgs(A), str(msgs(A)[-2:]))

        # ── a new passphrase elsewhere stops the other device ────────────────
        settings(B); B.click("#syncOff"); B.wait_for_selector("#syncOn")
        check("turning off on one device keeps the synced copy", len(db("SELECT uid FROM space")) == 1)
        B.click("#syncOn"); B.wait_for_selector("#syncForgot"); B.click("#syncForgot"); B.wait_for_selector("#syncPass2")
        B.fill("#syncPass", "a brand new passphrase here"); B.fill("#syncPass2", "a brand new passphrase here"); B.click("#syncGo")
        B.wait_for_selector("#syncNow", timeout=30000); wait_synced(B); close(B)
        settings(A); A.click("#syncNow"); A.wait_for_timeout(600)
        A.wait_for_selector("#syncOn", timeout=15000)
        check("the phone stops and asks for the new passphrase", "new passphrase" in A.text_content("#syncStatus"), A.text_content("#syncStatus"))
        check("the phone's memory is untouched", count(A) == 1)
        A.click("#syncOn"); A.wait_for_selector("#syncPass"); A.fill("#syncPass", "a brand new passphrase here"); A.click("#syncGo")
        A.wait_for_selector("#syncNow", timeout=30000); st = wait_synced(A)
        check("the phone rejoins under the new passphrase", "Synced" in st, st)

        # ── erase ────────────────────────────────────────────────────────────
        A.click("#syncErase"); A.wait_for_selector("#syncOn", timeout=10000)
        check("deleting the synced copy erases it from the server", not db("SELECT uid FROM space") and not db("SELECT rid FROM rec"))
        close(A)
        settings(B); B.click("#syncNow"); B.wait_for_selector("#syncOn", timeout=15000)
        check("the other device is told and stops, its memory kept", "deleted from another device" in B.text_content("#syncStatus") and count(B) >= 1, B.text_content("#syncStatus"))
        B.screenshot(path=os.path.join(ROOT, "sync-computer.png"), full_page=True)

        check("no page errors", not errors, "; ".join(errors[:5]))
        b.close()
    php.terminate(); srv.shutdown()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed · screenshots in {ROOT}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
