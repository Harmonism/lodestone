/**
 * Lodestone Extension — Background Service Worker (2.0)
 *
 * Owns all network traffic to harmonism.io. Content scripts run in the
 * page's origin, so they cannot call companion-api.php directly (CORS
 * allowlist is harmonism.io-only). The service worker fetches with
 * host_permissions, which exempts it from CORS entirely, and relays the
 * SSE stream to the content script over a long-lived Port.
 *
 * Since 2.0 the extension is a device of the practitioner's
 * Lodestone memory: signed in to their harmonism.io account (options page), it
 * keeps that memory in its own storage, encrypted copies carried by Lodestone
 * sync, and each turn goes out through held.js — the module website Lodestone
 * uses — which sends the memory along, keeps the reply in it (one
 * conversation per page read) and syncs. harmonism.io keeps none of it.
 * Not signed in, a turn is anonymous and kept nowhere, as before.
 *
 * The modules in lib/ are copied from lodestone/app/js by build.sh, never edited here.
 *
 * Port protocol (name: "lodestone"):
 *   content → bg : { type: "chat", payload: {...} }           start a request
 *   bg → content : { type: "delta", text }                    streamed text chunk
 *                  { type: "json",  data }                    JSON envelope (consent gate, errors, rate limit)
 *                  { type: "done",  full }                    stream complete
 *                  { type: "error", error }                   transport failure
 * Messages:
 *   { type: "lodestone-status" }   → { signedIn, email, synced }
 *   { type: "lodestone-consent" }  → records the Art. 9 consent on the account
 *   { type: "lodestone-readings", op: "list" | "forget", id }  → the Readings page (2.1)
 *   { type: "lodestone-open-readings" }  → opens it in a tab
 */

import { ready as sessionReady, store as sessionStore } from "./session-store.js";
import { setSessionStore, hosted } from "./lib/phone.js";
import * as held from "./lib/held.js";
import * as store from "./lib/store.js";

setSessionStore(sessionStore);
held.configure({ base: "https://harmonism.io" });

const SITE = "https://harmonism.io";
const API_URL = SITE + "/companion-api.php";

// ===== Context menu: Selection → Lodestone =====
function setupContextMenu() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "lodestone-selection",
      title: 'Ask Lodestone about "%s"',
      contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
    chrome.contextMenus.create({ id: "lodestone-readings", title: "All readings", contexts: ["action"] });
    chrome.contextMenus.create({ id: "lodestone-options", title: "Sign in, key and settings", contexts: ["action"] });
  });
}
chrome.runtime.onInstalled.addListener((details) => {
  setupContextMenu();
  // First install: the options page is where sign-in and the key live, so show it once.
  if (details && details.reason === "install") chrome.runtime.openOptionsPage();
});
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(setupContextMenu);

// ===== Lodestone is called to a page, never present by default (2.0) =====
// The sprite runs only where the practitioner calls it: the toolbar button or
// the right-click item grants activeTab for that tab, and the worker injects
// content.js then. Not on harmonism.io, which carries its own sprite.
const OWN_SITES = /^https?:\/\/(www\.)?(harmonism\.io|integralharmonysystem\.com)(\/|$)/;
const pingTab = (tabId) => chrome.tabs.sendMessage(tabId, { type: "lodestone-ping" }).then((r) => r || null, () => null);

async function ensureOnPage(tab) {
  if (!tab || tab.id == null || !/^https?:/.test(tab.url || "") || OWN_SITES.test(tab.url)) return false;
  if (await pingTab(tab.id)) return "present";
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); }
  catch (e) { return false; }
  for (let i = 0; i < 40; i++) {           // until the sprite has its conversation and memory
    const r = await pingTab(tab.id);
    if (r && r.ready) return "injected";
    await new Promise((res) => setTimeout(res, 50));
  }
  return "injected";
}

// Where Lodestone cannot be called (the browser's own pages, its extension store,
// a local file, harmonism.io with its own sprite), the click used to do nothing
// at all. It now says so on the button itself for a few seconds.
const TITLE = "Lodestone — call Lodestone to this page";
function cannotHere(tab) {
  const u = tab?.url || "";
  const why = OWN_SITES.test(u) ? "harmonism.io has its own Lodestone, in the corner of the page."
    : /^https?:/.test(u) ? "This page does not let extensions in (the browser's extension store, or a protected page)."
    : "Browsers keep extensions out of their own pages (settings, new tab, extensions). Open a website and click again.";
  if (tab?.id == null) return;
  chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#9B3DBE" }).catch(() => {});
  chrome.action.setBadgeText({ tabId: tab.id, text: "–" }).catch(() => {});
  chrome.action.setTitle({ tabId: tab.id, title: `Lodestone cannot open here. ${why}` }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
    chrome.action.setTitle({ tabId: tab.id, title: TITLE }).catch(() => {});
  }, 6000);
}

