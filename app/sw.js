// sw.js — keeps the app shell available with no network.
// The corpus pack and model weights are cached by the app and by WebLLM / transformers.js
// themselves; this worker only serves the shell and the vendored runtime files.
// The prefix keeps the app's earlier name: the cache is found by it.
const VERSION = "munai-offline-shell-v100";   // v100: Lodestone knows the hour and when they wrote: the device's own clock and time zone, the sittings of the conversation by their first words (prompt.js temporalBlock), local dates in learning and the life book; reply to a message, by a swipe from right to left or Reply in its menu, quoted in the bubble and to the model; search inside a conversation (a bar at its top, from a list search, a conversation's menu or ⌘F; the CSS Highlight API); on a phone a message's menu rises as a sheet, ordered by use; on an iPhone the app is kept on the visible part of the screen while the keyboard is open (visualViewport); diagnostics kept on the device, Settings → About → Diagnostics, Copy report (main.js, prompt.js, learning.js, lifebook.js, held.js, index.html, styles.css, i18n-fr.js); v99: answers painted once a frame and morphed in place (vendor/remend, vendor/idiomorph); a question rises to the top and its answer is read from its first line, with Jump to the latest; an answer kept as it arrives, a cut or failed one said in place with Try again and Edit, a stall ended after a minute (sse.js); words never stored go back to the box; drafts kept per conversation; the last conversation shown before the corpus loads; day separators; "Thinking…" before the first word; Select text in the held menu; persistent storage asked; an update said by a bar with Reload; WebLLM fetched only on demand; tap targets 40 px on touch; more of the setup in French (main.js, sse.js, i18n.js, i18n-fr.js, styles.css); v98: Lodestone's answers on a card of their own colour and the practitioner's words in a violet bubble, bold seen as bold (styles.css); a single message pinned (held at the top of the conversation) or deleted, by its ⋯ or by holding it on a phone, the deletion kept through sync (main.js, store.js, sync.js); the app's own words in French, Settings → Display → App language, Auto following the phone (i18n.js, i18n-fr.js, index.html); the first name and a few bold phrases in replies (prompt.js); on an iPhone the refused microphone names where to allow it (main.js); v97: on a phone the conversation moves aside to the right to show the list of conversations beneath it, under the finger or by the button, and comes back over it by a tap on what shows of it or a swipe to the left, as in Claude's app (main.js, styles.css); v96: on a phone the swipe moves the layer under the finger (the conversations slide in from the left and out again; a page, a drawer or the Harmonic Profile slides off to the right over what it was opened from) and finishes or springs back by distance and speed; the greeting lists only what the practitioner committed to, not the topics Lodestone inferred (main.js, styles.css); v95: in the Home Screen app on an iPhone the conversation takes no history entry, so the swipe from the edge is Lodestone's and opens the list (iOS's own swipe showed the same conversation, mirrored); forward from the list returns to the conversation; a drawer never scrolls sideways, so a swipe from right to left over the list closes it; the Wheel reading's fields: a tap on a pillar's line opens them, each box as tall as its text with Clear above it, no label wrapped round it (iOS selection), and no checkbox for avoidance: only where Lodestone noticed it, "Lodestone notices you tend to avoid this area" with Not true, which stands (main.js, learning.js, styles.css); "Tends to avoid" on the Harmonic Profile page (profileview.js); v94: at most one question a reply, none as a sign-off by default (prompt.js); learning after the third message, then every ten, and on leaving the app when three or more are new (learning.js, main.js); v93: a new conversation greets by name and the hour ("What is present for you today?") with what was left open a tap away; "Welcome to Lodestone" for a first one; no more "Speak from where you are" (read as a place); all eight pillars in What Lodestone has learned; Your strengths in the Harmonic Profile, beside Your edges, with Lodestone's own notes per pillar (main.js, profileview.js, index.html, styles.css); v92: on a phone, Settings and Your path one tap from the chat in the top bar; the conversation one step above the list of conversations, so a swipe, the phone\u2019s and the browser\u2019s back bring the list (no more reload of the same conversation), iOS\u2019s edge left to iOS; Your path opens on the first tap even if one of its parts fails; the four openings only before the first conversation; What Lodestone has learned: the notes read in full (Read all) and edited on purpose, each pillar\u2019s reading and Now / Left open corrected or forgotten in place, "Something it has wrong?" held as true over anything inferred, in every conversation and in learning (learning.js); no stray "null" (main.js, index.html, styles.css); v91: in the web app the routes on one\u2019s own hardware (a model server, a model in this browser) fold under "On your own computer", pointing to Lodestone Desktop; not on a page one\u2019s computer serves, nor in the Android app (main.js, styles.css); v90: setup opened over a running Lodestone is a layer: a Back at its top, a swipe from left to right, Esc and the system back return to the saved route and to Settings when opened from there; Settings → Model offers another model on OpenRouter by id, tested under the key (main.js, index.html, styles.css); v89: flagship pass — the typefaces shipped with the app (fonts/, SIL OFL); the composer one block, opening on one line, its settings inside it; a message\u2019s actions appear with it (hover, a tap, the latest answer), Keep and Practice under ⋯, the model and cost under an answer only by choice (Settings → Display); the top bar: conversations, Lodestone, a new conversation, the state a quiet line with a dot; one accent (gold is the Matter pillar\u2019s); motion (drawers slide, pages rise, menus open, a new message settles; none with reduced motion); Lodestone\u2019s own question sheet in place of confirm(); Settings and Your path with one way out, the title first on a phone; one icon set; the Home Screen note and the sign-in ask wait for a third conversation or the first thing kept (main.js, styles.css, index.html); v88: where iOS stops an installed app short of the screen’s foot (WebKit 301994), measured on any phone, the composer drops the bottom inset; the page background set on html, which iOS takes for its band; the voice and model menus kept inside the screen (main.js, styles.css); the v87 measures line removed; v87: the large-viewport height of v86 withdrawn (it ran the composer under the screen's foot); the screen's measures shown in Settings in an installed app, for placing the composer (main.js, temporary); v86: the voice button beside dictation inside the box, becoming Send once there is text (styles.css, index.html); v85: the composer sits closer to the Home Screen app's bottom edge, 12 px above it instead of 18 (styles.css); v84: no model chip on the chat page, the model chosen in Settings and setup (main.js); no closed model and no GLM or Qwen among the recommended (phone.js); v83: the life book kept quietly, no cards for what Lodestone keeps by itself (main.js); Lodestone speaks in its own voice, never "Harmonism says" (prompt.js); the app pinned to the whole screen, no dead band under the composer in the Home Screen app (styles.css); v82: emoji mirrored sparingly, only when the practitioner uses them (prompt.js), and never spoken (voice.js); v81: Back everywhere: a swipe from left to right, the phone's and the browser's back step down one layer (a drawer, the one it was opened from, an article over the Library list, the Harmonic Profile page), back buttons on Page readings, Usage, Help and the Profile page; Your path and the vault at the foot of the conversations; Your path in four groups named in its list; the life book in Your path, grouped, searchable, each note switched on or off, made always present, edited, moved or merged, a new note, Sort with Lodestone; in Lodestone Desktop (1.14.2) also a two-finger swipe on the trackpad and the mouse's back button, and Your Path (⌘3) and Life Book (⌘4) in the Lodestone menu; v80: the model button names the model alone on a phone; no "Drawn from" list under a Telegram reply; v79: Lodestone knows itself: a question about the app, its models, memory or settings brings the manual and this install's state (selfknow.js); v78: no Retry under answers; what is kept about oneself goes to the pillar of the Wheel it concerns (or a person, how to speak with me, open threads, Unsorted), chosen in the card; a kept answer goes to Kept/<Pillar>.md, a shelf Lodestone does not read back; v77: copy, listen, save and retry under an answer as icons; an answer kept in the life book goes to Life/Kept answers.md unless another note is chosen, the notes offered by name; v76: an answer can be saved as a Markdown file (to Files on a phone) or kept in the life book; Copy falls back where the clipboard API is refused; v75: the composer without the dead band under it; dictation inside the box; a conversation by voice in the send slot while the box is empty; the cost line in the model menu on a phone; v74: Settings in six groups (Model, Voice, Memory, Account, Display, About) named in the list at the top, the version and Check for updates first, no sideways drift on a phone; v73: an article a reply names (in italics, in bold, or after the word "article") is a link that opens it in the Library; v72: the articles a reply drew on no longer listed under it; the composer is one row of every option (attach, look up, model, text or voice, dictation, talk) over a larger text box; the Library's back and close on a phone sit below the status bar, 52 px; v71: retrieval tuned on a 59-question set (tools/eval-retrieval.mjs): passages lifted by their article, a relative cut and a semantic floor (nothing retrieved for a question the corpus does not treat, said in <vault_knowledge>), a follow-up opening on "and", "why", "what about" carries the previous question and lifts the articles the last reply drew on; retrieval keeps a passage only if it treats the name asked about, not one that mentions it in passing (retrieval.js about()); the model told that a passing mention is not the corpus's answer, and never to remark on a repeated question (prompt.js); v70: the care line is shown by the app only for a plain phrase; a suspected moment is the model's to mark (1.13.2), and the meaning layer refitted on short replies. v69: backbone 2.9, one backbone everywhere (the light one retired with thinking inside the browser); a rented model tested against the doctrine gets a 65,536-token window; the English persona and backbone counted at their measured rate, so the conversation keeps about a quarter more room; v68 also: "sort" in the life book's words; asked whether it remembers them, Lodestone does not bring up a death or grief they have not raised (prompt.js); v68: Organize my life book (one note per pillar of the Wheel, one per person; lines moved word for word, kept with Keep); v67: the app states its version and checks for a newer one (Settings → Corpus and updates), the worker answers {type:"version"}; v66: a carried memory (carried_at) stands over older memory, its notes all kept (sync.js mergeState); the server is asked again every ten minutes after a confirmed move (held.js), so a second carry arrives; v65: the life book on every device (kept notes live in the synced record until Lodestone Desktop writes them), its notes listed in Settings, and a carried memory offered as its first notes; v64: an empty answer from memory-export is asked again (held.js), so memory carried from Telegram later still arrives; v63: setup keeps the route picked before signing in, and takes the synced OpenRouter key on a new install; v62: a saved choice of the September V4.1 Flash moves to 1017; v61: a stream cut before any text is an error with Retry, not "…" (sse.js); v60: Pause and Resume beside Stop while an answer is read; v59: answer actions always shown; the reply told its language (<reply_language>); dictation hears the language when none is set, never the device's; folders it reads in the web app (folders-web.js); v58: Grok's voice through OpenRouter told the answer's language (voicecloud.js), French no longer read as English; v57: icon links versioned (?v=mark2) so home screens fetch the mark, not a cached sprite; v56: the sprite larger in the header, beside replies and on the empty screen; v55: the mark fills more of the icon tile; v54: icons are the Lodestone mark (heptagon, seven facets), no longer the sprite; v53: Help Lodestone improve is the last section of Settings; v52: setup heading names the surface (own computer / phone / device); v51: bottom facet a shade under its neighbours, both skins; v50: Help Lodestone improve (shareout.js); v49: dark skin is the mid tone; v48: icons mid-tone sprite on white; v47: light sprite bottom facet evened; v46: dictation's guard by alignment, hold fn to dictate; v45: the sprite's dark sheen, dictation in three layers
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "icons/lodestone-192.png", "icons/lodestone-512.png", "icons/lodestone-touch-180.png", "icons/lodestone-mark.svg", "icons/lodestone-32.png",
  "js/main.js", "js/store.js", "js/corpus.js", "js/retrieval.js", "js/embedder.js", "js/embed-worker.js",
  "js/engine.js", "js/phone.js", "js/sync.js", "js/unlock.js", "js/native.js", "js/held.js", "js/syncwire.js", "js/sse.js", "js/llm-worker.js", "js/prompt.js", "js/safety.js", "js/md.js", "js/attach.js", "js/privacygate.js", "js/care.js", "js/presence.js", "safety.html", "js/hp.js", "js/asr-worker.js", "js/voice.js", "js/learning.js", "js/lifebook.js", "js/speechweb.js", "js/wikilookup.js", "js/voicecloud.js", "js/canon.js", "js/canon-data.js", "js/outreach.js", "js/tidy.js", "js/shareout.js", "js/folders-web.js", "js/selfknow.js", "js/i18n.js", "js/i18n-fr.js",
  "vendor/transformers.min.js", "vendor/idiomorph/idiomorph.esm.js", "vendor/remend/remend.js",
  "fonts/cormorant-garamond-latin-500-normal.woff2", "fonts/cormorant-garamond-latin-600-normal.woff2", "fonts/cormorant-garamond-latin-500-italic.woff2", "fonts/source-sans-3-latin-wght-normal.woff2", "fonts/source-sans-3-latin-wght-italic.woff2", "fonts/cormorant-garamond-latin-ext-500-normal.woff2", "fonts/cormorant-garamond-latin-ext-600-normal.woff2", "fonts/cormorant-garamond-latin-ext-500-italic.woff2", "fonts/source-sans-3-latin-ext-wght-normal.woff2", "fonts/source-sans-3-latin-ext-wght-italic.woff2",
];
// Fetched on demand and cached on first use: the ONNX runtime and the vendored
// retrieval model (~130 MB), which must never be re-fetched from anywhere.
// v99: WebLLM (6.6 MB), no longer used on a phone, is fetched only if ever asked for.
const LAZY = /\/vendor\/(ort|models|pdfjs)\/|\/vendor\/web-llm\.js$/;

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
