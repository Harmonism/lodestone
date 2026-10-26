"""Lodestone Desktop's life book in a browser: the window as Lodestone Desktop serves it, a mock
model server at /v1, and the desktop bridge's life-book calls answered by the real
desktop/src/lifebook.js over HTTP. Recall by key, the always-on note, proposals at the learning
cadence, Keep writing inside Lodestone/ only, and the manual "Keep in my life book".

Usage: python3 tools/test-lifebook-window.py   (needs playwright, as test-phone.py; and node)"""
import json, os, shutil, subprocess, sys, tempfile, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
LODE = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..")); APP = os.path.join(LODE, "app"); BRIDGE = os.path.join(HERE, "lifebook-bridge.cjs")
TMP = tempfile.mkdtemp(prefix="lb-window-"); VAULT = os.path.join(TMP, "Vault")
os.makedirs(os.path.join(VAULT, "Lodestone", "People")); os.makedirs(os.path.join(VAULT, "Lodestone", "Health"))
open(os.path.join(VAULT, "Lodestone/People/Mother.md"), "w").write("---\nkeys: [mother, maman]\n---\n# Mother\n\nIn chemotherapy since 12 August; cycle 3 on 2 November.\n")
open(os.path.join(VAULT, "Lodestone/Health/Allergies.md"), "w").write("---\nalways: true\n---\n# Allergies\n\nPenicillin.\n")
open(os.path.join(VAULT, "Journal.md"), "w").write("outside, never touched\n")
PROPOSAL = json.dumps({"changes": [{"op": "create", "path": "Health/Sleep.md", "keys": ["sleep", "insomnia"], "text": "Wakes at 3 every night since the move."}], "why": "a pattern they named"})
LOG = []
class H(SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=APP, **k)
    def log_message(s, *a): pass
    def do_GET(s):
        if s.path.startswith("/v1/models"):
            b = json.dumps({"data": [{"id": "lodestone"}]}).encode(); s.send_response(200); s.send_header("Content-Type", "application/json"); s.end_headers(); return s.wfile.write(b)
        return super().do_GET()
    def do_POST(s):
        body = json.loads(s.rfile.read(int(s.headers["Content-Length"]))); msgs = body.get("messages", [])
        sysm = msgs[0]["content"] if msgs else ""
        kind = "propose" if sysm.startswith("You keep a practitioner's life book") else "learn" if len(msgs) == 2 and "Lodestone" not in sysm[:40] else "turn"
        LOG.append({"kind": kind, "system": sysm, "n": len(msgs)})
        text = PROPOSAL if kind == "propose" else "{}" if kind == "learn" else "An answer."
        s.send_response(200); s.send_header("Content-Type", "text/event-stream"); s.end_headers()
        s.wfile.write(f'data: {json.dumps({"choices": [{"delta": {"content": text}}]})}\n\ndata: [DONE]\n\n'.encode())
