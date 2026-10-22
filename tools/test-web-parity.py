"""The web app on a phone, with what used to be Lodestone Desktop's only: attachments
(text, PDF, image), dictation with the speech model downloaded into the browser and checked,
"Look this up" on Wikipedia, and the life book read from its synced copy with Keep queued for
the desktop. Phone mode on OpenRouter against mocks, reusing test-phone.py's server; the speech
model's real files are served at their Hugging Face addresses from a local folder, so the
download, the SHA-256 check and a real transcription all run.

Usage: python3 tools/test-web-parity.py [folder with the whisper-small files] [a speech .wav]
(needs playwright and openssl; without arguments the speech model's files and a sample
recording are downloaded once into ~/.cache/lodestone-tests/)"""
import importlib.util, json, os, ssl, subprocess, sys, tempfile, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "app"); TP = os.path.join(HERE, "test-phone.py")
REV = "2d67713f236afa48a18992566e7647f6ca848e13"
CACHE = os.path.expanduser("~/.cache/lodestone-tests")
WHISPER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(CACHE, "whisper-small")
WAV = sys.argv[2] if len(sys.argv) > 2 else os.path.join(CACHE, "jfk.wav")
def fetch_once(url, dest):
    if os.path.exists(dest): return
    import urllib.request
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print("downloading", url, flush=True); urllib.request.urlretrieve(url, dest + ".part"); os.replace(dest + ".part", dest)
for f in ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]:
    fetch_once(f"https://huggingface.co/Xenova/whisper-small/resolve/{REV}/{f}", os.path.join(WHISPER, f))
fetch_once("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav", WAV)
# The attachments: a text file, a one-page PDF with real text, an 8-pixel PNG
import struct, zlib
FIX = tempfile.mkdtemp(prefix="web-parity-fix-")
open(os.path.join(FIX, "practice.txt"), "w").write("Morning practice: 20 minutes of breathing, then a walk.\n")
_w = 8; _raw = b"".join(b"\x00" + b"\xc0\x80\x40" * _w for _ in range(_w))
_ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
open(os.path.join(FIX, "photo.png"), "wb").write(b"\x89PNG\r\n\x1a\n" + _ch(b"IHDR", struct.pack(">IIBBBBB", _w, _w, 8, 2, 0, 0, 0)) + _ch(b"IDAT", zlib.compress(_raw)) + _ch(b"IEND", b""))
_txt = b"BT /F1 12 Tf 72 720 Td (Lab results 14 October 2026: ferritin 18 ng/mL, vitamin D 21 ng/mL.) Tj ET"
_objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
         b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
         b"<< /Length %d >>\nstream\n" % len(_txt) + _txt + b"\nendstream", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
_pdf = b"%PDF-1.4\n"; _offs = []
for i, o in enumerate(_objs, 1): _offs.append(len(_pdf)); _pdf += b"%d 0 obj\n" % i + o + b"\nendobj\n"
_x = len(_pdf); _pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(_objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in _offs)
_pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(_objs) + 1, _x)
open(os.path.join(FIX, "labs.pdf"), "wb").write(_pdf)
sys.argv = [TP, APP]
spec = importlib.util.spec_from_file_location("tp", TP); tp = importlib.util.module_from_spec(spec); spec.loader.exec_module(tp)
calls = []; hf = []
class Files(SimpleHTTPRequestHandler):
    """The speech model's files over local HTTPS, standing in for Hugging Face (streamed, not held in memory)."""
    def __init__(s, *a, **k): super().__init__(*a, directory=WHISPER, **k)
    def log_message(s, *a): pass
    def end_headers(s): s.send_header("Access-Control-Allow-Origin", "*"); super().end_headers()

def https_files():
    d = tempfile.mkdtemp(); key, crt = os.path.join(d, "k.pem"), os.path.join(d, "c.pem")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "1", "-subj", "/CN=127.0.0.1"], check=True, capture_output=True)
    hs = ThreadingHTTPServer(("127.0.0.1", 8443), Files)
    cx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); cx.load_cert_chain(crt, key); hs.socket = cx.wrap_socket(hs.socket, server_side=True)
    threading.Thread(target=hs.serve_forever, daemon=True).start()

