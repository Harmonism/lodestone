"""Where Lodestone thinks, in the web app on a computer, against test-phone.py's mocks:
  setup begins on the harmonism.io account with DeepSeek V4.1 Flash, OpenRouter next, and no
  model inside the browser (withdrawn 25 Oct 2026: none holds the whole backbone);
  signed in, the account's model is chosen in setup; the chat page carries no model chip
  (October 26, 2026: the model is a Settings choice); Settings switches the model in place;
  "Change where Lodestone thinks" reopens setup, which says where Lodestone thinks now; a key
  pasted there is tested and DeepSeek V4.1 Flash begins on OpenRouter; another model id can
  be typed; no in-browser model is listed.

Usage: python3 tools/test-model-routes.py      (needs playwright, as test-phone.py)"""
import importlib.util, json, os, sys, threading, time
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); TP = os.path.join(HERE, "test-phone.py")
sys.argv = [TP, os.path.join(HERE, "..", "app")]
spec = importlib.util.spec_from_file_location("tp", TP); tp = importlib.util.module_from_spec(spec); spec.loader.exec_module(tp)
LOG = tp.LOG

def main():
    srv = ThreadingHTTPServer(("127.0.0.1", tp.PORT), tp.H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    res = []
    def check(n, ok, d=""): res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + n + (f" — {d}" if d else ""), flush=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1280, "height": 900}); page = ctx.new_page(); errors = []; dialogs = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
        def orouter(route):
            req = route.request
            if req.method == "OPTIONS": return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
            body = json.loads(req.post_data or "{}"); LOG["openrouter"].append({"auth": req.headers.get("authorization"), "body": body})
            if req.headers.get("authorization") != "Bearer " + tp.GOOD:
                return route.fulfill(status=401, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps({"error": {"message": "No auth"}}))
            route.fulfill(status=200, content_type="text/event-stream", headers={"Access-Control-Allow-Origin": "*"}, body=tp.sse(["ready"] if body.get("max_tokens") == 10 else ["OpenRouter ", "answer."]))
        page.route("https://openrouter.ai/**", orouter)
        page.route("https://zccplzknsbpdczfnwkwz.supabase.co/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
                   body=json.dumps({"access_token": "ACCESS2", "refresh_token": "REFRESH2", "expires_in": 3600, "token_type": "bearer", "user": {"email": "t@example.org"}})))
        sess = {"access_token": "ACCESS1", "refresh_token": "REFRESH1", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "token_type": "bearer", "user": {"email": "t@example.org"}}
        page.goto(f"http://localhost:{tp.PORT}/lodestone-app/")
        page.evaluate("([k, v]) => localStorage.setItem(k, v)", [tp.SB_KEY, json.dumps(sess)])
        page.reload(); page.wait_for_function("document.querySelectorAll('#tierChoices .choice').length > 0"); page.wait_for_timeout(800)
        labels = page.eval_on_selector_all("#tierChoices .choice strong", "ns => ns.map(n => n.textContent)")
        pressed = page.eval_on_selector_all("#tierChoices .choice[aria-pressed=true] strong", "ns => ns.map(n => n.textContent)")
        check("a computer's browser: the account first and chosen, OpenRouter next", labels[:2] == ["My harmonism.io account", "OpenRouter, with my own key"] and pressed == ["My harmonism.io account"], f"{labels} {pressed}")
        check("no model inside the browser is offered", "This browser" not in labels, str(labels))
        check("the account and OpenRouter cards name the tested models, DeepSeek V4.1 Flash the default",
              all("DeepSeek V4.1 Flash (default)" in page.text_content(f"#tierChoices .choice:has(strong:has-text('{t}')) .models") for t in ["harmonism.io account", "OpenRouter"]))
        check("first run: no line about where Lodestone thinks now", page.is_hidden("#setupNow"))
        page.wait_for_selector("#hModelRow:not([hidden])", timeout=10000)
        check("signed in: the account's model is chosen in setup, DeepSeek V4.1 Flash first", page.input_value("#hModel") == "deepseek/deepseek-v4.1-flash-1017" and page.eval_on_selector_all("#hModel option", "o => o.length") == 2)
        page.select_option("#hModel", "nvidia/nemotron-3-ultra-550b-a55b")
        page.uncheck("#optSemantic"); page.click("#beginSetup"); page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.wait_for_timeout(1500)
        check("the chat page carries no model chip", page.is_hidden("#modelRow"))
        page.fill("#input", "What is Dharma?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].some(b => b.textContent.includes('from the mock'))", timeout=20000)
        check("the turn goes to the account with the model chosen in setup", LOG["hosted"][-1]["body"].get("model") == "nvidia/nemotron-3-ultra-550b-a55b")
        # Settings: the model is changed here, in place
        page.click("#btnSettingsSide"); page.wait_for_selector("#drawerSettings:not([hidden])"); page.wait_for_timeout(800)
        opts = page.eval_on_selector_all("#setModel option", "o => o.map(x => x.value)")
        check("Settings lists the account's models, the current one chosen", opts == ["deepseek/deepseek-v4.1-flash-1017", "nvidia/nemotron-3-ultra-550b-a55b"] and page.input_value("#setModel") == "nvidia/nemotron-3-ultra-550b-a55b", str(opts))
        page.select_option("#setModel", "deepseek/deepseek-v4.1-flash-1017"); page.wait_for_timeout(1200)
        check("switching in Settings says so in the conversation", "Now thinking with" in page.text_content("#chat"))
        page.click("#drawerSettings [data-close]"); page.wait_for_timeout(300)
        page.fill("#input", "And Logos?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].filter(b => b.textContent.includes('from the mock')).length >= 2", timeout=20000)
        check("the next turn uses the model chosen in Settings", LOG["hosted"][-1]["body"].get("model") == "deepseek/deepseek-v4.1-flash-1017")
        # Settings → Change where Lodestone thinks: setup says where it thinks now; a key pasted there
        page.click("#btnSettingsSide"); page.wait_for_selector("#drawerSettings:not([hidden])"); page.wait_for_timeout(500)
        page.click("#setChangeTier"); page.wait_for_selector("#setup:not([hidden])"); page.wait_for_timeout(500)
        check("reopened from Settings, setup says where Lodestone thinks now and who reads", page.is_visible("#setupNow") and "harmonism.io" in page.text_content("#setupNow"), page.text_content("#setupNow"))
        page.click("#tierChoices .choice:has(strong:has-text('OpenRouter'))")
        page.fill("#orKey", "sk-or-v1-badkeybadkeybadkeybad00")
        page.wait_for_function("document.querySelector('#orStatus').textContent.includes('refused')", timeout=8000)
        check("a bad key pasted in setup is refused there", True, page.text_content("#orStatus"))
        page.fill("#orKey", tp.GOOD)
        page.wait_for_function("document.querySelector('#orStatus').textContent.includes('works')", timeout=8000)
        page.click("#beginSetup"); page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.fill("#input", "And the Wheel?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].some(b => b.textContent.includes('OpenRouter answer'))", timeout=20000)
        check("a good key: kept, and DeepSeek V4.1 Flash begins on OpenRouter under it", LOG["openrouter"][-1]["body"]["model"] == "deepseek/deepseek-v4.1-flash-1017" and LOG["openrouter"][-1]["auth"] == "Bearer " + tp.GOOD
              and page.evaluate("(async () => !!(await (await import('./js/phone.js')).secrets.get('openrouter')))()"))
        # Another model id, typed in setup
        page.click("#btnSettingsSide"); page.wait_for_selector("#drawerSettings:not([hidden])"); page.wait_for_timeout(500)
        page.click("#setChangeTier"); page.wait_for_selector("#setup:not([hidden])"); page.wait_for_timeout(500)
        check("reopened, setup says Lodestone thinks on OpenRouter with your key", "rented from OpenRouter with your key; OpenRouter reads each message" in page.text_content("#setupNow"), page.text_content("#setupNow"))
        page.click("#tierChoices .choice:has(strong:has-text('OpenRouter'))"); page.wait_for_timeout(300)
        page.select_option("#orModel", "__other"); page.fill("#orOther", "mistralai/mistral-medium-3")
        page.click("#orTest"); page.wait_for_function("document.querySelector('#orStatus').textContent.includes('works')", timeout=8000)
        page.click("#beginSetup"); page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.fill("#input", "And Presence?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].filter(b => b.textContent.includes('OpenRouter answer')).length >= 2", timeout=20000)
        check("another model id typed in setup is used", LOG["openrouter"][-1]["body"]["model"] == "mistralai/mistral-medium-3", LOG["openrouter"][-1]["body"]["model"])
        check("no page errors", not errors, "; ".join(errors)[:300])
        page.screenshot(path="/tmp/model-routes-setup.png", full_page=True)
    print(f"{sum(res)} of {len(res)} passed")
    srv.shutdown()
main()
