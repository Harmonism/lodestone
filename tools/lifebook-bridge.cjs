// lifebook-bridge.cjs — the desktop app's life-book handlers, served over HTTP for tools/test-lifebook-window.py (the real desktop/src/lifebook.js).
const http = require("http"); const path = require("path");
const { LifeBook } = require(path.resolve(process.argv[2], "desktop", "src", "lifebook.js"));
let vault = null; const VAULT = process.argv[3];
const lb = new LifeBook(() => vault);
const status = () => { const d = lb.dir(); return { vault, dir: d, notes: d ? lb.entries().length : 0 }; };
http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return res.end();
    try {
      const a = b ? JSON.parse(b) : {}; let out;
      switch (req.url) {
        case "/status": out = status(); break;
        case "/choose": vault = VAULT; lb.cache = null; lb.ensure(); out = status(); break;
        case "/forget": vault = null; out = status(); break;
        case "/entries": out = lb.dir() ? lb.entries() : []; break;
        case "/write": { const r = lb.write(a); out = { rel: r.rel, backup: r.backup, mtime: r.mtime }; break; }
        default: res.statusCode = 404; return res.end();
      }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(out));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
  });
}).listen(8797, "127.0.0.1", () => console.log("bridge up"));