async function openOnTab(tab) {
  const r = await ensureOnPage(tab);
  // Just injected: open it. Already there: the click toggles it.
  if (r) chrome.tabs.sendMessage(tab.id, { type: r === "injected" ? "lodestone-open" : "lodestone-toggle" }).catch(() => {});
  else cannotHere(tab);
}
chrome.action.onClicked.addListener(openOnTab);

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "lodestone-readings") return openReadings();
    if (info.menuItemId === "lodestone-options") return chrome.runtime.openOptionsPage();
    if (info.menuItemId !== "lodestone-selection" || !tab || !tab.id) return;
    if (!(await ensureOnPage(tab))) return;
    chrome.tabs.sendMessage(tab.id, { type: "lodestone-selection", text: info.selectionText || "" }).catch(() => {});
  });
}

// ===== Readings (2.1) =====
// Every page Lodestone was asked about, for the Readings page. Signed in, the
// readings are the memory's own page conversations (threads "ext-…", one per
// page, synced like the rest). Anonymous, a turn is kept only on this browser,
// in chrome.storage.local, unless the practitioner switches that off on the
// Readings page; it never leaves the browser.
const ANON_KEY = "readings-anon", ANON_ON = "readings-anon-keep", ANON_CAP = 300;
const openReadings = () => chrome.tabs.create({ url: chrome.runtime.getURL("readings.html") });

/** What kind of turn a question was, from the panel's own prompts. */
function readingKind(q) {
  const t = String(q || "");
  if (t.startsWith("Give me the Harmonist reading of this page")) return "harmonist";
  if (t.startsWith("On this passage from the page:")) return "passage";
  if (t.startsWith("Absorb this page.")) return "absorb";
  if (t.startsWith("Summarize this page")) return "summary";
  return "question";
}

async function keepAnonymous(payload, full) {
  try {
    const o = await chrome.storage.local.get({ [ANON_ON]: true, [ANON_KEY]: [] });
    if (!o[ANON_ON] || !full) return;
    const user = [...(payload.messages || [])].reverse().find((m) => m.role === "user");
    const q = String((user && user.content) || "");
    const list = Array.isArray(o[ANON_KEY]) ? o[ANON_KEY] : [];
    list.push({ id: "anon-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), url: String(payload.pageUrl || "").slice(0, 500), title: String(payload.pageTitle || payload.pageDomain || "").slice(0, 200), q: q.slice(0, 12000), a: String(full).slice(0, 20000), kind: readingKind(q) });
    await chrome.storage.local.set({ [ANON_KEY]: list.slice(-ANON_CAP) });
  } catch (e) { /* the reading is shown on the page either way */ }
}

/** The memory's page conversations, newest first, each with its exchanges. */
async function memoryReadings() {
  await sessionReady();
  if (!(await hosted.account().catch(() => null))) return { signedIn: false, items: [] };
  await held.bind();
  const items = [];
  for (const t of await store.threads.list()) {
    if (t.source !== "extension" && !String(t.id).startsWith("ext-")) continue;
    const msgs = await store.messages.forThread(t.id);
    const url = (msgs.find((m) => m.meta && m.meta.url) || {}).meta?.url || "";
    const turns = msgs.map((m) => ({ role: m.role, content: String(m.content || ""), ts: m.ts }));
    const first = turns.find((m) => m.role === "user");
    items.push({ id: t.id, title: t.title || "", url, created: t.created, updated: t.updated, turns, kind: readingKind(first && first.content), kinds: [...new Set(turns.filter((m) => m.role === "user").map((m) => readingKind(m.content)))] });
  }
  return { signedIn: true, items };
}

async function readingsOp(msg) {
  if (msg.op === "list") {
    const mem = await memoryReadings().catch((e) => ({ signedIn: false, items: [], error: String(e.message || e) }));
    const o = await chrome.storage.local.get({ [ANON_ON]: true, [ANON_KEY]: [] });
    return { ...mem, anonymous: o[ANON_KEY] || [], keepAnonymous: o[ANON_ON] };
  }
  if (msg.op === "forget") {
    const id = String(msg.id || "");
    if (id.startsWith("anon-")) {
      const o = await chrome.storage.local.get({ [ANON_KEY]: [] });
      await chrome.storage.local.set({ [ANON_KEY]: (o[ANON_KEY] || []).filter((r) => r.id !== id) });
      return { ok: true };
    }
    if (!id.startsWith("ext-")) return { ok: false, error: "Not a page reading." };
    await sessionReady(); await held.bind();
    const t = await store.threads.get(id);
    if (!t || (t.source !== "extension" && !id.startsWith("ext-"))) return { ok: false, error: "Not found." };
    await store.threads.remove(id);
    held.syncSoon();
    return { ok: true };
  }
  if (msg.op === "forget-anonymous") { await chrome.storage.local.set({ [ANON_KEY]: [] }); return { ok: true }; }
  if (msg.op === "keep-anonymous") {
    await chrome.storage.local.set({ [ANON_ON]: !!msg.on });
    return { ok: true };
  }
  return { ok: false, error: "Unknown request." };
}

// ===== Status, consent, options =====
// ===== A tab's conversation, kept out of the page's reach =====
// Keyed by tab and site, in the extension's session storage: not readable by
// pages, cleared when the tab closes or the browser quits.
const histKey = (sender) => {
  let origin = "";
  try { origin = new URL(sender.url || (sender.tab && sender.tab.url) || "").origin; } catch (e) {}
  return "hist:" + sender.tab.id + ":" + origin;
};
if (chrome.tabs && chrome.tabs.onRemoved && chrome.storage.session) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.get(null).then((all) => {
      const gone = Object.keys(all).filter((k) => k.startsWith("hist:" + tabId + ":"));
      if (gone.length) chrome.storage.session.remove(gone);
    }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && (msg.type === "lodestone-tab-history-get" || msg.type === "lodestone-tab-history-set")) {
    if (!sender.tab || sender.tab.id == null || !chrome.storage.session) { sendResponse({ messages: [] }); return; }
    const key = histKey(sender);
    if (msg.type === "lodestone-tab-history-get") {
      chrome.storage.session.get(key).then((r) => sendResponse({ messages: Array.isArray(r[key]) ? r[key] : [] }), () => sendResponse({ messages: [] }));
    } else {
      const list = Array.isArray(msg.messages) ? msg.messages.slice(-20) : [];
      chrome.storage.session.set({ [key]: list }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    }
    return true;
  }
  if (msg && msg.type === "lodestone-open-readings") { openReadings(); sendResponse({ ok: true }); return; }
  // Only the extension's own pages read or change the readings, never a page's content script.
  if (msg && msg.type === "lodestone-readings") {
    if (sender.tab && !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) { sendResponse({ ok: false, error: "Not allowed here." }); return; }
    readingsOp(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg && msg.type === "lodestone-open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "lodestone-status") {
    (async () => {
      await sessionReady();
      const acct = await hosted.account().catch(() => null);
      let synced = false;
      try { await held.bind(); synced = await held.syncer().isOn(); } catch (e) {}
      // byok: a key of the practitioner's own, with the permission to reach OpenRouter (held.js byokReady).
      const byok = await held.byokReady().catch(() => false);
      sendResponse({ signedIn: !!acct, email: acct ? acct.email : null, synced, byok });
    })();
    return true;
  }
  if (msg && msg.type === "lodestone-consent") {
    (async () => {
      try {
        await sessionReady();
        const tok = await hosted.token();
        const r = await fetch(SITE + "/member/companion-consent.php", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
          body: JSON.stringify({ action: "grant", consentVersion: msg.version || "extension-2026-10-18" }),
        });
        const j = await r.json().catch(() => ({}));
        sendResponse({ ok: r.ok && !j.error, error: j.error || null });
      } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
    })();
    return true;
  }
});

// ===== Chat streaming over Port =====
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "lodestone") return;
  let aborter = null;
  let disconnected = false;

  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (aborter) aborter.abort();
  });

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "chat") return;
    aborter = new AbortController();
    streamChat(port, msg.payload, aborter, () => disconnected);
  });
});

