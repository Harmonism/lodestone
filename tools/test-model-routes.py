"""Where Lodestone thinks, in the web app on a computer, against test-phone.py's mocks:
  setup begins on the harmonism.io account with DeepSeek V4.1 Flash, OpenRouter next, the
  browser's own model offered after the computer and never preselected, Bonsai named for the desktop;
  signed in, the account's model is chosen in setup and the chip names it, not its id;
  reopening setup says where Lodestone thinks now;
  the menu: a key pasted there is tested and DeepSeek V4.1 Flash begins on OpenRouter; another
  model id can be typed; this browser's models are listed, and choosing one asks first.

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
        check("this browser's model offered after the computer, never chosen for the practitioner", "This browser" in labels and labels.index("This browser") > labels.index("My computer's model server"))
        br = page.text_content("#tierChoices .choice:has(strong:has-text('This browser'))")
        check("its card says what it downloads, that it stays on the device, and points to Bonsai on the desktop", "6 GB" in br and "nothing you say leaves this device" in br and "Bonsai 2 27B Heretic" in br)
        check("the account and OpenRouter cards name the tested models, DeepSeek V4.1 Flash the default",
              all("DeepSeek V4.1 Flash (default)" in page.text_content(f"#tierChoices .choice:has(strong:has-text('{t}')) .models") for t in ["harmonism.io account", "OpenRouter"]))
        check("first run: no line about where Lodestone thinks now", page.is_hidden("#setupNow"))
        page.wait_for_selector("#hModelRow:not([hidden])", timeout=10000)
        check("signed in: the account's model is chosen in setup, DeepSeek V4.1 Flash first", page.input_value("#hModel") == "deepseek/deepseek-v4.1-flash" and page.eval_on_selector_all("#hModel option", "o => o.length") == 2)
        page.select_option("#hModel", "z-ai/glm-5.3-flash")
        page.uncheck("#optSemantic"); page.click("#beginSetup"); page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.wait_for_selector("#modelRow:not([hidden])", timeout=20000); page.wait_for_timeout(600)
        check("the chip names the account's model, not its id", page.text_content("#modelChipLabel") == "GLM-5.3 Flash · harmonism.io", page.text_content("#modelChipLabel"))
        page.fill("#input", "What is Dharma?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].some(b => b.textContent.includes('from the mock'))", timeout=20000)
        check("the turn goes to the account with the model chosen in setup", LOG["hosted"][-1]["body"].get("model") == "z-ai/glm-5.3-flash")
        # The menu: no key yet; one pasted there
        page.click("#modelChip"); page.wait_for_timeout(500)
        groups = page.eval_on_selector_all("#modelMenu .model-group", "ns => ns.map(n => n.textContent)")
        check("menu order: account, OpenRouter, this browser, no model; each says who reads",
              [g.split(" —")[0] for g in groups] == ["Your harmonism.io account", "OpenRouter, your key", "In this browser", "No model"] and "harmonism.io reads each turn" in groups[0] and "nothing leaves this device" in groups[2], str(groups))
        check("the account's current model is marked", "GLM-5.3 Flash" in page.text_content("#modelMenu .model-item.active"))
        page.fill("#menuOrKey", "sk-or-v1-badkeybadkeybadkeybad00"); page.click("#modelMenu .model-other button")
        page.wait_for_function("!/Asking OpenRouter/.test(document.querySelector('#modelMenu').textContent)", timeout=10000)
        check("a bad key pasted in the menu is refused there", "OpenRouter refused the key" in page.text_content("#modelMenu") and page.is_visible("#modelMenu"), page.text_content("#modelMenu")[:700] if page.is_visible("#modelMenu") else "menu closed")
        page.fill("#menuOrKey", tp.GOOD); page.click("#modelMenu .model-other button")
        page.wait_for_function("document.querySelector('#modelChipLabel').textContent === 'DeepSeek V4.1 Flash · openrouter.ai'", timeout=15000)
        check("a good key pasted in the menu: kept, and DeepSeek V4.1 Flash begins on OpenRouter", page.evaluate("(async () => !!(await (await import('./js/phone.js')).secrets.get('openrouter')))()"))
        page.fill("#input", "And the Wheel?"); page.click("#sendBtn")
        page.wait_for_function("[...document.querySelectorAll('.msg.assistant .body')].some(b => b.textContent.includes('OpenRouter answer'))", timeout=20000)
        check("the turn goes to OpenRouter under that key", LOG["openrouter"][-1]["body"]["model"] == "deepseek/deepseek-v4.1-flash" and LOG["openrouter"][-1]["auth"] == "Bearer " + tp.GOOD)
        page.click("#modelChip"); page.wait_for_timeout(500)
        page.fill("#modelMenu .model-other input", "mistralai/mistral-medium-3"); page.press("#modelMenu .model-other input", "Enter"); page.wait_for_timeout(800)
        check("another model id typed in the menu is used", "mistralai/mistral-medium-3" in page.text_content("#modelChipLabel"), page.text_content("#modelChipLabel"))
        # This browser's model: asks first (dismissed here), nothing changes
        page.click("#modelChip"); page.wait_for_timeout(500)
        page.click("#modelMenu .model-item:has-text('Qwen3-8B')"); page.wait_for_timeout(500)
        check("choosing this browser's model asks first, saying what it downloads", dialogs and "downloads about 6 GB" in dialogs[-1] and "mistral" in page.text_content("#modelChipLabel"), dialogs[-1][:120] if dialogs else "")
        # Reopening setup says where Lodestone thinks now
        page.click("#modelChip"); page.wait_for_timeout(400); page.click("#modelMenu .model-manage"); page.wait_for_selector("#setup:not([hidden])")
        page.wait_for_timeout(500)
        check("reopened, setup says where Lodestone thinks now and who reads", page.is_visible("#setupNow") and "rented from OpenRouter with your key; OpenRouter reads each message" in page.text_content("#setupNow"), page.text_content("#setupNow"))
        check("no page errors", not errors, "; ".join(errors)[:300])
        page.screenshot(path="/tmp/model-routes-setup.png", full_page=True)
    print(f"{sum(res)} of {len(res)} passed")
    srv.shutdown()
main()
