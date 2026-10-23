"""Headless test of Lodestone's phone mode against mock endpoints.

Usage: python3 tools/test-phone.py [path/to/lodestone/app] [path/to/harmonia-astro]
(needs: pip install playwright; playwright install chromium)

Serves the app at http://localhost:8799/lodestone-app/ (localhost is a secure
context, as harmonism.io's https is) and also at the old /munai-offline/,
mocks lodestone-desktop-api.php on the same origin, serves the real
assessment.php (through `php -S`) when a harmonia-astro folder is given, and
intercepts Supabase and OpenRouter in the browser.
"""
import base64, json, os, shutil, subprocess, sys, tempfile, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

APP = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "app"))
ASTRO = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else None
ROOT = tempfile.mkdtemp(prefix="lodestone-phone-test-")
os.symlink(APP, os.path.join(ROOT, "lodestone-app"))
os.symlink(APP, os.path.join(ROOT, "munai-offline"))
PORT, PHP_PORT = 8799, 8798
LOG = {"hosted": [], "openrouter": [], "supabase": []}
SB_KEY = "sb-zccplzknsbpdczfnwkwz-auth-token"
GOOD = "sk-or-v1-goodkeygoodkeygoodkey00"
NO_SIGNIN_ASK = "try { localStorage.setItem('lodestone-signin-ask', 'never'); } catch (e) {}"   # the sign-in prompt (askSignIn) as "Don't ask again here": it makes the page inert


def hp_code(presence=7.0):
    p = {"v": 2, "alt": 6.1, "sk": {"e": True, "c": True},
         "w": {k: [presence if k == "presence" else 5.0, 6.0] for k in
               ["presence", "health", "matter", "service", "relationships", "learning", "nature", "recreation"]}}
    return "HP::" + base64.b64encode(json.dumps(p).encode()).decode()


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/lodestone-desktop-api.php"):
            if self.headers.get("Authorization") not in ("Bearer ACCESS1", "Bearer ACCESS2"):
                return self._json(401, {"error": {"code": "auth", "message": "Sign in to your harmonism.io account again."}})
            return self._json(200, {"email": "t@example.org", "status": "free", "cap": 10, "remaining": 7, "reset_at": 0,
                                    "models": [{"id": "deepseek/deepseek-v4.1-flash", "label": "DeepSeek V4.1 Flash", "maker": "DeepSeek", "licence": "MIT", "default": True},
                                               {"id": "z-ai/glm-5.3-flash", "label": "GLM-5.3 Flash", "maker": "Zhipu", "licence": "MIT", "default": False}]})
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/lodestone-desktop-api.php"):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            LOG["hosted"].append({"auth": self.headers.get("Authorization"), "body": body})
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            for w in ["Hosted ", "answer ", "from the mock."]:
                self.wfile.write(f'data: {json.dumps({"choices": [{"delta": {"content": w}}]})}\n\n'.encode()); self.wfile.flush(); time.sleep(0.05)
            self.wfile.write(b"data: [DONE]\n\n")
            return
        self.send_response(404); self.end_headers()


