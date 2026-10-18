// server.js — serves the app's window: the harmonism.io library at /, Lodestone at
// /lodestone-app/, and the model engine behind /v1 on the same origin.
// (/munai-offline/ until October 17, 2026: answered with a 301, for
// library pages and phone bookmarks made before.)
//
//   /                        the library (site.js): English ships with the app,
//                            other languages are downloaded on request
//   /lodestone-app/              the Lodestone web app (the same one harmonism.io serves)
//   /lodestone-app/corpus/       the corpus, from an update when there is one
//   /lodestone-app/v1, /v1       the model engine (OpenAI-compatible)
//   POST /companion-api.php  the companion on the library's pages (companion.js)
//   /munai-pair, /munai-sync the Lodestone app for Android, paired with this computer
//                            a code traded for a token, then the synced
//                            copy kept here (syncstore.js), token required
//   *.php otherwise          the member area and the online services: a page
//                            saying so, with the link to harmonism.io
//
// Nothing is logged. The server listens on 127.0.0.1 only, unless the
// practitioner turns on phone access, which opens it to the local network.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable } = require("stream");
const { LANGS } = require("./site");

const APP = "/lodestone-app/";
const OLD_APP = "/munai-offline/";   // the address before October 17, 2026
const OLD_APP_2 = "/munai-app/";     // the address before October 18, 2026 (MunAI → Lodestone)
const ONLINE = "https://harmonism.io";
const CORPUS_FILES = new Set(["runtime.json", "corpus.json", "embeddings.json", "embeddings.bin"]);

const MIME = {
  ".html": "text/html; charset=utf-8", ".php": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".xml": "application/xml",
  ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".bin": "application/octet-stream",
  ".onnx": "application/octet-stream", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf", ".mp3": "audio/mpeg",
  ".pagefind": "application/octet-stream", ".pf_meta": "application/octet-stream",
  ".pf_index": "application/octet-stream", ".pf_fragment": "application/octet-stream",
};

// Injected into every library page. The companion on harmonism.io counts an
// anonymous visitor's messages and asks them to sign up after seven; here it
// is the practitioner's own model and there is nothing to count.
//
// Each library page also carries a way back to the conversation: the window
// has no address bar, and the site's own menus lead only around the site.
const BACK_LINK = `<a class="lodestone-back" href="${APP}" title="Back to the conversation (${process.platform === "darwin" ? "⌘1" : "Ctrl+1"})"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Back to Lodestone</a>`;
const PAGE_SCRIPT = `<script>(function(){try{var g=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==="munai-anon-msg-count")return"0";if(k==="munai-anon-nudge-shown")return"1";return g.call(this,k)};document.documentElement.classList.add("lodestone-app")}catch(e){}
if(window.top===window)document.addEventListener("DOMContentLoaded",function(){if(document.querySelector(".lodestone-back"))return;document.body.insertAdjacentHTML("beforeend",${JSON.stringify(BACK_LINK)})});})();</script><style>.nav-account-link{display:none!important}
.lodestone-back{position:fixed;left:20px;bottom:20px;z-index:150;display:inline-flex;align-items:center;gap:6px;padding:9px 16px 9px 11px;border-radius:999px;background:var(--bg-elevated,#1a1a3a);border:1px solid var(--border,#2a2a55);color:var(--text,#d8d8e8);font:600 15px/1 "Source Sans 3",system-ui,-apple-system,"Segoe UI",sans-serif;text-decoration:none;box-shadow:0 4px 18px rgba(0,0,0,.35)}
.lodestone-back:hover{border-color:#9B3DBE;color:var(--text-heading,#fff)}.lodestone-back svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
@media print{.lodestone-back{display:none}}</style>`;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || [])
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
  // Private ranges first: those are the Wi-Fi addresses a phone can reach.
  return out.sort((a, b) => (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(b) ? 1 : 0) - (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a) ? 1 : 0));
}