def main():
    srv = ThreadingHTTPServer(("127.0.0.1", tp.PORT), tp.H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    https_files()
    res = []
    def check(n, ok, d=""): res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + n + (f" — {d}" if d else ""), flush=True)
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={WAV}"])
        iphone = {k: v for k, v in p.devices["iPhone 13"].items() if k != "default_browser_type"}
        ctx = b.new_context(**iphone); ctx.grant_permissions(["microphone"], origin=f"http://localhost:{tp.PORT}")
        ctx.add_init_script("try { localStorage.setItem('lodestone-signin-ask', 'never'); } catch {}")   # the sign-in card (1.11) is not what this tests
        page = ctx.new_page(); errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.dismiss() if "write it out through" in d.message else d.accept())   # keep the device's speech model, the path tested here
        def orouter(route):
            req = route.request
            if req.method == "OPTIONS": return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
            body = json.loads(req.post_data or "{}"); calls.append(body)
            words = ["ready"] if body.get("max_tokens") == 10 else ["An answer."]
            route.fulfill(status=200, content_type="text/event-stream", headers={"Access-Control-Allow-Origin": "*"}, body=tp.sse(words))
        page.route("https://openrouter.ai/**", orouter)
        def huggingface(route):
            u = route.request.url; hf.append(u)
            pre = f"https://huggingface.co/Xenova/whisper-small/resolve/{REV}/"
            if not u.startswith(pre): return route.fulfill(status=404)
            route.continue_(url="https://127.0.0.1:8443/" + u[len(pre):])
        page.route("https://huggingface.co/**", huggingface)
        def wiki(route):
            u = route.request.url
            if "list=search" in u: body = {"query": {"search": [{"title": "Ferritin"}]}}
            else: body = {"query": {"pages": {"1": {"title": "Ferritin", "fullurl": "https://en.wikipedia.org/wiki/Ferritin", "extract": "Ferritin is a protein that stores iron."}}}}
            route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(body))
        page.route("https://*.wikipedia.org/**", wiki)
        page.goto(f"http://localhost:{tp.PORT}/lodestone-app/"); page.wait_for_selector("#setup:not([hidden])")
        page.wait_for_function("document.querySelectorAll('#tierChoices .choice').length > 0"); page.wait_for_timeout(400)
        page.click("#tierChoices .choice:has(strong:has-text('OpenRouter'))"); page.fill("#orKey", tp.GOOD)
        page.wait_for_function("document.querySelector('#orStatus').textContent.includes('works')", timeout=8000)
        page.uncheck("#optSemantic"); page.click("#beginSetup"); page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('OpenRouter')", timeout=20000)
        check("on the phone: attach, look-up and microphone buttons are shown", all(page.is_visible(s) for s in ["#attachBtn", "#webBtn", "#micBtn"]))
        page.screenshot(path="/tmp/web-parity-composer.png")
        n_ans = lambda: page.evaluate("document.querySelectorAll('.msg.assistant .body').length")
        def send(t):
            k = n_ans(); page.fill("#input", t); page.click("#sendBtn")
            page.wait_for_function(f"document.querySelectorAll('.msg.assistant .body').length > {k}", timeout=30000); page.wait_for_timeout(400)
            return calls[-1]
        # Attachments
        page.set_input_files("#fileInput", [os.path.join(FIX, "practice.txt"), os.path.join(FIX, "labs.pdf")])
        page.wait_for_function("[...document.querySelectorAll('.attach-chip small')].length === 2 && ![...document.querySelectorAll('.attach-chip small')].some(s => /Reading/.test(s.textContent))", timeout=30000)
        chips = page.eval_on_selector_all(".attach-chip", "ns => ns.map(n => n.textContent)")
        check("a text file and a PDF are read on the phone", len(chips) == 2 and not any("err" in c for c in chips), str(chips))
        body = send("Here are my notes and results.")
        sysm = body["messages"][0]["content"]
        check("their text reaches the model in <attached_files>", "<attached_files>" in sysm and "20 minutes of breathing" in sysm and "ferritin 18 ng/mL" in sysm)
        page.set_input_files("#fileInput", os.path.join(FIX, "photo.png"))
        page.wait_for_function("[...document.querySelectorAll('.attach-chip small')].some(s => s.textContent === 'image')", timeout=15000)
        body = send("What do you see?")
        last = body["messages"][-1]["content"]
        check("an image goes to a rented model as an image part", isinstance(last, list) and any(p.get("type") == "image_url" and p["image_url"]["url"].startswith("data:image/") for p in last))
        # 1.12: a Word file dropped on the window, a spreadsheet pasted outside the message box
        import docx as _docx, openpyxl as _xl
        dd = _docx.Document(); dd.add_paragraph("Retreat plan: three days of silence in May."); dd.save(os.path.join(FIX, "plan.docx"))
        wb = _xl.Workbook(); wb.active.append(["Item", "Cost"]); wb.active.append(["Cabin", 640]); wb.save(os.path.join(FIX, "costs.xlsx"))
        put = lambda name, mime: page.evaluate("""async ([name, mime, b64]) => { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          window.__dt = new DataTransfer(); window.__dt.items.add(new File([bytes], name, { type: mime })); }""", [name, mime, __import__("base64").b64encode(open(os.path.join(FIX, name), "rb").read()).decode()])
        put("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        page.evaluate("window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: window.__dt, bubbles: true, cancelable: true }))")
        check("a file dragged over the window shows it takes files", page.evaluate("document.body.classList.contains('dropping')"))
        dropped = page.evaluate("(() => { const e = new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true }); document.querySelector('#chat, main, body').dispatchEvent(e); return e.defaultPrevented; })()")
        check("the drop is taken by Lodestone, not the browser", dropped and not page.evaluate("document.body.classList.contains('dropping')"))
        put("costs.xlsx", "")
        page.evaluate("document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: window.__dt, bubbles: true, cancelable: true }))")
        page.wait_for_function("[...document.querySelectorAll('.attach-chip')].length === 2 && ![...document.querySelectorAll('.attach-chip small')].some(s => /Reading/.test(s.textContent))", timeout=30000)
        chips = page.eval_on_selector_all(".attach-chip", "ns => ns.map(n => n.className + ' ' + n.textContent)")
        check("a Word file and a spreadsheet are read on the phone", len(chips) == 2 and not any(" err" in c for c in chips) and any("Word document" in c for c in chips) and any("spreadsheet" in c for c in chips), str(chips))
        body = send("My plan and its costs.")
        sysm = body["messages"][0]["content"]
        check("their text reaches the model", "three days of silence" in sysm and "Cabin\t640" in sysm and 'kind="document"' in sysm)
        put("plan.docx", "")
        page.evaluate("window.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true }))")
        page.evaluate("window.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true }))")
        page.wait_for_timeout(1500)
        check("the same file dropped twice is attached once", page.evaluate("document.querySelectorAll('.attach-chip').length") == 1)
        page.evaluate("document.querySelector('.attach-chip button').click()")
        # 1.12: the privacy gate, before a turn leaves for OpenRouter
        open(os.path.join(FIX, "app.env"), "w").write("OPENROUTER_API_KEY=sk-or-v1-" + "ab12" * 16 + "\nDB_PASSWORD=hunter2hunter\nNAME=retreat\n")
        page.set_input_files("#fileInput", os.path.join(FIX, "app.env"))
        page.wait_for_function("[...document.querySelectorAll('.attach-chip small')].length === 1 && !/Reading/.test(document.querySelector('.attach-chip small').textContent)", timeout=15000)
        k = n_ans(); n_calls = len(calls)
        page.fill("#input", "Check my settings. My card is 4111 1111 1111 1111."); page.click("#sendBtn")
        page.wait_for_selector("#gateAsk", timeout=10000)
        gate = page.text_content("#gateAsk")
        check("the gate stops the turn and names what it found, masked", "OpenRouter key" in gate and "card number" in gate and "password" in gate and "ab12ab12" not in gate and "hunter2hunter" not in gate, gate[:300])
        check("nothing has gone yet", len(calls) == n_calls)
        page.click("#gateAsk button:has-text('Leave them out')")
        page.wait_for_function(f"document.querySelectorAll('.msg.assistant .body').length > {k}", timeout=30000); page.wait_for_timeout(400)
        sent = json.dumps(calls[-1])
        check("left out: the key, the password and the card do not reach OpenRouter, markers do", "ab12ab12" not in sent and "hunter2hunter" not in sent and "4111 1111" not in sent and "left out]" in sent and "NAME=retreat" in sent, sent[:400])
        stored = page.evaluate("(async () => { const st = await import('./js/store.js'); const all = await st.messages.all(); return JSON.stringify(all.slice(-2)); })()")
        check("and none of them is kept in the conversation", "ab12ab12" not in stored and "hunter2hunter" not in stored)
        page.set_input_files("#fileInput", os.path.join(FIX, "app.env"))
        page.wait_for_function("[...document.querySelectorAll('.attach-chip small')].length === 1 && !/Reading/.test(document.querySelector('.attach-chip small').textContent)", timeout=15000)
        k = n_ans()
        page.fill("#input", "Once more, as written."); page.click("#sendBtn"); page.wait_for_selector("#gateAsk", timeout=10000)
        page.click("#gateAsk button:has-text('Send as written')")
        page.wait_for_function(f"document.querySelectorAll('.msg.assistant .body').length > {k}", timeout=30000); page.wait_for_timeout(400)
        sent = json.dumps(calls[-1])
        stored = page.evaluate("(async () => { const st = await import('./js/store.js'); const all = await st.messages.all(); return JSON.stringify(all.slice(-2)); })()")
        check("sent as written: the provider gets it; the stored copy still never keeps the key", "ab12ab12" in sent and "ab12ab12" not in stored and "hunter2hunter" in stored, stored[:300])
        page.fill("#input", "A key sk-or-v1-" + "cd34" * 16); page.click("#sendBtn"); page.wait_for_selector("#gateAsk", timeout=10000)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        check("Esc goes back: nothing sent, the words kept", page.query_selector("#gateAsk") is None and "cd34" in page.input_value("#input"))
        page.fill("#input", "")
        # Look this up, on Wikipedia
        page.click("#webBtn"); page.wait_for_timeout(200)
        body = send("What is ferritin?")
        check("Look this up on OpenRouter is OpenRouter's web search", body.get("plugins") == [{"id": "web", "engine": "exa", "max_results": 5}] and "Ferritin (Wikipedia)" not in body["messages"][0]["content"], str({k: v for k, v in body.items() if k != "messages"}))
        wk = page.evaluate("(async () => (await import('./js/wikilookup.js')).wikiLookup('What is ferritin?', 'en'))()")
        check("Wikipedia, for the routes without a provider, reads from the phone", wk and wk[0]["title"] == "Ferritin (Wikipedia)" and "stores iron" in wk[0]["text"])
        # Dictation: the first press downloads the speech model, checked; the second records and transcribes
        page.click("#micBtn")
        ready = lambda: page.evaluate("(async () => (await import('./js/speechweb.js')).speechReady())()")
        t_dl = time.time()
        while not ready() and time.time() - t_dl < 300: page.wait_for_timeout(2000)
        page.wait_for_function("!document.querySelector('#micBtn').disabled", timeout=60000)
        check("the speech model is downloaded once into the browser, from the pinned revision", len(hf) == 7 and all(REV in u for u in hf), f"{len(hf)} files")
        page.wait_for_timeout(500)
        t0 = time.time()
        page.click("#micBtn"); page.wait_for_timeout(7000); page.click("#micBtn")
        page.wait_for_function("document.querySelector('#input').value.length > 20", timeout=180000, polling=1000)
        said = page.input_value("#input")
        check("dictation on the phone: Whisper in the browser writes what was said", "country" in said.lower(), f"{said[:90]!r} in {time.time() - t0:.0f} s (7 s recorded)")
        check("dictation made no request beyond the speech model's download", len(hf) == 7)
        page.fill("#input", "")
        # 1.13: a conversation by voice, the fake microphone playing the recording
        check("the voice button is offered", page.is_visible("#talkBtn"))
        n = len(calls)
        page.click("#talkBtn")
        page.wait_for_selector("#talkbar:not([hidden])", timeout=20000)
        check("listening: the bar says so", "Listening" in page.text_content("#talkLabel"))
        t0 = time.time()
        while time.time() - t0 < 240 and not any("country" in json.dumps(c.get("messages", [])[-1:]).lower() for c in calls[n:]): page.wait_for_timeout(1500)
        check("what was said is heard, written out and sent, with no click", any("country" in json.dumps(c.get("messages", [])[-1:]).lower() for c in calls[n:]), f"{len(calls) - n} calls in {time.time() - t0:.0f} s")
        page.wait_for_timeout(1500)
        state = page.get_attribute("#talkbar", "data-phase")
        check("then Lodestone answers and listens again", state in ("listening", "speaking", "writing", "answering") and not page.evaluate("document.querySelector('#talkbar').hidden"), state)
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
        check("Esc ends the conversation by voice", page.evaluate("document.querySelector('#talkbar').hidden") and page.get_attribute("#talkBtn", "aria-pressed") == "false")
        page.fill("#input", "")
        # A tampered file is refused: clear the cache, serve a wrong byte, try again
        def bad(route):
            u = route.request.url
            if u.endswith("config.json") and "generation" not in u and "preprocessor" not in u and "tokenizer" not in u:
                return route.fulfill(status=200, headers={"Access-Control-Allow-Origin": "*"}, body=b"{}" + b" " * 2230)
            huggingface(route)
        page.unroute("https://huggingface.co/**"); page.route("https://huggingface.co/**", bad)
        err = page.evaluate("(async () => { const s = await import('./js/speechweb.js'); await s.forgetSpeech(); try { await s.downloadSpeech(); return 'no error'; } catch (e) { return e.message; } })()")
        check("a file that does not match its SHA-256 is refused", "did not check out" in err, err)
        # The life book, from its synced copy
        page.evaluate("""(async () => { const st = await import('./js/store.js');
          await st.kv.set('lifebook', { notesAt: Date.now(), notes: [{ rel: 'People/Mother.md', mtime: 5, text: '---\\nkeys: [mother, maman]\\n---\\n# Mother\\n\\nCycle 3 on 2 November.\\n' }], queue: [], applied: [] }); })()""")
        page.reload(); page.wait_for_selector("#main:not([hidden])", timeout=60000); page.wait_for_timeout(1200)
        body = send("How is Maman?")
        check("the phone recalls a life-book note from the synced copy", "[Mother — Lodestone/People/Mother.md]" in body["messages"][0]["content"])
        page.locator(".msg.user .actions button:has-text('Keep in my life book')").last.click(); page.wait_for_timeout(400)
        page.click(".checkin.lifebook button:has-text('Keep')"); page.wait_for_timeout(600)
        q = page.evaluate("(async () => ((await (await import('./js/store.js')).kv.get('lifebook')).queue || []).map(x => x.change))()")
        check("Keep on the phone queues the change for the desktop, writes nothing", len(q) == 1 and q[0]["op"] in ("create", "append") and "How is Maman?" in (q[0].get("text") or ""), json.dumps(q)[:160])
        # Sync holds no lock (1.13.1): what is written while a cycle is out keeps
        sy = page.evaluate("""(async () => { const st = await import('./js/store.js'), sy = await import('./js/sync.js');
          const th = await st.threads.create('sync race'); const lid = 't:' + th.id;
          await st.messages.add({ threadId: th.id, role: 'user', content: 'A' }); await new Promise(r => setTimeout(r, 5));
          const b = { threadId: th.id, role: 'assistant', content: 'B' }; await st.messages.add(b); await new Promise(r => setTimeout(r, 5));
          const before = await sy.readLocal(lid, null);
          const remote = { thread: before.thread, messages: before.messages.filter(m => m.content !== 'B') };   // B deleted elsewhere
          const c = { threadId: th.id, role: 'user', content: 'C, sent while the cycle was out' }; await st.messages.add(c);
          await sy.writeLocal(lid, remote, null, before);
          return (await st.messages.forThread(th.id)).map(m => m.content).join('|'); })()""")
        check("sync: a message sent during a cycle is kept, one deleted elsewhere goes", sy == "A|C, sent while the cycle was out", sy)
        check("no page errors", not errors, "; ".join(errors)[:400])
    print(f"{sum(res)} of {len(res)} passed")
main()
