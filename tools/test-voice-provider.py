"""Voice and search through the provider in the web app on a phone. Phone mode on
OpenRouter against mocks (test-phone.py's server), and the harmonism.io account's endpoints
stood in for on the same origin:
  dictation and an attached recording written out by OpenRouter when chosen over the device;
  answers read by Grok's voices through the same OpenRouter key, by default, piece by piece,
    to the end, and by the device's own voices when those are chosen;
  keys given for voice alone (xAI, OpenAI) recognised by their shape and read through;
  Look this up sending OpenRouter's web search with the turn, and no Wikipedia request;
  the account route: transcription and speech through lodestone-voice-api.php, web: true to
  lodestone-desktop-api.php.

Usage: python3 tools/test-voice-provider.py [a speech .wav]   (needs playwright, as test-phone.py)"""
import base64, importlib.util, io, json, os, sys, threading, time, wave
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "app"); TP = os.path.join(HERE, "test-phone.py")
WAV = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.cache/lodestone-tests/jfk.wav")
sys.argv = [TP, APP]
spec = importlib.util.spec_from_file_location("tp", TP); tp = importlib.util.module_from_spec(spec); spec.loader.exec_module(tp)
buf = io.BytesIO(); w = wave.open(buf, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 3200); w.close()
SILENCE = buf.getvalue()   # 0.2 s, played as each spoken piece
LOG = {"stt": [], "tts": [], "chat": [], "wiki": 0, "voice_api": []}

class H(tp.H):
    def do_POST(self):
        if self.path.startswith("/lodestone-voice-api.php"):
            if self.headers.get("Authorization") not in ("Bearer ACCESS1", "Bearer ACCESS2"): return self._json(401, {"error": {"message": "Sign in"}})
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"]))); LOG["voice_api"].append({"path": self.path, **{k: (v if k != "audio" else len(v)) for k, v in body.items()}})
            if "transcribe" in self.path: return self._json(200, {"text": "Written out by the account.", "seconds": 3})
            self.send_response(200); self.send_header("Content-Type", "audio/mpeg"); self.send_header("Content-Length", str(len(SILENCE))); self.end_headers(); return self.wfile.write(SILENCE)
        return super().do_POST()

