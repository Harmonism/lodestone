"""Headless test of the conversation summary in Lodestone's web app (October 19, 2026).

Usage: python3 tools/test-summary.py [path/to/lodestone/app]   (needs playwright, as test-phone.py)

Phone mode on OpenRouter with a mocked endpoint, reusing test-phone.py's server: long
replies fill the window, and every question must stay either in the window or in the
summary; the summary is the structured record, rendered and shown."""
import importlib.util, json, os, sys, threading, time
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "app")); TP = os.path.join(HERE, "test-phone.py")
sys.argv = [TP, APP]
spec = importlib.util.spec_from_file_location("tp", TP); tp = importlib.util.module_from_spec(spec); spec.loader.exec_module(tp)
LONG = ("Sleep is the ground of the Wheel of Health. " * 70).strip()   # ~3,100 characters
SUMMARY_JSON = json.dumps({"working_on": ["sleep after the move to Rabat"], "about_them": ["wakes at 3 every night", "takes 400 mg magnesium glycinate"], "their_words": ["I wake at 3 every night and cannot fall back"], "commitments": ["no screens after 21:00"], "open": ["whether to fast in the morning"], "drew_on": ["Wheel of Health"]})
calls = []
def main():
    srv = ThreadingHTTPServer(("127.0.0.1", tp.PORT), tp.H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    res = []
    def check(n, ok, d=""): res.append(ok); print(("PASS " if ok else "FAIL ") + n + (f" — {d}" if d else ""), flush=True)
    with sync_playwright() as p:
        b = p.chromium.launch(); iphone = {k: v for k, v in p.devices["iPhone 13"].items() if k != "default_browser_type"}
        c0 = b.new_context(**iphone); c0.add_init_script(tp.NO_SIGNIN_ASK); page = c0.new_page(); errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        def orouter(route):
            req = route.request
            if req.method == "OPTIONS": return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
            body = json.loads(req.post_data or "{}"); msgs = body.get("messages", [])
            is_sum = bool(msgs) and msgs[0]["content"].startswith("You write the record")
            calls.append({"summary": is_sum, "n": len(msgs), "system": msgs[0]["content"] if msgs else "", "user": msgs[-1]["content"] if msgs else "", "all": "\n".join(m["content"] for m in msgs[1:])})
            words = ["ready"] if body.get("max_tokens") == 10 else ([SUMMARY_JSON] if is_sum else [LONG])
            route.fulfill(status=200, content_type="text/event-stream", headers={"Access-Control-Allow-Origin": "*"}, body=tp.sse(words))
        page.route("https://openrouter.ai/**", orouter)
        page.goto(f"http://localhost:{tp.PORT}/lodestone-app/"); page.wait_for_selector("#setup:not([hidden])")
        page.wait_for_function("document.querySelectorAll('#tierChoices .choice').length > 0"); page.wait_for_timeout(400)
        page.click("#tierChoices .choice:has(strong:has-text('OpenRouter'))")
        # A model not tested against the doctrine keeps the 32,768-token window (a tested one gets 65,536),
        # which fourteen long exchanges press: the fold is exercised where the window is narrowest.
        page.select_option("#orModel", "__other"); page.fill("#orOther", "mistralai/mistral-medium-3"); page.fill("#orKey", tp.GOOD)
        page.wait_for_function("document.querySelector('#orStatus').textContent.includes('works')", timeout=8000)
        page.uncheck("#optSemantic"); page.click("#beginSetup"); page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('OpenRouter') || document.querySelector('#engineBadge').textContent.includes('mistral')", timeout=20000)
        first_sum_at = None
        for i in range(1, 15):
            page.fill("#input", f"Question {i} about sleep: what next?"); page.click("#sendBtn")
            page.wait_for_function(f"document.querySelectorAll('.msg.assistant .body').length >= {i}", timeout=20000)
            page.wait_for_function("!document.querySelector('#sendBtn').disabled || true"); page.wait_for_timeout(700)
            if first_sum_at is None and any(c["summary"] for c in calls): first_sum_at = i
        turns = [c for c in calls if not c["summary"] and c["n"] > 1]
        sums = [c for c in calls if c["summary"]]
        check("a summary was folded before 40 turns, from window pressure", first_sum_at is not None and first_sum_at < 20, f"first fold after exchange {first_sum_at}; {len(sums)} summary call(s)")
        # Invariant: from the turn after it was asked until it is folded into a summary, every
        # question is sent with each turn; it is never in neither the summary nor the window.
        lost = []
        for i in range(1, 15):
            q = f"Question {i} about sleep"
            own = next(k for k, c in enumerate(calls) if not c["summary"] and c["user"].startswith(q))
            for c in calls[own + 1:]:
                if c["summary"]:
                    if q in c["all"]: break      # folded
                    continue
                if c["n"] > 1 and q not in c["all"]: lost.append(i); break
        check("no question fell out of the window unsummarized", not lost, f"lost: {lost}")
        print("DIAG folds after exchanges:", [sum(1 for c in calls[:k] if not c["summary"] and c["n"] > 1) for k, c in enumerate(calls) if c["summary"]])
        check("the summary request is the structured one", sums and '"their_words"' in sums[0]["system"])
        th = page.evaluate("(async () => { const s = await import('./js/store.js'); const t = (await s.threads.list())[0]; return { summary: t.summary, through: t.summaryThrough }; })()")
        check("the thread keeps the rendered record", th["summary"] and th["summary"].startswith("Working on: sleep after the move to Rabat") and "“I wake at 3 every night and cannot fall back”" in th["summary"] and "400 mg magnesium glycinate" in th["summary"], repr(th["summary"])[:200])
        last = turns[-1]
        check("later turns send it as <conversation_summary> and fewer turns", "<conversation_summary>\nWorking on:" in last["system"] and last["n"] - 2 < 26, f"history sent on the last turn: {last['n'] - 2}")
        page.wait_for_timeout(300)
        check("the summary note shows in the chat", "Working on:" in (page.text_content(".summary-note") or ""))
        check("no page errors", not errors, "; ".join(errors)[:300])
    print(f"{sum(res)} of {len(res)} passed")
main()
