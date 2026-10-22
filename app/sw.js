// sw.js — keeps the app shell available with no network.
// The corpus pack and model weights are cached by the app and by WebLLM / transformers.js
// themselves; this worker only serves the shell and the vendored runtime files.
// The prefix keeps the app's earlier name: the cache is found by it.
const VERSION = "munai-offline-shell-v45";   // v45: the sprite's dark sheen, dictation in three layers
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "icons/lodestone-192.png", "icons/lodestone-512.png", "icons/lodestone-touch-180.png",
  "js/main.js", "js/store.js", "js/corpus.js", "js/retrieval.js", "js/embedder.js", "js/embed-worker.js",
  "js/engine.js", "js/phone.js", "js/sync.js", "js/unlock.js", "js/native.js", "js/held.js", "js/syncwire.js", "js/sse.js", "js/llm-worker.js", "js/prompt.js", "js/safety.js", "js/md.js", "js/attach.js", "js/privacygate.js", "js/care.js", "js/presence.js", "safety.html", "js/hp.js", "js/asr-worker.js", "js/voice.js", "js/learning.js", "js/lifebook.js", "js/speechweb.js", "js/wikilookup.js", "js/voicecloud.js", "js/canon.js", "js/canon-data.js", "js/outreach.js", "js/tidy.js",
  "vendor/web-llm.js", "vendor/transformers.min.js",
];
// Fetched on demand and cached on first use: the ONNX runtime and the vendored
// retrieval model (~130 MB), which must never be re-fetched from anywhere.
const LAZY = /\/vendor\/(ort|models|pdfjs)\//;

// Cache each file on its own. cache.addAll() is atomic: a single 404 anywhere in
// the list rejects the whole install, the worker never activates, and the app
// silently loses offline support — which is exactly what one missing icon did on
// the first deploy. A file that cannot be fetched is logged and skipped; the page
// itself, index.html, is the only one whose failure is worth failing the install.
async function cacheShell() {
  const cache = await caches.open(VERSION);
  const results = await Promise.allSettled(SHELL.map(async (path) => {
    // The page is asked for as a page: the Lodestone app for Android adds
    // its bridge only to what is fetched as HTML, and the copy kept here is
    // the one it opens offline. On the web the header changes nothing.
    const page = path === "./" || path === "index.html";
    const res = await fetch(new Request(path, { cache: "reload", headers: page ? { Accept: "text/html" } : {} }));
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    await cache.put(path, res);
    return path;
  }));
  const failed = results.filter(r => r.status === "rejected").map(r => String(r.reason));
  if (failed.length) console.warn("[sw] not cached:", failed);
  const core = await cache.match("index.html");
  if (!core) throw new Error("index.html could not be cached — offline would not work");
}

self.addEventListener("install", e => {
  e.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

// Before an older shell cache goes, the large files fetched on demand (the
// retrieval model, the ONNX runtime) are carried into this one — under this
// worker's own path, since the app moved from /munai-offline/ to /lodestone-app/
// on October 17, 2026 — so a practitioner never downloads them twice.
async function carryLazy(fromName, to) {
  const from = await caches.open(fromName);
  const scope = new URL(self.registration.scope).pathname;
  for (const req of await from.keys()) {
    const u = new URL(req.url);
    if (!LAZY.test(u.pathname)) continue;
    u.pathname = u.pathname.replace(/^\/munai-offline\//, scope);
    if (await to.match(u.href)) continue;
    const res = await from.match(req);
    if (res) await to.put(u.href, res);
  }
}

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const to = await caches.open(VERSION);
    for (const k of await caches.keys()) {
      if (!k.startsWith("munai-offline-shell-") || k === VERSION) continue;
      try { await carryLazy(k, to); } catch (err) { console.warn("[sw] not carried:", k, err); }
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname.includes("/corpus/") || url.pathname.includes("/v1/")) return; // app-managed / live server
  if (url.pathname.includes("/download/") || url.pathname.endsWith(".zip")) return; // installers go straight to the network

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) {
      // refresh the shell in the background when online; the practitioner never waits on it
      if (!LAZY.test(url.pathname)) fetch(e.request).then(r => r.ok && cache.put(e.request, r)).catch(() => {});
      return hit;
    }
    try {
      const res = await fetch(e.request);
      if (res.ok && (LAZY.test(url.pathname) || url.pathname === scope.pathname || SHELL.some(s => url.pathname.endsWith(s)))) cache.put(e.request, res.clone());
      return res;
    } catch {
      if (e.request.mode === "navigate") return (await cache.match("index.html")) || Response.error();
      return Response.error();
    }
  })());
});
