"""Headless end-to-end test of Lodestone sync.

Usage: python3 tools/test-sync.py [path/to/lodestone/app] [path/to/lodestone-sync-api.php]
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
        signin = lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"access_token": "tok-" + UID, "refresh_token": "R2", "expires_in": 3600, "token_type": "bearer", "user": {"email": "t@example.org"}}))
        for name, opts in (("phone", iphone), ("computer", {"viewport": {"width": 1280, "height": 860}}), ("laptop", {"viewport": {"width": 1280, "height": 860}}), ("tablet", {"viewport": {"width": 1280, "height": 860}})):
            ctx = b.new_context(**opts)
            ctx.add_init_script(f"try {{ localStorage.setItem({json.dumps(SB_KEY)}, {json.dumps(session)}); }} catch {{}}")
            pg = ctx.new_page()
            pg.on("pageerror", lambda e, n=name: errors.append(f"{n}: {e}"))
            pg.on("console", lambda m, n=name: m.type == "error" and not m.text.startswith("Failed to load resource") and errors.append(f"{n}: {m.text}"))
            pg.on("dialog", lambda d: d.accept())
            pg.route("**/auth/v1/token**", signin)   # the password is checked by the sign-in service: stood in for here
            devices[name] = pg
        A, B, C, D = devices["phone"], devices["computer"], devices["laptop"], devices["tablet"]
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

        js = lambda pg, code: pg.evaluate(f"(async () => {{ const store = await import('./js/store.js'); const phone = await import('./js/phone.js'); const unlock = await import('./js/unlock.js'); {code} }})()")
        count = lambda pg: js(pg, "return (await store.threads.list()).length;")
        def settings(pg):
            # The top button, or the one under the docked conversations (wide windows): whichever shows.
            if pg.is_hidden("#drawerSettings"): pg.evaluate("[...document.querySelectorAll('#btnSettings, #btnSettingsSide')].find(b => b.offsetParent)?.click()")
            pg.wait_for_selector("#setSync:not([hidden])", timeout=8000); pg.wait_for_timeout(400)
        def close(pg): pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        def wait_synced(pg, t=15000):
            pg.wait_for_function("(() => { const s = document.querySelector('#syncStatus').textContent; return /Synced|Not synced|Off/.test(s); })()", timeout=t)
            return pg.text_content("#syncStatus")
        def db(q, *a):
            c = sqlite3.connect(DB); r = c.execute(q, a).fetchall(); c.close(); return r

        # ── the phone: signed in, sync is on by itself ───────────────
        setup(A, "What is Presence? MARKER-ALPHA")
        js(A, f"await phone.secrets.set('openrouter', {json.dumps(GOOD)}); await store.kv.set('practices', [{{id:'p1', title:'Morning sitting'}}]);")
        settings(A)
        A.wait_for_selector("#syncNow", timeout=30000)
        check("signed in, the first device turns sync on by itself, with nothing to press and no passphrase", A.locator("#syncOn").count() == 0 and A.locator("#syncPass").count() == 0, A.text_content("#syncStatus"))
        check("no offer to be let in on the first device", A.is_hidden("#syncBanner"))
        fine = A.text_content("#syncBody")
        check("the notice says it is kept on harmonism.io, encrypted, opened by the password, unreadable as kept, and lost only without password and recovery code",
              all(w in fine for w in ["keeps a copy", "harmonism.io", "encrypts", "your password", "it cannot read", "recovery code"]) and "as published" in fine)
        check("the OpenRouter key travels by default", A.is_checked("#syncKey"))
        A.click("#syncNow"); A.wait_for_timeout(300)
        st = wait_synced(A)
        A.screenshot(path=os.path.join(ROOT, "sync-phone.png"), full_page=False)
        check("the phone is on and synced", "Synced" in st and "encrypted" in st, st)
        rows = db("SELECT rid, data FROM rec WHERE data IS NOT NULL")
        blob = " ".join(r[1] for r in rows) + " " + " ".join(r[0] for r in rows)
        check("the server holds records", len(rows) >= 3, f"{len(rows)} records")
        check("nothing readable reaches the server (text, key, names)", not any(w in blob for w in SECRET_WORDS + [GOOD, "practices", "profile", "openrouter"]))
        meta = db("SELECT uid, v FROM space")
        check("the space is kept under the account id, as a linked copy (v2)", len(meta) == 1 and meta[0][0] == UID and meta[0][1] == 2, str(meta))
        close(A)

        # ── the computer joins ───────────────────────────────────────────────
        setup(B, "Tell me about Dharma. MARKER-BETA")
        js(B, "await store.kv.set('practices', [{id:'p2', title:'Evening walk'}]);")
        B.wait_for_selector("#syncAsk", timeout=15000)
        check("the second device offers, above the conversation, to be let in", B.is_visible("#syncAskGo") and "another of your devices" in B.text_content("#syncAsk"))
        B.click("#syncAskGo"); B.wait_for_selector("#syncBody .link-code", timeout=15000)
        check("one tap waits to be let in, asking for no code and no passphrase", "already syncs" in B.text_content("#syncStatus") and B.locator("#syncBody input[type=password]").count() == 0, B.text_content("#syncBody .link-code"))
        B.uncheck("#syncSetupKey")   # left unticked: a device with no key of its own takes the synced one anyway
        # The person turns to the phone: it shows the request above the conversation, Settings closed.
        A.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        A.wait_for_selector("#syncBanner .link-request", timeout=15000)
        check("the phone shows the computer waiting, without Settings being opened, with nothing to type", A.locator("#syncBanner .link-request").count() == 1 and A.is_hidden("#drawerSettings") and A.locator("#syncBanner .link-request input").count() == 0)
        A.click("#syncBanner .link-request button:has-text('Let it in')")
        A.wait_for_selector("#syncBanner .link-request .link-code", timeout=20000)
        B.wait_for_function("/^\\d{3} \\d{3}$/.test(document.querySelector('#syncBody .link-code').textContent)", timeout=20000)
        na, nb = A.text_content("#syncBanner .link-request .link-code").strip(), B.text_content("#syncBody .link-code").strip()
        check("both devices show the same six-digit number", na == nb and len(na) == 7, f"{na} / {nb}")
        check("nothing is sent before the tap that confirms it", B.locator("#syncNow").count() == 0 and not db("SELECT id FROM link WHERE box IS NOT NULL"))
        A.click("#syncBanner .link-request button:has-text('Yes, let it in')")
        B.wait_for_selector("#syncNow", timeout=30000)
        check("the tap lets it in, and the handover leaves nothing on the server", not db("SELECT id FROM link"))
        B.wait_for_selector("#syncAsk", state="detached", timeout=10000)
        check("the offer leaves the computer once it is in", B.locator("#syncAsk").count() == 0)
        A.wait_for_selector("#syncBanner .link-request", state="detached", timeout=15000)
        check("the request leaves the phone once answered", A.is_hidden("#syncBanner"))
        wait_synced(B)
        check("the computer now has both conversations", count(B) == 2, str(count(B)))
        k = js(B, "return await phone.secrets.get('openrouter');")
        check("the OpenRouter key arrived on a device that had none, even unticked, and travels from it now", k == GOOD and js(B, "return (await (await import('./js/held.js')).syncer().conf()).key") is not None, str(k))
        pr = js(B, "return (await store.kv.get('practices')).map(p => p.id).sort();")
        check("practices merged by id on the computer", pr == ["p1", "p2"], str(pr))
        close(B)

        settings(A); A.click("#syncNow"); A.wait_for_timeout(300); wait_synced(A)
        check("the phone takes in the computer's conversation", count(A) == 2, str(count(A)))
        pr = js(A, "return (await store.kv.get('practices')).map(p => p.id).sort();")
        check("practices merged on the phone", pr == ["p1", "p2"], str(pr))
        close(A)

        # ── the password opens the memory on a new device (October 20, 2026) ─
        settings(A); A.wait_for_selector("#syncBody button:has-text('Use my password')", timeout=15000)
        A.fill("#syncBody input[placeholder='Your harmonism.io password']", PASS); A.click("#syncBody button:has-text('Use my password')")
        A.wait_for_function("document.querySelector('#syncBody').textContent.includes('Done: signing in on another device')", timeout=30000)
        lock = db("SELECT box FROM unlock")
        check("typed once on a synced device, the password locks the key with the copy (unreadable)", len(lock) == 1 and PASS not in lock[0][0], str(len(lock)))
        close(A)
        # The laptop's sign-in page (member/login.php) keeps the stretched password; then Lodestone opens.
        C.goto(base); js(C, f"await unlock.stashPassword('t@example.org', {json.dumps(PASS)});")
        setup(C, "A question on the laptop.")
        settings(C); C.wait_for_selector("#syncNow", timeout=30000); wait_synced(C)
        check("signed in with the password, a new device is in by itself: no code, no tap", C.is_hidden("#syncBanner") and count(C) >= 3, str(count(C)))
        close(C)
        # The tablet signed in without typing it here: it types the password once, in Lodestone.
        setup(D, "A question on the tablet.")
        D.wait_for_selector("#syncAsk", timeout=15000); D.click("#syncAskGo")
        D.wait_for_selector("#syncBody button:has-text('Open my memory')", timeout=15000)
        D.fill("#syncBody input[placeholder='Your harmonism.io password']", "not the password")
        D.unroute("**/auth/v1/token**"); D.route("**/auth/v1/token**", lambda r: r.fulfill(status=400, content_type="application/json", body=json.dumps({"error_description": "Invalid login credentials"})))
        D.click("#syncBody button:has-text('Open my memory')"); D.wait_for_timeout(1500)
        check("a wrong password is refused by the sign-in service, and nothing opens", D.locator("#syncNow").count() == 0 and "do not match" in D.text_content("#syncBody"))
        D.unroute("**/auth/v1/token**"); D.route("**/auth/v1/token**", signin)
        D.fill("#syncBody input[placeholder='Your harmonism.io password']", PASS); D.click("#syncBody button:has-text('Open my memory')")
        D.wait_for_selector("#syncNow", timeout=30000); wait_synced(D)
        check("the right password opens it there and then", count(D) >= 4, str(count(D)))
        check("no request is left waiting on the server", not db("SELECT id FROM link"))
        close(D)
        for pg in (A, B): settings(pg); pg.click("#syncNow"); pg.wait_for_timeout(300); wait_synced(pg); close(pg)

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
        n_threads = count(B)
        other = js(B, f"return (await store.threads.list()).map(t => t.id).find(i => i !== {json.dumps(tid)});")
        js(B, f"await store.threads.remove({json.dumps(other)});")
        settings(B); B.click("#syncNow"); B.wait_for_timeout(300); wait_synced(B); close(B)
        settings(A); A.click("#syncNow"); A.wait_for_timeout(300); wait_synced(A); close(A)
        check("a conversation deleted on the computer is deleted on the phone", count(A) == count(B) and count(A) == n_threads - 1, f"{count(A)} / {count(B)}")

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

        # ── the copy started again elsewhere stops the other device ──────────
        settings(B); B.click("#syncOff"); B.wait_for_selector("#syncOn")
        check("turning off on one device keeps the synced copy", len(db("SELECT uid FROM space")) == 1)
        B.reload(); B.wait_for_selector("#main:not([hidden])", timeout=30000); B.wait_for_timeout(1500); settings(B)
        check("turned off by the person, it stays off after a reload, with no offer to be let in", B.is_visible("#syncOn") and B.is_hidden("#syncBanner"), B.text_content("#syncStatus"))
        B.click("#syncOn"); B.wait_for_selector("#syncBody .link-code", timeout=15000)
        B.click(".link-alt summary"); B.click(".link-alt button:has-text('Start the synced copy here')")
        B.wait_for_selector("#syncGo"); B.click("#syncGo")
        B.wait_for_selector("#syncNow", timeout=30000); wait_synced(B); close(B)
        settings(A); A.click("#syncNow"); A.wait_for_timeout(600)
        A.wait_for_selector("#syncOn", timeout=15000)
        check("the phone stops and says the copy was started again", "started again" in A.text_content("#syncStatus"), A.text_content("#syncStatus"))
        check("the phone's memory is untouched", count(A) == n_threads - 1)
        # The phone holds the password's key (typed above), but the copy started again on the
        # computer, which never had the password: the phone is let in by a tap.
        A.click("#syncOn"); A.wait_for_selector("#syncBody .link-code", timeout=15000)
        settings(B); B.wait_for_selector("#syncBody .link-request", timeout=15000); B.click("#syncBody .link-request button:has-text('Let it in')")
        B.wait_for_selector("#syncBody .link-request .link-code", timeout=20000); B.click("#syncBody .link-request button:has-text('Yes, let it in')")
        A.wait_for_selector("#syncNow", timeout=30000); st = wait_synced(A); close(B)
        lock = db("SELECT epoch FROM unlock"); sp = db("SELECT epoch FROM space")
        check("let in again, the phone locks the new copy under the password it holds", len(lock) == 1 and lock[0][0] == sp[0][0], f"{lock} {sp}")
        check("the computer lets the phone back in", "Synced" in st, st)

        # ── the recovery code ────────────────────────────────────────────────
        settings(A); A.click("#syncBody button:has-text('Recovery code')"); A.wait_for_selector(".recovery code")
        rc = A.text_content(".recovery code").strip()
        check("the recovery code is the key, shown only when asked (52 characters)", len(rc.replace("-", "")) == 52, rc[:9] + "…")

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