FAKE = """
const B = 'http://127.0.0.1:8797';
const post = (p, a) => fetch(B + p, { method: 'POST', body: JSON.stringify(a || {}) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
const real = {
  info: async () => ({ remote: null }), foldersList: async () => ({ folders: [] }), searchFolders: async () => [], webLookup: async () => [],
  onProgress: () => () => {}, quickModels: async () => null,
  lifebookStatus: () => post('/status'), lifebookChoose: () => post('/choose'), lifebookForget: () => post('/forget'),
  lifebookOpen: async () => true, lifebookEntries: () => post('/entries'), lifebookWrite: c => post('/write', c),
};
window.lodestoneDesktop = new Proxy(real, { get: (t, k) => k in t ? t[k] : (async () => null) });
"""
def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 8796), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    br = subprocess.Popen(["node", BRIDGE, LODE, VAULT], stdout=subprocess.PIPE); br.stdout.readline()
    res = []
    def check(n, ok, d=""): res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + n + (f" — {d}" if d else ""), flush=True)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(); page = b.new_page(); errors = []
            page.add_init_script("try { localStorage.setItem('lodestone-signin-ask', 'never'); } catch (e) {}")   # the sign-in prompt makes the page inert
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.add_init_script(FAKE)
            page.goto("http://127.0.0.1:8796/")
            page.wait_for_selector("#main:not([hidden])", timeout=120000)
            page.wait_for_function("document.querySelector('#input') && !document.querySelector('#input').disabled", timeout=60000)
            # Settings: choose the vault
            page.evaluate("document.querySelector('#btnSettings')?.click()"); page.wait_for_timeout(500)
            check("Settings shows the Life book section", page.is_visible("#setLifeBook"), page.text_content("#setLbWhere"))
            page.click("#setLbChoose"); page.wait_for_function("document.querySelector('#setLbWhere').textContent.includes('2 notes')", timeout=10000)
            check("choosing the vault finds its two notes", True, page.text_content("#setLbWhere"))
            check("the privacy line says nothing leaves the computer", "nothing from the life book leaves it" in page.text_content("#setLbPrivacy"))
            page.keyboard.press("Escape"); page.evaluate("document.querySelectorAll('[data-close]').forEach(b => b.offsetParent && b.click())"); page.wait_for_timeout(300)
            # Recall: Maman brings the Mother note; the always note is in every turn
            page.fill("#input", "How should I support Maman this week?"); page.click("#sendBtn")
            page.wait_for_function("document.querySelectorAll('.msg.assistant .body').length >= 1", timeout=20000); page.wait_for_timeout(500)
            t = [l for l in LOG if l["kind"] == "turn"][-1]["system"]
            check("the Mother note comes back word for word when Maman is named", "<life_book>" in t and "[Mother — Lodestone/People/Mother.md]" in t and "cycle 3 on 2 November" in t)
            check("the always-on note is there too", "[Allergies — Lodestone/Health/Allergies.md]" in t)
            page.fill("#input", "And what about breakfast?"); page.click("#sendBtn")
            page.wait_for_function("document.querySelectorAll('.msg.assistant .body').length >= 2", timeout=20000); page.wait_for_timeout(400)
            t2 = [l for l in LOG if l["kind"] == "turn"][-1]["system"]
            check("the Mother note stays for the next turns (sticky)", "Lodestone/People/Mother.md" in t2)
            # The learning cadence: ten messages, then a proposal card
            for i in range(8):
                page.fill("#input", f"Message {i}: I wake at 3 every night since the move."); page.click("#sendBtn")
                page.wait_for_function(f"document.querySelectorAll('.msg.assistant .body').length >= {3 + i}", timeout=20000); page.wait_for_timeout(250)
            page.wait_for_function("[...document.querySelectorAll('.checkin.lifebook')].length >= 1", timeout=30000)
            check("a proposal card appears at the learning cadence", "Health/Sleep.md" in page.text_content(".checkin.lifebook"))
            check("nothing was written before Keep", not os.path.exists(os.path.join(VAULT, "Lodestone/Health/Sleep.md")))
            page.click(".checkin.lifebook button:has-text('Keep')"); page.wait_for_timeout(800)
            sleep = open(os.path.join(VAULT, "Lodestone/Health/Sleep.md")).read() if os.path.exists(os.path.join(VAULT, "Lodestone/Health/Sleep.md")) else ""
            check("Keep writes the note inside Lodestone/, with its keys", sleep.startswith("---\nkeys: [sleep, insomnia]\n---\n# Sleep") and "Wakes at 3 every night" in sleep, repr(sleep[:120]))
            check("the card is gone after Keep", page.locator(".checkin.lifebook").count() == 0)
            # Manual keep from a message: card first, then Edit, then Keep appends to Life/Notes.md (created)
            page.locator(".msg.user .actions button:has-text('Keep in my life book')").first.click(); page.wait_for_timeout(500)
            check("Keep in my life book opens a card, writes nothing", page.locator(".checkin.lifebook").count() == 1 and not os.path.exists(os.path.join(VAULT, "Lodestone/Life/Notes.md")))
            # 1.14.1: the note is chosen in the card's "In" menu; "Another note…" takes any path.
            check("the card offers the Wheel's pillars", page.locator(".checkin.lifebook .lb-where option[value='Wheel/Health.md']").count() == 1)
            page.select_option(".checkin.lifebook .lb-where", "__other"); page.fill(".checkin.lifebook .lb-path", "People/Self.md")
            page.click(".checkin.lifebook button:has-text('Edit the text')"); page.fill(".checkin.lifebook .lb-edit", "I want to support my mother through cycle 3.")
            page.click(".checkin.lifebook button:has-text('Keep')"); page.wait_for_timeout(800)
            selfn = os.path.join(VAULT, "Lodestone/People/Self.md")
            check("an edited card is kept where the practitioner chose", os.path.exists(selfn) and "support my mother through cycle 3" in open(selfn).read())
            check("nothing outside Lodestone/ changed", open(os.path.join(VAULT, "Journal.md")).read() == "outside, never touched\n" and sorted(os.listdir(VAULT)) == ["Journal.md", "Lodestone"])
            # Recall picks up the new note by its key
            page.fill("#input", "My insomnia again."); page.click("#sendBtn")
            page.wait_for_function("document.querySelectorAll('.msg.assistant .body').length >= 11", timeout=20000); page.wait_for_timeout(400)
            check("the kept note comes back by its key", "[Sleep — Lodestone/Health/Sleep.md]" in [l for l in LOG if l["kind"] == "turn"][-1]["system"])
            # A change kept on a phone: queued in the synced record; the desktop writes it when it opens
            page.evaluate("""(async () => { const st = await import('./js/store.js'); const m = (await st.kv.get('lifebook')) || {};
              await st.kv.set('lifebook', { ...m, queue: [{ id: 'phone-1', ts: Date.now(), change: { op: 'create', path: 'Practices/Breath.md', text: '# Breath\\n\\nTwenty minutes each morning.\\n' }, card: {} }] }); })()""")
            page.reload(); page.wait_for_selector("#main:not([hidden])", timeout=60000)
            breath = os.path.join(VAULT, "Lodestone/Practices/Breath.md")
            for _ in range(20):
                if os.path.exists(breath): break
                page.wait_for_timeout(300)
            check("a change kept on a phone is written by the desktop when it opens", os.path.exists(breath) and "Twenty minutes each morning." in open(breath).read())
            m = page.evaluate("(async () => (await (await import('./js/store.js')).kv.get('lifebook')))()")
            check("the queue is emptied and the id remembered, so it is never written twice", not m.get("queue") and "phone-1" in (m.get("applied") or []))
            check("the desktop's synced copy carries the notes, the new one included", any(x["rel"] == "Practices/Breath.md" for x in (m.get("notes") or [])), str([x["rel"] for x in m.get("notes") or []]))
            check("no page errors", not errors, "; ".join(errors)[:400])
    finally:
        br.terminate(); shutil.rmtree(TMP, ignore_errors=True)
    print(f"{sum(res)} of {len(res)} passed")
main()
