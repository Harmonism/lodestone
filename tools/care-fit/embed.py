"""Embeds tools/care-fit/data.py with the app's own embedder (multilingual-e5-small, in Chromium) into vecs.json."""
import json, os, threading, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); from data import *
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
APP = os.path.join(HERE, "..", "..", "app")
class H(SimpleHTTPRequestHandler):
    def translate_path(self,p):
        p=p.split("?")[0]
        if p=="/blank.html": return os.path.join(HERE, "blank.html")
        return os.path.join(APP,p.lstrip("/"))
    def log_message(self,*a): pass
    def handle_error(self,*a): pass
    def guess_type(self,p): return "text/javascript" if p.endswith((".js",".mjs")) else super().guess_type(p)
srv=ThreadingHTTPServer(("127.0.0.1",0),H); srv.handle_error=lambda *a: None; threading.Thread(target=srv.serve_forever,daemon=True).start()
allt=POS+NEG+TEST_POS+TEST_NEG
with sync_playwright() as pw:
    b=pw.chromium.launch(); pg=b.new_page(); pg.goto(f"http://127.0.0.1:{srv.server_port}/blank.html")
    vecs=pg.evaluate("""async (ts) => { const {Embedder}=await import('/js/embedder.js'); const e=new Embedder(); await e.start(); const out=[]; for (const t of ts) out.push(Array.from(await e.embed(t))); return out; }""", allt)
    b.close()
json.dump({"texts":allt,"vecs":vecs},open(os.path.join(HERE, "vecs.json"), "w"))
print(len(vecs), len(vecs[0]))
