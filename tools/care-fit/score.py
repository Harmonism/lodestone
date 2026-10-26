import json, os, sys, threading
HERE=os.path.dirname(os.path.abspath(__file__))
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
APP=os.path.join(HERE,"..","..","app")
class H(SimpleHTTPRequestHandler):
    def translate_path(self,p):
        p=p.split("?")[0]
        if p=="/blank.html": return os.path.join(HERE,"blank.html")
        return os.path.join(APP,p.lstrip("/"))
    def log_message(self,*a): pass
    def guess_type(self,p): return "text/javascript" if p.endswith((".js",".mjs")) else super().guess_type(p)
srv=ThreadingHTTPServer(("127.0.0.1",0),H); threading.Thread(target=srv.serve_forever,daemon=True).start()
texts=json.load(open(sys.argv[1]))
with sync_playwright() as pw:
    b=pw.chromium.launch(); pg=b.new_page(); pg.goto(f"http://127.0.0.1:{srv.server_port}/blank.html")
    out=pg.evaluate("""async (ts) => { const {Embedder}=await import('/js/embedder.js'); const {careCheck}=await import('/js/care.js'); const e=new Embedder(); await e.start(); const r=[]; for (const t of ts) { const v=Array.from(await e.embed(t)); const c=await careCheck(t, x=>e.embed(x)); r.push({t, c, v}); } return r; }""", texts)
    b.close()
json.dump(out,open(sys.argv[2],"w"))
for r in out: print(f"{(r['c'] or {}).get('level','-'):6} {(r['c'] or {}).get('score','')!s:6} {r['t']}")