def sse(words):
    return "".join(f'data: {json.dumps({"choices": [{"delta": {"content": w}}]})}\n\n' for w in words) + "data: [DONE]\n\n"


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    php = None
    if ASTRO and shutil.which("php"):
        php = subprocess.Popen(["php", "-S", f"127.0.0.1:{PHP_PORT}", "-t", ASTRO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.8)
    results = []
    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail)); print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)

    with sync_playwright() as p:
        b = p.chromium.launch()
        iphone = {k: v for k, v in p.devices["iPhone 13"].items() if k != "default_browser_type"}
        ctx = b.new_context(**iphone); ctx.add_init_script(NO_SIGNIN_ASK)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e) + " @ " + (e.stack or "")[:400]))
        page.on("console", lambda m: m.type == "error" and not m.text.startswith("Failed to load resource") and errors.append(m.text))
        page.on("dialog", lambda d: d.accept())

        def supa(route):
            data = json.loads(route.request.post_data or "{}")
            LOG["supabase"].append({"url": route.request.url, "body": data})
            route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
                          body=json.dumps({"access_token": "ACCESS2", "refresh_token": "REFRESH2", "expires_in": 3600, "token_type": "bearer", "user": {"email": "t@example.org"}}))
        page.route("https://zccplzknsbpdczfnwkwz.supabase.co/**", supa)

        def orouter(route):
            req = route.request
            if req.method == "OPTIONS":
                return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
            body = json.loads(req.post_data or "{}")
            LOG["openrouter"].append({"auth": req.headers.get("authorization"), "body": body})
            if req.headers.get("authorization") != "Bearer " + GOOD:
                return route.fulfill(status=401, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps({"error": {"message": "No auth"}}))
            words = ["ready"] if body.get("max_tokens") == 10 else ["OpenRouter ", "answer."]
            route.fulfill(status=200, content_type="text/event-stream", headers={"Access-Control-Allow-Origin": "*"}, body=sse(words))
        page.route("https://openrouter.ai/**", orouter)

        base = f"http://localhost:{PORT}"
        page.goto(base + "/lodestone-app/")
        page.wait_for_selector("#setup:not([hidden])")
        page.wait_for_function("document.querySelectorAll('#tierChoices .choice').length > 0")
        page.wait_for_timeout(500)
        labels = page.eval_on_selector_all("#tierChoices .choice strong", "ns => ns.map(n => n.textContent)")
        check("phone order: account, OpenRouter, computer, no model", labels == ["My harmonism.io account", "OpenRouter, with my own key", "My computer's model server", "No model: read and search"], str(labels))
        pressed = page.eval_on_selector_all("#tierChoices .choice[aria-pressed=true] strong", "ns => ns.map(n => n.textContent)")
        check("the harmonism.io account preselected on a phone, its tested models named with DeepSeek V4.1 Flash the default", pressed == ["My harmonism.io account"] and "DeepSeek V4.1 Flash (default)" in page.text_content("#tierChoices .choice[aria-pressed=true] .models"), str(pressed))
        check("account is its own step, signed out, with links back to Lodestone",
              page.is_visible("#accountBox") and page.get_attribute("#acctBtns a:nth-child(1)", "href") == "/member/login.php?return=lodestone"
              and page.get_attribute("#acctBtns a:nth-child(2)", "href") == "/member/register.php?return=lodestone", page.text_content("#acctStatus"))
        check("Begin disabled before a key", page.is_disabled("#beginSetup"))

        page.click("#tierChoices .choice:has(strong:has-text('My computer'))")
        check("computer route on a phone is a pointer to Lodestone Desktop, not a form", page.is_visible("#phoneComputer") and page.is_hidden("#serverFields") and page.is_disabled("#beginSetup"))
        page.click("#tierChoices .choice:has(strong:has-text('harmonism.io account'))")
        check("hosted route needs the account first", page.is_disabled("#beginSetup") and "Sign in" in page.text_content("#hStatus"), page.text_content("#hStatus"))

        page.click("#tierChoices .choice:has(strong:has-text('OpenRouter'))")
        page.fill("#orKey", "sk-or-v1-badkeybadkeybadkeybad00")
        page.wait_for_function("document.querySelector('#orStatus').textContent.includes('refused')", timeout=8000)
        check("a pasted bad key is tested and refused without pressing Test", True, page.text_content("#orStatus"))
        page.fill("#orKey", GOOD)
        page.wait_for_function("document.querySelector('#orStatus').textContent.includes('works')", timeout=8000)
        check("a pasted good key enables Begin by itself", not page.is_disabled("#beginSetup"), page.text_content("#orStatus"))
        page.screenshot(path=os.path.join(ROOT, "setup.png"), full_page=True)
        page.uncheck("#optSemantic")
        page.click("#beginSetup")
        page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('OpenRouter')", timeout=20000)
        page.fill("#input", "How do I begin with sleep?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].some(b => b.textContent.includes('OpenRouter answer'))", timeout=20000)
        o = LOG["openrouter"][-1]
        check("OpenRouter turn: own key, recommended model run as hosted, full backbone",
              o["body"]["model"] == "deepseek/deepseek-v4.1-flash" and o["body"].get("provider") == {"data_collection": "deny"} and len(o["body"]["messages"][0]["content"]) > 40000)
        page.wait_for_timeout(400)
        check("model menu shown on the phone", page.is_visible("#modelRow") and "openrouter.ai" in page.text_content("#modelChipLabel"), page.text_content("#modelChipLabel"))
        page.click("#modelChip"); page.wait_for_timeout(400)
        groups = page.eval_on_selector_all("#modelMenu .model-group", "ns => ns.map(n => n.textContent)")
        check("menu: the account (signed out: one step to sign in), OpenRouter's models and no model, each saying who reads", groups[0].startswith("Your harmonism.io account — harmonism.io reads each turn") and "Sign in for ten free messages a day" in page.text_content("#modelMenu") and any(g.startswith("OpenRouter, your key — OpenRouter reads") for g in groups) and any("No model" in g for g in groups), str(groups))
        check("menu: another model id can be typed under OpenRouter", page.is_visible("#modelMenu .model-other input"))
        page.click("#modelMenu .model-item:has-text('GLM-5.3 Flash')"); page.wait_for_timeout(600)
        page.fill("#input", "And Logos?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].filter(b => b.textContent.includes('OpenRouter answer')).length >= 2", timeout=20000)
        check("switching in the menu changes the model in place", LOG["openrouter"][-1]["body"]["model"] == "z-ai/glm-5.3-flash" and LOG["openrouter"][-1]["body"].get("max_tokens") == 8000)

        # Setup opened from the menu is not a one-way door: a route not ready leaves Begin off, and Back restores the route as it was.
        page.click("#modelChip"); page.wait_for_timeout(400)
        page.click("#modelMenu .model-manage"); page.wait_for_selector("#setup:not([hidden])", timeout=10000)
        page.click("#tierChoices .choice:has(strong:has-text('computer'))"); page.wait_for_timeout(200)
        check("setup from the menu: an unready route disables Begin, and Back is offered", page.is_disabled("#beginSetup") and page.is_visible("#setupBack"))
        page.click("#setupBack"); page.wait_for_selector("#main:not([hidden])", timeout=10000); page.wait_for_timeout(400)
        page.fill("#input", "Back again?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].filter(b => b.textContent.includes('OpenRouter answer')).length >= 3", timeout=20000)
        check("Back restores the saved route untouched", LOG["openrouter"][-1]["body"]["model"] == "z-ai/glm-5.3-flash" and "openrouter.ai" in page.text_content("#modelChipLabel"), page.text_content("#modelChipLabel"))

        page.click("#btnMe"); page.wait_for_timeout(500)
        check("Your path offers the assessment and, signed out, the account", page.get_attribute("#hpBtns a:nth-child(1)", "href") == "/assessment.php?return=lodestone"
              and "account" in page.text_content("#hpStatus"), page.text_content("#hpStatus"))
        page.click("#drawerMe [data-close]")

        sess = {"access_token": "ACCESS1", "refresh_token": "REFRESH1", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "token_type": "bearer", "user": {"email": "t@example.org"}}
        page.evaluate("([k, v]) => localStorage.setItem(k, v)", [SB_KEY, json.dumps(sess)])
        page.reload(); page.wait_for_selector("#main:not([hidden])", timeout=30000)
        # Signing in, the app asks whether the device's memory is this account's (accepted here) and reopens on it.
        page.wait_for_function("(async () => (await import('./js/store.js')).using() === 'munai-offline')()", timeout=20000)
        page.wait_for_selector("#modelRow:not([hidden])", timeout=30000); page.wait_for_timeout(800)
        page.click("#modelChip"); page.wait_for_timeout(600)
        groups = page.eval_on_selector_all("#modelMenu .model-group", "ns => ns.map(n => n.textContent)")
        check("signed in on the website: the account's models join the menu", any("harmonism.io account" in g and "7 of 10" in g for g in groups), str(groups))
        page.click("#modelMenu .model-item:has-text('DeepSeek V4.1 Flash') >> nth=0")   # the account's, first; page.wait_for_timeout(600)
        page.fill("#input", "What is Dharma?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].some(b => b.textContent.includes('from the mock'))", timeout=20000)
        h = LOG["hosted"][-1]
        check("hosted turn uses the website's session and the backbone placeholder", h["auth"] == "Bearer ACCESS1" and "(harmonism.io places its current doctrinal backbone here.)" in h["body"]["messages"][0]["content"])

        sess["expires_at"] = int(time.time()) - 10
        page.evaluate("([k, v]) => localStorage.setItem(k, v)", [SB_KEY, json.dumps(sess)])
        page.fill("#input", "And the Wheel?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].filter(b => b.textContent.includes('from the mock')).length >= 2", timeout=20000)
        stored = json.loads(page.evaluate("k => localStorage.getItem(k)", SB_KEY))
        check("expired token renewed through Supabase and written back for the website",
              bool(LOG["supabase"]) and LOG["supabase"][-1]["body"].get("refresh_token") == "REFRESH1" and stored["access_token"] == "ACCESS2" and stored["refresh_token"] == "REFRESH2" and LOG["hosted"][-1]["auth"] == "Bearer ACCESS2")

        page.wait_for_timeout(1500)   # let the last turn's stream close before navigating away
        page.evaluate("([k, v]) => localStorage.setItem(k, v)", ["munai-hp-pending", hp_code(7.0)])
        page.reload(); page.wait_for_selector("#main:not([hidden])", timeout=30000)
        page.wait_for_function("[...document.querySelectorAll('.msg.user .body')].some(b => b.textContent.includes('Harmonic Profile from the assessment'))", timeout=10000)
        st = page.evaluate("async () => { const m = await import('./js/store.js'); return { wheel: await m.kv.get('wheel'), a: await m.kv.get('assessment'), pending: localStorage.getItem('munai-hp-pending') }; }")
        check("a profile left by the assessment is taken in once", st["wheel"].get("presence") == 4 and st["a"].startswith("Altitude") and st["pending"] is None, json.dumps(st)[:160])
        page.click("#btnMe"); page.wait_for_timeout(500)
        check("Your path then offers a retake", "Retake" in page.text_content("#hpBtns") and "Taken" in page.text_content("#hpStatus"))
        page.screenshot(path=os.path.join(ROOT, "yourpath.png"))
        page.click("#drawerMe [data-close]")
        page.evaluate("([k, v]) => localStorage.setItem(k, v)", ["munai-hp-pending", hp_code(9.5)])
        page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_timeout(1500)
        w = page.evaluate("async () => (await (await import('./js/store.js')).kv.get('wheel'))")
        check("a retake replaces the earlier profile after confirmation", w.get("presence") == 5, str(w))

        n = len(LOG["hosted"])
        page.fill("#input", "I want to kill myself"); page.click("#sendBtn")
        page.wait_for_selector(".msg.crisis", timeout=10000); page.wait_for_timeout(400)
        check("crisis gate answers without any model call", len(LOG["hosted"]) == n)
        check("no page errors", not errors, "; ".join(errors[:5]))
        ctx.close()

        if php:
            c2 = b.new_context(**iphone); c2.add_init_script(NO_SIGNIN_ASK)
            pg = c2.new_page()
            pg.on("dialog", lambda d: d.accept())
            ph = f"http://127.0.0.1:{PHP_PORT}"
            pg.goto(ph + "/assessment.php?return=lodestone")
            ok = pg.evaluate("() => typeof sendToLodestoneApp === 'function' && sessionStorage.getItem('munai-return') === '1'")
            check("assessment.php opened from Lodestone remembers to return", ok)
            pg.route("**/lodestone-app/**", lambda r: r.fulfill(status=200, body="<p>app</p>", content_type="text/html"))
            pg.evaluate("() => { document.getElementById('shareConsentCheckbox').checked = true; }")
            try:
                pg.evaluate("() => sendToLodestoneApp()")
                pg.wait_for_url("**/lodestone-app/**", timeout=5000)
                code = pg.evaluate("() => localStorage.getItem('munai-hp-pending')")
                check("the assessment leaves an HP code and goes to Lodestone", bool(code) and code.startswith("HP::"), (code or "")[:24])
            except Exception as e:
                check("the assessment leaves an HP code and goes to Lodestone", False, str(e)[:300])
            c2.close()

        ctx3 = b.new_context(viewport={"width": 1280, "height": 800}); ctx3.add_init_script(NO_SIGNIN_ASK)
        pg = ctx3.new_page()
        pg.goto(base + "/lodestone-app/")
        pg.wait_for_function("document.querySelectorAll('#tierChoices .choice').length > 0")
        l2 = pg.eval_on_selector_all("#tierChoices .choice strong", "ns => ns.map(n => n.textContent)")
        p2 = pg.eval_on_selector_all("#tierChoices .choice[aria-pressed=true] strong", "ns => ns.map(n => n.textContent)")
        check("a computer's browser also begins on the account, with this browser's model offered after the computer", l2[:2] == ["My harmonism.io account", "OpenRouter, with my own key"] and "This browser" in l2 and l2.index("This browser") > l2.index("My computer's model server") and p2 == ["My harmonism.io account"], f"{l2} {p2}")
        ctx3.close(); b.close()
    srv.shutdown()
    if php: php.terminate()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} of {len(results)} passed · screenshots in {ROOT}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