function send(res, status, body, type = "application/json", extra = {}) {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store", ...extra });
  res.end(buf);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** A plain page in the site's colours, for what the app cannot show offline. */
function notice(title, body) {
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Lodestone</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a14;color:#d8d8e8;font:17px/1.6 "Source Sans 3",system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;padding:2rem}h1{font:600 2rem/1.2 "Cormorant Garamond",Georgia,serif;color:#f0f0ff;margin:0 0 1rem}
a{color:#FFBA2E}.row{display:flex;gap:.8rem;flex-wrap:wrap;margin-top:1.4rem}
.btn{display:inline-block;padding:.55rem 1.1rem;border:1px solid #2a2a55;border-radius:10px;text-decoration:none;background:#1a1a3a;color:#d8d8e8;font:inherit;cursor:pointer}
.btn.primary{background:#9B3DBE;border-color:#9B3DBE;color:#fff;font-weight:600}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

function fileHeaders(file, p) {
  const ext = path.extname(file).toLowerCase();
  // The app's own shell revalidates, and must — the window has no address bar
  // to hard-reload from, and 1.5.1's docked conversations were once invisible
  // for a launch behind a cached main.js. The big downloaded artefacts keep
  // their hour (the corpus pack, the vendored runtimes, the speech model),
  // since a no-cache with no validator would refetch them whole; so do the
  // library's assets.
  const shell = p.startsWith(APP) && !p.includes("/corpus/") && !p.includes("/vendor/") && !p.includes("/asr/");
  const cc = (shell || ext === ".html" || ext === ".php" || p.endsWith("sw.js") || p.endsWith(".webmanifest") || p.includes("/corpus/")) ? "no-cache" : "max-age=3600";
  return { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cc };
}

function serveFile(file, p, req, res, { status = 200, inject = false } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "not found", "text/plain");
    const headers = fileHeaders(file, p);
    if (inject && headers["Content-Type"].startsWith("text/html")) {
      return fs.readFile(file, "utf8", (e, html) => {
        if (e) return send(res, 500, "unreadable", "text/plain");
        const i = html.search(/<head[^>]*>/i);
        const out = i < 0 ? PAGE_SCRIPT + html : html.replace(/<head[^>]*>/i, m => m + PAGE_SCRIPT);
        send(res, status, req.method === "HEAD" ? "" : out, headers["Content-Type"], { "Cache-Control": headers["Cache-Control"] });
      });
    }
    res.writeHead(status, { ...headers, "Content-Length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function serveUnder(root, rel, req, res, hdrPath = null) {
  if (rel.endsWith("/") || rel === "") rel += "index.html";
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) && file !== root) return send(res, 403, "forbidden", "text/plain");
  serveFile(file, hdrPath || rel, req, res);
}

async function passthrough(target, req, res, body) {
  // When the practitioner presses Stop the page drops the request; dropping the
  // upstream one with it is what makes the engine stop generating.
  const ctrl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
  let up;
  try {
    up = await fetch(target, {
      method: req.method, body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      headers: { "Content-Type": req.headers["content-type"] || "application/json" },
      signal: ctrl.signal,
    });
  } catch (e) {
    return send(res, 502, { error: `model server unreachable: ${e.message}` });
  }
  return pipeResponse(up, res);
}

function pipeResponse(up, res) {
  res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") || "application/json", "Cache-Control": "no-store" });
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on("error", () => res.end()).pipe(res);
}

/**
 * A rented model under the practitioner's key (remote.js). The page asks for
 * model "lodestone" in OpenAI's shape, as it does of the bundled engine.
 */
async function remoteModel(rc, req, res, sub, body) {
  const route = sub.split("?")[0];
  if (req.method === "GET" && route === "/models") return send(res, 200, { object: "list", data: [{ id: "lodestone", object: "model" }] });
  if (req.method !== "POST" || route !== "/chat/completions") return send(res, 404, { error: "Not available with a rented model." });
  let o;
  try { o = JSON.parse(body.toString("utf8")); } catch { return send(res, 400, { error: "Unreadable request." }); }
  const ctrl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
  let up;
  try { up = await require("./remote").chat(rc.fetch, rc.conf, rc.key, o, ctrl.signal); }
  catch (e) { return send(res, 502, { error: e.message }); }
  return pipeResponse(up, res);
}

/**
 * @param {{ webRoot: string, corpusRoot: () => string, site: import("./site").Site,
 *           companion: import("./companion").Companion,
 *           getConfig: () => { upstream: string|null, isEngine: boolean, remote?: object|null } }} opts
 */
// The Lodestone app for Android opens harmonism.io/lodestone-app/ and reaches this
// server across the home network, so its requests carry that origin.
// Only the routes it needs answer it: the model, pairing and sync.
const NATIVE_ORIGINS = new Set(["https://harmonism.io"]);
const NATIVE_PATHS = /^\/(v1\/|lodestone-app\/v1\/|munai-app\/v1\/|munai-pair$|munai-sync$)/;
function cors(req, res, p, origins = NATIVE_ORIGINS) {
  const o = req.headers.origin;
  if (!o || !origins.has(o) || !NATIVE_PATHS.test(p)) return false;
  res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}
const bearer = req => (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "") || [])[1] || null;

function createServer({ webRoot, corpusRoot, site, companion, getConfig, asrRoot = null, phone = null, nativeOrigins = NATIVE_ORIGINS }) {
  webRoot = path.resolve(webRoot);

  async function model(req, res, sub) {
    const { upstream, isEngine, remote } = getConfig();
    if (remote) return remoteModel(remote, req, res, sub, req.method === "POST" ? await readBody(req) : undefined);
    if (!upstream) return send(res, 503, { error: "Lodestone's model is not running. Open the Lodestone menu → Model… to start it." });
    let body = req.method === "POST" ? await readBody(req) : undefined;
    if (isEngine && req.method === "POST" && sub.split("?")[0] === "/chat/completions") {
      // Belt and braces with the engine's own flags: no hidden reasoning.
      try {
        const o = JSON.parse(body.toString("utf8"));
        o.chat_template_kwargs = { ...(o.chat_template_kwargs || {}), enable_thinking: false };
        body = Buffer.from(JSON.stringify(o));
      } catch {}
    }
    return passthrough(upstream.replace(/\/+$/, "") + sub, req, res, body);
  }

  function library(p, req, res) {
    const r = site.resolve(p);
    if (r?.file) return serveFile(r.file, p, req, res, { inject: true });
    if (r?.missingLang) {
      const lang = r.missingLang, name = LANGS[lang] || lang;
      return send(res, 200, notice(`${name} is not on this computer yet`, `
<p>The app carries the library in English. The ${esc(name)} library can be downloaded once and then reads offline like the rest.</p>
<div class="row"><button class="btn primary" onclick="window.lodestoneDesktop?window.lodestoneDesktop.openLibrary(${esc(JSON.stringify(lang))}):location.assign('${ONLINE}${esc(p)}')">Download the ${esc(name)} library</button>
<a class="btn" href="/">Stay in English</a><a class="btn" href="${ONLINE}${esc(p)}">Read it on harmonism.io</a></div>`), "text/html; charset=utf-8");
    }
    const nf = site.resolve("/404.html");
    if (nf?.file) return serveFile(nf.file, "/404.html", req, res, { status: 404, inject: true });
    return send(res, 404, notice("Not found", `<p>This page is not in the library.</p><div class="row"><a class="btn" href="/">The library</a></div>`), "text/html; charset=utf-8");
  }

  const handler = async (req, res) => {
    try {
      const url = req.url || "/";
      let p;
      try { p = decodeURIComponent(new URL(url, "http://x").pathname); } catch { return send(res, 400, "bad path", "text/plain"); }

      const crossOrigin = cors(req, res, p, nativeOrigins);
      if (req.method === "OPTIONS") {
        if (!crossOrigin) return send(res, 405, "method not allowed", "text/plain");
        res.writeHead(204, { "Content-Length": 0 }); return res.end();
      }

      // The Lodestone app for Android
      if (phone && p === "/munai-pair") {
        if (req.method === "GET") return send(res, 200, phone.hello());
        if (req.method !== "POST") return send(res, 405, { error: { code: "method", message: "Method not allowed" } });
        let body;
        try { body = JSON.parse((await readBody(req, 4096)).toString("utf8")); } catch { return send(res, 400, { error: { code: "bad_request", message: "Unreadable request." } }); }
        const r = phone.pair(body);
        return send(res, r.status, r.json);
      }
      if (phone && p === "/munai-sync") {
        if (!phone.authorized(bearer(req))) return send(res, 401, { error: { code: "auth", message: "This phone is not paired with Lodestone Desktop, or was forgotten there. Pair it again." } });
        let body = null;
        if (req.method === "PUT" || req.method === "POST") {
          try { body = JSON.parse((await readBody(req, 9 * 1024 * 1024)).toString("utf8")); } catch { return send(res, 400, { error: { code: "bad_request", message: "Unreadable request." } }); }
        }
        const r = phone.sync.handle(req.method, url.includes("?") ? url.slice(url.indexOf("?")) : "", body);
        return send(res, r.status, r.json);
      }

      // The model
      if (p.startsWith("/v1/")) return model(req, res, url.slice(3));
      if (p.startsWith(APP + "v1/")) return model(req, res, url.slice(APP.length + 2));

      // Everything else PHP was a service of harmonism.io's server
      if (req.method === "POST") {
        if (/(^|\/)companion-api\.php$/.test(p)) {
          let body;
          try { body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8")); } catch { return send(res, 400, { error: "Unreadable request." }); }
          return companion.handle(body, req, res);
        }
        if (/\.php$/.test(p)) return send(res, 503, { error: "This needs harmonism.io. In the app Lodestone works offline and keeps no account." });
        return send(res, 405, "method not allowed", "text/plain");
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", "text/plain");

      // Lodestone
      if (p === "/lodestone-app" || p === "/munai-offline" || p === "/munai-app") return send(res, 301, "", "text/plain", { Location: APP });
      for (const old of [OLD_APP, OLD_APP_2]) if (p.startsWith(old)) return send(res, 301, "", "text/plain", { Location: APP + p.slice(old.length) + (url.includes("?") ? url.slice(url.indexOf("?")) : "") });
      if (p.startsWith(APP + "corpus/")) {
        const f = p.slice(APP.length + 7);
        if (CORPUS_FILES.has(f)) return serveFile(path.join(corpusRoot(), f), p, req, res);
      }
      // The speech model, downloaded into the data folder on first use (speech.js)
      if (asrRoot && p.startsWith(APP + "asr/")) return serveUnder(asrRoot(), p.slice(APP.length + 4), req, res);
      // The full pathname travels as hdrPath, so the shell's files revalidate
      // (fileHeaders) instead of living an hour in Chromium's HTTP cache.
      if (p.startsWith(APP)) return serveUnder(webRoot, p.slice(APP.length), req, res, p);

      if (/\.php$/.test(p) || /^\/([a-z]{2}\/)?member(\/|$)/.test(p)) {
        // A .php in the library holds only HTML (the interactive Wheel, the assessment).
        const r = site.resolve(p);
        if (r?.file) return serveFile(r.file, p, req, res, { inject: true });
        return send(res, 200, notice("This page lives on harmonism.io", `
<p>Accounts, membership and the other online services are not part of the app: it works offline and keeps nothing about you anywhere but on this computer.</p>
<div class="row"><a class="btn primary" href="${ONLINE}${esc(url)}">Open it on harmonism.io</a><a class="btn" href="/" onclick="history.back();return false">Back</a></div>`), "text/html; charset=utf-8");
      }
      // Narration is not carried: it is several gigabytes. Played from harmonism.io when online.
      if (p.startsWith("/audio/") || /^\/[a-z]{2}\/audio\//.test(p)) return send(res, 302, "", "text/plain", { Location: ONLINE + url });

      return library(p, req, res);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
      else res.end();
    }
  };

  let srv = null;
  return {
    /** Listen on `port`; `lan` opens it to the local network for phones. */
    listen(port, lan) {
      return new Promise((resolve, reject) => {
        const s = http.createServer(handler);
        s.keepAliveTimeout = 5000;
        s.requestTimeout = 0; // generations can run for minutes
        s.once("error", reject);
        s.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => { srv = s; resolve(s.address().port); });
      });
    },
    close() {
      return new Promise(r => { if (!srv) return r(); srv.closeAllConnections?.(); srv.close(() => r()); srv = null; });
    },
    lanAddresses,
  };
}

module.exports = { createServer, lanAddresses, APP };