def main():
    srv = ThreadingHTTPServer(("127.0.0.1", tp.PORT), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    res = []
    def check(n, ok, d=""): res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + n + (f" — {d}" if d else ""), flush=True)
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={WAV}", "--autoplay-policy=no-user-gesture-required"])
        iphone = {k: v for k, v in p.devices["iPhone 13"].items() if k != "default_browser_type"}
        ctx = b.new_context(**iphone); ctx.grant_permissions(["microphone"], origin=f"http://localhost:{tp.PORT}")
        page = ctx.new_page(); errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        def orouter(route):
            req = route.request
            if req.method == "OPTIONS": return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
            u = req.url
            if u.endswith("/audio/transcriptions"):
                pd = req.post_data_buffer or b""
                LOG["stt"].append({"model": b'openai/whisper-1' in pd, "file": b'filename="recording.' in pd, "auth": req.headers.get("authorization")})
                return route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps({"text": "I sleep badly since the move."}))
            if u.endswith("/audio/speech"):
                LOG["tts"].append(json.loads(req.post_data or "{}"))
                return route.fulfill(status=200, content_type="audio/wav", headers={"Access-Control-Allow-Origin": "*"}, body=SILENCE)
            body = json.loads(req.post_data or "{}"); LOG["chat"].append(body)
            words = ["ready"] if body.get("max_tokens") == 10 else ["Sleep follows the light. ", "Begin by rising at the same hour each day."]
            route.fulfill(status=200, content_type="text/event-stream", headers={"Access-Control-Allow-Origin": "*"}, body=tp.sse(words))
        page.route("https://openrouter.ai/**", orouter)
        page.route("https://*.wikipedia.org/**", lambda r: (LOG.__setitem__("wiki", LOG["wiki"] + 1), r.fulfill(status=200, content_type="application/json", body="{}"))[1])
        page.goto(f"http://localhost:{tp.PORT}/lodestone-app/"); page.wait_for_selector("#setup:not([hidden])")
        page.wait_for_function("document.querySelectorAll('#tierChoices .choice').length > 0"); page.wait_for_timeout(400)
        page.click("#tierChoices .choice:has(strong:has-text('OpenRouter'))"); page.fill("#orKey", tp.GOOD)
        page.wait_for_function("document.querySelector('#orStatus').textContent.includes('works')", timeout=8000)
        page.uncheck("#optSemantic"); page.click("#beginSetup"); page.wait_for_selector("#main:not([hidden])", timeout=60000)
        page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('OpenRouter')", timeout=20000)
        n_ans = lambda: page.evaluate("document.querySelectorAll('.msg.assistant .body').length")
        def send(t):
            k = n_ans(); page.fill("#input", t); page.click("#sendBtn")
            page.wait_for_function(f"document.querySelectorAll('.msg.assistant .body').length > {k}", timeout=30000); page.wait_for_timeout(300)
        # Settings: both choices are offered on this route
        page.evaluate("document.querySelector('#btnSettings')?.click()"); page.wait_for_timeout(600)
        check("Settings offers dictation through OpenRouter and the natural voice", page.is_visible("#setDictSource") and page.is_visible("#setVoiceSource") and "OpenRouter" in page.text_content("#setDictSource"))
        page.click("#setVoiceMode button[data-v=voice]"); page.wait_for_timeout(600)
        hint = page.text_content("#setVoiceSourceHint")
        check("by default the natural voice reads, Grok's, on the key Lodestone thinks with, and says where the text goes", page.get_attribute("#setVoiceSource button[data-v=provider]", "aria-pressed") == "true" and "Grok" in hint and "key Lodestone thinks with" in hint and "goes to OpenRouter" in hint, hint)
        check("the device's voice list is put away while the natural voice reads", not page.is_visible("#setVoiceName") and page.is_visible("#setVoiceFamily"))
        page.evaluate("document.querySelectorAll('[data-close]').forEach(b => b.offsetParent && b.click())"); page.wait_for_timeout(300)
        # A spoken answer, read by OpenRouter's voice, to the end
        send("Tell me about sleep.")
        page.wait_for_function("[...document.querySelectorAll('.voice-row .vr-state')].some(s => s.textContent === 'Spoken')", timeout=20000)
        said = " ".join(t.get("input", "") for t in LOG["tts"])
        check("the answer is read by Grok's Ara through OpenRouter, in pieces, to the end", len(LOG["tts"]) >= 1 and all(t.get("voice") == "ara" and t.get("model") == "x-ai/grok-voice-tts-1.0" and t.get("response_format") == "mp3" for t in LOG["tts"]) and "Sleep follows the light." in said and "same hour each day" in said, f"{len(LOG['tts'])} piece(s)")
        # The device's own voices, when chosen: nothing goes to the provider
        page.evaluate("document.querySelector('#btnSettings')?.click()"); page.wait_for_timeout(500)
        page.click("#setVoiceSource button[data-v=device]"); page.wait_for_timeout(500)
        check("choosing the device's voices says nothing leaves it", "nothing leaves it" in page.text_content("#setVoiceSourceHint") and page.is_visible("#setVoiceName"))
        n_tts = len(LOG["tts"])
        page.evaluate("document.querySelectorAll('[data-close]').forEach(b => b.offsetParent && b.click())"); page.wait_for_timeout(300)
        send("And waking?"); page.wait_for_timeout(800)
        check("on the device's voices no answer text goes to the provider", len(LOG["tts"]) == n_tts)
        page.evaluate("document.querySelector('#btnSettings')?.click()"); page.wait_for_timeout(500)
        page.click("#setVoiceSource button[data-v=provider]"); page.click("#setVoiceMode button[data-v=text]"); page.wait_for_timeout(300)
        page.evaluate("document.querySelectorAll('[data-close]').forEach(b => b.offsetParent && b.click())"); page.wait_for_timeout(300)
        # Keys for voice alone: recognised by shape, and read through
        XLOG = []
        def xai(route):
            if route.request.method == "OPTIONS": return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
            XLOG.append({"url": route.request.url, "auth": route.request.headers.get("authorization"), "body": json.loads(route.request.post_data or "{}") if route.request.method == "POST" else None})
            if route.request.method == "GET": return route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body="{}")
            route.fulfill(status=200, content_type="audio/mpeg", headers={"Access-Control-Allow-Origin": "*"}, body=SILENCE)
        page.route("https://api.x.ai/**", xai); page.route("https://api.openai.com/**", xai)
        out = page.evaluate("""async () => {
          const vc = await import('./js/voicecloud.js');
          const kinds = ['sk-or-v1-abc', 'xai-abcdefghijklmnopqrstuvwxyz', 'sk-proj-abcdefghijklmnopqrstuvwxyz', 'sk-ant-api03-abc', 'nonsense'].map(k => vc.keyKind(k).kind || 'none');
          const a = await vc.synthesize('xai', 'Hello.', { family: 'grok', gender: 'male', lang: 'fr' }, { key: 'xai-K' });
          const b = await vc.synthesize('openai', 'Hello.', { family: 'openai', gender: 'female', lang: 'en' }, { key: 'sk-proj-K' });
          await vc.testVoiceKey('xai', 'xai-K');
          const r1 = vc.chooseRoute('grok', { openrouter: true, account: true }, 'account');
          const r2 = vc.chooseRoute('elevenlabs', { xai: true }, null);
          const r3 = vc.chooseRoute('grok', {}, null);
          return { kinds, a: a.size, b: b.size, r1, r2, r3 };
        }""")
        check("keys are told apart by their shape", out["kinds"] == ["openrouter", "xai", "openai", "none", "none"], str(out["kinds"]))
        posts = [x for x in XLOG if x["body"]]
        check("an xAI key reads with Rex at api.x.ai, an OpenAI key with Coral", out["a"] == len(SILENCE) and out["b"] == len(SILENCE) and posts[0]["body"].get("voice_id") == "rex" and posts[0]["body"].get("language") == "fr" and posts[0]["auth"] == "Bearer xai-K" and posts[1]["body"].get("voice") == "coral", json.dumps(posts)[:300])
        # A key for voice, pasted in Settings, and the chip's menu
        page.evaluate("document.querySelector('#btnSettings')?.click()"); page.wait_for_timeout(500)
        page.fill("#setVoiceKey", "xai-abcdefghijklmnopqrstuvwxyz0123"); page.click("#setVoiceKeySave"); page.wait_for_timeout(1200)
        check("a pasted xAI key is checked and kept for voice", "xAI" in page.text_content("#setVoiceKeys") and page.input_value("#setVoiceKey") == "" and any("api-key" in x["url"] for x in XLOG), page.text_content("#setVoiceKeys"))
        page.evaluate("document.querySelectorAll('[data-close]').forEach(b => b.offsetParent && b.click())"); page.wait_for_timeout(300)
        page.click("#voiceChip"); page.wait_for_timeout(600)
        menu = page.text_content("#voiceMenu")
        check("the chip's menu offers the natural voice and the device's", "Natural voice — Grok" in menu and "voices" in menu and "nothing leaves it" in menu, menu[:200])
        page.click("#voiceChip"); page.wait_for_timeout(200)
        check("the conversation's own route is preferred; an unreachable voice falls back to Grok; none, none", out["r1"]["route"] == "account" and out["r2"]["family"] == "grok" and out["r2"]["route"] == "xai" and out["r2"]["instead"] and out["r3"] is None, json.dumps(out)[:300])
        # Dictation through OpenRouter: the first press asks (accepted: the provider) and records at once
        page.click("#micBtn"); page.wait_for_timeout(3000); page.click("#micBtn")
        page.wait_for_function("document.querySelector('#input').value.length > 5", timeout=20000)
        check("dictation written out by OpenRouter, with no speech model downloaded", page.input_value("#input") == "I sleep badly since the move." and LOG["stt"] and LOG["stt"][-1]["model"] and LOG["stt"][-1]["file"] and LOG["stt"][-1]["auth"] == f"Bearer {tp.GOOD}")
        check("no speech model in the browser", not page.evaluate("(async () => (await import('./js/speechweb.js')).speechReady())()"))
        # An attached recording, written out by OpenRouter
        page.set_input_files("#fileInput", WAV)
        page.wait_for_function("[...document.querySelectorAll('.attach-chip small')].some(s => /written out by OpenRouter/.test(s.textContent))", timeout=20000)
        check("an attached recording is written out by OpenRouter", len(LOG["stt"]) == 2)
        send("Here is what I recorded.")
        check("its text reaches the model", "I sleep badly since the move." in LOG["chat"][-1]["messages"][0]["content"])
        # Look this up: OpenRouter's web search with the turn, and no Wikipedia
        page.click("#webBtn"); page.wait_for_timeout(200)
        send("What is ferritin?")
        check("Look this up sends OpenRouter's web search with the turn", LOG["chat"][-1].get("plugins") == [{"id": "web", "engine": "exa", "max_results": 5}] and LOG["wiki"] == 0)
        send("And without searching?")
        check("the next turn carries no search", "plugins" not in LOG["chat"][-1])
        # The account route: the endpoints on harmonism.io
        sess = {"access_token": "ACCESS1", "refresh_token": "REFRESH1", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "token_type": "bearer", "user": {"email": "t@example.org"}}
        page.evaluate("([k, v]) => localStorage.setItem(k, v)", [tp.SB_KEY, json.dumps(sess)])
        out = page.evaluate("""async () => {
          const vc = await import('./js/voicecloud.js'); const ph = await import('./js/phone.js');
          const ctx = { call: (u, i) => ph.hosted.call(u, i) };
          const text = await vc.transcribe('account', new Blob([new Uint8Array(4000)], { type: 'audio/webm' }), 'fr', ctx);
          const audio = await vc.synthesize('account', 'Bonjour.', { gender: 'male', lang: 'fr' }, ctx);
          const eng = new ph.HostedEngine({ ctx: 32768, maxTokens: 1200 }, {}); let said = '';
          for await (const part of eng.stream([{ role: 'user', content: 'Hi' }], { maxTokens: 300, web: true })) said = part;
          return { text, size: audio.size, type: audio.type, said };
        }""")
        va = LOG["voice_api"]
        check("account route: a recording written out through lodestone-voice-api.php", out["text"] == "Written out by the account." and va and "transcribe" in va[0]["path"] and va[0]["format"] == "webm" and va[0]["language"] == "fr")
        check("account route: an answer read through lodestone-voice-api.php", out["size"] == len(SILENCE) and "speak" in va[-1]["path"] and va[-1]["gender"] == "male")
        check("account route: Look this up asks the server for the web search", tp.LOG["hosted"] and tp.LOG["hosted"][-1]["body"].get("web") is True)
        check("no page errors", not errors, "; ".join(errors)[:400])
    print(f"{sum(res)} of {len(res)} passed")
main()
