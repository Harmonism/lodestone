/**
 * Lodestone Extension — Content Script
 *
 * Injects the Lodestone sprite (ported from LodestoneSprite.astro, visuals and
 * core states only) inside a closed shadow root, with a chat panel wired to
 * companion-api.php via the background service worker. Since 2.0 it runs
 * only on a page where the practitioner calls Lodestone (the toolbar button or
 * the right-click item): the worker injects it then, under activeTab.
 *
 * The sprite is the site's own — crystal body, almond eyes, shimmer — with
 * the states that matter here: standing (breathing, sheen drift, a blink that
 * closes the lid), absorbing (faster breath, open mouth) while page content is
 * taken in, thinking while Lodestone streams. Body of the October 21, 2026
 * rebuild: seven facets, rim light, glint, sheen band, tucked feet.
 *
 * Nothing runs against the page's own JS; everything lives in the shadow
 * root. No page-origin network calls (CORS-exempt fetches happen in the
 * background worker).
 */

(function () {
  "use strict";

  if (window.top !== window) return;
  if (window.__lodestoneInjected) return;
  window.__lodestoneInjected = true;

  const HOSTNAME = location.hostname;
  const SESSION_KEY = "munai-chat-v1";
  const MAX_MESSAGES = 20;

  // Anonymous lifetime allowance — mirrors the site's conversion architecture:
  // soft nudge at 4, hard gate after 7. Linked members bypass entirely (their
  // caps are enforced server-side: free 5/day; no paid tier).
  const ANON_LIFETIME_LIMIT = 10;   // the website's ten in total (October 24, 2026; was 7)
  const ANON_NUDGE_AT = 7;
  let anonCount = 0;
  let nudgeShown = false;
  let follow = true, ownScroll = false;   // the message list follows the writing until the reader scrolls up (scrollBottom)

  // ===== Settings =====
  const DEFAULTS = { memoryLinked: false };
  // Signed in to harmonism.io in the options page: the turn goes into the
  // practitioner's own Lodestone memory. Asked of the worker, which holds the sign-in.
  let memory = false;
  let byok = false;   // answered under the practitioner's own OpenRouter key: no anonymous allowance applies
  function refreshMemory(then) {
    try {
      chrome.runtime.sendMessage({ type: "lodestone-status" }, (st) => {
        void chrome.runtime.lastError;
        memory = !!(st && st.signedIn);
        byok = !!(st && st.byok);
        if (ui && ui.sub) ui.sub.textContent = memory && !anonymousFallback ? "your memory" : "anonymous";
        if (ui && ui.options) ui.options.textContent = memory ? "Settings" : "Sign in";
        if (then) then();
      });
    } catch (e) { if (then) then(); }
  }
  let settings = Object.assign({}, DEFAULTS);
  let anonymousFallback = false; // set when user declines the consent gate for this session

  // ===== State =====
  let host = null;
  let root = null;
  let ui = {};
  let chatOpen = false;
  let streaming = false;
  let absorbed = false;
  let pageContextCache = null;
  let messages = [];

  // The tab's conversation is kept by the worker in the extension's own
  // session storage (cleared when the tab closes or the browser quits), never
  // in the page's sessionStorage, which the page's own scripts can read.
  // 1.x kept it there: whatever it left is removed.
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  function loadSession() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "lodestone-tab-history-get" }, (r) => {
          if (chrome.runtime.lastError) { resolve([]); return; }
          resolve(r && Array.isArray(r.messages) ? r.messages : []);
        });
      } catch (e) { resolve([]); }
    });
  }
  function saveSession() {
    try {
      chrome.runtime.sendMessage({ type: "lodestone-tab-history-set", messages: messages.slice(-MAX_MESSAGES) }, () => { void chrome.runtime.lastError; });
    } catch (e) {}
  }

  // ===== Language =====
  const SUPPORTED = ["en", "fr", "es", "ar", "pt", "de", "zh", "ja", "hi", "ru"];
  const LANG = (function () {
    const l = (navigator.language || "en").slice(0, 2).toLowerCase();
    return SUPPORTED.indexOf(l) !== -1 ? l : "en";
  })();

  // ===== Page content extraction (Readability-lite) =====
  // Walks visible text blocks on the live DOM (layout-aware innerText),
  // skipping chrome: nav, header, footer, aside, hidden nodes. Returns
  // clean prose capped for the server's extension-tier excerpt limit.
  function extractPageContent() {
    if (pageContextCache !== null) return pageContextCache;
    const CAP = 11500;
    const seen = new Set();
    const parts = [];
    let total = 0;
    const roots = [
      document.querySelector("article"),
      document.querySelector("main"),
      document.querySelector('[role="main"]'),
      document.body,
    ].filter(Boolean);
    const scope = roots.find((r) => (r.innerText || "").length > 400) || document.body;
    const blocks = scope.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre,figcaption,td,dt,dd");
    for (const el of blocks) {
      if (total >= CAP) break;
      if (el.closest("nav,header,footer,aside,form,[aria-hidden='true'],[hidden]")) continue;
      if (el.querySelector("p,li,blockquote")) continue; // take leaves, not containers
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length < 3 || seen.has(t)) continue;
      seen.add(t);
      const tag = el.tagName;
      const line = /^H[1-4]$/.test(tag) ? "\n## " + t : tag === "LI" ? "- " + t : t;
      parts.push(line);
      total += t.length;
    }
    let text = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) text = (document.body.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    pageContextCache = text.slice(0, CAP);
    return pageContextCache;
  }

  // ===== Payload =====
  function buildPayload() {
    const payload = {
      messages: messages.slice(-MAX_MESSAGES).map((m) => ({ role: m.role === "companion" ? "assistant" : m.role, content: m.content })),
      pageContext: extractPageContent(),
      pageDomain: HOSTNAME.slice(0, 50),
      pageTitle: (document.title || "").slice(0, 200),
      pageUrl: location.href.slice(0, 500),
      lang: LANG,
      source: "extension",
    };
    if (!(memory && !anonymousFallback)) payload.anonymous = true;
    return payload;
  }


  // AMO forbids assigning built strings to innerHTML (October 26, 2026): every
  // string here is already escaped, and goes in through DOMParser instead.
  function setHtml(el, html) {
    const doc = new DOMParser().parseFromString("<!doctype html><body>" + html, "text/html");
    el.replaceChildren(...doc.body.childNodes);
  }

  // ===== Markdown-lite rendering (escape first, then links/bold/italic) =====
  function renderMd(text) {
    let s = text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    s = s.replace(
      /\[([^\]]+)\]\(((?:https?:\/\/(?:www\.)?harmonism\.io[^\s)"]*|\/[^\s)]*))\)/g,
      function (_m, label, url) {
        const href = url.charAt(0) === "/" ? "https://harmonism.io" + url : url;
        return '<a href="' + href + '" target="_blank" rel="noopener">' + label + "</a>";
      }
    );
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    s = s.replace(/\n/g, "<br>");
    return s;
  }

  // ===== Sprite SVG (the October 21, 2026 body of LodestoneSprite.astro) =====
  // Colours are --sp-* custom properties, dark skin as fallback; .mn-light sets the light skin.
  const SPRITE_SVG = '<svg viewBox="0 0 48 56" width="64" height="75" xmlns="http://www.w3.org/2000/svg" class="sprite-body" overflow="visible"><defs><linearGradient id="mn-sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0.52" stop-color="#9B3DBE" stop-opacity="0"/><stop offset="0.60" stop-color="#9B3DBE" stop-opacity="0.45"/><stop offset="0.66" stop-color="#3DBE9B" stop-opacity="0.35"/><stop offset="0.72" stop-color="#3D6ABE" stop-opacity="0.4"/><stop offset="0.80" stop-color="#3D6ABE" stop-opacity="0"/></linearGradient><linearGradient id="mn-sheensoft" x1="0" y1="0" x2="1" y2="1"><stop offset="0.46" stop-color="#9B3DBE" stop-opacity="0"/><stop offset="0.58" stop-color="#9B3DBE" stop-opacity="0.30"/><stop offset="0.66" stop-color="#3DBE9B" stop-opacity="0.20"/><stop offset="0.74" stop-color="#3D6ABE" stop-opacity="0.26"/><stop offset="0.86" stop-color="#3D6ABE" stop-opacity="0"/></linearGradient><radialGradient id="mn-eyeglow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#8B6BAE" stop-opacity="0.35"/><stop offset="100%" stop-color="#8B6BAE" stop-opacity="0"/></radialGradient><radialGradient id="mn-facefade" cx="24" cy="26" r="13" gradientUnits="userSpaceOnUse" gradientTransform="translate(24 26) scale(1.15 0.9) translate(-24 -26)"><stop offset="0.45" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient><mask id="mn-facemask" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="56"><rect width="48" height="56" fill="url(#mn-facefade)"/></mask><clipPath id="mn-hull"><path d="M24 4 L38 14 L40 30 L34 44 L14 44 L8 30 L10 14 Z"/></clipPath><clipPath id="mn-eyeL"><path d="M14.2 22 Q18 18 21.8 22 Q18 25.5 14.2 22 Z"/></clipPath><clipPath id="mn-eyeR"><path d="M26.2 22 Q30 18 33.8 22 Q30 25.5 26.2 22 Z"/></clipPath><filter id="mn-eyeblur"><feGaussianBlur stdDeviation="0.35" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g class="sprite-feet"><g class="foot-left"><ellipse cx="18" cy="47" rx="4" ry="2.6" style="fill:var(--sp-foot,#574878);stroke:var(--sp-edge,#3E3160);stroke-width:.5"/><path d="M14.8 46.2 Q18 44.9 21.2 46.2" style="fill:none;stroke:var(--sp-foot-top,#8A84AA);stroke-width:.5;stroke-linecap:round"/></g><g class="foot-right"><ellipse cx="30" cy="47" rx="4" ry="2.6" style="fill:var(--sp-foot,#574878);stroke:var(--sp-edge,#3E3160);stroke-width:.5"/><path d="M26.8 46.2 Q30 44.9 33.2 46.2" style="fill:none;stroke:var(--sp-foot-top,#8A84AA);stroke-width:.5;stroke-linecap:round"/></g></g><g class="sprite-figure"><g class="sprite-crystal"><g clip-path="url(#mn-hull)"><path d="M24 4 L38 14 L40 30 L34 44 L14 44 L8 30 L10 14 Z" style="fill:var(--sp-base,#6F658F)"/><g mask="url(#mn-facemask)"><polygon points="23,25 24,4 38,14" style="fill:var(--sp-f1,#817AA0)"/><polygon points="23,25 38,14 40,30" style="fill:var(--sp-f2,#6F658F)"/><polygon points="23,25 40,30 34,44" style="fill:var(--sp-f3,#615583)"/><polygon points="23,25 34,44 14,44" style="fill:var(--sp-f4,#5E5381)"/><polygon points="23,25 14,44 8,30" style="fill:var(--sp-f5,#655B88)"/><polygon points="23,25 8,30 10,14" style="fill:var(--sp-f6,#786E9A)"/><polygon points="23,25 10,14 24,4" style="fill:var(--sp-f7,#8A84AA)"/></g><g class="sheen-shift"><rect x="-6" y="-6" width="60" height="68" fill="url(#mn-sheensoft)" class="shimmer-layer" style="fill:var(--sp-sheen-fill,url(#mn-sheensoft));opacity:calc(var(--sp-sheen-o,0.6) * .85)"/></g></g><path d="M24 4 L38 14 L40 30 L34 44 L14 44 L8 30 L10 14 Z" style="fill:none;stroke:var(--sp-edge,#3E3160);stroke-width:.55;stroke-linejoin:round"/><path d="M8 30 L10 14 L24 4 L38 14" style="fill:none;stroke:var(--sp-rim,#D2C4F0);stroke-width:.6;stroke-linejoin:round;stroke-linecap:round;opacity:var(--sp-rim-o,0.85)"/><path d="M11.2 13.4 L23.4 5" style="stroke:#fff;stroke-width:.55;stroke-linecap:round;opacity:var(--sp-glint-o,0.85)"/></g><g class="sprite-eyes" filter="url(#mn-eyeblur)"><circle cx="18" cy="22" r="4" fill="url(#mn-eyeglow)" class="eye-glow-left"/><circle cx="30" cy="22" r="4" fill="url(#mn-eyeglow)" class="eye-glow-right"/><g clip-path="url(#mn-eyeL)"><path d="M14.2 22 Q18 18 21.8 22 Q18 25.5 14.2 22 Z" fill="#F0ECF8" class="sclera-left"/><circle cx="18" cy="22" r="1.8" fill="#8B6BAE" class="eye-left"/><circle cx="18" cy="22" r=".95" fill="#2A1B5E" class="pupil-left"/><circle cx="17.3" cy="21.3" r=".55" fill="#fff" opacity=".65"/><circle cx="18.6" cy="22.4" r=".28" fill="#fff" opacity=".3"/></g><g clip-path="url(#mn-eyeR)"><path d="M26.2 22 Q30 18 33.8 22 Q30 25.5 26.2 22 Z" fill="#F0ECF8" class="sclera-right"/><circle cx="30" cy="22" r="1.8" fill="#8B6BAE" class="eye-right"/><circle cx="30" cy="22" r=".95" fill="#2A1B5E" class="pupil-right"/><circle cx="29.3" cy="21.3" r=".55" fill="#fff" opacity=".65"/><circle cx="30.6" cy="22.4" r=".28" fill="#fff" opacity=".3"/></g></g><g class="sprite-eye-outline" style="fill:none;stroke:var(--sp-outline,#3E3160);stroke-width:.45;stroke-linejoin:round;opacity:var(--sp-outline-o,0.55)"><path d="M14.2 22 Q18 18 21.8 22 Q18 25.5 14.2 22 Z"/><path d="M26.2 22 Q30 18 33.8 22 Q30 25.5 26.2 22 Z"/></g><g class="sprite-eyelids" style="fill:none;stroke:var(--sp-lid,#4A3C6E);stroke-width:.8;stroke-linecap:round"><path d="M14.2 22 Q18 25.5 21.8 22" class="eyelid-left"/><path d="M26.2 22 Q30 25.5 33.8 22" class="eyelid-right"/></g><g class="sprite-mouth"><path d="M20 32 Q24 33 28 32" class="mouth-closed" style="fill:none;stroke:var(--sp-mouth,#3A2C58);stroke-width:.8;stroke-linecap:round"/><ellipse cx="24" cy="33" rx="3" ry="2" class="mouth-open" style="fill:var(--sp-mouth-open,#2A1E44);stroke:var(--sp-mouth-open-stroke,#3E3160);stroke-width:.5"/></g></g></svg>';

  // ===== Styles (shadow-scoped; palette from sprite-embed.astro dark theme) =====
  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .mn-root {
      --bg: #0a0a14; --bg-surface: #12122a; --bg-elevated: #1a1a3a; --bg-hover: #222250;
      --text: #d8d8e8; --text-muted: #8888a8; --text-heading: #f0f0ff;
      --accent: #9B3DBE; --accent-secondary: #3DBEA0; --gold: #FFBA2E;
      --border: #1e1e40; --border-light: #2a2a55;
      font-family: 'Source Sans 3', 'Source Sans Pro', system-ui, -apple-system, sans-serif;
      font-size: 14px; line-height: 1.5; color: var(--text);
      position: fixed; z-index: 2147483646; bottom: 0; right: 0; width: 0; height: 0;
    }

    /* ===== Light theme — soft plum silhouette (mirrors the site's
       [data-theme="light"] remap, as the site does). Applied when
       the host page's background reads as light. ===== */
    .mn-root.mn-light {
      --bg: #f8f6f2; --bg-surface: #ffffff; --bg-elevated: #f0ede8; --bg-hover: #e8e4de;
      --text: #2a2a3a; --text-muted: #6a6a80; --text-heading: #1a1a2e;
      --accent: #7B2D8E; --accent-secondary: #1A8A6E; --gold: #b07800;
      --border: #d8d4ce; --border-light: #c8c4be;
    }
    .mn-light .mn-sprite { --sp-f1:#E4DAF2;--sp-f2:#CDBFE3;--sp-f3:#B9A8D6;--sp-f4:#B6A4D3;--sp-f5:#BFAFDA;--sp-f6:#D6CAEB;--sp-f7:#EEE7F8;--sp-base:#CDBFE3;--sp-edge:#7A6598;--sp-rim:#7A6598;--sp-rim-o:0.75;--sp-glint-o:0.95;--sp-foot:#A893C9;--sp-foot-top:#E4DAF2;--sp-mouth:#7A6598;--sp-mouth-open:#6A4E88;--sp-mouth-open-stroke:#7A6598;--sp-lid:#7A6598;--sp-outline:#7A6598;--sp-outline-o:0.85;--sp-sheen-o:0.55;--sp-sparkle:#9B7FC8; --sp-sheen-fill: url(#mn-sheen); --mn-ground: rgba(90,60,130,0.24); }
    .mn-light .mn-chat { box-shadow: 0 12px 40px rgba(60,50,90,0.22); }
    .mn-sprite {
      position: fixed; bottom: 20px; right: 20px; width: 64px; height: 75px;
      cursor: pointer; user-select: none; -webkit-user-select: none;
      transition: transform 0.35s cubic-bezier(0.3, 0.7, 0.4, 1);
      --mn-ground: rgba(0,0,0,0.55);
    }
    /* Ground shadow under the feet, as on the site */
    .mn-sprite::before {
      content: ""; position: absolute; left: 16%; width: 68%; height: 7px; bottom: calc(7.5% - 3.5px);
      border-radius: 50%; background: radial-gradient(closest-side, var(--mn-ground), transparent);
      transition: opacity 0.25s ease, transform 0.25s ease; pointer-events: none;
    }
    .mn-sprite svg { width: 100%; height: 100%; display: block; overflow: visible; position: relative; }
    @media (hover: hover) {
      .mn-sprite:hover { transform: translateY(-3px) scale(1.06); }
      .mn-sprite:hover::before { transform: scale(0.86); opacity: 0.75; }
    }

    /* Breathing: body and face together, up from the base; the feet stay planted */
    .mn-sprite .sprite-figure { transform-origin: 24px 44px; animation: mn-breathe 3.6s ease-in-out infinite; }
    @keyframes mn-breathe { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.018,1.032); } }
    @keyframes mn-breathe-fast { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.025,1.045); } }
    /* Sheen: a slow drift of the rainbow band */
    .mn-sprite .shimmer-layer { animation: mn-sheen 9s ease-in-out infinite alternate; }
    @keyframes mn-sheen { 0% { transform: translate(-2.5px,-2.5px); } 100% { transform: translate(2.5px,2.5px); } }
    .mn-sprite .eye-glow-left, .mn-sprite .eye-glow-right { animation: mn-eye-aura 3s ease-in-out infinite; }
    @keyframes mn-eye-aura { 0%,100% { opacity: 0.5; } 50% { opacity: 0.8; } }
    .mn-sprite .foot-left { animation: mn-foot-l 2.5s ease-in-out infinite; }
    .mn-sprite .foot-right { animation: mn-foot-r 2.5s ease-in-out infinite 0.3s; }
    @keyframes mn-foot-l { 0%,100% { transform: translateY(0); } 50% { transform: translate(-0.4px,-0.6px); } }
    @keyframes mn-foot-r { 0%,100% { transform: translateY(0); } 50% { transform: translate(0.4px,-0.6px); } }

    /* Blink: the lid closes over the eye (not a crescent over an open eye) */
    .mn-sprite .sprite-eyelids path { opacity: 0; }
    .mn-sprite .mouth-open { opacity: 0; transition: opacity 0.2s ease; }
    .mn-sprite .mouth-closed { transition: opacity 0.2s ease; }
    .mn-sprite.standing .sprite-eyes, .mn-sprite.standing .sprite-eye-outline {
      transform-origin: 24px 22px; animation: mn-blink 6.5s ease-in-out infinite;
    }
    .mn-sprite.standing .sprite-eyelids path { animation: mn-lid 6.5s ease-in-out infinite; }
    @keyframes mn-blink { 0%,94%,99%,100% { transform: scaleY(1); } 96%,97% { transform: scaleY(0.08); } }
    @keyframes mn-lid { 0%,95%,98.5%,100% { opacity: 0; } 96%,97% { opacity: 1; } }

    /* Absorbing: faster breath, sheen brightens, mouth opens */
    .mn-sprite.absorbing .sprite-figure { animation: mn-breathe-fast 1.5s ease-in-out infinite; }
    .mn-sprite.absorbing .shimmer-layer { opacity: var(--sp-sheen-o, 0.6) !important; animation-duration: 2s; }
    .mn-sprite.absorbing .mouth-closed { opacity: 0; }
    .mn-sprite.absorbing .mouth-open { opacity: 1; }
    .mn-sprite.absorbing .eye-left, .mn-sprite.absorbing .eye-right { fill: #A67DC8; }
    .mn-sprite.absorbing .pupil-left, .mn-sprite.absorbing .pupil-right { fill: #1A0E4E; }

    /* Thinking: the sheen slows and the eye glow deepens while Lodestone streams */
    .mn-sprite.thinking .shimmer-layer { animation-duration: 18s; }
    .mn-sprite.thinking .eye-glow-left, .mn-sprite.thinking .eye-glow-right { animation-duration: 6s; }

    @media (prefers-reduced-motion: reduce) {
      .mn-sprite .sprite-figure, .mn-sprite .shimmer-layer, .mn-sprite .eye-glow-left, .mn-sprite .eye-glow-right,
      .mn-sprite .foot-left, .mn-sprite .foot-right, .mn-sprite .sprite-eyes, .mn-sprite .sprite-eye-outline,
      .mn-sprite .sprite-eyelids path { animation: none !important; }
    }

    .mn-dismiss {
      position: fixed; bottom: 88px; right: 16px; width: 20px; height: 20px;
      border-radius: 50%; border: 1px solid var(--border-light); background: var(--bg-surface);
      color: var(--text-muted); font-size: 12px; line-height: 1; cursor: pointer;
      display: none; align-items: center; justify-content: center; padding: 0;
    }
    .mn-sprite-wrap:hover .mn-dismiss { display: flex; }
    .mn-dismiss:hover { color: var(--text-heading); background: var(--bg-hover); }

    /* ===== Chat panel ===== */
    .mn-chat {
      position: fixed; bottom: 104px; right: 20px; width: 384px; max-width: calc(100vw - 32px);
      max-height: min(600px, calc(100vh - 130px));
      display: none; flex-direction: column;
      background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: 14px;
      box-shadow: 0 12px 40px rgba(5,5,15,0.6);
      overflow: hidden;
    }
    .mn-chat.open { display: flex; }
    .mn-chat-header {
      display: flex; align-items: center; gap: 8px; padding: 10px 14px;
      border-bottom: 1px solid var(--border); background: var(--bg-elevated);
    }
    .mn-chat-title {
      font-family: 'Cormorant Garamond', Georgia, serif; font-size: 17px; font-weight: 600;
      color: var(--text-heading); flex: 1;
    }
    .mn-chat-sub { font-size: 11px; color: var(--text-muted); }
    .mn-chat-close {
      background: none; border: none; color: var(--text-muted); font-size: 18px;
      cursor: pointer; padding: 2px 6px; line-height: 1;
    }
    .mn-chat-close:hover { color: var(--text-heading); }
    .mn-chat-readings {
      background: none; border: 1px solid var(--border-light); color: var(--text-muted); font-size: 11px;
      cursor: pointer; padding: 2px 8px; border-radius: 10px; font-family: inherit;
    }
    .mn-chat-readings:hover { color: var(--text-heading); border-color: var(--accent); }
    .mn-messages {
      flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px;
      min-height: 200px; scrollbar-width: thin; scrollbar-color: var(--border-light) transparent;
    }
    .mn-msg { max-width: 88%; padding: 9px 12px; border-radius: 12px; white-space: normal; word-wrap: break-word; }
    .mn-msg-user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
    .mn-msg-companion { align-self: flex-start; background: var(--bg-elevated); color: var(--text); border-bottom-left-radius: 4px; }
    .mn-msg-companion a { color: var(--gold); text-decoration: none; }
    .mn-msg-companion a:hover { text-decoration: underline; }
    .mn-msg-companion.streaming::after { content: "▍"; opacity: 0.6; animation: mn-cursor 1s step-end infinite; }
    @keyframes mn-cursor { 50% { opacity: 0; } }
    .mn-msg-error { align-self: center; background: transparent; color: var(--text-muted); font-size: 12px; font-style: italic; }

    /* Quick actions */
    .mn-quick { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; }
    .mn-quick button {
      background: var(--bg-elevated); border: 1px solid var(--border-light); color: var(--text);
      border-radius: 20px; padding: 5px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
    }
    .mn-quick button:hover { background: var(--bg-hover); border-color: var(--accent); }
    .mn-quick button.mn-absorb-btn { border-color: var(--accent); color: var(--text-heading); }
    .mn-quick button.mn-absorb-btn::before { content: "✸ "; color: var(--gold); }

    .mn-input-row { display: flex; gap: 8px; padding: 10px 14px 12px; border-top: 1px solid var(--border); }
    .mn-input {
      flex: 1; background: var(--bg); border: 1px solid var(--border-light); border-radius: 10px;
      color: var(--text); padding: 8px 12px; font-family: inherit; font-size: 14px; resize: none;
      max-height: 96px; min-height: 38px; outline: none;
    }
    .mn-input:focus { border-color: var(--accent); }
    .mn-send {
      background: var(--accent); border: none; color: #fff; border-radius: 10px;
      padding: 0 16px; font-family: inherit; font-size: 14px; cursor: pointer; align-self: stretch;
    }
    .mn-send:disabled { opacity: 0.45; cursor: default; }
    .mn-send:not(:disabled):hover { filter: brightness(1.15); }

    /* Consent card */
    .mn-consent { align-self: stretch; max-width: 100%; background: var(--bg-elevated); border: 1px solid var(--border-light); border-radius: 12px; padding: 12px; }
    .mn-consent-header { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 15px; color: var(--text-heading); margin-bottom: 6px; }
    .mn-consent-text { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }
    .mn-consent a { color: var(--gold); }
    .mn-consent-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .mn-consent-actions button, .mn-consent-actions a.mn-btn {
      background: var(--accent); border: none; color: #fff; border-radius: 8px; padding: 6px 12px;
      font-size: 12px; cursor: pointer; text-decoration: none; font-family: inherit; display: inline-block;
    }
    .mn-consent-actions .mn-btn-ghost { background: transparent; border: 1px solid var(--border-light); color: var(--text); }

    @media (max-width: 480px) {
      .mn-chat { width: calc(100vw - 24px); right: 12px; bottom: 96px; }
      .mn-sprite { width: 52px; height: 61px; bottom: 16px; right: 16px; }
    }
  `;

  // ===== Theme detection =====
  // The site reads its own data-theme attribute; out on the open web the
  // signal is the page's effective background. Walk body → html for the
  // first non-transparent background color and read its luminance;
  // fall back to prefers-color-scheme when both are transparent.
  function detectLightTheme() {
    const parse = (c) => {
      const m = c && c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
      if (!m) return null;
      const a = m[4] === undefined ? 1 : parseFloat(m[4]);
      return a < 0.1 ? null : [+m[1], +m[2], +m[3]];
    };
    try {
      for (const el of [document.body, document.documentElement]) {
        if (!el) continue;
        const rgb = parse(getComputedStyle(el).backgroundColor);
        if (rgb) {
          const [r, g, b] = rgb.map((v) => v / 255);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
        }
      }
    } catch (e) {}
    return !(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function applyTheme() {
    if (ui.wrap) ui.wrap.classList.toggle("mn-light", detectLightTheme());
  }

  // ===== Build UI =====
  function buildUI() {
    if (host) return;
    host = document.createElement("div");
    host.id = "lodestone-extension-host";
    root = host.attachShadow({ mode: "closed" });

    const wrap = document.createElement("div");
    wrap.className = "mn-root";
    const styleEl = document.createElement("style");
    styleEl.textContent = STYLES;
    setHtml(wrap,
      '<div class="mn-sprite-wrap">' +
      '<div class="mn-sprite standing" role="button" tabindex="0" aria-label="Lodestone" title="Lodestone">' + SPRITE_SVG + "</div>" +
      '<button class="mn-dismiss" aria-label="Dismiss Lodestone from this page" title="Dismiss Lodestone from this page">&times;</button>' +
      "</div>" +
      '<div class="mn-chat" role="dialog" aria-label="Lodestone chat">' +
      '<div class="mn-chat-header">' +
      '<div class="mn-chat-title">Lodestone</div>' +
      '<div class="mn-chat-sub"></div>' +
      '<button class="mn-chat-readings" title="Every page Lodestone has read with you, with its address">All readings</button>' +
      '<button class="mn-chat-readings mn-chat-options" title="Sign in to harmonism.io, add your OpenRouter key, and other settings">' + (memory ? "Settings" : "Sign in") + '</button>' +
      '<button class="mn-chat-close" aria-label="Close">&times;</button>' +
      "</div>" +
      '<div class="mn-messages"></div>' +
      '<div class="mn-quick">' +
      '<button class="mn-absorb-btn" data-action="absorb">Absorb this page</button>' +
      '<button data-action="summary">Summary</button>' +
      '<button data-action="harmonist">Harmonist reading</button>' +
      "</div>" +
      '<div class="mn-input-row">' +
      '<textarea class="mn-input" rows="1" placeholder="Speak with Lodestone…"></textarea>' +
      '<button class="mn-send">Send</button>' +
      "</div>" +
      "</div>");
    wrap.prepend(styleEl);
    root.appendChild(wrap);
    document.documentElement.appendChild(host);

    ui.wrap = wrap;
    ui.sprite = root.querySelector(".mn-sprite");
    ui.dismiss = root.querySelector(".mn-dismiss");
    ui.chat = root.querySelector(".mn-chat");
    ui.sub = root.querySelector(".mn-chat-sub");
    ui.messages = root.querySelector(".mn-messages");
    // Scrolling up while Lodestone writes leaves the reader where they are; back at the bottom, it follows again.
    ui.messages.addEventListener("scroll", () => {
      if (ownScroll) { ownScroll = false; return; }
      follow = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 24;
    }, { passive: true });
    ui.messages.addEventListener("wheel", (e) => { if (e.deltaY < 0) follow = false; }, { passive: true });
    ui.quick = root.querySelector(".mn-quick");
    ui.input = root.querySelector(".mn-input");
    ui.send = root.querySelector(".mn-send");

    ui.sub.textContent = memory && !anonymousFallback ? "your memory" : "anonymous";

    ui.sprite.addEventListener("click", toggleChat);
    ui.sprite.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleChat(); } });
    root.querySelector(".mn-chat-close").addEventListener("click", toggleChat);
    root.querySelector(".mn-chat-readings").addEventListener("click", () => { try { chrome.runtime.sendMessage({ type: "lodestone-open-readings" }); } catch (e) {} });
    ui.options = root.querySelector(".mn-chat-options");
    ui.options.addEventListener("click", () => { try { chrome.runtime.sendMessage({ type: "lodestone-open-options" }); } catch (e) {} });
    ui.dismiss.addEventListener("click", (e) => { e.stopPropagation(); removeUI(); });

    ui.quick.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || streaming) return;
      const action = btn.getAttribute("data-action");
      if (action === "absorb") return doAbsorb();
      if (action === "summary") return sendMessage("Summarize this page for me — its core claims and structure.");
      if (action === "harmonist") return sendMessage("Give me the Harmonist reading of this page — where it stands relative to the doctrine, to the Way of Harmony, and to the Architecture of Harmony.");
    });

    ui.send.addEventListener("click", () => submitInput());
    ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitInput(); }
      e.stopPropagation(); // don't leak keystrokes to page shortcuts
    });
    ui.input.addEventListener("input", () => {
      ui.input.style.height = "auto";
      ui.input.style.height = Math.min(ui.input.scrollHeight, 96) + "px";
    });

    // Restore prior session messages
    for (const m of messages) addBubble(m.role === "assistant" ? "companion" : m.role, m.content);

    applyTheme();
  }

  function toggleChat() {
    chatOpen = !chatOpen;
    ui.chat.classList.toggle("open", chatOpen);
    if (chatOpen) { applyTheme(); ui.input.focus(); scrollBottom(true); }
  }

  function removeUI() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    chatOpen = false;
  }

  // `follow`: whether the view keeps up with the text being written. It stops the
  // moment the reader scrolls up, and starts again when they return to the bottom
  // or send a new message (force).
  function scrollBottom(force) {
    if (!ui.messages) return;
    if (force) follow = true;
    if (!follow) return;
    const target = ui.messages.scrollHeight - ui.messages.clientHeight;
    if (Math.abs(ui.messages.scrollTop - target) < 1) return;
    ownScroll = true;
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function addBubble(role, content, streamingFlag) {
    const div = document.createElement("div");
    div.className = "mn-msg mn-msg-" + role + (streamingFlag ? " streaming" : "");
    if (role === "companion") setHtml(div, renderMd(content));
    else div.textContent = content;
    ui.messages.appendChild(div);
    scrollBottom(true);
    return div;
  }

  function addError(text) {
    const div = document.createElement("div");
    div.className = "mn-msg mn-msg-error";
    div.textContent = text;
    ui.messages.appendChild(div);
    scrollBottom(true);
  }

  function setSpriteState(state) {
    ui.sprite.classList.remove("standing", "absorbing", "thinking");
    ui.sprite.classList.add(state);
  }

  // ===== Actions =====
  function doAbsorb() {
    if (!chatOpen) toggleChat();
    absorbed = true;
    setSpriteState("absorbing");
    sendMessage(
      "Absorb this page. Give me its essence: a compact summary of what it actually says, then the Harmonist analysis — " +
      "how its claims sit against the doctrine, which pillar of the Wheel it touches, and what a practitioner should take or leave.",
      true
    );
  }

  function submitInput() {
    const text = ui.input.value.trim();
    if (!text || streaming) return;
    ui.input.value = "";
    ui.input.style.height = "auto";
    sendMessage(text);
  }

  // ===== Anonymous lifetime gate =====
  function isAnonymousSend() {
    return !(memory && !anonymousFallback);
  }

  function renderLifetimeGate() {
    const card = document.createElement("div");
    card.className = "mn-consent";
    setHtml(card,
      '<div class="mn-consent-header">Lodestone has walked ' + ANON_LIFETIME_LIMIT + " steps with you</div>" +
      '<div class="mn-consent-text">The anonymous path ends here. A free harmonism.io account continues it — ten messages a day for a month, then five a day, with your own Lodestone memory. ' +
      "Have an account? Sign in under the extension options. For Lodestone without a daily limit, run the free Lodestone app with your own model or key.</div>");
    const actions = document.createElement("div");
    actions.className = "mn-consent-actions";
    const reg = document.createElement("a");
    reg.className = "mn-btn";
    reg.href = "https://harmonism.io/member/register.php";
    reg.target = "_blank"; reg.rel = "noopener";
    reg.textContent = "Create a free account";
    const opts = document.createElement("button");
    opts.className = "mn-btn-ghost";
    opts.textContent = "Sign in (options)";
    opts.addEventListener("click", () => { try { chrome.runtime.sendMessage({ type: "lodestone-open-options" }); } catch (e) {} });
    actions.appendChild(reg);
    actions.appendChild(opts);
    card.appendChild(actions);
    ui.messages.appendChild(card);
    scrollBottom(true);
  }

  function maybeNudge() {
    if (nudgeShown || anonCount < ANON_NUDGE_AT || anonCount >= ANON_LIFETIME_LIMIT) return;
    nudgeShown = true;
    const div = document.createElement("div");
    div.className = "mn-msg mn-msg-error";
    div.textContent = "Step " + anonCount + " of " + ANON_LIFETIME_LIMIT + " on the anonymous path — a free account gives Lodestone ten messages a day for a month, then five a day.";
    ui.messages.appendChild(div);
    scrollBottom(true);
  }

  function sendMessage(text, isAbsorb) {
    if (streaming) return;
    if (isAnonymousSend() && !byok && anonCount >= ANON_LIFETIME_LIMIT) {
      if (!chatOpen) toggleChat();
      renderLifetimeGate();
      setSpriteState("standing");
      return;
    }
    streaming = true;
    ui.send.disabled = true;
    if (!isAbsorb) setSpriteState("thinking");

    if (isAnonymousSend() && !byok) {
      anonCount++;
      try { chrome.storage.local.set({ anonCount: anonCount }); } catch (e) {}
    }

    messages.push({ role: "user", content: text });
    saveSession();
    addBubble("user", text);
    const bubble = addBubble("companion", "", true);
    let full = "";

    let port;
    try {
      port = chrome.runtime.connect({ name: "lodestone" });
    } catch (e) {
      finalize("Lodestone cannot reach Harmonia right now — try reloading the page.");
      return;
    }

    function finalize(errText) {
      streaming = false;
      ui.send.disabled = false;
      setSpriteState("standing");
      bubble.classList.remove("streaming");
      if (errText) {
        bubble.remove();
        addError(errText);
      } else if (full) {
        messages.push({ role: "assistant", content: full });
        saveSession();
        if (isAnonymousSend() && !byok) maybeNudge();
      } else {
        bubble.textContent = "Lodestone is resting. Try again shortly.";
      }
      try { port.disconnect(); } catch (e) {}
    }

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "delta") {
        full += msg.text;
        setHtml(bubble, renderMd(full));
        scrollBottom(false);
      } else if (msg.type === "done") {
        finalize(null);
      } else if (msg.type === "json") {
        const data = msg.data || {};
        if (data.consent_required) {
          bubble.remove();
          renderConsentGate(data, text);
          streaming = false;
          ui.send.disabled = false;
          setSpriteState("standing");
          try { port.disconnect(); } catch (e) {}
        } else if (data.rate_limit_hit && data.message) {
          // The daily allowance used: said as Lodestone's own reply, with the way past it (October 24, 2026).
          full = String(data.message);
          setHtml(bubble, renderMd(full));
          streaming = false; ui.send.disabled = false; setSpriteState("standing");
          bubble.classList.remove("streaming");
          try { port.disconnect(); } catch (e) {}
        } else {
          // Other refusals come with the server's own words.
          finalize(data.error || data.message || "Lodestone is resting. Try again shortly.");
        }
      } else if (msg.type === "error") {
        finalize("Connection failed: " + msg.error);
      }
    });

    port.onDisconnect.addListener(() => {
      if (streaming) finalize(full ? null : "Connection to Lodestone was interrupted.");
    });

    port.postMessage({ type: "chat", payload: buildPayload() });
  }

  // Memory requires the explicit Art. 9 consent, recorded on the member's
  // harmonism.io account. Signed in through the options page, the
  // extension records it itself and sends the message again — or the person
  // continues anonymously for this browsing session.
  function renderConsentGate(data, pendingText) {
    const card = document.createElement("div");
    card.className = "mn-consent";
    const textDiv = document.createElement("div");
    textDiv.className = "mn-consent-text";
    // consent_text arrives from harmonism.io with embedded ToS anchor tags.
    // Render as plain text (tags stripped) — no remote HTML is ever injected —
    // and append our own fixed links instead.
    const stripped = String(data.consent_text || "Memory requires explicit consent, recorded on harmonism.io.")
      .replace(/<[^>]*>/g, "");
    textDiv.textContent = stripped;
    const legal = document.createElement("div");
    legal.className = "mn-consent-text";
    const terms = document.createElement("a");
    terms.href = "https://harmonism.io/terms"; terms.target = "_blank"; terms.rel = "noopener"; terms.textContent = "Terms of Service";
    const priv = document.createElement("a");
    priv.href = "https://harmonism.io/privacy"; priv.target = "_blank"; priv.rel = "noopener"; priv.textContent = "Privacy Policy";
    legal.append(terms, " · ", priv);
    const header = document.createElement("div");
    header.className = "mn-consent-header";
    header.textContent = "Memory needs your consent";
    card.appendChild(header);
    card.appendChild(textDiv);
    card.appendChild(legal);
    const actions = document.createElement("div");
    actions.className = "mn-consent-actions";
    const link = document.createElement("button");
    link.className = "mn-btn";
    link.textContent = "I consent — continue";
    link.addEventListener("click", () => {
      link.disabled = true;
      chrome.runtime.sendMessage({ type: "lodestone-consent", version: data.consent_version }, (r) => {
        void chrome.runtime.lastError;
        if (!r || !r.ok) { link.disabled = false; link.textContent = "Could not record it — try again"; return; }
        card.remove();
        const last = messages[messages.length - 1];
        if (last && last.role === "user" && last.content === pendingText) messages.pop();
        const bubbles = ui.messages.querySelectorAll(".mn-msg-user");
        if (bubbles.length) bubbles[bubbles.length - 1].remove();
        sendMessage(pendingText);
      });
    });
    const ghost = document.createElement("button");
    ghost.className = "mn-btn-ghost";
    ghost.textContent = "Continue without memory";
    ghost.addEventListener("click", () => {
      anonymousFallback = true;
      ui.sub.textContent = "anonymous";
      card.remove();
      // Retry the same message anonymously — pull it back off the history
      // first so it isn't doubled.
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && last.content === pendingText) messages.pop();
      // Remove the rendered user bubble for the retried message
      const bubbles = ui.messages.querySelectorAll(".mn-msg-user");
      if (bubbles.length) bubbles[bubbles.length - 1].remove();
      sendMessage(pendingText);
    });
    actions.appendChild(link);
    actions.appendChild(ghost);
    card.appendChild(actions);
    ui.messages.appendChild(card);
    scrollBottom(true);
  }

  // ===== Selection → Lodestone (context menu, relayed by background) =====
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "lodestone-selection") return;
    const sel = String(msg.text || "").trim().slice(0, 1500);
    if (!sel) return;
    if (!host) buildUI();
    if (!chatOpen) toggleChat();
    if (streaming) return;
    sendMessage(
      'On this passage from the page:\n\n"' + sel + '"\n\n' +
      "Give me the Harmonist reading of this specific claim — what it gets right, and where it stands relative to the doctrine, to the Way of Harmony, and to the Architecture of Harmony."
    );
  });

  // ===== Called to the page by the worker (toolbar button) =====
  // A second click dismisses Lodestone from the page; the conversation stays
  // with the tab (the worker keeps it) and returns the next time.
  let ready = false;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "lodestone-ping") { sendResponse({ ready }); return; }
    if (msg.type !== "lodestone-toggle" && msg.type !== "lodestone-open") return;
    if (host && msg.type === "lodestone-toggle") removeUI();
    else { buildUI(); if (!chatOpen) toggleChat(); }
    sendResponse({ ok: true });
  });

  // ===== Init: the practitioner has just called Lodestone here =====
  chrome.storage.local.get({ anonCount: 0 }, (data) => {
    anonCount = data.anonCount || 0;
    nudgeShown = anonCount >= ANON_NUDGE_AT; // don't re-nudge every page
  });
  chrome.storage.sync.get(DEFAULTS, (data) => {
    settings = Object.assign({}, DEFAULTS, data);
    loadSession().then((arr) => {
      messages = arr;
      refreshMemory(() => { buildUI(); ready = true; });
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["munai-session"]) { refreshMemory(); return; }
    if (area === "sync" && changes.memoryLinked) refreshMemory();
  });
})();