/** One conversation per page read: its address without the fragment, hashed. */
async function threadFor(url) {
  const clean = String(url || "").split("#")[0];
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean));
  return "ext-" + Array.from(new Uint8Array(d).slice(0, 9), b => b.toString(16).padStart(2, "0")).join("");
}

async function streamChat(port, payload, aborter, isDisconnected) {
  const post = (m) => {
    if (!isDisconnected()) {
      try { port.postMessage(m); } catch (e) { /* port gone */ }
    }
  };

  try {
    await sessionReady();
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: aborter.signal,
    };
    // held.js passes an anonymous turn through as it came, unless it is answered under the practitioner's own key.
    const resp = payload.anonymous
      ? await held.heldFetch(API_URL, init)
      : await held.heldFetch(API_URL, init, {
          source: "extension",
          threadId: await threadFor(payload.pageUrl),
          title: payload.pageTitle || payload.pageDomain || "A page on the web",
          page: { title: payload.pageTitle || "", url: payload.pageUrl || "" },
        });

    const ct = resp.headers.get("content-type") || "";

    // JSON envelope: consent gate, rate limit (429), server errors.
    if (ct.indexOf("application/json") !== -1) {
      let data = null;
      try { data = await resp.json(); } catch (e) { /* fallthrough */ }
      post({ type: "json", data, status: resp.status });
      return;
    }

    if (!resp.ok || !resp.body) {
      post({ type: "error", error: "HTTP " + resp.status });
      return;
    }

    // SSE stream: parse "data: {...}" lines, forward text deltas.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(jsonStr); } catch (e) { continue; }
        if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
          full += evt.delta.text;
          post({ type: "delta", text: evt.delta.text });
        } else if (evt.type === "error") {
          post({ type: "error", error: (evt.error && evt.error.message) || "API error" });
          return;
        }
      }
    }

    if (payload.anonymous) keepAnonymous(payload, full);
    post({ type: "done", full });
  } catch (e) {
    if (e && e.name === "AbortError") return;
    post({ type: "error", error: String((e && e.message) || e) });
  }
}
