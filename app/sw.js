// sw.js — keeps the app shell available with no network.
// The corpus pack and model weights are cached by the app and by WebLLM / transformers.js
// themselves; this worker only serves the shell and the vendored runtime files.
// The prefix keeps the app's earlier name: the cache is found by it.
const VERSION = "munai-offline-shell-v80";   // v80: the model button names the model alone on a phone; no "Drawn from" list under a Telegram reply; v79: Lodestone knows itself: a question about the app, its models, memory or settings brings the manual and this install's state (selfknow.js); v78: no Retry under answers; what is kept about oneself goes to the pillar of the Wheel it concerns (or a person, how to speak with me, open threads, Unsorted), chosen in the card; a kept answer goes to Kept/<Pillar>.md, a shelf Lodestone does not read back; v77: copy, listen, save and retry under an answer as icons; an answer kept in the life book goes to Life/Kept answers.md unless another note is chosen, the notes offered by name; v76: an answer can be saved as a Markdown file (to Files on a phone) or kept in the life book; Copy falls back where the clipboard API is refused; v75: the composer without the dead band under it; dictation inside the box; a conversation by voice in the send slot while the box is empty; the cost line in the model menu on a phone; v74: Settings in six groups (Model, Voice, Memory, Account, Display, About) named in the list at the top, the version and Check for updates first, no sideways drift on a phone; v73: an article a reply names (in italics, in bold, or after the word "article") is a link that opens it in the Library; v72: the articles a reply drew on no longer listed under it; the composer is one row of every option (attach, look up, model, text or voice, dictation, talk) over a larger text box; the Library's back and close on a phone sit below the status bar, 52 px; v71: retrieval tuned on a 59-question set (tools/eval-retrieval.mjs): passages lifted by their article, a relative cut and a semantic floor (nothing retrieved for a question the corpus does not treat, said in <vault_knowledge>), a follow-up opening on "and", "why", "what about" carries the previous question and lifts the articles the last reply drew on; retrieval keeps a passage only if it treats the name asked about, not one that mentions it in passing (retrieval.js about()); the model told that a passing mention is not the corpus's answer, and never to remark on a repeated question (prompt.js); v70: the care line is shown by the app only for a plain phrase; a suspected moment is the model's to mark (1.13.2), and the meaning layer refitted on short replies. v69: backbone 2.9, one backbone everywhere (the light one retired with thinking inside the browser); a rented model tested against the doctrine gets a 65,536-token window; the English persona and backbone counted at their measured rate, so the conversation keeps about a quarter more room; v68 also: "sort" in the life book's words; asked whether it remembers them, Lodestone does not bring up a death or grief they have not raised (prompt.js); v68: Organize my life book (one note per pillar of the Wheel, one per person; lines moved word for word, kept with Keep); v67: the app states its version and checks for a newer one (Settings → Corpus and updates), the worker answers {type:"version"}; v66: a carried memory (carried_at) stands over older memory, its notes all kept (sync.js mergeState); the server is asked again every ten minutes after a confirmed move (held.js), so a second carry arrives; v65: the life book on every device (kept notes live in the synced record until Lodestone Desktop writes them), its notes listed in Settings, and a carried memory offered as its first notes; v64: an empty answer from memory-export is asked again (held.js), so memory carried from Telegram later still arrives; v63: setup keeps the route picked before signing in, and takes the synced OpenRouter key on a new install; v62: a saved choice of the September V4.1 Flash moves to 1017; v61: a stream cut before any text is an error with Retry, not "…" (sse.js); v60: Pause and Resume beside Stop while an answer is read; v59: answer actions always shown; the reply told its language (<reply_language>); dictation hears the language when none is set, never the device's; folders it reads in the web app (folders-web.js); v58: Grok's voice through OpenRouter told the answer's language (voicecloud.js), French no longer read as English; v57: icon links versioned (?v=mark2) so home screens fetch the mark, not a cached sprite; v56: the sprite larger in the header, beside replies and on the empty screen; v55: the mark fills more of the icon tile; v54: icons are the Lodestone mark (heptagon, seven facets), no longer the sprite; v53: Help Lodestone improve is the last section of Settings; v52: setup heading names the surface (own computer / phone / device); v51: bottom facet a shade under its neighbours, both skins; v50: Help Lodestone improve (shareout.js); v49: dark skin is the mid tone; v48: icons mid-tone sprite on white; v47: light sprite bottom facet evened; v46: dictation's guard by alignment, hold fn to dictate; v45: the sprite's dark sheen, dictation in three layers
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "icons/lodestone-192.png", "icons/lodestone-512.png", "icons/lodestone-touch-180.png", "icons/lodestone-mark.svg", "icons/lodestone-32.png",
  "js/main.js", "js/store.js", "js/corpus.js", "js/retrieval.js", "js/embedder.js", "js/embed-worker.js",
  "js/engine.js", "js/phone.js", "js/sync.js", "js/unlock.js", "js/native.js", "js/held.js", "js/syncwire.js", "js/sse.js", "js/llm-worker.js", "js/prompt.js", "js/safety.js", "js/md.js", "js/attach.js", "js/privacygate.js", "js/care.js", "js/presence.js", "safety.html", "js/hp.js", "js/asr-worker.js", "js/voice.js", "js/learning.js", "js/lifebook.js", "js/speechweb.js", "js/wikilookup.js", "js/voicecloud.js", "js/canon.js", "js/canon-data.js", "js/outreach.js", "js/tidy.js", "js/shareout.js", "js/folders-web.js", "js/selfknow.js",
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

// The page asks which version this worker is (Settings shows it, and compares it with the newest).
self.addEventListener("message", e => {
  if (e.data?.type === "version") (e.ports?.[0] || e.source)?.postMessage({ type: "version", version: VERSION });
});

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
