// main.js — the Lodestone web app's controller (in the browser, on a phone, and in Lodestone Desktop's window).
import * as store from "./store.js";
import * as corpusPack from "./corpus.js";
import { Retriever, wantsWhole, isFollowUp } from "./retrieval.js";
import { Embedder } from "./embedder.js";
import { TIERS, MODELS, probeWebGPU, DeviceEngine, ServerEngine, ReaderEngine, isHandheld, isIOS, localInferenceAvailable, defaultModelFor, smallerModelThan } from "./engine.js";
import { HostedEngine, OpenRouterEngine, hosted, secrets, phoneRoutesAvailable, RECOMMENDED, DEFAULT_REMOTE, refreshRecommended, assess, testOpenRouter, accountLinks, signInWithPassword } from "./phone.js";
import * as unlock from "./unlock.js";
import { heldBlock, personContext, buildSystem, fitMessages, estTokens, PILLARS, LEVELS, webBlock, foldersBlock, earlierBlock, fullArticleBlock, stripRetrievalNote, summaryBlock, summaryRequest, renderSummary, summaryPlan } from "./prompt.js";
import { detectLang, detectCrisis, buildCrisisResponse, detectWitness, witnessBlock, governorBlock, crisisLine } from "./safety.js";
import { careCheck } from "./care.js";
import * as presence from "./presence.js";
import { render } from "./md.js";
import { readAttachment, filesBlock, kindOf, speechLanguage, transcribeClip, setSpeechMode, sizeLabel } from "./attach.js";
import { scanMessage, leaveOutMessage, redact, leaveOut } from "./privacygate.js";
import * as speechWeb from "./speechweb.js";
import { CloudSpeaker, providerOf, PROVIDER_LABEL, transcribe as cloudTranscribe, FAMILIES, ROUTE_LABEL, chooseRoute, keyKind, testVoiceKey, orFamilyFor, onVoiceSubstitute, clearPolicyBlocks } from "./voicecloud.js";
import { wikiLookup } from "./wikilookup.js";
import { normUsage } from "./sse.js";
import * as voice from "./voice.js";
import * as learning from "./learning.js";
import * as lifebook from "./lifebook.js";
import * as canon from "./canon.js";
import * as outreach from "./outreach.js";
import { isHPCode, parseHP, decodeHP } from "./hp.js";
import { buildProfile, renderProfile } from "./profileview.js";
import { Sync, SyncError, normCode, merge as syncMerge } from "./sync.js";
import { wire } from "./syncwire.js";
import * as held from "./held.js";
import { isNative, lanFetch, pairWith, pairing, computerServer, parsePairLink, onAppLink } from "./native.js";

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
// The sprite is an inline <symbol> in index.html rather than a fetched file:
// production rewrites .svg requests to .png, so a fetched sprite 404s there.
const sprite = (cls) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  n.setAttribute("class", cls); n.setAttribute("aria-hidden", "true");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "#lodestone-sprite");
  n.append(u); return n;
};
const PILLAR_COLOR = k => `var(--pillar-${k})`;

// ─── Crash guard ─────────────────────────────────────────────────────────────
// iOS Safari kills a tab that exceeds its memory ceiling. The tab reloads, the
// app loads the model again, and the tab dies again — a loop with no way out
// from inside the page. A model load that starts and never finishes is recorded
// here; twice on the same model within five minutes and the app drops to a
// smaller one instead of trying the same thing forever.
const GUARD_KEY = "munai-engine-attempts";
const guard = {
  read() {
    try { return JSON.parse(localStorage.getItem(GUARD_KEY) || "null") || { n: 0, t: 0, model: "" }; }
    catch { return { n: 0, t: 0, model: "" }; }
  },
  start(modelKey) {
    try {
      const g = guard.read();
      const fresh = Date.now() - g.t > 300000 || g.model !== modelKey;
      localStorage.setItem(GUARD_KEY, JSON.stringify({ n: fresh ? 1 : g.n + 1, t: Date.now(), model: modelKey }));
    } catch {}
  },
  clear() { try { localStorage.removeItem(GUARD_KEY); } catch {} },
  tripped(modelKey) {
    const g = guard.read();
    return g.model === modelKey && g.n >= 2 && Date.now() - g.t < 300000;
  },
};

const S = {
  settings: null, gpu: null, pack: null, retriever: null, embedder: null, engine: null,
  engineReady: false, thread: null, history: [], busy: false, profile: {}, wheel: {}, practices: [],
  assessment: null, pending: [], learned: null, reading: null, outreachState: null,
};

// ─── Boot ────────────────────────────────────────────────────────────────────

// ─── Desktop app ─────────────────────────────────────────────────────────────
// Inside the Lodestone desktop app (desktop/), the model runs in an engine
// bundled with the app and is served on this same origin under /v1. There is
// nothing to choose: setup runs by itself and the practitioner lands in the
// conversation. The bridge is exposed by desktop/src/preload.js.
const DESKTOP = window.lodestoneDesktop || window.munaiDesktop || null;   // munaiDesktop: desktop builds before the rename
// Where attachments and dictation are read: "this computer" in Lodestone Desktop, "this device" in the web app and on the phone.
const HERE = DESKTOP ? "this computer" : "this device";
if (!DESKTOP) setSpeechMode("web");
const desktopServer = () => ({ baseUrl: new URL("v1", location.href).href, model: "lodestone", ctx: 32768 });
const desktopConfigured = () => S.settings.tier === "server" && S.settings.server?.model === "lodestone"
  && S.settings.server?.baseUrl === desktopServer().baseUrl;

function setWebNext(on) {
  S.webNext = !!on;
  $("#webBtn")?.setAttribute("aria-pressed", String(S.webNext));
  $("#composer")?.classList.toggle("web-armed", S.webNext);
  const i = $("#input"); if (i) i.placeholder = S.webNext ? "Ask — Lodestone will also look online…" : "Speak from where you are…";
}

// ─── The move from /munai-offline/ to /lodestone-app/ ───────────────────
// The web app's address changed on October 17, 2026. The site answers every
// old address with a 301, but a worker installed under /munai-offline/ keeps
// serving its cached copy there; when this code runs at the old path it takes
// that worker down and goes to the new one. Conversations, practices and
// memory live in IndexedDB, which belongs to the origin, not the path, so
// they come along untouched. The corpus, the retrieval model and the shell are
// cached under their URLs, which carry the path; they are copied to the new
// path once (migrateCaches), so nothing is downloaded again.
const OLD_PATH = "/munai-offline/", NEW_PATH = "/lodestone-app/";

async function leaveOldPath() {
  if (DESKTOP || !location.pathname.startsWith(OLD_PATH)) return false;
  try { for (const r of await navigator.serviceWorker?.getRegistrations?.() || []) if (new URL(r.scope).pathname.startsWith(OLD_PATH)) await r.unregister(); } catch {}
  location.replace(NEW_PATH + location.pathname.slice(OLD_PATH.length) + (location.search ? location.search + "&" : "?") + "moved=1" + location.hash);
  return true;
}

async function migrateCaches() {
  if (!self.caches || !location.pathname.startsWith(NEW_PATH)) return;
  try { if (await store.kv.get("caches-moved")) return; } catch { return; }
  try {
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const req of await c.keys()) {
        const u = new URL(req.url);
        if (u.origin !== location.origin || !u.pathname.startsWith(OLD_PATH)) continue;
        u.pathname = NEW_PATH + u.pathname.slice(OLD_PATH.length);
        if (await c.match(u.href)) continue;
        const res = await c.match(req);
        if (res) await c.put(u.href, res);
      }
    }
    await store.kv.set("caches-moved", Date.now());
  } catch (e) { console.warn("[move] caches not copied:", e); }
}

/**
 * A phone's browser opened from the computer's QR code (1.13.1): the address
 * carries the pairing code (#pair=123456); the page trades it for a token, kept
 * as a cookie this origin's requests carry, so the computer answers this phone
 * and no other device on the Wi-Fi.
 */
async function pairBrowserFromCode() {
  if (DESKTOP || isNative()) return;
  let code = (/^#pair=(\d{6})$/.exec(location.hash || "") || [])[1];
  if (code) { try { history.replaceState(null, "", location.pathname + location.search); } catch {} }
  else {
    // The address typed by hand (1.13.1): a page served by Lodestone Desktop to
    // this network, not yet paired, asks for the code the computer shows.
    const h = location.hostname;
    const lan = /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+(\.\d+)?$/.test(h) || /\.local$/i.test(h);
    if (!lan || location.protocol !== "http:") return;
    const probe = await fetch("/v1/models", { cache: "no-store" }).catch(() => null);
    if (!probe || probe.status !== 401) return;
    code = (prompt("Pair this browser with Lodestone Desktop.\n\nOn the computer, open Lodestone → Use from Your Phone…, and type the six-digit code shown under “The Lodestone app for Android”:") || "").replace(/\D/g, "");
    if (!code) return toast("Not paired: answers need the code from the computer. Reload the page to type it.", 8000);
  }
  try {
    const r = await fetch("/munai-pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: isHandheld() ? "Phone browser" : "Browser" }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new Error(j.error?.message || `The computer answered ${r.status}.`);
    document.cookie = `lodestone_pair=${j.token}; path=/; max-age=${400 * 86400}; SameSite=Strict`;
    toast(`Paired with ${j.name || "your computer"}: Lodestone here thinks with its model.`, 5000);
  } catch (e) { toast(`Not paired: ${e.message || e}`, 7000); }
}

async function boot() {
  if (await leaveOldPath()) return;
  if (await reloadForBridge()) return;
  // One memory per person: the signed-in account's own, or the device's when
  // no one is signed in, opened before anything of it is read.
  if (syncAvailable()) { try { await held.bind(); } catch (e) { console.warn("[memory]", e?.message || e); } }
  await migrateCaches();
  S.settings = (await store.kv.get("settings")) || { theme: "dark", lang: "auto" };
  if (BRIDGE) return startBridge();
  await pairBrowserFromCode();
  applyTheme(S.settings.theme);
  // The desktop window is served by the app's own local server, which always
  // holds the installed version, so a service worker in front of it can only
  // serve an older one — and did: 1.5.1's docked conversations (which stay
  // until collapsed) were invisible for a launch behind this cache. No worker
  // in the desktop window; any left over from an earlier version is taken
  // down. The web app keeps the worker; there it is what makes offline work.
  if (DESKTOP) {
    navigator.serviceWorker?.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  } else if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { scope: new URL("../", import.meta.url).pathname }).catch(e => console.warn("[sw]", e));
  }
  bindChrome();
  if (isNative()) onAppLink(handleAppLink);
  const installed = await corpusPack.isInstalled();
  // An unknown tier is an install from before a tier was withdrawn (the light
  // tier, 24 Sep 2026). Everything else it holds is still good; only the choice
  // of where Lodestone thinks has to be made again.
  if (DESKTOP) {
    document.documentElement.classList.add("desktop");
    document.title = "Lodestone";
    if (!installed || !desktopConfigured()) return desktopSetup();
    // The app may have brought a newer corpus (an update from harmonism.io, or a
    // new version of the app): take it in before opening. It is local, so quick.
    let refreshed = false;
    try {
      const r = await corpusPack.checkForUpdate();
      if (r.newer) { await corpusPack.install({ semantic: S.settings.semantic !== false }); refreshed = true; }
    } catch (e) { console.warn("[corpus refresh]", e); }
    await startMain();
    if (refreshed) toast("The corpus has been updated.", 5000);
    return;
  }
  if (!installed || !S.settings.tier || !TIERS[S.settings.tier]) return showSetup();
  await startMain();
}

/**
 * The Android app adds its bridge (window.Capacitor) to the page as it loads
 * it from harmonism.io. A copy of the page the service worker kept from
 * before carries no bridge; that copy is dropped and the page loaded again,
 * once, while online.
 */
async function reloadForBridge() {
  if (!/Lodestone-Android/.test(navigator.userAgent) || window.Capacitor || !navigator.onLine || !self.caches) return false;
  try { if (sessionStorage.getItem("munai-bridge-reload")) return false; sessionStorage.setItem("munai-bridge-reload", "1"); } catch { return false; }
  for (const k of await caches.keys()) {
    if (!k.startsWith("munai-offline-shell-")) continue;
    const c = await caches.open(k);
    for (const r of await c.keys()) if (/\/lodestone-app\/(index\.html)?$/.test(new URL(r.url).pathname)) await c.delete(r);
  }
  location.reload();
  return true;
}

/** A lodestone:// link opened the Android app: a pairing QR from Lodestone Desktop. */
async function handleAppLink(link) {
  const r = parsePairLink(link);
  if (!r) return;
  if (!confirm(`Pair this phone with ${r.name || "Lodestone Desktop"} at ${r.base}?`)) return;
  try {
    const p = await pairWith(r.base, r.code);
    if (!$("#setup").hidden) { S.preferComputer = true; await showSetup(); toast(`Paired with ${p.name}.`, 4000); }
    else toast(`Paired with ${p.name}. Choose it in the model menu under the message box.`, 6000);
    if (!$("#drawerSettings").hidden) renderSync();
  } catch (e) { toast(String(e.message || e), 7000); }
}

function applyTheme(t) {
  const mode = t === "auto" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : (t || "dark");
  document.documentElement.dataset.theme = mode;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

const remoteName = id => RECOMMENDED.find(m => m.id === id)?.label || hosted.models?.find(m => m.id === id)?.label || id;

/** Where Lodestone thinks now, in one sentence, as Lodestone Desktop's Model page says it. "" on first run. */
function routeLine() {
  const t = S.settings.tier;
  if (!t || !TIERS[t]) return "";
  const m = S.settings.remote?.tier === t ? S.settings.remote.model : "";
  if (t === "hosted") return `Lodestone is thinking with ${m ? remoteName(m) : "harmonism.io's default model"} through your harmonism.io account, which reads each message. Everything else stays on this device.`;
  if (t === "openrouter") return `Lodestone is thinking with ${remoteName(m || DEFAULT_REMOTE)}, rented from OpenRouter with your key; OpenRouter reads each message. Everything else stays on this device.`;
  if (t === "server") return `Lodestone is thinking with ${S.settings.server?.model || "your computer's model"} on your own computer: nothing leaves your network.`;
  if (t === "reader") return "Lodestone is using no model: a question brings back the passages of the corpus that bear on it.";
  return `Lodestone is thinking with ${S.settings.modelKey || "a model"} in this browser: nothing you say leaves this device.`;
}

async function showSetup() {
  $("#main").hidden = true; $("#setup").hidden = false; syncDock();
  S.gpu = await probeWebGPU();
  const served = await detectLocalServer();
  const box = $("#tierChoices"); box.innerHTML = "";
  const now = $("#setupNow"); if (now) { const line = routeLine(); now.hidden = !line; now.textContent = line; }
  const localOk = localInferenceAvailable();
  const phoneOk = phoneRoutesAvailable();
  // DeepSeek V4.1 Flash is the default everywhere: on the harmonism.io
  // account's free messages, or under the practitioner's own OpenRouter key when
  // one is saved. A model in this browser is offered, never chosen for them.
  // A page served by the practitioner's own computer (tools/serve.py) keeps it.
  const orKeySaved = phoneOk ? !!(await secrets.get("openrouter").catch(() => null)) : false;
  let chosen = S.preferTier || S.settings.tier || (served ? "server" : phoneOk ? (orKeySaved ? "openrouter" : "hosted") : localOk && S.gpu.ok ? "standard" : "server");
  S.preferTier = null;
  if (!TIERS[chosen]) chosen = null;                 // a tier this build withdrew: choose again
  if (!localOk && TIERS[chosen]?.engine === "webllm") chosen = phoneOk ? "hosted" : "server";
  if (!phoneOk && (chosen === "hosted" || chosen === "openrouter")) chosen = "server";
  // What each phone route has proved before Begin is allowed.
  const ready = { hosted: !!(await hosted.account().catch(() => null)), openrouter: false };
  const orSaved = S.settings.remote?.tier === "openrouter" ? S.settings.remote.model : "";
  const srv = S.settings.server || {};
  $("#srvUrl").value = srv.baseUrl || (served ? served.baseUrl : "http://localhost:11434/v1");
  $("#srvModel").value = srv.model || (served?.models?.[0] || "");
  $("#srvCtx").value = srv.ctx || 32768;

  const TAGS = { standard: "this browser · offline after one download", server: "owned hardware", hosted: "recommended · free account · internet", openrouter: "recommended · your own key · internet", reader: "no model · offline" };
  // A phone's own page cannot call a plain-http server on the home network
  // (an https page may not), so there "your computer" is a pointer to the
  // copy Lodestone Desktop serves to phones, unless this page is that copy.
  const phoneComputer = !localOk && !served && window.isSecureContext;
  // In the Android app the route pairs with Lodestone Desktop instead.
  const nativePair = isNative();
  let paired = nativePair ? await pairing.get().catch(() => null) : null;
  if (nativePair && S.preferComputer) { chosen = "server"; S.preferComputer = false; }
  const ORDER = phoneOk ? ["hosted", "openrouter", "server", "standard", "reader"] : ["standard", "server", "reader"];
  const tierList = [...ORDER.filter(k => TIERS[k]), ...Object.keys(TIERS).filter(k => !ORDER.includes(k))].map(k => [k, TIERS[k]]);
  for (const [key, t] of tierList) {
    const needsGpu = t.engine === "webllm";
    if (needsGpu && !localOk) continue;   // not offered on phones and tablets
    if ((t.engine === "hosted" || t.engine === "openrouter") && !phoneOk) continue;   // needs https (WebCrypto)
    const disabled = needsGpu && !S.gpu.ok;
    const def = t.models[0] ? MODELS[t.models[0]] : null;
    const b = el("button", { class: "choice", type: "button", "aria-pressed": String(key === chosen), disabled },
      el("span", { class: "tag" }, TAGS[key] || `default model: ${t.models[0]} · ${def.openness}`),
      el("strong", {}, t.label),
      el("span", { class: "sub" }, t.sub),
      // The tested models, by name: the same list the model menu offers.
      t.engine === "hosted" || t.engine === "openrouter" ? el("span", { class: "models" }, RECOMMENDED.map(m => m.id === DEFAULT_REMOTE ? `${m.label} (default)` : m.label).join(" · ")) : null,
    );
    b.onclick = () => { chosen = key; [...box.children].forEach(c => c.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); sync(); };
    box.append(b);
  }
  const note = $("#gpuNote");
  if (!localOk) {
    note.hidden = false;
    note.textContent = "On a phone or tablet Lodestone does not think locally: the models small enough to run here answer poorly enough to misrepresent the system they speak for. It thinks on a computer you own, on harmonism.io under your account, or on OpenRouter under your own key — or not at all, and then a question brings back the passages that answer it. Whichever you choose, the corpus, your memory and Lodestone's safeguards stay on this phone, and reading and searching work with no network at all.";
  } else if (!S.gpu.ok) {
    note.hidden = false;
    note.textContent = `This browser cannot run a model itself: that needs WebGPU, and it has none (${S.gpu.reason}). Every other route above works here.`;
  } else if (!S.gpu.f16) {
    note.hidden = false;
    note.textContent = "This GPU lacks 16-bit shaders. Lodestone will use the 32-bit build, which is larger and somewhat slower.";
  }
  const orModel = () => $("#orModel").value === "__other" ? $("#orOther").value.trim() : $("#orModel").value;
  const sync = () => {
    $("#serverFields").hidden = chosen !== "server" || phoneComputer;
    $("#phoneComputer").hidden = chosen !== "server" || !phoneComputer;
    $("#hostedFields").hidden = chosen !== "hosted";
    $("#orFields").hidden = chosen !== "openrouter";
    $("#orOtherRow").hidden = $("#orModel").value !== "__other";
    $("#beginSetup").textContent = TIERS[chosen]?.engine === "webllm" ? "Download and begin" : "Begin";
    $("#beginSetup").disabled = !chosen || (chosen === "server" && (phoneComputer ? !(nativePair && paired) : !$("#srvModel").value.trim()))
      || (chosen === "hosted" && !ready.hosted) || (chosen === "openrouter" && !ready.openrouter);
  };
  $("#srvModel").oninput = sync;
  if (nativePair) {
    const box = $("#phoneComputer");
    const drawPair = () => {
      box.innerHTML = "";
      if (paired) {
        box.append(el("p", {}, "Paired with ", el("b", {}, paired.name), ` (${paired.base}). Lodestone thinks with that computer's model while it is awake, Lodestone Desktop is open on it, and this phone is on the same Wi-Fi. ${S.pairedWhere ? `That computer rents its model from ${HOST_LABEL[S.pairedWhere] || S.pairedWhere}, so each turn goes on to them.` : "Nothing leaves your network."}`),
          el("button", { class: "btn ghost", type: "button", id: "pairForget", onclick: async () => {
            if (!confirm(`Forget ${paired.name} on this phone?`)) return;
            await pairing.forget(); paired = null; drawPair(); sync();
          } }, "Forget this computer"));
        return;
      }
      const base = el("input", { type: "text", id: "pairBase", placeholder: "Computer address, such as 192.168.1.20", autocomplete: "off", spellcheck: "false", inputmode: "url" });
      const code = el("input", { type: "text", id: "pairCode", placeholder: "Six-digit code", autocomplete: "one-time-code", inputmode: "numeric", maxlength: "6" });
      const msg = el("p", { class: "hint", role: "status", id: "pairMsg" });
      const go = el("button", { class: "btn ghost", type: "button", id: "pairGo", onclick: async () => {
        go.disabled = true; msg.textContent = "Pairing…";
        try { paired = await pairWith(base.value, code.value); S.pairedWhere = (await desktopWhere(paired.base)) ?? null; toast(`Paired with ${paired.name}.`); drawPair(); sync(); }
        catch (e) { msg.textContent = String(e.message || e); go.disabled = false; }
      } }, "Pair");
      box.append(el("p", {}, "Pair this phone with Lodestone Desktop: on the computer, open the Lodestone menu → ", el("em", {}, "Use from Your Phone…"), " and switch on phone access. Scan the pairing code shown there with this phone's camera, or type the address and code here. Same Wi-Fi."),
        base, code, go, msg);
    };
    drawPair();
    if (paired) desktopWhere(paired.base).then(w => { if (w !== undefined && paired) { S.pairedWhere = w; drawPair(); } });
    S.redrawPair = async () => { paired = await pairing.get().catch(() => null); drawPair(); sync(); };
  }

  // harmonism.io account: its own step, apart from where Lodestone thinks.
  // The sign-in is the website's, on the same origin; Lodestone reads it.
  const hosting = async () => {
    const a = await hosted.account().catch(() => null);
    ready.hosted = !!a;
    $("#accountBox").hidden = !phoneOk;
    renderAccount($("#acctStatus"), $("#acctBtns"), a);
    $("#hStatus").textContent = a ? `Signed in as ${a.email}.` : "Sign in to your harmonism.io account above first.";
    $("#hModelRow").hidden = !a;
    const fillH = list => {
      const sel = $("#hModel"), keep = sel.value || (S.settings.remote?.tier === "hosted" && S.settings.remote.model) || DEFAULT_REMOTE;
      sel.replaceChildren(...list.map(m => el("option", { value: m.id }, `${m.label} · ${m.maker} · tested with Lodestone`)));
      sel.value = list.some(m => m.id === keep) ? keep : (list.find(m => m.id === DEFAULT_REMOTE) || list.find(m => m.default) || list[0])?.id || "";
    };
    fillH(RECOMMENDED);
    if (a) hosted.status(true).then(st => {
      if (st?.models?.length) fillH(st.models);
      if (st?.cap > 0 && st.remaining != null) $("#hStatus").textContent += ` ${st.remaining} of ${st.cap} messages left today.`;
    }).catch(() => {});
    sync();
  };
  hosting();

  // OpenRouter, under the practitioner's own key
  const fillOr = () => {
    const sel = $("#orModel"), keep = sel.value || orSaved || RECOMMENDED[0]?.id;
    sel.innerHTML = "";
    for (const m of RECOMMENDED) sel.append(el("option", { value: m.id }, `${m.label} · ${m.maker} · tested with Lodestone`));
    sel.append(el("option", { value: "__other" }, "Another model on OpenRouter…"));
    if (RECOMMENDED.some(m => m.id === keep)) sel.value = keep;
    else if (keep) { sel.value = "__other"; $("#orOther").value = keep; }
  };
  fillOr();
  refreshRecommended().then(ok => { if (ok) { fillOr(); sync(); } });
  secrets.get("openrouter").then(k => { if (k) { $("#orKey").value = k; ready.openrouter = !!orSaved; $("#orStatus").textContent = orSaved ? "A key is saved on this device." : ""; sync(); } }).catch(() => {});
  const orChanged = () => { ready.openrouter = false; $("#orStatus").textContent = ""; sync(); };
  let orAuto;
  $("#orKey").oninput = () => {
    orChanged();
    clearTimeout(orAuto);
    if (/^sk-or-[A-Za-z0-9_-]{20,}$/.test($("#orKey").value.trim())) orAuto = setTimeout(() => $("#orTest").click(), 600);
  };
  $("#orModel").onchange = orChanged;
  $("#orOther").oninput = orChanged;
  $("#orTest").onclick = async () => {
    const st = $("#orStatus"), model = orModel();
    st.textContent = "Asking OpenRouter…";
    try {
      await testOpenRouter($("#orKey").value, model);
      ready.openrouter = true;
      const a = assess(model);
      st.textContent = `The key works with ${model}${a.tested ? "." : ` (${a.note}).`}`;
    } catch (e) { ready.openrouter = false; st.textContent = String(e.message || e); }
    sync();
  };
  $("#srvTest").onclick = async () => {
    const st = $("#srvStatus"); st.textContent = "Testing…";
    try {
      const models = await ServerEngine.test($("#srvUrl").value.trim());
      st.textContent = models.length ? `Connected. Models: ${models.slice(0, 8).join(", ")}` : "Connected.";
      if (!$("#srvModel").value && models[0]) $("#srvModel").value = models[0];
    } catch (e) {
      st.textContent = `Could not reach it (${e.message}). For Ollama, start it with OLLAMA_ORIGINS set to this page's origin, or run tools/serve.py on that computer and open Lodestone from there.`;
    }
    sync();
  };
  sync();

  // Back (#setup-back): opened from the model menu or Settings, setup must not be
  // a one-way door. The saved route is restored untouched when it can still run:
  // an OpenRouter route needs its key, an account route its sign-in.
  const saved = (await store.kv.get("settings")) || null;
  const savedOk = !!(S.mainStarted && saved?.tier && TIERS[saved.tier]
    && (saved.tier !== "openrouter" || orKeySaved)
    && (saved.tier !== "hosted" || ready.hosted));
  $("#setupBack").hidden = !savedOk;
  $("#setupBack").onclick = async () => {
    S.settings = saved;
    $("#setup").hidden = true; $("#main").hidden = false; syncDock();
    S.engine = makeEngine(); S.engineReady = false; updateBadge();
    try { await S.engine.load((p, t) => engineStatus(shorten(t || "Loading the model…"), p)); S.engineReady = true; engineStatus(null); }
    catch (e) { toast(String(e.message || e), 6000); }
    await refreshWhere(); updateBadge(); refreshWebChip();
  };

  $("#beginSetup").onclick = async () => {
    $("#beginSetup").disabled = true;
    const server = chosen !== "server" ? null
      : nativePair && phoneComputer && paired ? await computerServer(paired)
      : { baseUrl: $("#srvUrl").value.trim(), model: $("#srvModel").value.trim(), ctx: Number($("#srvCtx").value) || 32768 };
    if (chosen === "openrouter") {
      await secrets.set("openrouter", $("#orKey").value.trim());
      S.settings.remote = { tier: "openrouter", model: orModel() };
    } else if (chosen === "hosted") {
      S.settings.remote = { tier: "hosted", model: $("#hModel").value || "" };
    }
    S.engine = null; S.engineReady = false;
    const ok = await runSetup(chosen, $("#optSemantic").checked, server);
    if (!ok) $("#beginSetup").disabled = false;
  };
}

/** Desktop app: no choices to make. Show only the progress, and go. */
async function desktopSetup() {
  $("#main").hidden = true; $("#setup").hidden = false; syncDock();
  const setup = $("#setup");
  setup.querySelector("h1").textContent = "Preparing Lodestone";
  setup.querySelector(".lede").textContent = "Placing the articles and the retrieval model on this computer. This takes a few seconds, once.";
  for (const sel of ["h2", "#tierChoices", "#serverFields", "#gpuNote", "label.check", "#beginSetup", "p.fine"])
    setup.querySelectorAll(sel).forEach(n => { n.hidden = true; });
  S.gpu = { ok: false, reason: "desktop" };
  if (!(await runSetup("server", true, desktopServer()))) {
    const retry = el("button", { class: "btn primary", type: "button", onclick: () => location.reload() }, "Try again");
    $("#setupProgress").append(retry);
  }
}

async function runSetup(chosen, semantic, server) {
  {
    S.settings.tier = chosen;
    if (chosen === "server") {
      S.settings.server = server;
    } else {
      S.settings.modelKey = S.settings.modelKey && TIERS[chosen].models.includes(S.settings.modelKey) ? S.settings.modelKey : defaultModelFor(chosen);
    }
    S.settings.semantic = semantic;
    try { await navigator.storage?.persist?.(); } catch {}
    $("#setupProgress").hidden = false;
    $("#pgSemRow").hidden = !semantic;
    $("#pgModelRow").hidden = TIERS[chosen].engine !== "webllm";
    const msg = $("#setupMsg");
    let semanticNote = "";
    try {
      if (!(await corpusPack.isInstalled())) {
        msg.textContent = DESKTOP ? "Placing the articles…" : "Downloading the corpus…";
        await corpusPack.install({
          semantic,
          onProgress: (kind, f, label) => {
            if (kind === "corpus") setBar("#pgCorpus", f, label);
            else setBar("#pgSem", f * 0.2, label);
          },
        });
      }
      setBar("#pgCorpus", 1, "done");
      await store.kv.set("settings", S.settings);
      if (semantic && (await corpusPack.hasSemanticLocal())) {
        msg.textContent = DESKTOP ? "Preparing the multilingual retrieval model…" : "Downloading the multilingual retrieval model…";
        S.embedder = new Embedder();
        try {
          await S.embedder.start((f, g) => setBar("#pgSem", 0.2 + 0.8 * f, (g / 1e6).toFixed(0) + " MB"));
          setBar("#pgSem", 1, "done");
        } catch (e) {
          console.warn("[semantic]", e);
          S.embedder = null;
          setBar("#pgSem", 0, "unavailable");
          // This line is the shared status line: the model download overwrites it
          // within a second, which is how a practitioner ends up looking at the
          // word "unavailable" with no reason attached. Carry it past setup.
          semanticNote = `Deep retrieval could not start (${String(e.message || e).slice(0, 120)}). Keyword retrieval is being used instead — everything else works.`;
          msg.textContent = semanticNote;
        }
      } else if (semantic) {
        setBar("#pgSem", 0, "not in pack");
      }
      if (TIERS[chosen].engine === "webllm") {
        msg.textContent = "Downloading the model. This happens once; keep this page open.";
        S.engine = makeEngine();
        await S.engine.load((p, t) => { setBar("#pgModel", p, Math.round(p * 100) + "%"); if (t) msg.textContent = shorten(t); });
        S.engineReady = true;
        setBar("#pgModel", 1, "done");
      }
      msg.textContent = "Ready.";
      await startMain();
      if (semanticNote) toast(semanticNote, 12000);
      return true;
    } catch (e) {
      console.error(e);
      msg.textContent = `Stopped: ${e.message || e}. Your progress is kept; press the button to resume.`;
      return false;
    }
  }
}

async function detectLocalServer() {
  // When this page is served by tools/serve.py, /v1 on the same origin is the practitioner's own model server.
  try {
    const base = new URL("v1", location.href).href;
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(base + "/models", { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return { baseUrl: base, models: (j.data || []).map(m => m.id) };
  } catch { return null; }
}

const setBar = (sel, f, label) => { $(sel).style.width = Math.max(0, Math.min(1, f)) * 100 + "%"; const t = $(sel + "T"); if (t) t.textContent = label || ""; };
const shorten = t => t.replace(/\[.*?\]\s*/g, "").slice(0, 90);

function makeEngine() {
  const tier = TIERS[S.settings.tier];
  if (tier.engine === "openai") {
    const srv = S.settings.server || {};
    // A computer paired with the Android app: its token, over the home network.
    if (srv.paired) return new ServerEngine(tier, { ...srv, fetchImpl: lanFetch, headers: async () => { const p = await pairing.get(); return p ? { Authorization: `Bearer ${p.token}` } : {}; } });
    return new ServerEngine(tier, srv);
  }
  if (tier.engine === "hosted") return new HostedEngine(tier, { model: S.settings.remote?.tier === "hosted" ? S.settings.remote.model : "" });
  if (tier.engine === "openrouter") return new OpenRouterEngine(tier, { model: S.settings.remote?.tier === "openrouter" ? S.settings.remote.model : "" });
  if (tier.engine === "none") return new ReaderEngine(tier);
  // A saved modelKey can name a model this build no longer carries.
  const key = tier.models.includes(S.settings.modelKey) ? S.settings.modelKey : tier.models[0];
  return new DeviceEngine(tier, key, S.gpu ? S.gpu.f16 : true);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function startMain() {
  $("#setup").hidden = true; $("#main").hidden = false;
  S.mainStarted = true;
  S.profile = (await store.kv.get("profile")) || {};
  S.wheel = (await store.kv.get("wheel")) || {};
  S.practices = (await store.kv.get("practices")) || [];
  S.assessment = (await store.kv.get("assessment")) || null;
  S.heldBlocks = ((await store.kv.get("companion")) || {}).blocks || null;
  await loadPathState();
  await loadLifeBookStatus();
  renderVault().catch(() => {});
  await loadLifeBookMirror();
  applyLifeBookQueue().catch(e => console.warn("[life book queue]", e));

  engineStatus("Opening the corpus…", 0.05);
  const { corpus, runtime, embeddings } = await corpusPack.load();
  S.pack = { runtime, corpus };
  await new Promise(r => setTimeout(r, 30));
  S.retriever = new Retriever({ corpus, runtime, embeddings });
  console.info(`[retrieval] ${corpus.chunks.length} chunks indexed in ${S.retriever.buildMs} ms`);

  if (embeddings && S.settings.semantic !== false) {
    S.embedder = S.embedder || new Embedder();
    S.embedder.start().then(() => { S.retriever.embedQuery = memoEmbed(t => S.embedder.embed(t)); updateBadge(); recallSoon(); })
      .catch(e => console.warn("[semantic] unavailable, keyword retrieval only:", e.message));
  }

  await openLatestThread();
  syncDock();
  renderCheckins();
  await refreshWhere();
  showHomeNote();
  await takeAssessment();
  refreshWebChip();
  // Writing first, while Lodestone is open; and what the Telegram bridge learned meanwhile, when the window comes back.
  setTimeout(() => maybeReview().then(r => r || maybeOutreach()), 2 * 60 * 1000);
  setInterval(() => { maybeReview().then(r => r || maybeOutreach()); recallSoon(5 * 60 * 1000); }, 60 * 60 * 1000);
  window.addEventListener("focus", async () => { await loadPathState(); renderCheckins(); if (!$("#drawerMe").hidden) renderMe(); });
  // Not awaited: the first sync of a new copy must not hold up the first question.
  const autoP = autoSync().catch(e => console.warn("[sync]", e?.message || e));
  // Not signed in (a new install, or an update that lost the sign-in): asked once, at the start.
  autoP.then(() => setTimeout(() => askSignIn().catch(e => console.warn("[sign-in]", e?.message || e)), 600));
  // Arrived from the dashboard's "Turn on Sync": open Settings at Sync.
  let resume = false; try { resume = sessionStorage.getItem("lodestone-resume-sync") === "1"; sessionStorage.removeItem("lodestone-resume-sync"); } catch {}
  if (resume && syncAvailable()) {
    renderSettings(); openDrawer("#drawerSettings");
    setTimeout(() => { $("#setSync")?.scrollIntoView({ block: "start" }); syncSetup("account", null); }, 300);
  } else if (location.hash === "#sync" && syncAvailable()) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
    // Sent here to let this browser in (the website, the account page): straight to the code.
    autoP.then(() => {
      if (S.autoState === "join" || S.autoState === "passphrase") openSyncSetup();
      else { renderSettings(); openDrawer("#drawerSettings"); setTimeout(() => $("#setSync")?.scrollIntoView({ block: "start" }), 200); }
    });
  } else if (location.hash === "#path") {
    // From the account page: Your path, the one place for the profile, the Wheel and the Wisdom Canon.
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
    renderMe(); openDrawer("#drawerMe");
  }
  // Telegram (bridge mode) writes to the same store from a hidden page: take in
  // what it added when the practitioner comes back to the window.
  if (DESKTOP && !S.focusHook) {
    S.focusHook = true;
    window.addEventListener("focus", async () => {
      if (S.busy) return;
      S.practices = (await store.kv.get("practices")) || [];
      S.profile = (await store.kv.get("profile")) || {};
      renderCheckins();
      if (S.thread) { const fresh = await store.messages.forThread(S.thread.id); if (fresh.length !== S.history.length) { S.history = fresh; renderChat(); } }
    });
  }

  if (!S.engine) {
    if (!S.gpu && TIERS[S.settings.tier].engine === "webllm") S.gpu = await probeWebGPU();
    // An install made while phones were still offered on-device inference is
    // carrying a device tier. Its corpus, memory and threads are intact; only
    // where Lodestone thinks has to be chosen again.
    if (TIERS[S.settings.tier].engine === "webllm" && !localInferenceAvailable()) {
      guard.clear();
      S.settings.tier = null; S.settings.modelKey = null;
      await store.kv.set("settings", S.settings);
      toast("On-device thinking is no longer offered on phones — the small models answered badly. Point Lodestone at your computer.");
      return showSetup();
    }
    S.engine = makeEngine();
  }
  if (!S.engineReady) {
    // A model that killed the tab twice is not tried a third time.
    if (S.engine.kind === "device" && guard.tripped(S.settings.modelKey)) {
      const smaller = smallerModelThan(S.settings.tier, S.settings.modelKey);
      guard.clear();
      if (smaller) {
        const was = S.settings.modelKey;
        S.settings.modelKey = smaller;
        await store.kv.set("settings", S.settings);
        S.engine = makeEngine();
        toast(`${was} was too large for this device — switched to ${smaller}.`);
        engineStatus(`${was} could not run here. Loading ${smaller} instead.`, 0.05);
      } else {
        engineStatus("This computer cannot hold the model. Settings → Change where Lodestone thinks, and run the model outside the browser instead — it can hold far more there.", 0);
        updateBadge(); $("#input").focus();
        return;
      }
    }
    try {
      const cached = await S.engine.isCached();
      engineStatus(cached ? "Waking the model…" : "Downloading the model (once)…", 0.1);
      if (S.engine.kind === "device") guard.start(S.settings.modelKey);
      await S.engine.load((p, t) => engineStatus(cached ? "Waking the model…" : shorten(t || "Downloading…"), p));
      S.engineReady = true;
      guard.clear();
      engineStatus(null);
    } catch (e) {
      console.error(e);
      const t = TIERS[S.settings.tier];
      if (t.engine === "hosted" || t.engine === "openrouter") {
        engineStatus(`${String(e.message || e)} Settings → Change where Lodestone thinks. The library and your memory work meanwhile.`, 0);
        updateBadge();
        return;
      }
      const smaller = t.engine === "webllm" && t.models.indexOf(S.settings.modelKey) < t.models.length - 1;
      engineStatus(`The model could not start (${String(e.message || e).slice(0, 80)}).`, 0);
      toast(smaller ? "Not enough memory for this model, most likely. Settings → Model → try the other one." : "The model could not start — most likely this computer has too little GPU memory. Settings → Change where Lodestone thinks, and run the model outside the browser.");
    }
  } else engineStatus(null);
  updateBadge();
  refreshWebChip();   // the chip names the model once the engine exists
  $("#input").focus();
}

// Safari deletes what a website stores after seven days of use without a visit
// to it; a web app opened from the Home Screen is not subject to that. On an
// iPhone or iPad opened in Safari, say so once, until dismissed.
function showHomeNote() {
  const n = $("#homeNote"); if (!n || DESKTOP) return;
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  let dismissed = false; try { dismissed = localStorage.getItem("munai-home-note") === "1"; } catch {}
  // Opened from a Home Screen icon made at the old address: that icon
  // still points there, so ask once for a new one.
  const moved = new URLSearchParams(location.search).has("moved");
  let movedSeen = false; try { movedSeen = localStorage.getItem("munai-moved-note") === "1"; } catch {}
  if (moved && standalone && !movedSeen) {
    n.querySelector("p").textContent = "Lodestone has a new address. Add it to your Home Screen again from Safari or Chrome, then remove the old icon. Your conversations are kept.";
    n.hidden = false;
    $("#homeNoteClose").onclick = () => { n.hidden = true; try { localStorage.setItem("munai-moved-note", "1"); } catch {} };
    return;
  }
  n.hidden = !isIOS() || standalone || dismissed;
  $("#homeNoteClose").onclick = () => { n.hidden = true; try { localStorage.setItem("munai-home-note", "1"); } catch {} };
}

function engineStatus(msg, frac = 0) {
  const bar = $("#engineBar");
  if (!msg) { bar.hidden = true; return; }
  bar.hidden = false; $("#engineMsg").textContent = msg;
  $("#engineProg").style.width = Math.round(frac * 100) + "%";
}

// What retrieval is actually doing, not what it was asked to do. The badge used
// to report "hybrid" whenever the embedder object existed, so a meaning model
// that loaded but could not embed — see embed-worker.js — read as healthy while
// every question was answered from keyword search alone.
function retrievalMode() {
  const r = S.retriever;
  if (!r) return "no corpus";
  if (r.semanticError) return `keyword only — the meaning model failed (${r.semanticError.slice(0, 60)})`;
  if (!r.emb) return "keyword only — no meaning vectors in this pack";
  if (!r.embedQuery) return "keyword (meaning model still loading)";
  return "hybrid (keyword + multilingual meaning)";
}

const WHERE_LABEL = { server: "your computer", device: "this device", hosted: "harmonism.io", openrouter: "OpenRouter" };
// In Lodestone Desktop the engine is always the app's own server, which either runs
// the model here or passes each turn to the provider in S.where.
const HOST_LABEL = { "openrouter.ai": "OpenRouter", "api.anthropic.com": "Anthropic", "api.venice.ai": "Venice", "router.huggingface.co": "Hugging Face" };

function updateBadge() {
  const b = $("#engineBadge");
  if (!S.engine) { b.textContent = "offline"; return; }
  // A server engine is the desktop's own (this computer) or a paired computer's
  // (your computer); either may pass each turn on to a rented provider (S.where).
  const relayed = S.engine.kind === "server" && !!S.where;
  const where = relayed ? HOST_LABEL[S.where] || S.where : DESKTOP && S.engine.kind === "server" ? "this computer" : WHERE_LABEL[S.engine.kind] || "this device";
  b.textContent = S.engine.kind === "reader" ? "reading the corpus" : S.engineReady ? `thinking on ${where}` : `waking on ${where}…`;
  b.title = `${S.engine.describe()} · ${retrievalMode()}`;
  b.classList.toggle("live", !!S.engineReady);
  b.classList.toggle("rented", S.engine.kind === "hosted" || S.engine.kind === "openrouter" || relayed);
}

/**
 * What Lodestone Desktop at `base` says of its model: the provider it rents it from,
 * or null when it runs the model itself (and for a server that is not Lodestone
 * Desktop). undefined when it cannot be reached: asleep, or off this Wi-Fi.
 */
async function desktopWhere(base) {
  try {
    const r = await lanFetch(base + "/munai-pair", { signal: AbortSignal.timeout(2500) });
    return r.ok ? (await r.json()).where || null : null;
  } catch { return undefined; }
}

/** Where the next turn will be answered, asked afresh: the computer can change its model at any time. */
async function refreshWhere() {
  if (DESKTOP) S.where = (await DESKTOP.info().catch(() => ({}))).remote?.host || null;
  else if (S.engine?.kind === "server") {
    // The Android app paired with the computer, or a browser on the computer's own page.
    const srv = S.settings.server || {};
    const p = srv.paired ? await pairing.get().catch(() => null) : null;
    let base = p?.base || null;
    if (!base) try { base = new URL(srv.baseUrl, location.href).origin; } catch {}
    const w = base ? await desktopWhere(base) : null;
    if (p && w !== undefined) S.pairedWhere = w;
    S.where = S.engine.where = w !== undefined ? w : (S.engine.where ?? null);   // unreachable: keep what it last said
  }
  else S.where = S.engine?.where || null;
  updateBadge();
}

// ─── Threads ─────────────────────────────────────────────────────────────────

// The conversation open in this window is remembered for the session, so a
// visit to the library (the site, in the same window) comes back to it.
const OPEN_KEY = "lodestone-open-thread";
function rememberOpen() { try { sessionStorage.setItem(OPEN_KEY, S.thread?.id || ""); } catch {} }

async function openLatestThread() {
  const list = await store.threads.list();
  let id = null; try { id = sessionStorage.getItem(OPEN_KEY); } catch {}
  S.thread = (id && list.find(t => t.id === id)) || list[0] || null;
  await loadThread();
}

/**
 * Another conversation, opened by the practitioner (1.13.1): not while an answer
 * is being written, which would land in the conversation opened instead.
 */
async function openThread(t) {
  if (!t) return false;
  if (S.busy) { toast("The answer is still being written: wait for it, or Stop it, then open the other conversation.", 5000); return false; }
  S.thread = t; await loadThread();
  return true;
}

async function loadThread() {
  speaker.stop();
  S.history = S.thread ? await store.messages.forThread(S.thread.id) : [];
  rememberOpen();
  renderChat();
  renderCostLine();
  if (threadsDocked()) renderThreadList();
}

async function newThread() {
  if (S.busy) { toast("The answer is still being written: wait for it, or Stop it, then begin a new conversation.", 5000); return; }
  speaker.stop();
  S.thread = null; S.history = []; rememberOpen();
  renderChat(); renderCostLine(); closeDrawers(); if (threadsDocked()) renderThreadList(); $("#input").focus();
}

// ─── Conversations: pin, rename, export, delete, search ─────────────────────
// Pinned conversations come first, under their own heading. A rename or a pin
// carries its own time (titled, pinSet), so sync keeps the latest of each
// (sync.js merge) without reordering the list.

/** The thread object to change: the open one is S.thread itself, which touchThread writes back whole. */
const live = t => (S.thread && S.thread.id === t.id ? S.thread : t);

/** Every thread's usage, summed from its messages (and its summaries), keyed by thread id. */
async function usageByThread(threads) {
  const by = new Map();
  const add = (id, u) => { if (!u) return; const a = by.get(id) || { in: 0, out: 0, cost: 0, priced: false }; a.in += u.in || 0; a.out += u.out || 0; if (u.cost != null) { a.cost += u.cost; a.priced = true; } by.set(id, a); };
  for (const m of await store.messages.all()) if (m.meta?.usage) add(m.threadId, m.meta.usage);
  for (const t of threads) if (t.side) add(t.id, t.side);
  return by;
}

let threadQuery = "";
async function renderThreadList() {
  const ul = $("#threadList");
  const all = await store.threads.list();
  const q = threadQuery.trim().toLowerCase();
  const usage = await usageByThread(all);
  const pages = await pagesOf(all);
  let list = all, hits = new Map();
  if (q) {
    for (const m of await store.messages.all()) {
      if (hits.has(m.threadId)) continue;
      const c = String(m.content || ""), i = c.toLowerCase().indexOf(q);
      if (i >= 0) hits.set(m.threadId, { text: c, at: i });
    }
    list = all.filter(t => String(t.title || "").toLowerCase().includes(q) || hits.has(t.id));
  }
  const pins = list.filter(t => t.pinned), rest = list.filter(t => !t.pinned);
  const kids = [];
  if (!list.length) kids.push(el("li", { class: "empty-row" }, q ? "No conversation matches." : "No conversations yet."));
  if (pins.length) { kids.push(el("li", { class: "group" }, "Pinned")); pins.forEach(t => kids.push(threadRow(t, usage.get(t.id), hits.get(t.id), q, pages.get(t.id)))); }
  if (pins.length && rest.length) kids.push(el("li", { class: "group" }, q ? "Others" : "Recent"));
  rest.forEach(t => kids.push(threadRow(t, usage.get(t.id), hits.get(t.id), q, pages.get(t.id))));
  ul.replaceChildren(...kids);
}

function snippet(hit, q) {
  const from = Math.max(0, hit.at - 24), raw = hit.text.slice(from, hit.at + q.length + 60).replace(/\s+/g, " ");
  const i = raw.toLowerCase().indexOf(q);
  if (i < 0) return el("span", { class: "snip" }, raw);
  return el("span", { class: "snip" }, (from ? "…" : "") + raw.slice(0, i), el("mark", {}, raw.slice(i, i + q.length)), raw.slice(i + q.length));
}

function threadRow(t, u, hit, q, pg) {
  const when = new Date(t.updated);
  const today = new Date().toDateString() === when.toDateString();
  const date = today ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: when.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  const cost = u?.priced && u.cost > 0 ? fmtCost(u.cost) : "";
  const more = el("button", { class: "more", type: "button", title: "Rename, pin, export or delete", "aria-label": "Conversation actions", "aria-haspopup": "menu", "aria-expanded": "false" }, "⋯");
  const li = el("li", { class: "row" + (S.thread && S.thread.id === t.id ? " active" : "") + (t.pinned ? " pinned" : "") },
    el("button", { class: "t", type: "button", onclick: async () => { if (await openThread(t)) closeDrawers(); } },
      el("span", {}, t.pinned ? el("span", { class: "pin-dot", "aria-label": "Pinned" }, "●") : null, t.title || "Untitled"),
      hit && q ? snippet(hit, q) : null,
      el("small", {}, el("span", {}, date), pg ? el("span", { class: "pg", title: pg.url ? `Read with the browser extension: ${pg.url}` : "Read with the browser extension" }, "⧉ " + (pg.domain || "a page")) : null, cost ? el("span", { class: "c", title: "What this conversation has cost" }, cost) : null)),
    more);
  more.onclick = e => { e.stopPropagation(); threadMenu(t, more); };
  li.oncontextmenu = e => { e.preventDefault(); threadMenu(t, more, e.clientX, e.clientY); };
  li.querySelector("button.t").addEventListener("dblclick", e => { e.preventDefault(); startRename(t, li); });
  return li;
}

// ─── Page readings: the browser extension's conversations, one per page ─────
// The extension keeps each page it reads as a conversation of its own (id
// "ext-…", source "extension"), every message carrying the page's title and
// address; sync brings them here. This view lists them with their addresses.

const isPageThread = t => !!t && (t.source === "extension" || String(t.id || "").startsWith("ext-"));
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const webUrl = u => (/^https?:\/\//i.test(u || "") ? u : "");
const READING_KINDS = { harmonist: "Harmonist reading", passage: "Passage", absorb: "Absorbed", summary: "Summary", question: "Question" };
/** What kind of turn a question was, from the extension panel's own prompts. */
function readingKind(q) {
  const t = String(q || "");
  if (t.startsWith("Give me the Harmonist reading of this page")) return "harmonist";
  if (t.startsWith("On this passage from the page:")) return "passage";
  if (t.startsWith("Absorb this page.")) return "absorb";
  if (t.startsWith("Summarize this page")) return "summary";
  return "question";
}

/** For each page conversation: { url, domain, exchanges, kinds, msgs }. */
async function pagesOf(threads) {
  const out = new Map();
  for (const t of threads) {
    if (!isPageThread(t)) continue;
    const msgs = await store.messages.forThread(t.id);
    const url = webUrl(msgs.find(m => m.meta?.url)?.meta.url || "");
    const asks = msgs.filter(m => m.role === "user");
    out.set(t.id, { url, domain: hostOf(url), exchanges: asks.length, kinds: [...new Set(asks.map(m => readingKind(m.content)))], msgs });
  }
  return out;
}

let readingsCache = [];
async function renderReadings() {
  const threads = (await store.threads.list()).filter(isPageThread);
  const pages = await pagesOf(threads);
  readingsCache = threads.map(t => ({ t, ...pages.get(t.id) }));
  drawReadings();
}

function readingsShown() {
  const q = ($("#readingsSearch").value || "").trim().toLowerCase(), k = $("#readingsKind").value;
  return readingsCache.filter(r => (!k || r.kinds.includes(k)) && (!q || `${r.t.title || ""} ${r.url}`.toLowerCase().includes(q) || r.msgs.some(m => String(m.content || "").toLowerCase().includes(q))));
}

function drawReadings() {
  const list = readingsShown(), total = readingsCache.length;
  $("#readingsCount").textContent = total ? (list.length === total ? `${total} page${total === 1 ? "" : "s"}` : `${list.length} of ${total} pages`) : "";
  $("#readingsList").replaceChildren(...(list.length ? list.map(r => {
    const when = new Date(r.t.updated || r.t.created);
    return el("li", { class: "reading" },
      el("button", { class: "t", type: "button", title: "Open the conversation", onclick: async () => { if (await openThread(r.t)) closeDrawers(); } },
        el("span", { class: "rt" }, r.t.title || r.domain || "A page"),
        el("small", {}, when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }), ` · ${r.exchanges} exchange${r.exchanges === 1 ? "" : "s"}`)),
      r.url ? el("a", { class: "rurl", href: r.url, target: "_blank", rel: "noopener noreferrer", title: "Open the page" }, r.url) : null,
      el("div", { class: "kinds" }, r.kinds.map(k => el("span", { class: "kind " + k }, READING_KINDS[k] || k))));
  }) : [el("li", { class: "empty-row" }, total ? "No reading matches." : "No page readings yet. Pages read with the Lodestone browser extension, signed in to the same account with sync on, appear here with their addresses.")]));
}

function exportReadings() {
  const list = readingsShown();
  const who = S.profile?.name || "You";
  const out = ["# Lodestone page readings", "", `*Exported ${new Date().toLocaleString()} · ${list.length} page${list.length === 1 ? "" : "s"}*`, ""];
  for (const r of list) {
    out.push(`## ${r.t.title || r.domain || "A page"}`, "");
    if (r.url) out.push(`<${r.url}>`, "");
    out.push(`*${new Date(r.t.updated || r.t.created).toLocaleString()} · ${r.kinds.map(k => READING_KINDS[k] || k).join(", ")}*`, "");
    for (const m of r.msgs) out.push(`**${m.role === "user" ? who : "Lodestone"}:** ${String(m.content || "").trim()}`, "");
  }
  const a = el("a", { href: URL.createObjectURL(new Blob([out.join("\n")], { type: "text/markdown" })), download: `Lodestone page readings ${new Date().toISOString().slice(0, 10)}.md` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const ICON = {
  rename: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3.5 3.5h-11L10 10z"/><path d="M12 13.5V20"/></svg>',
  export: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>',
};

function closeThreadMenu() {
  document.querySelector(".row-menu")?.remove();
  document.querySelectorAll('#threadList button.more[aria-expanded="true"]').forEach(b => b.setAttribute("aria-expanded", "false"));
}

function threadMenu(t, anchor, x = null, y = null) {
  const open = document.querySelector(".row-menu");
  closeThreadMenu();
  if (open && open.dataset.id === t.id && x == null) return;
  const item = (icon, label, fn, cls = "") => {
    const b = el("button", { type: "button", role: "menuitem", class: cls, onclick: e => { e.stopPropagation(); closeThreadMenu(); fn(); } });
    b.innerHTML = ICON[icon]; b.append(label); return b;
  };
  const li = anchor.closest("li");
  const m = el("div", { class: "row-menu", role: "menu", "data-id": t.id },
    item("rename", "Rename", () => startRename(t, li)),
    item("pin", t.pinned ? "Unpin" : "Pin", () => togglePin(t)),
    item("export", "Export as Markdown", () => exportThread(t)),
    el("hr"),
    item("del", "Delete", () => deleteThread(t), "del"));
  document.body.append(m);
  const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  const left = x != null ? x : r.right - w, top = y != null ? y : r.bottom + 4;
  m.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + "px";
  m.style.top = Math.max(8, top + h > innerHeight - 8 ? (y != null ? y : r.top) - h - 4 : top) + "px";
  anchor.setAttribute("aria-expanded", "true");
  m.addEventListener("keydown", e => {
    const items = [...m.querySelectorAll("button")], i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); items[e.key === "Home" ? 0 : items.length - 1].focus(); }
    else if (e.key === "Tab") { e.preventDefault(); closeThreadMenu(); anchor.focus(); }
  });
  m.querySelector("button")?.focus();
}

function startRename(t, li) {
  if (!li) return;
  const btn = li.querySelector("button.t"); if (!btn) return;
  const inp = el("input", { type: "text", class: "rename", value: t.title || "", "aria-label": "Conversation name", maxlength: "120" });
  btn.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const v = inp.value.trim().replace(/\s+/g, " ");
    if (save && v && v !== t.title) {
      const th = live(t);
      th.title = v; th.titled = Date.now();
      await store.threads.put(th);
      syncSoon();
    }
    renderThreadList();
  };
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
}

async function togglePin(t) {
  const th = live(t);
  th.pinned = th.pinned ? 0 : Date.now(); th.pinSet = Date.now();
  await store.threads.put(th);
  syncSoon(); renderThreadList();
  toast(th.pinned ? "Pinned." : "Unpinned.", 1800);
}

async function deleteThread(t) {
  if (S.busy && S.thread?.id === t.id) { toast("Wait for the answer to finish before deleting this conversation."); return; }
  if (!confirm(`Delete “${t.title || "this conversation"}” from this device?`)) return;
  await store.threads.remove(t.id);
  recallDropThread(t.id);
  if (S.thread && S.thread.id === t.id) { S.thread = null; await openLatestThread(); }
  syncSoon(); renderThreadList();
}

/** The conversation as Markdown: what was said, with the articles each answer drew on. */
async function exportThread(t) {
  const msgs = await store.messages.forThread(t.id);
  const titles = new Map((S.pack?.corpus.articles || []).map(a => [a.p, a]));
  const who = S.profile?.name || "You";
  const out = [`# ${t.title || "Conversation"}`, "", `*Lodestone · ${new Date(t.created || t.updated).toLocaleString()}${msgs.length ? ` – ${new Date(msgs[msgs.length - 1].ts).toLocaleString()}` : ""}*`, ""];
  if (t.summary) out.push("> **Earlier turns, summarized:** " + t.summary.replace(/\n+/g, " "), "");
  for (const m of msgs) {
    if (m.meta?.notice) { out.push(`> *${String(m.content || "").trim().replace(/\n+/g, " ")}*`, ""); continue; }   // the app's own notices, not Lodestone speaking
    out.push(`## ${m.role === "user" ? who : "Lodestone"}`, "", String(m.content || "").trim(), "");
    const src = (m.meta?.sources || []).map(p => titles.get(p)).filter(Boolean);
    if (src.length) out.push("*Drawn from: " + src.map(a => (a.u ? `[${a.t}](${a.u})` : a.t)).join(" · ") + "*", "");
  }
  const name = (t.title || "Conversation").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 80) || "Conversation";
  const a = el("a", { href: URL.createObjectURL(new Blob([out.join("\n")], { type: "text/markdown" })), download: `${name}.md` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ─── Usage and costs ─────────────────────────────────────────────────────────
// Each answer keeps the usage its provider reported (meta.usage: tokens, and the
// cost in dollars where the provider gives it — OpenRouter does). A model on
// the practitioner's own computer reports tokens and costs nothing. Kept with
// the message, synced with it, and never sent to any model.

const fmtCost = c => (c == null ? "" : c === 0 ? "$0" : c >= 1 ? `$${c.toFixed(2)}` : `$${Number(c.toFixed(c < 0.01 ? 4 : 3))}`);
const kTok = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
const usageNow = (background = false) => normUsage(background ? S.engine?.bgUsage : S.engine?.lastUsage);

function sumUsage(list) {
  const a = { in: 0, out: 0, cost: 0, priced: false, turns: 0 };
  for (const u of list) { if (!u) continue; a.turns++; a.in += u.in || 0; a.out += u.out || 0; if (u.cost != null) { a.cost += u.cost; a.priced = true; } }
  return a;
}

function renderCostLine() {
  const b = $("#costLine"); if (!b) return;
  const u = sumUsage([...S.history.map(m => m.meta?.usage), S.thread?.side]);
  if (!S.thread || (!u.in && !u.out && !u.priced)) { b.hidden = true; return; }
  b.textContent = `This conversation: ${u.priced ? fmtCost(u.cost) : "no cost"} · ${kTok(u.in)} in, ${kTok(u.out)} out`;
  b.title = u.priced ? "What this conversation has cost, as the provider reported it. Click for usage over time." : "Tokens used by this conversation; the model reported no cost. Click for usage over time.";
  b.hidden = false;
}

/** The thread's summaries are paid for too: their usage is kept on the thread. */
function addSideUsage(thread, u) {
  if (!thread || !u) return;
  const s = thread.side || { in: 0, out: 0, cost: null };
  s.in += u.in || 0; s.out += u.out || 0;
  if (u.cost != null) { s.cost = (s.cost || 0) + u.cost; s.log = [...(s.log || []), { ts: Date.now(), cost: u.cost }].slice(-200); }   // dated, so a month counts only its own (1.13.1)
  thread.side = s;
}

let usageDays = 30;
async function renderUsage(days = usageDays) {
  usageDays = days;
  [...$("#usageTabs").children].forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.d) === days)));
  const since = days ? (days === 1 ? new Date(new Date().toDateString()).getTime() : Date.now() - days * 864e5) : 0;
  const msgs = (await store.messages.all()).filter(m => m.meta?.usage && (m.ts || 0) >= since);
  const threads = await store.threads.list();
  const tot = sumUsage(msgs.map(m => m.meta.usage));
  const side = sumUsage(threads.filter(t => t.side && (t.summaryAt || t.updated || 0) >= since).map(t => t.side));
  const byModel = new Map();
  for (const m of msgs) {
    const k = m.meta.modelLabel || m.meta.model || "unknown";
    const a = byModel.get(k) || [];
    a.push(m.meta.usage); byModel.set(k, a);
  }
  const rows = [...byModel].map(([k, l]) => [k, sumUsage(l)]).sort((x, y) => y[1].cost - x[1].cost || y[1].in - x[1].in);
  const convs = new Set(msgs.map(m => m.threadId)).size;
  const cost = tot.cost + (side.priced ? side.cost : 0), priced = tot.priced || side.priced;
  const body = $("#usageBody");
  body.replaceChildren(...[
    el("div", { class: "usage-tot" },
      el("div", {}, el("b", {}, priced ? fmtCost(cost) : "$0"), el("small", {}, "spent")),
      el("div", {}, el("b", {}, String(tot.turns)), el("small", {}, `answer${tot.turns === 1 ? "" : "s"} · ${convs} conversation${convs === 1 ? "" : "s"}`)),
      el("div", {}, el("b", {}, kTok(tot.in + side.in)), el("small", {}, "tokens in")),
      el("div", {}, el("b", {}, kTok(tot.out + side.out)), el("small", {}, "tokens out"))),
    rows.length ? el("h5", {}, "By model") : null,
    rows.length ? el("table", {},
      el("tr", {}, el("th", {}, "Model"), el("th", { class: "n" }, "Answers"), el("th", { class: "n" }, "In"), el("th", { class: "n" }, "Out"), el("th", { class: "n" }, "Cost")),
      rows.map(([k, a]) => el("tr", {}, el("td", {}, k), el("td", { class: "n" }, String(a.turns)), el("td", { class: "n" }, kTok(a.in)), el("td", { class: "n" }, kTok(a.out)), el("td", { class: "n" }, a.priced ? fmtCost(a.cost) : "—")))) :
      el("p", { class: "hint" }, "Nothing in this period."),
    side.turns ? el("p", { class: "hint" }, `Summaries of long conversations: ${kTok(side.in)} in, ${kTok(side.out)} out${side.priced ? `, ${fmtCost(side.cost)}` : ""}.`) : null,
    el("p", { class: "hint" }, "As each provider reported it. OpenRouter reports the cost of every answer; a model on your own computer costs nothing and reports tokens only. Answers given before this version of Lodestone carry no usage.")].filter(Boolean));
}

function openUsage() { renderUsage(); openDrawer("#drawerUsage"); }

// ─── Chat rendering ──────────────────────────────────────────────────────────

function renderChat() {
  const chat = $("#chat"); chat.innerHTML = "";
  if (!S.history.length) {
    const starters = [
      "What is the purpose of a human life?",
      "My sleep is broken. Where do I begin?",
      "Why does the modern world feel so hollow?",
      "How do I discern what my Dharma is?",
    ];
    chat.append(el("div", { class: "empty" },
      sprite("empty-sprite"),
      el("h2", {}, "Speak from where you are."),
      el("p", {}, "Lodestone reads Harmonism against your situation, from the corpus on this device. Tell it where you stand, or begin with one of these."),
      el("div", { class: "starters" }, starters.map(s => el("button", { type: "button", onclick: () => { $("#input").value = s; send(); } }, s))),
      S.assessment ? null : el("p", { class: "hint" }, el("a", { href: "#", onclick: e => { e.preventDefault(); renderMe(); openDrawer("#drawerMe"); } }, "Take the Harmonic Profile assessment"), " and Lodestone reads you through it.")));
    return;
  }
  if (S.thread?.summary) chat.append(el("details", { class: "summary-note" },
    el("summary", {}, "Earlier turns, summarized"),
    el("p", {}, S.thread.summary),
    el("small", {}, "Kept on this computer with the conversation. Lodestone sends this in place of those turns.")));
  if (isPageThread(S.thread)) {
    const url = webUrl(S.history.find(m => m.meta?.url)?.meta.url || "");
    chat.append(el("div", { class: "page-strip" }, el("span", { class: "lbl" }, "Page reading"),
      url ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer", title: "Open the page" }, S.thread.title || hostOf(url)) : el("span", {}, S.thread.title || "A page"),
      url ? el("small", {}, url) : null));
  }
  for (const m of S.history) chat.append(msgNode(m));
  chat.scrollTop = chat.scrollHeight;
}

function msgNode(m) {
  const isUser = m.role === "user";
  const body = el("div", { class: "body" + (isUser ? "" : " prose") + (voiceOnly.has(m) ? " folded" : ""), dir: "auto" });
  if (isUser) body.textContent = m.content;
  else body.innerHTML = render(m.content);
  const wrap = el("div", { class: `msg ${m.role}${m.meta?.crisis ? " crisis" : ""}${m.meta?.notice ? ` notice ${m.meta.notice}` : ""}` });
  if (m.meta?.notice) { body.className = "body"; body.textContent = m.content; wrap.append(el("div", { class: "col", style: "flex:1;min-width:0" }, body)); return wrap; }
  if (!isUser) wrap.append(sprite("avatar"));
  const col = el("div", { class: "col", style: isUser ? "display:flex;flex-direction:column;align-items:flex-end;max-width:85%;min-width:0" : "flex:1;min-width:0" }, body);
  if (voiceOnly.has(m)) {
    const me = speaker.active && speaker.key === m;
    const row = el("div", { class: "voice-row" },
      el("span", { class: "vr-wave", "aria-hidden": "true" }, el("i"), el("i"), el("i"), el("i")),
      el("span", { class: "vr-state" }, me ? "Lodestone is speaking" : "Spoken"),
      el("button", { type: "button", class: "vr-stop", hidden: !me, onclick: () => speaker.stop() }, "Stop"),
      el("button", { type: "button", class: "vr-show", onclick: e => { const f = body.classList.toggle("folded"); e.target.textContent = f ? "Show the text" : "Hide the text"; } }, "Show the text"));
    row._msg = m;
    col.prepend(row);
  }
  if (isUser && m.meta?.files?.length) col.prepend(el("div", { class: "msg-files" }, m.meta.files.map(f => el("span", { title: f.note || f.kind }, `📎 ${f.name}${f.images ? ` · ${f.images} image${f.images > 1 ? "s" : ""}` : ""}`))));
  if (!isUser && m.meta?.recalled?.length) col.append(recalledNode(m));
  if (!isUser && (m.meta?.sources?.length || m.meta?.web?.length || m.meta?.yours?.length)) col.append(sourcesNode(m.meta.sources || [], m.meta.web || [], m.meta.yours || []));
  const actions = el("div", { class: "actions" });
  if (isUser) {
    actions.append(el("button", { type: "button", onclick: () => remember(m.content) }, "Remember this about me"));
    if (lifeBookOn()) actions.append(el("button", { type: "button", title: "A card opens to choose the note; nothing is written until you keep it", onclick: () => keepFromMessage(m.content) }, "Keep in my life book"));
    if (isLastPair(m) && !m.meta?.files?.length) actions.append(el("button", { type: "button", class: "last-only", title: "Take this message and its answer back into the message box, to change and send again", onclick: () => editLast() }, "Edit"));
  } else if (!m.meta?.crisis) {
    actions.append(el("button", { type: "button", onclick: () => { navigator.clipboard?.writeText(m.content); toast("Copied"); } }, "Copy"));
    actions.append(el("button", { type: "button", onclick: () => { openDrawer("#drawerMe"); renderMe(); $("#prText").focus(); } }, "Make a practice of this"));
    if (voice.available() && m.content) actions.append(listenButton(m));
    if (isLastPair(m) && !lastUser()?.meta?.files?.length) actions.append(el("button", { type: "button", class: "last-only", title: "Ask again: this answer is replaced by a new one", onclick: () => retryLast() }, "Retry"));
    if (m.meta?.stopped) actions.append(el("span", { class: "meta stopped" }, "stopped"));
    const u = m.meta?.usage;
    if (u) {
      const who = m.meta.modelLabel || "";
      actions.append(el("span", { class: "meta", title: `${who ? who + " · " : ""}${u.in.toLocaleString()} tokens in, ${u.out.toLocaleString()} out${u.cost != null ? ` · ${fmtCost(u.cost)}` : ""}` },
        [who.split(" · ")[0], u.cost != null ? fmtCost(u.cost) : "", `${kTok(u.in)} in · ${kTok(u.out)} out`].filter(Boolean).join(" · ")));
    }
  }
  col.append(actions);
  wrap.append(col);
  body.addEventListener("click", onLinkClick);
  return wrap;
}

/** Under an answer: the earlier conversations it drew on, each openable and forgettable. */
function recalledNode(m) {
  const box = el("div", { class: "sources recalled" }, el("span", { class: "rc-label" }, "Remembered from:"));
  for (const r of m.meta.recalled) {
    const chip = el("span", { class: "rc" },
      el("button", { type: "button", title: "Open that conversation", onclick: async () => { const t = await store.threads.get(r.th); if (!t) { toast("That conversation is no longer here."); return; } await openThread(t); } }, `↺ ${r.title} · ${r.date}`),
      el("button", { type: "button", class: "rc-forget", title: "Lodestone will not bring this back again", "aria-label": `Forget ${r.title} for recall`, onclick: async () => { await recallForget(r.key); chip.classList.add("gone"); chip.querySelector(".rc-forget").remove(); toast("Lodestone will not bring that back again."); } }, "Forget"));
    box.append(chip);
  }
  return box;
}

function sourcesNode(paths, web = [], yours = []) {
  const box = el("div", { class: "sources" });
  for (const f of yours) box.append(el("span", { class: "own-src", title: "From a folder you let Lodestone read" }, "▸ " + f.split(/[\\/]/).pop()));
  for (const w of web) {
    if (!webUrl(w.url)) continue;   // http(s) only (1.13.1)
    let host = ""; try { host = new URL(w.url).hostname.replace(/^www\./, ""); } catch {}
    box.append(el("a", { class: "web-src", href: w.url, target: "_blank", rel: "noopener", title: w.url }, "↗ " + (host || w.title)));
  }
  const idx = new Map(S.pack.corpus.articles.map((a, i) => [a.p, i]));
  for (const p of paths) {
    const a = idx.get(p);
    if (a == null) continue;
    box.append(el("button", { type: "button", title: "Read offline", onclick: () => openReader(a) }, "↳ " + S.pack.corpus.articles[a].t));
  }
  return box;
}

function onLinkClick(e) {
  const a = e.target.closest("a[data-hurl]");
  if (!a) return;
  const url = a.dataset.hurl.replace(/[.,;:]+$/, "");
  const i = S.pack.corpus.articles.findIndex(x => x.u === url);
  if (i >= 0) { e.preventDefault(); openReader(i); }
}

// ─── Sending ─────────────────────────────────────────────────────────────────

/**
 * One turn's context, the same for the window and for the Telegram bridge.
 * The crisis gate runs first and no model sees a message it catches; the web
 * is consulted only after it, and only when `getWeb` is given.
 */
async function prepareTurn(text, history, { getWeb = null, files = [], folders = false, summary = null } = {}) {
  const lang = detectLang(text, S.settings.lang || "auto");
  const runtime = S.pack.runtime;

  // 1 — deterministic crisis gate: no model sees this message
  const crisis = detectCrisis(text, lang, runtime.crisis);
  if (crisis) return { crisis, reply: buildCrisisResponse(crisis.category, S.profile.country, crisis.lang || lang, runtime.crisis) };
  // 1b — the care layer (1.13): what is said indirectly, by phrase or by meaning, still before any model
  const embed = S.retriever?.embedQuery || null;
  const care = await careCheck(text, embed).catch(() => null);

  // 2 — retrieval
  let tier = S.engine.tier;
  const prevUser = [...history].reverse().find(m => m.role === "user")?.content || "";
  const prevSources = [...history].reverse().find(m => m.role === "assistant" && m.meta?.sources?.length)?.meta.sources || [];
  const titles = new Map(S.pack.corpus.articles.map(a => [a.p, a.t]));
  const titleOf = p => titles.get(p);

  // A message that points back at the conversation ("the whole article", "your
  // last message") names no topic of its own, so it searches with the last
  // question as well.
  const follow = isFollowUp(text) && !S.retriever.asked(text).length;
  let { hits } = await S.retriever.retrieve(text, { ...tier.rag, context: prevUser, follow });

  // 2a — articles read whole, from the corpus pack on this device. Asked for in
  // full: the one named, else the one the practitioner last named, else the first
  // the last reply was given. Otherwise, with a wide window (a rented or hosted
  // model; a local 32k window has no room), the one or two the question rests on:
  // named in it, or retrieved at two passages or more. The rest stay passages.
  const arts = S.pack.corpus.articles;
  let full = [], articleBudget = 0;
  if (wantsWhole(text)) {
    let cands = S.retriever.asked(text);
    for (let i = history.length - 1; i >= 0 && !cands.length; i--) if (history[i].role === "user") cands = S.retriever.asked(history[i].content);
    const prev = new Set(prevSources);
    const idx = cands.find(a => prev.has(arts[a].p)) ?? cands[0] ?? arts.findIndex(a => a.p === prevSources[0]);
    if (idx >= 0) { full = [idx]; hits = []; articleBudget = arts[idx].x.length; }   // the article is the whole of what was asked for
  } else if (S.where) {
    const named = S.retriever.asked(text), depth = new Map();
    for (const h of hits) depth.set(h.article, (depth.get(h.article) || 0) + 1);
    const cap = 100000;   // characters of article text per turn (the hosted limit is 400,000, history included)
    let total = 0;
    for (const a of [...new Set([...named, ...hits.map(h => h.article)])]) {
      if (full.length >= 2) break;
      if (!named.includes(a) && depth.get(a) < 2) continue;
      if (full.length && total + arts[a].x.length > cap) continue;
      full.push(a); total += arts[a].x.length;
    }
    articleBudget = Math.min(total, cap);
    hits = hits.filter(h => !full.includes(h.article));
  }
  const articleBlocks = () => {
    let left = articleBudget;
    return full.map(a => { const t = arts[a].x.slice(0, Math.max(0, left)); left -= t.length; return t.length ? fullArticleBlock(arts[a], t, t.length < arts[a].x.length) : ""; }).filter(Boolean).join("\n\n");
  };

  // 2b — the web, only when the practitioner asked for it on this question
  const web = getWeb ? await getWeb() : [];

  // 2b′ — the practitioner's chosen folders: in Lodestone's own window only, never over Telegram
  let yours = folders && DESKTOP?.searchFolders ? await DESKTOP.searchFolders(text).catch(() => []) : [];

  // What leaves for a model elsewhere is screened as this message was (1.13.1):
  // earlier turns and files, the summary, recalled passages, the life book and
  // the folders' passages go without keys, passwords, cards or IBANs.
  const away = S.where ? leaveOut : (x => x);

  // 2c — attachments: this message's, then up to three read earlier in the
  // conversation, so a follow-up question can still reach them. With a rented
  // model the window widens to hold them; the bundled engine's stays at 32k.
  const earlier = [];
  for (let i = history.length - 1; i >= 0 && earlier.length < 3; i--) {
    for (const f of history[i].meta?.files || []) if (f.text && earlier.length < 3) earlier.push({ ...f, earlier: true, text: history[i].meta?.asWritten ? f.text : away(f.text) });
  }
  const all = [...files, ...earlier];
  if ((all.length || full.length) && S.where) tier = { ...tier, ctx: 160000 };
  let filesBudget = 60000;

  // 3 — per-turn blocks
  const w = detectWitness(text, lang, runtime.witness);
  const since = await store.messages.since(Date.now() - 864e5);
  const count24h = since.filter(m => m.role === "user").length + 1;
  const person = { profile: S.profile, wheel: S.wheel, practices: S.practices, assessment: S.assessment, learned: learning.learnedLines(S.learned) };
  // The calibration of what Lodestone has learned (fluency, openness, the conversation's state), read before this message advances it.
  const calib = calibrationFor(text);
  const reading = readingFor();
  // The life book: notes whose keys came up, read from Lodestone's folder in the vault.
  if (S.lifeBook === undefined) await loadLifeBookStatus();
  const lbThread = history[0]?.threadId || S.thread?.id || "new";
  if (!lbSticky.has(lbThread)) lbSticky.set(lbThread, new Map());
  let lbSel = lifeBookOn() ? lifebook.selectEntries(await lifeBookEntries(), [text, ...history.slice(-lifebook.SCAN_DEPTH).reverse().map(m => String(m.content || ""))], lbSticky.get(lbThread)) : [];
  const lbBudget = Math.floor(tier.ctx * lifebook.BUDGET_SHARE);
  // Earlier conversations that bear on this message (1.13), recalled on this device.
  let recalled = await recallFor(text, history[0]?.threadId || S.thread?.id || null).catch(e => { console.warn("[recall]", e); return []; });
  // Earlier turns, screened before they are fitted (1.13.1: after, a marker could
  // push the fitted window past the model's), except those sent as written.
  const screened = history.map(m => S.where && !m.meta?.asWritten && typeof m.content === "string" ? { ...m, content: leaveOut(m.content) } : m);
  let system, fitted;
  for (;;) {
    system = buildSystem({ tier, runtime, person, where: S.where || null, device: !DESKTOP && isHandheld() ? "device" : "computer", turn: {
      files: filesBlock(all, filesBudget),
      folders: away(foldersBlock(yours)),
      lifebook: away(lifebook.lifeBookBlock(lbSel, lbBudget)),
      recall: away(presence.recallBlock(recalled)),
      care: presence.careBlock(care),
      summary: away(summaryBlock(summary?.text)),
      article: articleBlocks(),
      vault: S.retriever.format(hits),
      earlier: earlierBlock(history, titleOf),
      web: webBlock(web),
      witness: w ? witnessBlock(w.strength) : "",
      governor: governorBlock(count24h),
      held: heldBlock(S.heldBlocks),
      calibration: calib.blocks,
      reading: reading.block,
    } });
    // turns already folded into the summary are not sent a second time
    fitted = fitMessages({ system, history: screened.filter(m => !m.meta?.crisis && !m.meta?.notice && !(summary && summary.through && (m.ts || 0) <= summary.through)), current: text, tier });
    const over = estTokens(system) + estTokens(text) > tier.ctx - tier.maxTokens - 64;
    if (!over) break;
    if (yours.length) { yours = yours.slice(0, -1); continue; }   // small context: shed folder passages first
    if (hits.length) { hits = hits.slice(0, -1); continue; }   // then retrieval
    if (lbSel.length > 1) { lbSel = lbSel.slice(0, -1); continue; }   // then the life book's last notes
    if (recalled.length) { recalled = recalled.slice(0, -1); continue; }   // then what was recalled
    if (all.length && filesBudget > 3000) { filesBudget = Math.floor(filesBudget * 0.6); continue; }   // then shorten the files
    if (full.length > 1) { full.pop(); articleBudget = Math.min(articleBudget, arts[full[0]].x.length); continue; }   // then the second article
    if (full.length && articleBudget > 3000) { articleBudget = Math.floor(articleBudget * 0.8); continue; }   // last, the first one
    break;
  }
  const sources = [...new Set([...full.map(a => arts[a].p), ...hits.map(h => arts[h.article].p)])];
  const images = files.flatMap(f => f.images || []);
  await calib.advance();
  return { tier, fitted, w, web, sources, images, hits, yours: [...new Set(yours.map(r => r.file))], lifebook: lbSel.map(e => e.rel), readingDue: reading.due, readingArc: reading.arc, care, lang,
    recalled: recalled.map(r => ({ key: r.key, th: r.th, title: r.title, date: r.date })) };
}

/**
 * The reading tier's answer: no model, so the passages themselves, each under
 * its article's title; the articles open offline from the list beneath.
 */
function readerReply(hits) {
  if (!hits.length) return "Nothing in the corpus on this device matches these words. Try the topic by name, or open the Library and search there.";
  const arts = S.pack.corpus.articles;
  const parts = hits.map(h => {
    const a = arts[h.article];
    let t = h.text.replace(/^#{1,6}\s+.*$/gm, "").replace(/\n{2,}/g, "\n").trim();
    if (t.length > 700) t = t.slice(0, t.lastIndexOf(" ", 700)) + " …";
    return `**${a.t}**${h.heading ? ` — ${h.heading}` : ""}\n\n> ${t.replace(/\n/g, "\n> ")}`;
  });
  return `No model is in use, so here are the passages of the corpus that bear on this.\n\n${parts.join("\n\n")}`;
}

/** The current turn's images go into the practitioner's own message, as OpenAI content parts. */
function withImages(messages, images) {
  if (!images?.length) return messages;
  const out = messages.slice(), last = out[out.length - 1];
  out[out.length - 1] = { ...last, content: [{ type: "text", text: last.content }, ...images.map(url => ({ type: "image_url", image_url: { url } }))] };
  return out;
}

/** What a stored message keeps of its attachments: the text (for later turns), never the images. */
const storedFiles = files => files.map(f => ({ name: f.name, kind: f.kind, note: f.note || null, text: f.text ? redact(f.text.slice(0, 60000)) : "", cut: f.cut || 0, images: (f.images || []).length }));

/**
 * A pasted Harmonic Profile code: read here, never sent to the model as text.
 * Returns Lodestone's reply, or null when the message is not a code.
 */
async function ingestHPCode(text) {
  if (!isHPCode(text)) return null;
  let r;
  try { r = parseHP(text); } catch (e) { return e.message; }
  S.wheel = { ...S.wheel, ...r.wheel };
  S.assessment = r.summary;
  await store.kv.set("wheel", S.wheel);
  await store.kv.set("assessment", S.assessment);
  // Website Lodestone reads the profile from the code itself.
  await store.kv.set("hp_code", String(text).trim());
  await store.kv.set("hp_fresh", true);
  if (r.country && !S.profile.country) { S.profile.country = r.country; await store.kv.set("profile", S.profile); }
  return `I have your Harmonic Profile now: your Wheel reading across ${Object.keys(r.wheel).length} pillars${/Enneagram: \d/.test(r.summary) ? ", your Enneagram" : ""}${/Constitution: (?!not)/.test(r.summary) ? ", your constitution" : ""}. It stays on this device; your Wheel reading is under Your path, where you can change it, and the whole profile leaves with Export memory. Where would you like to begin?`;
}

/** While a modal card is open, everything else is inert: Tab stays in it, a click behind it does nothing (1.13.1). */
function modalInert(box) {
  const others = [...document.body.children].filter(n => n !== box && !n.inert && n.id !== "toast");
  others.forEach(n => { n.inert = true; });
  return () => others.forEach(n => { n.inert = false; });
}

/**
 * What the privacy gate found, shown masked; resolves "out" (leave them out),
 * "asis" (send as written) or "back". Esc and a click outside go back.
 */
function askPrivacy(found, where) {
  return new Promise(resolve => {
    let done = v => { box.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); done("back"); } };
    const list = el("ul", { class: "gate-list" }, ...found.slice(0, 8).map(f => el("li", {}, `${cap(f.label)} in ${f.where === "your message" ? "your message" : f.where}${f.line > 1 ? `, line ${f.line}` : ""}: `, el("code", {}, f.sample))));
    if (found.length > 8) list.append(el("li", {}, `and ${found.length - 8} more`));
    const out = el("button", { type: "button", class: "btn primary", onclick: () => done("out") }, "Leave them out");
    const card = el("div", { class: "signin-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "gateTitle" },
      el("h3", { id: "gateTitle" }, "This message carries something private"),
      el("p", {}, `It is about to go to ${where}, outside ${HERE}. Lodestone found:`),
      list,
      el("p", { class: "muted" }, "Left out, each is replaced by a short marker and the rest goes as written. Keys are never kept in the conversation either way."),
      el("div", { class: "row-btns" }, out,
        el("button", { type: "button", class: "btn ghost", onclick: () => done("asis") }, "Send as written"),
        el("button", { type: "button", class: "btn ghost", onclick: () => done("back") }, "Go back")));
    const box = el("div", { class: "signin-ask", id: "gateAsk" }, card);
    box.addEventListener("click", e => { if (e.target === box) done("back"); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(box);
    const unInert = modalInert(box);
    const was = done; done = v => { unInert(); was(v); };
    setTimeout(() => out.focus(), 30);
  });
}

// One send at a time: a second Enter while the first still checks (the spending
// limit reads the store, the privacy gate waits for an answer) is not a second message.
let sendingNow = false;
async function send(prefill) {
  if (sendingNow) { giveBackTo(prefill); return; }
  sendingNow = true;
  try { return await sendOne(prefill); } finally { sendingNow = false; }
}

// A message coming back (Retry, or words spoken in talk mode) that cannot go
// now returns to the message box, never lost (1.13.1): after a draft already
// there, not instead of it.
function giveBackTo(prefill) {
  const text = String(prefill ?? "").trim();
  if (!text) return;
  S.dictated = false;
  const input = $("#input"), draft = input.value.trim();
  if (draft.includes(text)) return;
  input.value = draft ? `${draft}\n\n${text}` : text; autosize();
}

async function sendOne(prefill) {
  let turnForNotice = null, noticesDone = false;
  const input = $("#input");
  let text = (prefill ?? input.value).trim();
  if (S.busy) { giveBackTo(prefill); return; }
  if (prefill == null && S.pending.some(x => x.status === "reading")) { toast("Still reading the attachments…"); return; }
  let files = prefill == null ? S.pending.filter(x => x.status === "ready").map(x => x.data) : [];
  if (!text && files.length) text = files.length > 1 ? "Read what I attached." : `Read ${files[0].name}.`;
  if (!text) return;
  const giveBack = () => { if (prefill != null) giveBackTo(text); };
  if (!S.engineReady && !isHPCode(text)) {
    giveBack();
    toast(S.engine?.kind === "hosted" || S.engine?.kind === "openrouter"
      ? "Lodestone cannot reach its model yet: Settings → Change where Lodestone thinks. Your words are kept."
      : "The model is still waking. Your words are kept.", 6000);
    return;
  }
  if (!isHPCode(text) && (await capReached())) { giveBack(); return; }
  // The privacy gate: keys, passwords, card numbers, before they leave this device.
  let asWritten = false;
  if (!isHPCode(text)) {
    await refreshWhere();
    const found = S.where ? scanMessage(text, files) : [];
    if (found.length) {
      const choice = await askPrivacy(found, S.where);
      if (choice === "back") { giveBack(); $("#input").focus(); return; }
      if (choice === "out") ({ text, files } = leaveOutMessage(text, files));
      // Sent as written: later turns send it as written too, not with markers the model never saw.
      if (choice === "asis") asWritten = true;
    }
  }
  const keep = S.retrying ? null : rememberAsked(text);
  const spoke = S.dictated; S.dictated = false;
  speaker.stop(); (voice.available() || speakViaProvider()) && primeSpeech();
  S.busy = true; S.stopRequested = false; input.value = ""; autosize(); setSending(true);
  if (prefill == null) { S.pending = []; renderAttachBar(); }

  try {
    if (!S.thread) S.thread = await store.threads.create(text.slice(0, 60));
    await refreshWhere();

    const hp = await ingestHPCode(text);
    if (hp) {
      const uid = await store.messages.add({ threadId: S.thread.id, role: "user", content: "(Harmonic Profile code)" });
      const am = { threadId: S.thread.id, role: "assistant", content: hp, meta: { model: "harmonic-profile" } };
      am.id = await store.messages.add(am);
      S.history.push({ id: uid, threadId: S.thread.id, role: "user", content: "(Harmonic Profile code)", ts: Date.now() }, am);
      await touchThread(); renderChat();
      return;
    }

    // Look this up: on OpenRouter and harmonism.io's models, the provider searches the web; elsewhere in a browser, Wikipedia.
    const webViaProvider = !!S.webNext && !DESKTOP && ["openrouter", "hosted"].includes(S.engine?.kind);
    if (webViaProvider) { setWebNext(false); toast(`Searching the web through ${S.engine.kind === "hosted" ? "harmonism.io" : "OpenRouter"}…`, 4000); }
    const getWeb = S.webNext ? async () => {
      setWebNext(false);
      toast(DESKTOP ? "Looking this up online…" : "Looking this up on Wikipedia…", 4000);
      let web = [];
      try { web = DESKTOP ? await DESKTOP.webLookup(text) : await wikiLookup(text, detectLang(text, S.settings.lang || "auto")); }
      catch (e) { toast(`Could not look it up online (${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}). Answering from the corpus.`, 7000); }
      if (!web.length) toast("Nothing useful came back from the web; answering from the corpus.", 5000);
      return web;
    } : null;
    await summaryOrStop();   // one model, one slot: a summary in progress finishes first
    // Key memories: in this turn's notes at once, kept only once the gates have passed it;
    // a crisis or a care moment is never kept as a fact.
    const notesBefore = S.profile.notes;
    if (keep) S.profile.notes = withMemory(notesBefore, keep);
    const turn = await prepareTurn(text, S.history, { getWeb, files, folders: true, summary: threadSummary(S.thread) });
    turnForNotice = turn;
    if (keep) {
      S.profile.notes = notesBefore;
      if (!turn.crisis && !turn.care) { await keepMemory(keep); toast("Kept in what Lodestone knows about you: Your path → What Lodestone knows about you.", 5000); }
    }

    if (turn.crisis) {
      // The message is kept as stored, marked: no model reads it, now or on a later turn.
      const um = { threadId: S.thread.id, role: "user", content: redact(text), meta: { crisis: turn.crisis.category, ...(asWritten ? { asWritten: true } : {}), ...(files.length ? { files: storedFiles(files) } : {}) } };
      um.id = await store.messages.add(um);
      const am = { threadId: S.thread.id, role: "assistant", content: turn.reply, meta: { crisis: turn.crisis.category, model: "crisis-template" } };
      am.id = await store.messages.add(am);
      S.history.push(um, am);
      await touchThread();
      renderChat();
      return;
    }
    const { tier, fitted, w, web, sources, images } = turn;

    const um = { threadId: S.thread.id, role: "user", content: redact(text), meta: { ...(turn.care ? { care: turn.care.level } : {}), ...(asWritten ? { asWritten: true } : {}), ...(files.length ? { files: storedFiles(files) } : {}) } };
    um.id = await store.messages.add(um);
    S.history.push(um);
    recallAdd(um);
    const chat = $("#chat");
    if (chat.querySelector(".empty")) chat.innerHTML = "";
    const unode = msgNode(um);
    chat.append(unode);

    if (S.engine.kind === "reader") {
      const rm = { threadId: S.thread.id, role: "assistant", content: readerReply(turn.hits), meta: { sources, model: "corpus-only" } };
      rm.id = await store.messages.add(rm);
      S.history.push(rm);
      chat.append(msgNode(rm)); chat.scrollTop = chat.scrollHeight;
      await touchThread();
      noticesDone = true;
      await addNotices(turn, S.thread.id, n => { S.history.push(n); chat.append(msgNode(n)); });   // no model here: the care line is the only safety net
      return;
    }

    const am = { threadId: S.thread.id, role: "assistant", content: "", meta: { sources, web: web.map(r => ({ title: r.title, url: r.url })), yours: turn.yours, model: S.engine.describe(), witness: w?.strength || null, ...(turn.recalled?.length ? { recalled: turn.recalled } : {}), ...(turn.care ? { care: turn.care.level } : {}) } };
    // Spoken as it is written, when the mode asks for it (never in witness mode, never a crisis reply: those never reach here).
    // Not spoken: witness mode, and a care moment (1.13.1), read rather than heard in passing.
    const speak = wantsSpeech(spoke) && !w && !turn.care && (await startSpeaking(am, detectLang(text, S.settings.lang || "auto")));
    if (speak && voiceSettings().mode === "voice") voiceOnly.add(am);
    const node = msgNode(am); chat.append(node);
    const body = node.querySelector(".body"); body.classList.add("typing");
    followChat(true);

    let out = "";
    const t0 = performance.now();
    // Stop keeps what was written so far, marked as stopped, rather than losing it to an error.
    try {
      // Stop pressed while the turn was being prepared: nothing is asked of the model (1.13.1).
      if (!S.stopRequested) for await (const partial of S.engine.stream(withImages(fitted.messages, images), { maxTokens: tier.maxTokens, web: webViaProvider })) {
        out = partial;
        body.innerHTML = render(stripRetrievalNote(out));
        if (speak && speaker.key === am) speaker.feed(stripRetrievalNote(out));
        followChat();
      }
    } catch (e) {
      if (!S.stopRequested) { node.remove(); throw e; }
    }
    body.classList.remove("typing");
    if (speak && speaker.key === am) { if (S.stopRequested) speaker.stop(); else speaker.feed(stripRetrievalNote(out), true); }
    if (S.stopRequested) am.meta.stopped = true;
    out = stripRetrievalNote(out).trim() || (S.stopRequested ? "(stopped before answering)" : "…");
    guard.clear();   // it loaded and answered: nothing for the loop guard to catch
    am.content = out; am.meta.ms = Math.round(performance.now() - t0);
    const usage = usageNow();
    if (usage) am.meta.usage = usage;
    const label = currentModelLabel();
    if (label) am.meta.modelLabel = label;
    am.id = await store.messages.add(am);
    S.history.push(am);
    chat.querySelectorAll(".last-only").forEach(b => b.remove());   // Retry and Edit move to the new last exchange
    node.replaceWith(msgNode(am));
    if (unode.isConnected) unode.replaceWith(msgNode(um));
    await touchThread();
    noticesDone = true;
    await addNotices(turn, S.thread.id, n => { S.history.push(n); chat.append(msgNode(n)); followChat(true); });
    renderCostLine();
    capWarn();
    afterTurn(turn);
    scheduleSummary(S.thread, S.history, turn.fitted);
  } catch (e) {
    console.error(e);
    toast(`Something failed: ${e.message || e}`);
    // The answer failed, the care line does not: it was never the model's to give.
    if (turnForNotice?.care?.level === "refer" && !noticesDone && S.thread) {
      noticesDone = true;
      await addNotices({ ...turnForNotice }, S.thread.id, n => { S.history.push(n); $("#chat").append(msgNode(n)); }).catch(() => {});
    }
  } finally {
    S.busy = false; setSending(false);
    if (threadsDocked()) renderThreadList();
    syncSoon(5000);
    maybeLearn();
  }
}

// ─── After an answer: the care line and the pause bell (1.13) ───────────────
// Neither is written by a model, neither is sent to one (meta.notice).

/** Adds the notices this turn calls for to the thread; `show` receives each stored message. */
async function addNotices(turn, threadId, show, channel = null) {
  const lang = turn.lang || "en";
  const out = [];
  if (turn.care?.level === "refer") out.push({ notice: "care", content: crisisLine(S.profile.country, lang, S.pack.runtime.crisis) });
  // The pause bell: one sitting at a time, on this device, whatever the window or the bot.
  const st = presence.advanceSitting(await store.kv.get("sitting").catch(() => null));
  await store.kv.set("sitting", st.state);
  if (st.ring) out.push({ notice: "bell", content: presence.bellText(lang, Date.now() - st.state.start) });
  for (const n of out) {
    const m = { threadId, role: "assistant", content: n.content, meta: { notice: n.notice, model: "notice", ...(channel ? { channel } : {}) } };
    m.id = await store.messages.add(m);
    show(m);
    if (n.notice === "bell" && T.on) talkEnd("A pause: the conversation by voice ends here.");
  }
}

// ─── Recall across conversations (1.13) ──────────────────────────────────────
// The practitioner's own words in earlier conversations, and what each
// conversation held (its summary), embedded on this device by the meaning model
// retrieval uses, and kept in this device's storage only (never synced: each
// device builds its own). A message brings back the two or three passages that
// bear on it, from other conversations, named under the answer; each can be
// forgotten there. Needs the meaning model: without it nothing is recalled.

const R = { items: new Map(), loaded: false, dirty: false, saveT: null, filling: false };
// On by default where the conversation stays on this device; where a rented model
// or harmonism.io reads each turn, off until chosen (what is recalled would travel too).
const recallOn = () => S.settings.recall ?? !S.where;
const recallEmbed = () => (recallOn() && S.retriever?.embedQuery) || null;

/** One embedding per text: retrieval, the care layer and recall ask for the same message. */
function memoEmbed(fn) {
  const memo = new Map();
  return async t => {
    if (memo.has(t)) return memo.get(t);
    const v = await fn(t);
    memo.set(t, v); if (memo.size > 16) memo.delete(memo.keys().next().value);
    return v;
  };
}

async function recallLoad() {
  // The hidden Telegram page reads the window's index afresh every ten minutes.
  if (R.loaded && !(BRIDGE && Date.now() - R.loaded > 600000)) return;
  R.loaded = Date.now();
  if (BRIDGE) R.items.clear();
  const saved = await store.kv.get("recall:index").catch(() => null);
  for (const it of saved?.items || []) if (it?.v?.length) R.items.set(it.key, it);
}
// Only the window writes the index: the hidden Telegram page reads it, and its
// messages are indexed by the window's next pass, so neither overwrites the other.
function recallSave() {
  if (BRIDGE) return;
  clearTimeout(R.saveT);
  R.saveT = setTimeout(async () => { if (!R.dirty) return; R.dirty = false; await store.kv.set("recall:index", { v: 1, items: [...R.items.values()] }).catch(() => {}); }, 20000);
}

/** A message just stored: indexed in the background. */
function recallAdd(m) {
  const embed = recallEmbed(); if (!embed || !m?.id || BRIDGE) return;
  const text = presence.recallable(m); if (!text) return;
  setTimeout(async () => {
    try { await recallLoad(); R.items.set("m:" + m.id, { key: "m:" + m.id, th: m.threadId, ts: m.ts || Date.now(), kind: "said", text, v: await embed(text) }); R.dirty = true; recallSave(); } catch {}
  }, 1500);
}

/** The backlog: messages and summaries not yet indexed, newest first, a few at a time, out of the way of a conversation. */
let recallT = null;
function recallSoon(ms = 20000) { clearTimeout(recallT); recallT = setTimeout(recallFill, ms); }
async function recallFill() {
  const embed = recallEmbed(); if (!embed || R.filling || BRIDGE) return;
  R.filling = true;
  try {
    await recallLoad();
    const [msgs, threads] = await Promise.all([store.messages.all(), store.threads.list()]);
    const gone = new Set((await store.kv.get("recall:forgotten")) || []);
    // What sync or another page deleted leaves the index too.
    const alive = new Set(threads.map(t => t.id)), ids = new Set(msgs.map(m => "m:" + m.id));
    for (const [k, it] of R.items) if (!alive.has(it.th) || (k.startsWith("m:") && !ids.has(k)) || gone.has(k)) { R.items.delete(k); R.dirty = true; }
    const todo = [];
    // A conversation that held a moment of crisis or care is not recalled by its summary (1.13.1).
    const tender = new Set(msgs.filter(m => m.meta?.crisis || m.meta?.care).map(m => m.threadId));
    for (const [k, it] of R.items) if (k.startsWith("s:") && tender.has(it.th)) { R.items.delete(k); R.dirty = true; }
    for (const t of threads) if (t.summary && !tender.has(t.id) && !gone.has("s:" + t.id) && R.items.get("s:" + t.id)?.through !== t.summaryThrough) todo.push({ key: "s:" + t.id, th: t.id, ts: t.updated || 0, kind: "summary", text: String(t.summary).slice(0, 900), through: t.summaryThrough });
    const said = msgs.filter(m => !R.items.has("m:" + m.id) && !gone.has("m:" + m.id)).map(m => ({ m, text: presence.recallable(m) })).filter(x => x.text).sort((a, b) => (b.m.ts || 0) - (a.m.ts || 0)).slice(0, 2000);
    for (const { m, text } of said) todo.push({ key: "m:" + m.id, th: m.threadId, ts: m.ts || 0, kind: "said", text });
    let n = 0;
    for (const it of todo) {
      while (S.busy) await new Promise(r => setTimeout(r, 3000));
      R.items.set(it.key, { ...it, v: await embed(it.text) }); R.dirty = true;
      if (++n % 8 === 0) { recallSave(); await new Promise(r => setTimeout(r, 120)); }
    }
    recallSave();
  } catch (e) { console.warn("[recall] index:", e.message || e); }
  finally { R.filling = false; }
}

async function recallFor(text, threadId) {
  const embed = recallEmbed(); if (!embed || text.length < 8) return [];
  await recallLoad();
  if (!R.items.size) { recallSoon(3000); return []; }
  const [q, threads, forgotten] = await Promise.all([embed(text), store.threads.list(), store.kv.get("recall:forgotten")]);
  const alive = new Map(threads.map(t => [t.id, t]));
  const picked = presence.pickRecall([...R.items.values()], q, { exclude: threadId, forgotten: new Set(forgotten || []), alive, text });
  return picked.map(it => ({ ...it, title: alive.get(it.th)?.title || "A conversation", date: new Date(it.ts || alive.get(it.th)?.updated || Date.now()).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) }));
}

/** Messages taken back, conversations deleted: out of the index, and off the disk at the next save. */
async function recallDrop(keys) {
  await recallLoad();
  let n = 0; for (const k of keys) if (R.items.delete(k)) n++;
  if (n) { R.dirty = true; recallSave(); }
}
async function recallDropThread(threadId) {
  await recallLoad();
  let n = 0; for (const [k, it] of R.items) if (it.th === threadId) { R.items.delete(k); n++; }
  if (n) { R.dirty = true; recallSave(); }
}

async function recallForget(key) {
  const f = new Set((await store.kv.get("recall:forgotten")) || []);
  f.add(key);
  await store.kv.set("recall:forgotten", [...f]);
  R.items.delete(key); R.dirty = true; recallSave();
}

// ─── Telegram bridge ─────────────────────────────────────────────────────────
// In the desktop app, a hidden copy of this page (?bridge=telegram) answers the
// practitioner's own Telegram bot (desktop/src/telegram.js): the same crisis
// gate, retrieval, witness mode, memory and practices, written to the same
// store, so the conversation appears in the window's thread list. Requests are
// answered one at a time.

const BRIDGE = DESKTOP && new URLSearchParams(location.search).get("bridge") === "telegram";
const TG_THREAD = "telegram-thread";
let bridgeQueue = Promise.resolve();

async function startBridge() {
  const installed = await corpusPack.isInstalled();
  if (!installed || !desktopConfigured()) {
    DESKTOP.onBridgeRequest(r => DESKTOP.bridgeReply(r.id, false, "Open Lodestone on your computer once, so it can finish setting up."));
    return DESKTOP.bridgeReady();
  }
  const { corpus, runtime, embeddings } = await corpusPack.load();
  S.pack = { runtime, corpus };
  S.retriever = new Retriever({ corpus, runtime, embeddings });
  if (embeddings && S.settings.semantic !== false) {
    S.embedder = new Embedder();
    S.embedder.start().then(() => { S.retriever.embedQuery = memoEmbed(t => S.embedder.embed(t)); recallSoon(); })
      .catch(e => console.warn("[semantic] unavailable in the bridge, keyword retrieval only:", e.message));
  }
  S.engine = makeEngine(); S.engineReady = true;
  DESKTOP.onBridgeRequest(r => {
    bridgeQueue = bridgeQueue.then(async () => {
      try { await DESKTOP.bridgeReply(r.id, true, await bridgeHandle(r)); }
      catch (e) { await DESKTOP.bridgeReply(r.id, false, String(e.message || e)); }
    });
  });
  await DESKTOP.bridgeReady();
}

async function bridgeThread(fresh = false) {
  const id = fresh ? null : await store.kv.get(TG_THREAD);
  let th = id ? await store.threads.get(id) : null;
  if (!th) {
    th = await store.threads.create(`Telegram · ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`);
    await store.kv.set(TG_THREAD, th.id);
  }
  return th;
}

async function bridgeHandle(r) {
  // The window may have changed these since the last request.
  S.profile = (await store.kv.get("profile")) || {};
  S.wheel = (await store.kv.get("wheel")) || {};
  S.practices = (await store.kv.get("practices")) || [];
  S.assessment = (await store.kv.get("assessment")) || null;
  S.where = (await DESKTOP.info().catch(() => ({}))).remote?.host || null;
  await loadPathState();

  if (r.kind === "new") { await bridgeThread(true); return true; }

  // Writing first through the practitioner's own bot (telegram.js asks while it is in waking hours).
  if (r.kind === "outreach") {
    // The weekly review first, when it is due and this device has not written it (1.13).
    const wk = await composeReview("telegram").catch(() => null);
    if (wk) { await storeReview(wk); return wk.text; }
    const o = await composeOutreach("telegram");
    if (!o) return null;
    const th = await bridgeThread();
    await store.messages.add({ threadId: th.id, role: "assistant", content: o.text, meta: { outreach: o.type, channel: "telegram", model: S.engine.describe(), ...(o.usage ? { usage: o.usage } : {}) } });
    th.updated = Date.now(); await store.threads.put(th);
    return o.text;
  }

  if (r.kind === "due") return duePractices().map(p => ({ id: p.id, pillar: cap(p.pillar), text: p.text }));

  if (r.kind === "checkin") {
    const p = S.practices.find(x => String(x.id) === String(r.practiceId));
    if (!p) return "That practice is no longer on your list.";
    if (r.status === "talk") return p.text;
    if (!["held", "partly", "not"].includes(r.status)) return "Noted.";
    p.log = p.log || []; p.log.push({ ts: Date.now(), status: r.status });
    p.lastCheckin = Date.now();
    await savePractices();
    return r.status === "held" ? "Noted: it held." : r.status === "partly" ? "Noted: partly." : "Noted: it did not hold.";
  }

  if (r.kind !== "message") throw new Error("Unknown request.");
  let text = String(r.text || "").trim().slice(0, 8000);
  // A file sent to the bot (telegram.js): read here as the window reads an attachment.
  let files = [];
  if (r.file?.bytes) {
    const file = new File([r.file.bytes], String(r.file.name || "file").slice(0, 200), { type: String(r.file.type || "") });
    const info = await DESKTOP.info().catch(() => ({}));
    const kind = kindOf(file);
    if (kind === "audio" && !info.asr) return "To read recordings, Lodestone needs its speech model, downloaded once on the computer: attach a recording in Lodestone's window there the first time, then send them here.";
    const vision = info.vision?.state || "no";
    if (kind === "image" && !(vision === "yes" || vision === "maybe")) return vision === "download"
      ? "To see photos, the model needs its vision component, downloaded once on the computer: attach an image in Lodestone's window there the first time."
      : `${info.label || "The model in use"} cannot see images. A Gemma model, or a rented model such as Claude, can.`;
    const language = speechLanguage(S.settings.lang && S.settings.lang !== "auto" ? S.settings.lang : navigator.language);
    const data = await readAttachment(file, { canSee: vision === "yes" || vision === "maybe", language, convert: convertFile });
    if (!data.text?.trim() && !data.images?.length) return kind === "audio" ? "Nothing could be heard in it." : `Nothing readable in ${file.name}.`;
    // A voice message with nothing written is what was said.
    if (r.file.voice && !text && data.text && data.text.length < 4000) text = data.text.trim();
    else { files = [data]; if (!text) text = `Read ${file.name}.`; }
  }
  if (!text) return "…";
  // The privacy gate, with no one to ask: what leaves for a model elsewhere goes without its secrets.
  let gateNote = "";
  if (S.where && !isHPCode(text)) {
    const found = scanMessage(text, files);
    if (found.length) {
      ({ text, files } = leaveOutMessage(text, files));
      gateNote = `(Before sending to ${S.where}, Lodestone left out ${[...new Set(found.map(f => f.label))].join(", ")} it found${found.some(f => f.where !== "your message") ? " in what you attached" : ""}.)\n\n`;
    }
  }
  // Key memories read the message as it will leave, secrets out (1.13.1).
  const keepTg = rememberAsked(text);
  // The month's limit on rented models holds here as in the window (1.13.1).
  if (!isHPCode(text) && S.where && S.where !== "harmonism.io") {
    S.settings = { ...S.settings, ...((await store.kv.get("settings")) || {}) };
    const capUsd = Number(S.settings.spendCap) || 0;
    if (capUsd > 0 && (await monthSpend()) >= capUsd) return `This month's limit for rented models (${fmtCost(capUsd)}) is reached. Raise it in Lodestone's Settings on your computer, or wait for the new month.`;
  }
  const th = await bridgeThread();
  const hp = await ingestHPCode(text);
  if (hp) {
    await store.messages.add({ threadId: th.id, role: "user", content: "(Harmonic Profile code)", meta: { channel: "telegram" } });
    await store.messages.add({ threadId: th.id, role: "assistant", content: hp, meta: { model: "harmonic-profile", channel: "telegram" } });
    th.updated = Date.now(); await store.threads.put(th);
    return hp;
  }
  const history = await store.messages.forThread(th.id);
  await S.summaryJob;
  const notesTg = S.profile.notes;
  if (keepTg) S.profile.notes = withMemory(notesTg, keepTg);
  const turn = await prepareTurn(text, history, { summary: threadSummary(th, history), files });
  if (keepTg) { S.profile.notes = notesTg; if (!turn.crisis && !turn.care) await keepMemory(keepTg); }
  const tgUid = await store.messages.add({ threadId: th.id, role: "user", content: redact(text), meta: { channel: "telegram", ...(turn.crisis ? { crisis: turn.crisis.category } : {}), ...(turn.care ? { care: turn.care.level } : {}), ...(files.length ? { files: storedFiles(files) } : {}) } });

  if (turn.crisis) {
    await store.messages.add({ threadId: th.id, role: "assistant", content: turn.reply, meta: { crisis: turn.crisis.category, model: "crisis-template", channel: "telegram" } });
    th.updated = Date.now(); await store.threads.put(th);
    return turn.reply;
  }
  let out = "";
  const t0 = performance.now();
  try {
    for await (const partial of S.engine.stream(withImages(turn.fitted.messages, turn.images), { maxTokens: turn.tier.maxTokens })) out = partial;
  } catch (e) {
    // The answer failed; the crisis line does not depend on it (1.13.1).
    if (turn.care?.level === "refer") return `Lodestone could not answer just now (${e.message || e}).\n\n${crisisLine(S.profile.country, turn.lang || "en", S.pack.runtime.crisis)}`;
    throw e;
  }
  const tgUsage = usageNow(), tgLabel = currentModelLabel();
  setTimeout(() => afterTurn(turn), 0);
  out = stripRetrievalNote(out).trim() || "…";
  await store.messages.add({ threadId: th.id, role: "assistant", content: out, meta: { ...(turn.recalled?.length ? { recalled: turn.recalled } : {}), ...(turn.care ? { care: turn.care.level } : {}), sources: turn.sources, model: S.engine.describe(), witness: turn.w?.strength || null, channel: "telegram", ms: Math.round(performance.now() - t0), ...(tgUsage ? { usage: tgUsage } : {}), ...(tgLabel ? { modelLabel: tgLabel } : {}) } });
  th.updated = Date.now(); await store.threads.put(th);
  const notes = [];
  await addNotices(turn, th.id, n => notes.push(n.content), "telegram");
  scheduleSummary(th, await store.messages.forThread(th.id), turn.fitted);
  const idx = new Map(S.pack.corpus.articles.map(a => [a.p, a]));
  const read = turn.sources.map(s => idx.get(s)).filter(Boolean).slice(0, 4).map(a => a.u ? `[${a.t}](${a.u})` : a.t);
  return gateNote + (read.length ? `${out}\n\nDrawn from: ${read.join(" · ")}` : out) + notes.map(n => `\n\n${n}`).join("");
}

async function touchThread() {
  S.thread.updated = Date.now();
  await store.threads.put(S.thread);
}

// ─── The discussion summary ──────────────────────────────────────────────────
// The turns the summary does not yet cover are folded into it, all but the
// newest, which stay sent one by one. The summary is kept with the thread and
// sent in place of the folded turns. It runs after the reply is on screen, on
// the model the practitioner is already using, and never on harmonism.io's
// hosted models: a summary there would spend the daily allowance on a message
// nobody sent.
//
// When (October 19, 2026, after Goose's compaction): once SUMMARY_AFTER turns
// are pending, or as soon as the last turn's history filled COMPACT_AT of the
// room the window left for it, or dropped turns the summary did not hold. On
// an 8k window the old count alone (40 turns) let turns fall out of the window
// unsummarized, lost to the model. What stays unfolded is the newest turns
// that fill KEEP_SHARE of that room, at least KEEP_MIN and at most
// SUMMARY_KEEP. A summary call too long for the window is retried with each
// turn cut shorter, then with fewer turns (the oldest first); what is left
// waits for the next fold.
const SUMMARY_MAX_TOKENS = 900;   // thresholds: prompt.js summaryPlan()

// The summary's cut-off is the time of the last turn it holds (summaryThroughTs, 1.13.1): message ids
// are each device's own, so the id it used to be left the other devices sending no recent turns at all.
// A summary made before then, on this device, finds its last turn by id; from another device, it has no cut-off.
const throughOf = (th, history = S.history) => th?.summaryThroughTs || (th?.summaryThrough ? (history.find(m => m.id === th.summaryThrough && m.threadId === th.id)?.ts || 0) : 0);
const threadSummary = (th, history) => (th?.summary ? { text: th.summary, through: throughOf(th, history) } : null);

function scheduleSummary(thread, history, fit = null) {
  if (!thread || S.summaryJob || !S.engineReady || S.engine?.kind === "reader" || S.engine?.kind === "hosted" || S.where === "harmonism.io") return;
  const through = throughOf(thread, history);
  const pending = history.filter(m => (m.ts || 0) > through && !m.meta?.crisis && !m.meta?.notice);
  const fold = summaryPlan(pending, fit);
  if (!fold) return;
  const titles = new Map(S.pack.corpus.articles.map(a => [a.p, a.t]));
  const tier = S.engine?.tier || TIERS[S.settings.tier] || { ctx: 8192 };
  const room = tier.ctx - SUMMARY_MAX_TOKENS - 64;
  const job = (async () => {
    try {
      // Cut each turn shorter, then fold fewer turns, until the request fits the window.
      let turns = fold, messages = null;
      for (const maxChars of [1800, 900, 400]) {
        messages = summaryRequest({ previous: thread.summary || "", turns, titleOf: p => titles.get(p), maxChars });
        if (estTokens(messages.map(m => m.content).join("\n")) <= room) break;
        messages = null;
      }
      while (!messages && turns.length > 2) {
        turns = turns.slice(0, Math.max(2, Math.floor(turns.length * 0.6)));
        const m = summaryRequest({ previous: thread.summary || "", turns, titleOf: p => titles.get(p), maxChars: 400 });
        if (estTokens(m.map(x => x.content).join("\n")) <= room) messages = m;
      }
      if (!messages) return;
      let out = "";
      for await (const partial of S.engine.stream(messages, { maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.2, background: true })) out = partial;
      addSideUsage(thread, usageNow(true));
      out = renderSummary(stripRetrievalNote(out));
      if (out.length < 40) { if (thread.side) await store.threads.put(thread); return; }
      thread.summary = out; thread.summaryThrough = turns[turns.length - 1].id; thread.summaryThroughTs = turns[turns.length - 1].ts || Date.now(); thread.summaryAt = Date.now();
      await store.threads.put(thread);
      if (thread === S.thread) renderChat();
    } catch (e) { console.warn("[summary]", e); }
  })();
  S.summaryJob = job;
  job.finally(() => { if (S.summaryJob === job) S.summaryJob = null; });
}

// The chat follows an answer as it is written until the reader scrolls up; it
// leaves them where they are, and follows again once they are back at the bottom
// or send the next message. Instant jumps: a smooth scroll would fight the reader.
let chatFollow = true, chatOwn = false;
function followChat(force = false) {
  const c = $("#chat"); if (!c) return;
  if (force) chatFollow = true;
  if (!chatFollow || Math.abs(c.scrollTop - (c.scrollHeight - c.clientHeight)) < 1) return;
  chatOwn = true;
  c.scrollTo({ top: c.scrollHeight, behavior: "instant" });
}
function watchChatScroll() {
  const c = $("#chat");
  c.addEventListener("scroll", () => { if (chatOwn) { chatOwn = false; return; } chatFollow = c.scrollHeight - c.scrollTop - c.clientHeight < 24; }, { passive: true });
  c.addEventListener("wheel", e => { if (e.deltaY < 0) chatFollow = false; }, { passive: true });
}

// A summary in progress, waited for, but no longer than Stop or a minute and a
// half (1.13.1): before, Stop did nothing until the summary was done.
async function summaryOrStop(ms = 90000) {
  if (!S.summaryJob) return;
  let timer;
  const stopped = new Promise(res => { const t0 = Date.now(); timer = setInterval(() => { if (S.stopRequested || Date.now() - t0 > ms) res(); }, 200); });
  try { await Promise.race([S.summaryJob.catch(() => {}), stopped]); } finally { clearInterval(timer); }
}

function stopAnswer() { if (!S.busy) return; S.stopRequested = true; S.engine?.interrupt(); speaker.stop(); }

// ─── Spoken replies ──────────────────────────────────────────────────────────
// The four modes of Settings → Spoken replies (voice.js): text, voice (spoken,
// the text folded away under the voice row), both, mirror (spoken when the
// practitioner dictated the message). Any answer can be heard with Listen.

const voiceOnly = new WeakSet();   // answers shown folded while spoken, in this window only
const voiceSettings = () => ({ mode: "text", gender: "female", names: {}, rate: 1, family: "grok", ...(S.settings.voice || {}) });
function wantsSpeech(spoke) {
  if (!voice.available() && !speakViaProvider() && !hasVoiceRoute()) return false;
  if (T.on) return true;   // a conversation by voice is spoken, whatever the mode
  const m = voiceSettings().mode;
  return m === "voice" || m === "both" || (m === "mirror" && !!spoke);
}

function onSpeakState(on, key) {
  if (!on && T.on && T.phase === "speaking") setTimeout(() => { if (T.on && T.phase === "speaking" && !speaker.active) talkListen(); }, 250);
  document.querySelectorAll(".listen-btn").forEach(b => { const me = b._msg === key || b._msg === speaker.key; b.textContent = me && speaker.active ? "Stop" : "Listen"; b.classList.toggle("on", me && speaker.active); });
  document.querySelectorAll(".voice-row").forEach(r => { const me = r._msg === speaker.key && speaker.active; r.querySelector(".vr-state").textContent = me ? "Lodestone is speaking" : "Spoken"; r.querySelector(".vr-stop").hidden = !me; });
}
// A natural voice, else the device's own: one speaks, the other is silent.
const deviceSpeaker = new voice.Speaker(onSpeakState);
const cloudSpeaker = new CloudSpeaker(onSpeakState, e => toast(`Not read aloud: ${e.message || e}`, 6000));
let speaker = deviceSpeaker;

// A phone's browser speaks only after a gesture; the click that sends is one.
function primeSpeech() {
  cloudSpeaker.prime();   // the natural voice is settled only when the answer begins: both are unlocked
  try { if (!S.speechPrimed) { speechSynthesis.speak(new SpeechSynthesisUtterance("")); S.speechPrimed = true; } } catch {}
}

async function startSpeaking(m, lang) {
  const v = voiceSettings();
  const plan = await voicePlan().catch(() => null);
  if (plan) {
    deviceSpeaker.stop(); speaker = cloudSpeaker;
    try { cloudSpeaker.start({ provider: plan.route, ctx: plan.ctx, family: plan.family, gender: v.gender, lang, rate: Number(v.rate) || 1, key: m }); }
    catch (e) { toast(`Not read aloud: ${e.message || e}`, 6000); return false; }
    return true;
  }
  cloudSpeaker.stop(); speaker = deviceSpeaker;
  const list = await voice.voices();
  const chosen = voice.pickVoice(list, lang, v.gender, v.names?.[lang] || "");
  if (!chosen) { const c = voice.pickVoice(list, "en", v.gender); if (!c && !list.length) { toast("This computer offers no voice to speak with.", 5000); return false; } }
  speaker.start({ voice: chosen || voice.pickVoice(list, "en", v.gender), lang, rate: Number(v.rate) || 1, key: m });
  return true;
}

function listenButton(m) {
  const b = el("button", { type: "button", class: "listen-btn", title: "Hear this answer" }, speaker.active && speaker.key === m ? "Stop" : "Listen");
  b._msg = m;
  b.onclick = async () => {
    if (speaker.active && speaker.key === m) { speaker.stop(); return; }
    if (await startSpeaking(m, detectLang(m.content, S.settings.lang || "auto"))) speaker.feed(m.content, true);
  };
  return b;
}

function setSending(on) {
  const b = $("#sendBtn");
  b.classList.toggle("stop", on);
  b.setAttribute("aria-label", on ? "Stop" : "Send");
  b.innerHTML = on ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';
}

// ─── Retry and edit: the last exchange only ──────────────────────────────────
// Earlier turns stay as they were said; only the last question and its answer
// can be taken back. An exchange with attachments cannot: their text is not kept.

// The exchange ends before the notices the app added after it (the care line, the pause bell).
const pairEnd = () => { const h = S.history; let k = h.length; while (k && h[k - 1].meta?.notice) k--; return k; };
const lastUser = () => { const h = S.history, k = pairEnd(); return k >= 2 && h[k - 1].role === "assistant" && h[k - 2].role === "user" ? h[k - 2] : null; };
function isLastPair(m) {
  const h = S.history, a = h[pairEnd() - 1], u = lastUser();
  return !!u && !a.meta?.crisis && !["harmonic-profile", "crisis-template"].includes(a.meta?.model) && (m === a || m === u);
}

async function takeBackLast() {
  if (S.busy) { toast("Wait for this answer to finish."); return null; }
  const u = lastUser(), k = pairEnd();
  if (!u) return null;
  const gone = S.history.slice(k - 2);
  for (const m of gone) await store.messages.del(m.id);
  S.history.splice(k - 2);
  recallDrop(gone.map(m => "m:" + m.id));
  renderChat(); renderCostLine(); syncSoon();
  return u;
}

async function retryLast() {
  // Nothing is taken back unless it can be asked again now (1.13.1): the model ready, nothing else under way.
  if (S.busy || sendingNow) { toast("Wait for this answer to finish."); return; }
  if (!S.engineReady) { toast("The model is not ready yet; the exchange stays as it is.", 4000); return; }
  const u = await takeBackLast(); if (u) { S.retrying = true; try { await send(u.content); } finally { S.retrying = false; } } }

async function editLast() {
  const input = $("#input");
  if (input.value.trim() && !confirm("Replace what is in the message box with your last message?")) return;
  const u = await takeBackLast(); if (!u) return;
  input.value = u.content; autosize(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
}

// ─── Monthly limit on rented models ──────────────────────────────────────────
// Optional (Settings → Usage and costs). Counted on this device from the cost
// each answer reports, including answers synced from other devices; OpenRouter
// still bills what it bills, so its own limit on the key is the hard one.

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
async function monthSpend() {
  const since = monthStart();
  let c = 0;
  for (const m of await store.messages.all()) if ((m.ts || 0) >= since && m.meta?.usage?.cost != null) c += m.meta.usage.cost;
  for (const t of await store.threads.list()) {
    if (t.side?.log) { for (const x of t.side.log) if (x.ts >= since) c += x.cost || 0; }
    else if (t.side?.cost && (t.summaryAt || t.updated || 0) >= since) c += t.side.cost;   // before 1.13.1: one total
  }
  // What learning cost, read again from the store (the Telegram page writes it too).
  const L = (await store.kv.get("learned")) || {};
  for (const x of L.costLog || []) if ((x.ts || 0) >= since && x.cost != null) c += x.cost;
  return c;
}
const rented = () => S.engine?.kind === "openrouter" || (DESKTOP && S.models?.current?.kind === "remote");

async function capReached() {
  const cap = Number(S.settings.spendCap) || 0;
  $("#capCard").hidden = true;
  if (!(cap > 0) || !rented()) return false;
  const spent = await monthSpend();
  if (spent < cap) return false;
  const next = Math.max(cap * 2, Math.ceil(spent + 1));
  const card = $("#capCard");
  card.replaceChildren(
    el("span", {}, el("strong", {}, "Monthly limit reached. "), `Rented models have cost ${fmtCost(spent)} this month, of the ${fmtCost(cap)} you set. Your message is kept.`),
    el("span", { class: "spacer" }),
    el("button", { type: "button", onclick: async () => { S.settings.spendCap = next; await store.kv.set("settings", S.settings); card.hidden = true; toast(`Limit raised to ${fmtCost(next)} for this month and after.`, 4000); } }, `Raise to ${fmtCost(next)}`),
    el("button", { type: "button", onclick: () => { card.hidden = true; renderSettings(); openDrawer("#drawerSettings"); setTimeout(() => $("#setCap")?.focus(), 200); } }, "Settings"),
    el("button", { type: "button", class: "x", "aria-label": "Dismiss", onclick: () => { card.hidden = true; } }, "×"));
  card.hidden = false;
  return true;
}

async function capWarn() {
  const cap = Number(S.settings.spendCap) || 0;
  if (!(cap > 0) || !rented()) return;
  const spent = await monthSpend(), key = "lodestone-cap-warned";
  let warned = ""; try { warned = localStorage.getItem(key) || ""; } catch {}
  const tag = `${monthStart()}:${cap}`;
  if (spent >= cap * 0.8 && spent < cap && warned !== tag) {
    toast(`Rented models have cost ${fmtCost(spent)} this month: 80% of your ${fmtCost(cap)} limit.`, 6000);
    try { localStorage.setItem(key, tag); } catch {}
  }
}

/**
 * Practices written from this page, merged with what the store holds now (1.13.1):
 * the Telegram page records check-ins in the same store, and this page's copy
 * may be older. Practices are united by id, their check-ins by time.
 */
async function savePractices() {
  const fresh = (await store.kv.get("practices")) || [];
  const byId = new Map(fresh.map(p => [String(p.id), p]));
  const out = (S.practices || []).map(p => {
    const f = byId.get(String(p.id)); byId.delete(String(p.id));
    if (!f) return p;
    const log = [...(f.log || []), ...(p.log || [])].filter((x, i, a) => a.findIndex(y => y.ts === x.ts && y.status === x.status) === i).sort((a, b) => a.ts - b.ts);
    // The same object, updated (1.13.1): a card holding it keeps acting on the saved one.
    return Object.assign(p, { ...f, ...p, log, lastCheckin: Math.max(f.lastCheckin || 0, p.lastCheckin || 0) || undefined });
  });
  S.practices = [...out, ...byId.values()];
  await store.kv.set("practices", S.practices);
}

/** An imported memory joined with this device's (1.13.1): the notes' lines united, a name or country kept where set here. */
function importMerge(k, mine, theirs) {
  if (k === "profile") {
    const lines = [...String(mine.notes || "").split("\n"), ...String(theirs.notes || "").split("\n")].map(l => l.trimEnd()).filter((l, i, a) => l.trim() && a.indexOf(l) === i);
    return { ...theirs, ...mine, name: mine.name || theirs.name, country: mine.country || theirs.country, notes: lines.join("\n") };
  }
  if (k === "assessment" || k === "hp_code") return mine || theirs;
  return syncMerge("k:" + k, mine, theirs);
}

/** A memory kept: added to the notes as the store holds them now, not to this page's older copy (1.13.1). */
async function keepMemory(text) {
  const fresh = (await store.kv.get("profile")) || {};
  fresh.notes = withMemory(fresh.notes, text);
  S.profile = { ...S.profile, ...fresh };
  await store.kv.set("profile", S.profile); syncSoon();
}

/** What a kept memory adds to the notes: a dated line in their own words, never a key. */
function withMemory(notes, text) {
  const day = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  notes = (notes || "").trim();
  return (notes ? notes + "\n" : "") + "• " + leaveOut(text.trim()) + ` (${day})`;   // these notes go with every turn: no key, password, card or IBAN (1.13.1)
}

async function remember(text, { quiet = false } = {}) {
  await keepMemory(text);
  if (!quiet) toast("Added to what Lodestone knows about you: Your path → What Lodestone knows about you.", 5000);
}

/**
 * Key memories (1.13, after Kindroid's): "remember that …" at the start of a
 * message keeps what follows in what Lodestone always knows, in the
 * practitioner's own words; the message still goes, and the answer has it.
 */
function rememberAsked(text) {
  // A fact about themselves, said as one (1.13.1): "remember that…", "remember: …",
  // "remember, …", "I want you to remember that…", "remember I'm vegetarian",
  // "remember my daughter is called Noor". Not "remember when…",
  // "remember to breathe", "remember the exercise you gave me", "remember that
  // time…", nor their French, Spanish and Arabic kin: those carry no "that".
  const t = String(text || "").replace(/[’‘ʼ´`]/g, "'");
  const bare = /^\s*(?:please\s+|lodestone,?\s+)?(?:(?:i want you to|i'd like you to|can you|could you|please)\s+)?(?:remember|don't forget|never forget|keep in mind)\s+(?=(?:i'm|i am|i've|i have|i was|i don't|i can't|i work|i live|my|we|we're|we've|our)\s)(.{4,600})$/is.exec(t);
  const m = bare || /^\s*(?:please\s+|lodestone,?\s+)?(?:(?:i want you to|i'd like you to|can you|could you|please)\s+)?(?:remember|don't forget|never forget|keep in mind)(?:\s+that\s+|\s*[:,]\s+)(.{4,600})$/is.exec(t)
    || /^\s*(?:souviens[- ]toi|rappelle[- ]toi|retiens|n'oublie pas|garde en t[êe]te)(?:\s+que\s+|\s+qu'|\s*[:,]\s+)(.{4,600})$/is.exec(t)
    || /^\s*(?:recuerda|acu[ée]rdate de|no olvides|ten en cuenta)(?:\s+que\s+|\s*[:,]\s+)(.{4,600})$/is.exec(t)
    || /^\s*(?:تذكر|تذكّر|لا تنس)(?:\s+(?:أن|ان)\s+|\s*[:،,]\s+)(.{4,600})$/s.exec(t);
  if (!m) return null;
  const fact = m[1].trim();
  // Without "that" or a colon, only a sentence ("remember my daughter is Noor"), not a thing ("remember my birthday").
  if (m === bare && !/\b(?:is|are|am|was|were|have|has|had|do|does|don't|doesn't|can't|won't|work|live|like|love|hate|need)\b|'m\b|'re\b|'ve\b/i.test(fact)) return null;
  if (/^(?:time|day|moment|night|when|how|la fois|le jour|quand|la vez|el día|cuando|عندما)\b/i.test(fact) || /\?\s*$/.test(fact)) return null;
  return fact.length >= 4 ? fact : null;
}


// ─── The life book ───────────────────────────────────────────────────
// Lodestone's own folder in the practitioner's vault (<vault>/Lodestone/), on
// Lodestone Desktop only. Read on every turn: a note whose keys come up is placed
// in the context whole (lifebook.js, after SillyTavern's lore books). Written
// only when the practitioner presses Keep on a card: from the learning cadence,
// which proposes what is worth keeping, or from "Keep in my life book" on one of
// their messages. The desktop app writes the change inside that folder only,
// with a backup, and reads it back (desktop/src/lifebook.js).
let lbCache = { at: 0, entries: [] };
const lbSticky = new Map();   // thread id → (note → turns it stays)
// In the web app and on the phone the life book is the copy Lodestone
// Desktop keeps in sync ("lifebook"): read for recall, and Keep queues the
// change there for the desktop to write; nothing on a phone writes to the vault.
function lifeBookOn() { return DESKTOP ? !!(DESKTOP.lifebookEntries && S.lifeBook?.vault) : !!S.lbMirror?.notes?.length; }
const LB_MIRROR_CAP = 400000;   // characters of notes carried to other devices; past it, the largest notes stay on the computer
async function loadLifeBookMirror() { S.lbMirror = (await store.kv.get("lifebook")) || null; }

/** Desktop: keep the synced copy of the notes in step with the folder. */
async function mirrorLifeBook(entries) {
  if (!DESKTOP || !S.lifeBook?.vault) return;
  const m = (await store.kv.get("lifebook")) || { notesAt: 0, notes: [], queue: [], applied: [] };
  let used = 0;
  const notes = [...entries].sort((a, b) => a.text.length - b.text.length).filter(e => (used += e.text.length) <= LB_MIRROR_CAP)
    .map(e => ({ rel: e.rel, text: e.text, mtime: e.mtime })).sort((a, b) => a.rel.localeCompare(b.rel));
  const sig = x => JSON.stringify(x.map(n => [n.rel, n.mtime]));
  if (sig(notes) === sig(m.notes || [])) return;
  await store.kv.set("lifebook", { ...m, notesAt: Date.now(), notes });
  syncSoon();
}

/** Desktop: write what was kept on another device, once; what cannot be written comes back as a card. */
let lbApplying = false;
async function applyLifeBookQueue() {
  if (!DESKTOP || !S.lifeBook?.vault || lbApplying) return;
  for (let i = 0; i < 240 && !(S.pack && S.learned); i++) await new Promise(r => setTimeout(r, 250));   // at startup: after the corpus and the learning are open
  if (!(S.pack && S.learned)) return;
  const m = await store.kv.get("lifebook");
  if (!m?.queue?.length) return;
  lbApplying = true;
  try {
    const applied = new Set(m.applied || []);
    let wrote = 0;
    for (const q of m.queue) {
      if (applied.has(q.id)) continue;
      try { await DESKTOP.lifebookWrite(q.change); wrote++; }
      catch (e) {
        S.learned.lifeBook = [...(S.learned.lifeBook || []), { ...(q.card || {}), id: q.id + "-again", ts: Date.now(), mine: true, note: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }].slice(-6);
      }
      applied.add(q.id);
    }
    await store.kv.set("lifebook", { ...m, queue: [], applied: [...applied].slice(-300) });
    lbCache.at = 0;
    await mirrorLifeBook(await lifeBookEntries(true));
    if (wrote) toast(`${wrote} change${wrote === 1 ? "" : "s"} kept on another device ${wrote === 1 ? "is" : "are"} now in your life book.`, 6000);
    await saveLearned(); renderCheckins();
  } finally { lbApplying = false; }
}
async function loadLifeBookStatus() { if (!DESKTOP?.lifebookStatus) { S.lifeBook = null; return; } try { S.lifeBook = await DESKTOP.lifebookStatus(); } catch { S.lifeBook = null; } }
async function lifeBookEntries(force = false) {
  if (!lifeBookOn()) return [];
  if (!DESKTOP) return (S.lbMirror?.notes || []).map(n => lifebook.parseEntry(n.rel, n.text, n.mtime));
  if (!force && Date.now() - lbCache.at < 5000) return lbCache.entries;
  try { const r = await DESKTOP.lifebookEntries(); lbCache = { at: Date.now(), entries: (r || []).map(n => lifebook.parseEntry(n.rel, n.text, n.mtime)) }; }
  catch (e) { console.warn("[life book]", e); lbCache = { at: Date.now(), entries: [] }; }
  mirrorLifeBook(lbCache.entries).catch(e => console.warn("[life book mirror]", e));
  return lbCache.entries;
}

/** At the learning cadence: what of the last conversation is worth keeping, as proposals. Nothing is written here. */
async function proposeLifeBook(all) {
  if (!lifeBookOn()) return;
  const entries = await lifeBookEntries(true);
  const convo = (S.where ? leaveOut : x => x)(learning.conversationText(all.slice(-30)));
  const touched = lifebook.selectEntries(entries, [convo], new Map(), { depth: 0, max: 6 }).filter(e => e.why !== "always");
  const raw = await complete(lifebook.PROPOSE_PROMPT, lifebook.proposeRequest(entries, convo, { touched }), 1200);
  const props = lifebook.parseProposals(raw, entries);
  if (!props.length) return;
  const same = (a, b) => a.path === b.path && a.op === b.op && (a.text || a.find) === (b.text || b.find);
  const kept = (S.learned.lifeBook || []).filter(p => !props.some(q => same(p, q)));
  S.learned.lifeBook = [...kept, ...props.map(p => ({ ...p, id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())), ts: Date.now() }))].slice(-6);
}

/** "Keep in my life book" on a message of theirs: a card to place it, nothing written yet. */
async function keepFromMessage(text) {
  const entries = await lifeBookEntries(true);
  const path = "Life/Notes.md";
  const have = entries.find(e => e.rel.toLowerCase() === path.toLowerCase());
  const pr = have ? { op: "append", path: have.rel, text: String(text).trim(), mtime: have.mtime } : { op: "create", path, keys: [], text: String(text).trim() };
  S.learned.lifeBook = [...(S.learned.lifeBook || []), { ...pr, id: String(Date.now()), ts: Date.now(), mine: true }].slice(-6);
  await saveLearned();
  renderCheckins();
  toast("Choose where it goes, then Keep. Nothing is written until you do.", 5000);
}

async function dropLifeBook(pr) {
  S.learned.lifeBook = (S.learned.lifeBook || []).filter(x => x.id !== pr.id);
  await saveLearned(); renderCheckins();
}

async function keepLifeBook(pr, edited, pathIn) {
  let change;
  const text = edited ?? (pr.op === "replace" ? pr.replace : pr.text);
  const path = (pathIn || pr.path).trim().replace(/^\/+/, "").replace(/^Lodestone\//i, "");
  const target = /\.md$/i.test(path) ? path : path + ".md";
  const entries = await lifeBookEntries(true);
  const have = entries.find(e => e.rel.toLowerCase() === target.toLowerCase());
  if (pr.op === "replace") change = { op: "replace", path: target, find: pr.find, replace: text, mtime: pr.mtime };
  else if (have) change = { op: "append", path: have.rel, text: lifebook.appendedText(text), mtime: pr.path.toLowerCase() === have.rel.toLowerCase() ? pr.mtime : have.mtime };
  else change = { op: "create", path: target, text: lifebook.newNoteText(target, pr.keys || [], text) };
  if (!DESKTOP) {
    // Not on this device: queued in the synced record for Lodestone Desktop to write.
    const m = (await store.kv.get("lifebook")) || { notesAt: 0, notes: [], queue: [], applied: [] };
    m.queue = [...(m.queue || []), { id: pr.id + "-" + Date.now(), ts: Date.now(), change, card: { op: pr.op, path: change.path, text, keys: pr.keys || [], find: pr.find, replace: pr.replace } }];
    await store.kv.set("lifebook", m); S.lbMirror = m;
    await dropLifeBook(pr); syncSoon(1000);
    toast(`Kept: Lodestone Desktop writes it in Lodestone/${change.path} the next time it opens.`, 6000);
    return;
  }
  try {
    const r = await DESKTOP.lifebookWrite(change);
    lbCache.at = 0;
    await dropLifeBook(pr);
    toast(`Kept in Lodestone/${r.rel}${r.backup ? " (the note as it was is in Lodestone/.backups/)" : ""}`, 6000);
  } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), 8000); }
}

function lifeBookCards() {
  if (!lifeBookOn()) return [];
  return (S.learned?.lifeBook || []).map(pr => {
    const preview = pr.op === "replace"
      ? el("p", { class: "lb-diff" }, el("del", {}, pr.find), " → ", el("ins", {}, pr.replace))
      : el("p", { class: "lb-text" }, pr.text);
    const edit = el("textarea", { class: "lb-edit", rows: 4, hidden: true, "aria-label": "What to keep" });
    const where = el("input", { class: "lb-path", hidden: true, "aria-label": "Note", value: pr.path });
    const what = pr.op === "create" ? "a new note," : pr.op === "append" ? "an addition to" : "a correction in";
    return el("div", { class: "checkin proposal lifebook" },
      el("p", {}, el("b", {}, pr.mine ? "Keep this in your life book? " : "Worth keeping in your life book? "), `${what} `, el("code", {}, `Lodestone/${pr.path}`)),
      pr.note ? el("p", { class: "fine" }, `Kept on another device, not written: ${pr.note}`) : null,
      preview, where, edit,
      el("div", { class: "row" },
        el("button", { type: "button", onclick: () => keepLifeBook(pr, edit.hidden ? null : edit.value, where.hidden ? null : where.value) }, "Keep"),
        el("button", { type: "button", onclick: () => { const opening = edit.hidden; edit.hidden = !opening; where.hidden = !opening || pr.op === "replace"; if (opening) { edit.value = pr.op === "replace" ? pr.replace : pr.text; edit.focus(); } } }, "Edit"),
        el("button", { type: "button", onclick: () => dropLifeBook(pr) }, "Not this")));
  });
}

// Settings → Life book
async function renderLifeBook() {
  const sec = $("#setLifeBook"); if (!sec) return;
  if (!DESKTOP) {
    await loadLifeBookMirror();
    const n = S.lbMirror?.notes?.length || 0, q = S.lbMirror?.queue?.length || 0;
    $("#setLbWhere").textContent = n ? `${n.toLocaleString()} note${n === 1 ? "" : "s"} from Lodestone Desktop, through sync${q ? ` · ${q} kept here, waiting for the desktop to write` : ""}.` : "The life book lives in Lodestone Desktop. With sync on there, its notes are read here too.";
    for (const id of ["#setLbChoose", "#setLbForget", "#setLbOpen"]) $(id).hidden = true;
    $("#setLbPrivacy").textContent = n ? (S.where ? `The notes Lodestone recalls travel with each message to ${S.where}, which can read them.` : "") : "";
    return;
  }
  if (!DESKTOP?.lifebookStatus) { sec.hidden = true; return; }
  await loadLifeBookStatus();
  const on = !!S.lifeBook?.vault;
  $("#setLbWhere").textContent = on ? `${S.lifeBook.dir} · ${S.lifeBook.notes.toLocaleString()} note${S.lifeBook.notes === 1 ? "" : "s"}` : "No vault chosen.";
  $("#setLbChoose").textContent = on ? "Choose another vault…" : "Choose your vault…";
  $("#setLbForget").hidden = !on; $("#setLbOpen").hidden = !on;
  $("#setLbPrivacy").textContent = !on ? "" : S.where
    ? `Lodestone is thinking with a rented model (${S.where}): the notes it recalls travel with each message to that provider, which can read them.`
    : "Lodestone is thinking on this computer: nothing from the life book leaves it.";
}

// ─── Accompaniment: practices and check-ins ─────────────────────────────────

function duePractices() {
  const now = Date.now();
  return S.practices.filter(p => !p.archived && now - (p.lastCheckin || p.created) >= p.cadence * 864e5);
}

function renderCheckins() {
  const box = $("#checkins"); box.innerHTML = "";
  if (!BRIDGE) for (const c of proposalCards()) box.append(c);
  if (!BRIDGE) for (const c of lifeBookCards()) box.append(c);
  for (const p of duePractices().slice(0, 2)) {
    const answer = async (status, talk) => {
      if (status) { p.log = p.log || []; p.log.push({ ts: Date.now(), status }); }
      p.lastCheckin = Date.now();
      await savePractices();
      renderCheckins();
      if (talk) send(`I want to look at my practice "${p.text}" with you.`);
    };
    box.append(el("div", { class: "checkin", style: `--pc:${PILLAR_COLOR(p.pillar)}` },
      el("p", {}, `${cap(p.pillar)}: “${p.text}”. How has it gone since you last looked?`),
      el("div", { class: "row" },
        el("button", { type: "button", onclick: () => answer("held") }, "It held"),
        el("button", { type: "button", onclick: () => answer("partly") }, "Partly"),
        el("button", { type: "button", onclick: () => answer("not") }, "It did not"),
        el("button", { type: "button", onclick: () => answer(null, true) }, "Talk it through"))));
  }
}

// ─── The harmonism.io account and the Harmonic Profile ──────────────
// The account is the website's own sign-in on this origin (phone.js). The
// assessment runs on the website (or in Lodestone Desktop's copy of it) and, at
// its end, leaves the profile code in this origin's storage for Lodestone to take
// in; nothing goes to a server for that.

// ─── Sync ────────────────────────────────────────────────────────────
// Off until switched on. The memory is encrypted here under a key the
// practitioner's devices keep (handed device to device, sync.js) and kept on harmonism.io under their account
// (sync.js). The web app reaches the endpoint on its own origin with the
// website's session; Lodestone Desktop through its main process, which holds the
// account.

const SYNC_DISCLOSURE = "Sync keeps a copy of your conversations, notes, Wheel, practices and Harmonic Profile on harmonism.io, so Lodestone on your phone and on your computer share one memory. Each device encrypts it before it leaves, under a key your devices keep. That key never reaches harmonism.io as it is: it is left there locked under your password, so a device you sign in on with your password opens your memory by itself, and a device that cannot (your password changed) is let in by a tap on one already synced. Your password goes only to the sign-in service, never to harmonism.io. What harmonism.io keeps it cannot read: a stolen copy of it opens to no one. What it sees is your account, how much you sync and when. If you forget your password and every synced device is lost without the recovery code, the synced copy cannot be opened again.";
const SYNC_WEB_NOTE = "On the website, this rests on Lodestone's code being as published; Lodestone Desktop carries its own copy of the code.";
const syncAvailable = () => !!(window.isSecureContext && crypto?.subtle) && !BRIDGE;

const SYNC_DISCLOSURE_COMPUTER = "Sync through your computer keeps a copy of your conversations, notes, Wheel, practices and Harmonic Profile in Lodestone Desktop, on that computer, so the phones paired with it share one memory with it. Nothing goes to harmonism.io. Each device encrypts the copy before it leaves, under a key your devices keep and hand to one another, so it is unreadable even in the computer's own files. Devices sync while they are on the same Wi-Fi as the computer and Lodestone Desktop is open.";

// Where the synced copy is kept and how it is reached: syncwire.js.
const { syncVia, computerLabel, accountTransport, computerTransport, syncTransport, syncSecret } = wire(DESKTOP);

let SY = null;
function syncer() {
  if (!SY && syncAvailable()) SY = new Sync({ transport: syncTransport(), secret: syncSecret(), canRun: () => !S.busy, onChange: afterSync });
  return SY;
}

async function afterSync(changed) {
  const ids = [...changed];
  if (ids.some(x => x.startsWith("k:"))) {
    S.profile = (await store.kv.get("profile")) || {};
    S.wheel = (await store.kv.get("wheel")) || {};
    S.practices = (await store.kv.get("practices")) || [];
    S.assessment = (await store.kv.get("assessment")) || null;
    S.heldBlocks = ((await store.kv.get("companion")) || {}).blocks || null;
    await loadPathState();
    if (ids.includes("k:lifebook")) { await loadLifeBookMirror(); applyLifeBookQueue().catch(e => console.warn("[life book queue]", e)); }
    renderCheckins();
    if ($("#drawerMe") && !$("#drawerMe").hidden) renderMe();
    refreshProfileView();
  }
  if (ids.some(x => x.startsWith("t:")) && !S.busy) {
    if (S.thread) {
      const t = await store.threads.get(S.thread.id);
      if (!t) await openLatestThread();
      else if (changed.has("t:" + S.thread.id)) { S.thread = t; await loadThread(); }
      else if (threadsDocked()) renderThreadList();
    } else if (!S.history.length) await openLatestThread();
    else if (threadsDocked()) renderThreadList();
  }
  if (ids.includes("s:openrouter") && !DESKTOP) {
    // The key arrived from another device: this browser can think with it at once.
    const k = await secrets.get("openrouter").catch(() => null);
    if (k && !S.busy && S.settings.tier !== "openrouter" && S.settings.tier !== "standard") {
      try { await switchWebTo({ tier: "openrouter", model: S.settings.remote?.model || DEFAULT_REMOTE }); toast("Your OpenRouter key came from your other device: Lodestone thinks with it here too.", 6000); } catch {}
    }
    refreshWebChip();
  }
  if (!$("#drawerSettings").hidden) renderSync();
  if ($("#drawerMe") && !$("#drawerMe").hidden) renderMemoryLine();
}

let syncT = null;
function syncSoon(ms = 4000) { clearTimeout(syncT); syncT = setTimeout(() => syncer()?.now(), ms); }
async function startSync() {
  const sy = syncer();
  if (!sy || !(await sy.isOn())) return;
  sy.now();
  if (S.autoState !== "on") { S.autoState = "on"; renderSyncBanner(); }
  checkLinkRequests();
  if (S.syncHooks) return;
  S.syncHooks = true;
  // Coming back to this device is when a person who just asked on another one looks here.
  document.addEventListener("visibilitychange", () => { syncSoon(document.hidden ? 0 : 800); if (!document.hidden) checkLinkRequests(); });
  setInterval(() => { if (!document.hidden) syncer()?.now(); }, 5 * 60 * 1000);
  setInterval(() => { if (!document.hidden) checkLinkRequests(); }, 60 * 1000);
}

// ─── Sync without a switch ───────────────────────────────────────────
// Signed in, sync is on: the first device starts the synced copy by itself, a
// device whose account already syncs elsewhere offers, above the conversation,
// to be let in, and every synced device shows a waiting request there, with
// the field for its code, without Settings being opened. The encryption is
// that of linked devices, unchanged: the key passes only from device to device.
/** Lodestone Desktop: the password stretched in the main process at sign-in, kept here as a key (unlock.js). */
async function takeUnlockHandoff() {
  if (!DESKTOP?.syncUnlockTake) return false;
  try {
    const h = await DESKTOP.syncUnlockTake();
    if (!h?.raw) return false;
    return await unlock.stashRaw(h.email, Uint8Array.from(atob(h.raw), c => c.charCodeAt(0)), h.at);
  } catch { return false; }
}

async function autoSync() {
  const sy = syncer();
  if (!sy) return;
  await takeUnlockHandoff();
  const r = await sy.ensure();
  S.autoState = r.state;
  if (r.state === "on") await startSync();
  renderSyncBanner();
  // Turned on without a press, here or on the website: said plainly, once.
  const ann = (await sy.conf()).announce;
  if (ann === "joined") {
    await sy.setConf({ announce: false });
    toast("Your memory from your other devices is here: it opened with your password. Sync is on.", 8000);
  } else if (ann) {
    await sy.setConf({ announce: false });
    toast("Sync is on: your memory is kept on harmonism.io, encrypted on this device and locked under your password, so what harmonism.io keeps it cannot read; your other devices open it when you sign in on them. Settings → Sync to turn it off.", 10000);
  }
}

// ─── Asked at the start: sign in ─────────────────────────────────────
// A person who uses Lodestone without being signed in talks to an empty memory:
// their profile, Wheel and conversations are in their account. Each start asks,
// until they sign in or say not to; an account whose sign-in this computer lost
// (an expiry, or an update the keychain would not open to) is always asked for.
const SIGNIN_ASK = "lodestone-signin-ask";
async function askSignIn() {
  if (!syncAvailable() || BRIDGE || $("#signinAsk") || !$("#setup").hidden) return;
  if (!DESKTOP && !phoneRoutesAvailable()) return;
  const acct = await accountTransport().account().catch(() => null);
  if (acct && !acct.expired) return;
  const conf = await syncer()?.conf().catch(() => ({})) || {};
  if (conf.on && conf.via === "computer") return;   // a phone synced through its computer needs no account
  let never = false; try { never = localStorage.getItem(SIGNIN_ASK) === "never"; } catch {}
  if (never && !acct?.expired) return;
  let unInert = () => {};
  const close = () => { unInert(); box.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = e => { if (e.key === "Escape") { e.stopImmediatePropagation(); close(); } };
  const done = async () => {
    close();
    toast("Signed in. Your memory syncs with your account and your other devices.", 5000);
    await autoSync().catch(() => {});
    renderMemoryLine(); renderCheckins();
  };
  const email = acct?.email || "";
  const card = el("div", { class: "signin-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "signinAskTitle" },
    el("h3", { id: "signinAskTitle" }, acct?.expired ? "Sign in again" : "Sign in to Lodestone"),
    el("p", {}, acct?.expired
      ? `Lodestone on this ${DESKTOP ? "computer" : "device"} is no longer signed in as ${email}. What it holds here is kept; sign in, and it syncs again with your account and your other devices.`
      : "Your Harmonic Profile, your Wheel, your practices and your conversations live in your harmonism.io account. Without it, Lodestone here begins with an empty memory. Sign in, and they come back here and stay in step with your other devices."));
  if (DESKTOP) card.append(desktopSignIn(done, email || null));
  else {
    const L = accountLinks();
    card.append(el("div", { class: "row-btns" }, el("a", { class: "btn primary", href: L.signIn }, "Sign in"), el("a", { class: "btn ghost", href: L.register }, "Create an account")));
  }
  card.append(el("div", { class: "later" },
    el("button", { type: "button", onclick: close }, "Not now"),
    acct?.expired ? null : el("button", { type: "button", onclick: () => { try { localStorage.setItem(SIGNIN_ASK, "never"); } catch {} close(); toast("Settings → Sync signs you in whenever you want.", 5000); } }, "Don't ask again here")));
  const box = el("div", { class: "signin-ask", id: "signinAsk" }, card);
  box.addEventListener("click", e => { if (e.target === box) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(box);
  unInert = modalInert(box);
  setTimeout(() => card.querySelector("input[type=password]" + (email ? "" : ", input[type=email]"))?.focus(), 50);
}

function openSyncSetup() {
  renderSettings(); openDrawer("#drawerSettings");
  setTimeout(() => { $("#setSync")?.scrollIntoView({ block: "start" }); syncSetup("account", null); }, 300);
}

let linkCheckT = null;
async function checkLinkRequests() {
  clearTimeout(linkCheckT);
  const sy = syncer();
  let reqs = [];
  // Every synced device shows a waiting request; one that holds no key offers to take it over when let in (linkRequestEl).
  try { if (sy && (await sy.isOn())) reqs = await sy.pendingLinks(); } catch {}
  const before = (S.linkReqs || []).map(q => q.id + (q.answered ? "a" : "")).join();
  S.linkReqs = reqs;
  if (before !== reqs.map(q => q.id + (q.answered ? "a" : "")).join()) renderSyncBanner();
  // While a device waits, look again soon: the person is standing between the two.
  if (reqs.length) linkCheckT = setTimeout(checkLinkRequests, 5000);
}

function renderSyncBanner() {
  const b = $("#syncBanner");
  if (!b) return;
  const kids = [];
  if ((S.autoState === "join" || S.autoState === "passphrase") && !S.syncSnooze) {
    kids.push(el("div", { class: "checkin sync-ask", id: "syncAsk" },
      el("p", {}, S.autoState === "join"
        ? "Your memory already syncs on another of your devices. Let this one in, and your conversations, Harmonic Profile and Wheel arrive here; what you say here goes back to them."
        : "Your account holds an older synced copy, made with a passphrase. Bring it in here once, and sync carries on without one."),
      el("div", { class: "row" },
        el("button", { type: "button", id: "syncAskGo", onclick: openSyncSetup }, "Let this device in"),
        el("button", { type: "button", onclick: () => { S.syncSnooze = true; renderSyncBanner(); } }, "Not now"))));
  }
  for (const q of S.linkReqs || []) kids.push(linkRequestEl(q, () => checkLinkRequests()));
  b.replaceChildren(...kids);
  b.hidden = !kids.length;
}

const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(); };
const mb = b => b == null ? "" : b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toFixed(1)} MB`;

let syncPick = null;
async function renderSync() {
  const sec = $("#setSync"), box = $("#syncBody"), st = $("#syncStatus");
  if (!sec) return;
  if (!syncAvailable()) { sec.hidden = true; return; }
  sec.hidden = false; box.innerHTML = "";
  const sy = syncer();
  const conf = await sy.conf();
  const comp = await computerLabel();
  const err = conf.error ? ` ${conf.error.message}` : "";
  const fineFor = via => el("p", { class: "fine" }, via === "computer" ? SYNC_DISCLOSURE_COMPUTER : SYNC_DISCLOSURE + (DESKTOP ? "" : " " + SYNC_WEB_NOTE));

  if (!conf.on) {
    st.textContent = "Off: your memory is on this device only." + err;
    const via = comp ? (syncPick || conf.via || "account") : "account";
    if (comp) {
      const opt = (v, title, sub) => {
        const r = el("input", { type: "radio", name: "syncVia", value: v, id: "syncVia-" + v });
        r.checked = via === v;
        r.onchange = () => { syncPick = v; renderSync(); };
        return el("label", { class: "check" }, r, el("span", {}, el("b", {}, title), " — ", sub));
      };
      box.append(opt("account", "Through your harmonism.io account", "from anywhere, encrypted."),
        opt("computer", DESKTOP ? "Through this computer only" : `Through ${comp} only`,
          DESKTOP ? "the phones paired with it sync over your Wi-Fi; nothing goes to harmonism.io." : "over your Wi-Fi, while Lodestone Desktop is open; nothing goes to harmonism.io."));
    }
    const fine = fineFor(via);
    if (via === "account") {
      const acct = await accountTransport().account().catch(() => null);
      if (!acct || acct.expired) {
        box.append(fine, el("p", { class: "hint" }, acct?.expired ? `Your sign-in as ${acct.email} has expired on this computer. Sign in again to turn on sync.` : "Sync through the account needs your harmonism.io account."));
        // Signed in, it goes straight on to turning sync on: that is why the person signed in.
        if (DESKTOP) box.append(desktopSignIn(() => syncSetup("account", null), acct?.email));
        else { const L = accountLinks(); box.append(el("div", { class: "row-btns" }, el("a", { class: "btn ghost", href: L.signIn }, "Sign in"), el("a", { class: "btn ghost", href: L.register }, "Create an account"))); }
        return;
      }
      box.append(fine,
        el("p", { class: "hint" }, `Signed in as ${acct.email}. `, el("button", { class: "link-btn", type: "button", onclick: async () => { if (await signOutOfAccount()) location.reload(); } }, "Sign out")),
        el("button", { class: "btn ghost block", type: "button", id: "syncOn", onclick: () => syncSetup("account", acct.email) }, "Turn on sync"));
    } else {
      box.append(fine, el("button", { class: "btn ghost block", type: "button", id: "syncOn", onclick: () => syncSetup("computer", comp) }, "Turn on sync"));
    }
    return;
  }

  const via = conf.via === "computer" ? "computer" : "account";
  const acctRaw = await sy.t.account().catch(() => null);
  const acct = acctRaw?.expired ? null : acctRaw;
  const where = via === "computer" ? (DESKTOP ? "on this computer" : `on ${acct?.email || "your computer"}`) : "on harmonism.io";
  const who = via === "computer" ? `through ${DESKTOP ? "this computer" : acct?.email || "your computer"}` : `as ${acct?.email}`;
  st.textContent = !acct ? (via === "computer" ? "On, but this phone is no longer paired with the computer: pair it again." : "On, but this device is signed out of harmonism.io: sign in again to keep syncing.")
    : conf.error ? `On, ${who}. Not synced:${err}`
    : `On, ${who}. ${conf.last ? `Synced ${ago(conf.last)}` : "Syncing…"}${conf.bytes != null ? ` · ${mb(conf.bytes)} ${where}, encrypted` : ""}.`;
  if (!acct && via === "account") {
    if (DESKTOP) box.append(desktopSignIn(() => { syncer().now(); renderSync(); }));
    else { const L = accountLinks(); box.append(el("div", { class: "row-btns" }, el("a", { class: "btn ghost", href: L.signIn }, "Sign in"))); }
  }
  const key = el("input", { type: "checkbox", id: "syncKey" });
  key.checked = !!conf.key;
  key.onchange = async () => { key.disabled = true; await sy.setKey(key.checked); renderSync(); };
  box.append(
    el("label", { class: "check" }, key, el("span", {}, "Also sync my OpenRouter key, encrypted like the rest, so another device needs no key of its own.")),
    el("button", { class: "btn ghost block", type: "button", id: "syncNow", onclick: async e => {
      e.target.disabled = true; e.target.textContent = "Syncing…";
      const r = await sy.now();
      toast(r.ok ? "Synced." : r.busy ? "Wait for this answer to finish." : r.message || "Not synced.");
      renderSync();
    } }, "Sync now"),
    el("button", { class: "btn ghost block", type: "button", id: "syncOff", onclick: async () => {
      if (!confirm(`Stop syncing on this device? Its memory stays here, and the synced copy stays ${where} for your other devices.`)) return;
      await sy.off(); toast("Sync is off on this device."); renderSync();
    } }, "Turn off on this device"),
    el("button", { class: "btn danger block", type: "button", id: "syncErase", onclick: async () => {
      if (!confirm(`Delete the synced copy ${where}? Every device keeps its own memory and stops syncing. This cannot be undone.`)) return;
      try { await sy.erase(); toast("The synced copy is deleted."); } catch (e) { toast(String(e.message || e)); }
      renderSync();
    } }, "Delete the synced copy"),
    fineFor(via));
  if (acct) { await renderLinkTools(box, where); await renderLinkRequests(box); }
}

function desktopSignIn(done, known = null) {
  const email = el("input", { type: "email", placeholder: "Email", autocomplete: "username", ...(known ? { value: known } : {}) });
  const pass = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const msg = el("p", { class: "hint", role: "status" });
  const go = el("button", { class: "btn ghost block", type: "button", onclick: async () => {
    go.disabled = true; msg.textContent = "Signing in…";
    try {
      await DESKTOP.syncSignIn(email.value, pass.value);
      await takeUnlockHandoff();   // the password, stretched, to open the synced memory with
      // Signing in may open this account's own memory, which reloads the
      // window: Settings comes back at Sync, where the person was.
      try { sessionStorage.setItem("lodestone-resume-sync", "1"); } catch {}
      const r = await held.bind().catch(() => ({ changed: false }));
      if (r.changed) { location.reload(); return; }
      try { sessionStorage.removeItem("lodestone-resume-sync"); } catch {}
      done();
    }
    catch (e) { msg.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); go.disabled = false; }
  } }, "Sign in to harmonism.io");
  // Enter signs in, from either field.
  for (const f of [email, pass]) f.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && !go.disabled) { e.preventDefault(); go.click(); } });
  return el("div", { class: "sync-form" }, email, pass, go, msg,
    el("p", { class: "fine" }, "No account? ", el("a", { href: "https://harmonism.io/member/register.php", target: "_blank", rel: "noopener" }, "Create one at harmonism.io"), ", confirm it by email, then sign in here."));
}

// ─── Linking devices (sync.js, v2) ───────────────────────────────────────────
// Sync is a switch. The first device makes the key; another joins when a device
// already synced lets it in with the one-time code it shows. No passphrase.
let linkWait = null, linkPoll = null;
const syncErr = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

async function syncSetup(via, label, replace = false) {
  const box = $("#syncBody"), st = $("#syncStatus");
  box.innerHTML = "";
  st.textContent = "Looking for a synced copy…";
  const sy = syncer();
  await sy.setConf({ via, error: null });
  let r;
  try { r = await sy.remote(); } catch (e) { toast(syncErr(e)); return renderSync(); }
  const place = via === "computer" ? (DESKTOP ? "this computer" : label) : "your account";
  // The OpenRouter key travels unless untick'd: one key for every device is what a person expects of one account.
  const key = el("input", { type: "checkbox", id: "syncSetupKey", checked: true });
  const keyRow = el("label", { class: "check" }, key, el("span", {}, "Also sync my OpenRouter key"));
  const msg = el("p", { class: "hint", role: "status", id: "syncMsg" });
  const cancel = el("button", { class: "btn ghost block", type: "button", onclick: () => { linkWait?.abort(); renderSync(); } }, "Cancel");
  const fine = el("p", { class: "fine" }, via === "computer" ? SYNC_DISCLOSURE_COMPUTER : SYNC_DISCLOSURE);

  // No copy yet, or starting again: one click.
  if (!r.meta || replace) {
    st.textContent = replace ? `Start the synced copy on ${place} again from this device.` : `Turn on sync${via === "account" && label ? ` for ${label}` : ""}. Your other devices join from this one: nothing to remember.`;
    // This device cannot read the copy it would replace: when it holds less, say so before anything goes.
    let less = null;
    if (r.meta) { const here = await sy.localCount().catch(() => null); if (here != null && r.count != null && here < r.count) less = { here, there: r.count }; }
    const go = el("button", { class: "btn primary block", type: "button", id: "syncGo", onclick: async () => {
      if (r.meta && !confirm(`This replaces the synced copy on ${place} with this device's memory. Every device keeps its own memory; the others join again from this one.`)) return;
      go.disabled = true; msg.textContent = "Encrypting and syncing…";
      try {
        const res = await sy.createLinked({ key: key.checked, replace: !!r.meta });
        startSync();
        toast(res.ok ? "Sync is on." : `Sync is on, but the first sync failed: ${res.message}`, 5000);
        renderSync();
      } catch (e) { msg.textContent = syncErr(e); go.disabled = false; }
    } }, less ? "Start here anyway" : "Turn on sync");
    if (less) go.className = "btn ghost block";
    box.append(el("div", { class: "sync-form" },
      less ? el("p", { class: "hint warn" }, `The synced copy holds ${less.there} items (conversations and kinds of notes); this device holds ${less.here}. Starting here keeps only this device's: what only the synced copy holds stays on the devices that synced it, and is lost if none did. Start from the device that holds the most, or let this one in instead.`) : null,
      keyRow, go, msg, cancel), fine);
    return;
  }

  // A copy made with a passphrase, before linking existed.
  if (!Sync.linked(r.meta)) {
    st.textContent = `${place[0].toUpperCase() + place.slice(1)} holds an older synced copy, made on ${new Date(r.meta.created * 1000).toLocaleDateString()} (${mb(r.bytes)}) when sync still used a passphrase. Sync no longer needs one. If you remember it, enter it once to bring that copy in. If not, start again: this device's memory becomes the synced copy, with no passphrase, and the older copy is replaced. Nothing is removed from any device: a device that synced the older copy keeps its own memory, and adds it when it joins again.`;
    const pass = el("input", { type: "password", id: "syncPass", placeholder: "Its passphrase", autocomplete: "current-password", spellcheck: "false" });
    const go = el("button", { class: "btn primary block", type: "button", id: "syncGo", onclick: async () => {
      go.disabled = true; msg.textContent = "Unlocking…";
      try { const res = await sy.join(pass.value, { key: key.checked }); startSync(); toast(res.ok ? "Sync is on." : `Sync is on, but the first sync failed: ${res.message}`, 5000); renderSync(); }
      catch (e) { msg.textContent = syncErr(e); go.disabled = false; }
    } }, "Unlock and sync");
    box.append(el("div", { class: "sync-form" }, pass, keyRow, go, msg,
      el("button", { class: "btn ghost block", type: "button", onclick: () => syncSetup(via, label, true) }, "I don't have it: start again from this device"), cancel), fine);
    pass.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && !go.disabled) { e.preventDefault(); go.click(); } });
    pass.focus();
    return;
  }

  // A linked copy: the password opens it; failing that, a tap on a device already synced.
  try {
    const res = await sy.unlockWithPassword({ key: key.checked });
    if (res) { startSync(); toast(res.ok ? "This device is in: your password opened your memory." : `Sync is on, but the first sync failed: ${res.message}`, 5000); return renderSync(); }
  } catch {}
  const ps = await sy.passwordState().catch(() => ({}));
  st.textContent = `${place[0].toUpperCase() + place.slice(1)} already syncs your memory (${mb(r.bytes)}). Let this device in.`;
  let req;
  try { req = await sy.requestLink({ key: key.checked }); } catch (e) { msg.textContent = syncErr(e); box.append(msg, cancel); return; }
  const ctrl = new AbortController(); linkWait = ctrl;
  const done = res => { ctrl.abort(); sy.declineLink(req.id); startSync(); toast(res.ok ? "This device is in: sync is on." : `Sync is on, but the first sync failed: ${res.message}`, 5000); renderSync(); };
  const numEl = el("div", { class: "link-code", "aria-label": "Number to compare" }, "··· ···");
  const tapLine = el("p", {});   // filled once it is known whether the password is offered first
  const left = el("p", { class: "fine", role: "timer" });
  const tick = setInterval(() => { const s = Math.max(0, Math.round((req.expires - Date.now()) / 1000)); left.textContent = `Waiting… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left.`; if (!s || ctrl.signal.aborted) clearInterval(tick); }, 1000);
  // The password, when the copy carries a lock and this device has no key from it yet.
  let pw = null;
  if (via === "account" && ps.locked && !ps.here) {
    pw = el("div", {}, el("p", {}, "Type your harmonism.io password: your memory opens with it, with nothing to tap."),
      passwordForm("Open my memory", async m => {
        const res = await sy.unlockWithPassword({ key: key.checked });
        if (res) done(res);
        else m.textContent = "Your memory is locked under another password (changed since?). Let this device in with a tap; your password then opens it everywhere.";
      }));
  } else if (via === "account" && ps.locked && ps.here) {
    pw = el("p", { class: "hint" }, "Your memory is locked under a password other than the one you signed in with here (changed since?). Let this device in with a tap: from then on, your current password opens it on every device.");
  }
  tapLine.append(pw ? "Or, on a device already synced, Lodestone shows " : "On a device already synced, Lodestone shows ", el("b", {}, "A device asks to join your memory"), ". Tap ", el("b", {}, "Let it in"), " there: it shows a number, which should be this one.");
  const rec = el("input", { type: "text", placeholder: "Recovery code", spellcheck: "false", autocomplete: "off" });
  const recGo = el("button", { class: "btn ghost", type: "button", onclick: async () => {
    recGo.disabled = true;
    try { ctrl.abort(); await sy.declineLink(req.id); const res = await sy.joinWithRecovery(rec.value, { key: key.checked }); startSync(); toast(res.ok ? "Sync is on." : `Sync is on, but the first sync failed: ${res.message}`, 5000); renderSync(); }
    catch (e) { msg.textContent = syncErr(e); recGo.disabled = false; }
  } }, "Use it");
  const restart = () => { ctrl.abort(); sy.declineLink(req.id); syncSetup(via, label, true); };
  box.append(el("div", { class: "sync-form" },
    pw, tapLine, numEl, left,
    el("p", { class: "fine" }, `A device with an older Lodestone asks for a code instead: type ${req.code} there.`),
    keyRow, msg,
    el("details", { class: "link-alt" }, el("summary", {}, "No device already synced?"),
      el("p", { class: "hint" }, "Enter the recovery code you saved, or start the synced copy from this device: then your other devices join from this one. Start from the device that holds the most."),
      el("div", { class: "row-btns" }, rec, recGo),
      el("button", { class: "btn ghost block", type: "button", onclick: restart }, "Start the synced copy here")),
    cancel), fine);
  try {
    let res = await req.wait({ signal: ctrl.signal, onNumber: n => { numEl.textContent = n; tapLine.replaceChildren("Your other device shows a number. If it is this one, tap ", el("b", {}, "Yes, let it in"), " there."); } });
    if (key.checked) res = await sy.setKey(true);   // ticked while waiting
    clearInterval(tick); startSync();
    toast(res.ok ? "This device is in: sync is on." : `Sync is on, but the first sync failed: ${res.message}`, 5000);
    renderSync();
  } catch (e) { clearInterval(tick); if (e.code !== "cancelled") { msg.textContent = syncErr(e); } }
}

/**
 * The harmonism.io password, typed once here: checked with the sign-in service,
 * then stretched into the key that opens the synced memory (unlock.js). `then(m)`
 * runs once it is kept; m is the line to speak on.
 */
function passwordForm(label, then) {
  const pass = el("input", { type: "password", placeholder: "Your harmonism.io password", autocomplete: "current-password" });
  const m = el("p", { class: "hint", role: "status" });
  const go = el("button", { class: "btn primary", type: "button", onclick: async () => {
    go.disabled = true; m.textContent = "Checking…";
    try {
      const email = (await accountTransport().account().catch(() => null))?.email;
      if (!email) throw new Error("Sign in to your harmonism.io account first.");
      if (DESKTOP) { await DESKTOP.syncSignIn(email, pass.value); if (!(await takeUnlockHandoff())) throw new Error("Lodestone could not keep the key on this computer."); }
      else { await signInWithPassword(email, pass.value); if (!(await unlock.stashPassword(email, pass.value))) throw new Error("This browser could not keep the key."); }
      pass.value = ""; m.textContent = "";
      await then(m);
    } catch (e) { m.textContent = syncErr(e); }
    go.disabled = false;
  } }, label);
  pass.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && !go.disabled) { e.preventDefault(); go.click(); } });
  return el("div", { class: "sync-form" }, pass, go, m);
}

/** On a synced device: the devices waiting to be let in, each with the field for its code. Polled while Settings shows them. */
async function renderLinkRequests(box) {
  const sy = syncer();
  const holder = el("div", { class: "link-requests" });
  box.prepend(holder);
  const draw = async () => {
    if (!holder.isConnected) { clearInterval(linkPoll); linkPoll = null; return; }
    const reqs = await sy.pendingLinks();
    const open = new Set([...holder.querySelectorAll("[data-id]")].map(n => n.dataset.id));
    if (reqs.length === open.size && reqs.every(q => open.has(q.id))) return;   // keep what is being typed
    holder.replaceChildren(...reqs.map(q => linkRequestEl(q, draw)));
  };
  await draw();
  clearInterval(linkPoll);
  linkPoll = setInterval(draw, 4000);
}

/**
 * One device waiting to be let in. Asked by a tap (a current Lodestone): "Let it
 * in", then the number both devices show, then "Yes". Asked by an older Lodestone:
 * the field for the code it shows.
 */
function linkRequestEl(q, redraw) {
  const sy = syncer();
  const m = el("p", { class: "hint", role: "status" });
  const tap = !!q.commit;
  const code = tap ? null : el("input", { type: "text", placeholder: "Code shown on the new device", spellcheck: "false", autocomplete: "off", maxlength: "14", class: "link-input" });
  const step = el("div", { class: "link-step" });
  // Synced, but without the key to hand on (it joined with a passphrase, or
  // lost it): this device takes the key over first, then lets the other in.
  const ensureKey = async () => {
    if (await sy.canLink()) return true;
    if (!confirm("This device syncs, but does not hold the key that lets another device in.\n\nIt can take the key over: it syncs first, then starts the synced copy again from here under a new key, and lets the other device in. Nothing is removed from either device; any other synced device asks to be let in again.\n\nGo ahead?")) return false;
    m.textContent = "Syncing, then making this device the one that holds the key…";
    await sy.takeOver();
    startSync();
    return true;
  };
  const yes = el("button", { class: "btn primary", type: "button", onclick: async () => {
    yes.disabled = true;
    try {
      if (!tap && normCode(code.value).length < 10) throw new SyncError("code", "Type the ten characters the new device shows.");
      if (!(await ensureKey())) { yes.disabled = false; return; }
      if (!tap) {
        m.textContent = "Sealing the key for that device…";
        await sy.approveLink(q.id, code.value);
        m.textContent = "Sent. The new device opens your memory in a moment, if the code was right; if it does not, type the code again.";
        yes.disabled = false;
        return;
      }
      m.textContent = "Waiting for the new device to show its number…";
      const a = await sy.answerLink(q);
      m.textContent = "";
      const ok = el("button", { class: "btn primary", type: "button", onclick: async () => {
        ok.disabled = true;
        try { await a.letIn(); step.replaceChildren(); m.textContent = "Let in. The new device opens your memory in a moment."; }
        catch (e) { m.textContent = syncErr(e); ok.disabled = false; }
      } }, "Yes, let it in");
      const nope = el("button", { class: "btn ghost", type: "button", onclick: async () => { await a.refuse(); redraw(); } }, "No");
      yes.hidden = true; no.hidden = true;
      step.replaceChildren(el("p", {}, "Does the new device show this number?"), el("div", { class: "link-code" }, a.number), el("div", { class: "row-btns" }, ok, nope),
        el("p", { class: "fine" }, "If it shows another number, tap No: something stood between the two devices, and nothing is sent."));
    }
    catch (e) { m.textContent = syncErr(e); yes.disabled = false; }
  } }, "Let it in");
  code?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); yes.click(); } });
  const no = el("button", { class: "btn ghost", type: "button", onclick: async () => { await sy.declineLink(q.id); redraw(); } }, "Decline");
  return el("div", { class: "link-request", "data-id": q.id },
    el("div", {}, el("b", {}, "A device asks to join your memory"), el("small", {}, ` · ${ago(q.created * 1000)}${!tap && q.answered ? " · answered; type the code again if it did not open" : ""}`)),
    el("p", { class: "hint" }, tap ? "Only if you just asked on another device of yours." : "Only if you just asked on another device of yours: type the code it shows."),
    code, el("div", { class: "row-btns" }, yes, no), step, m);
}

async function renderLinkTools(box, where) {
  const sy = syncer();
  if (!(await sy.canLink())) {
    box.append(el("p", { class: "hint" }, "This device syncs, but does not hold the key that lets your other devices in (it joined with a passphrase, or its key was lost). Make it the device that holds the key: it syncs first, then starts the synced copy again from here; nothing is removed from any device, and your other devices join from this one."),
      el("button", { class: "btn ghost block", type: "button", onclick: async () => {
        if (!confirm(`Make this device the one that holds the key? It syncs first, then starts the synced copy ${where} again from here. Nothing is removed from any device; your other devices then ask to be let in from this one.`)) return;
        try { await sy.takeOver(); startSync(); toast("This device now holds the key: let your other devices in from here."); } catch (e) { toast(syncErr(e)); }
        renderSync();
      } }, "Make this device hold the key"));
    return;
  }
  const out = el("div", { class: "recovery", hidden: true });
  box.append(el("button", { class: "btn ghost block", type: "button", onclick: async () => {
    const c = await sy.recoveryCode(); if (!c) return;
    out.replaceChildren(el("p", { class: "hint" }, "The key itself, for the day no synced device is left. Keep it where you keep important papers. Anyone with it and your account can read your synced memory."),
      el("code", { class: "link-code small" }, c),
      el("button", { class: "btn ghost", type: "button", onclick: () => { navigator.clipboard?.writeText(c); toast("Copied."); } }, "Copy"));
    out.hidden = !out.hidden;
  } }, "Recovery code (optional)"), out);
  // The password opens this memory on other devices once it has been typed here (or at sign-in).
  if ((await sy.conf()).via === "computer") return;
  const ps = await sy.passwordState().catch(() => ({}));
  if (ps.here && ps.locked) { box.append(el("p", { class: "hint" }, "Signing in with your harmonism.io password on another device opens this memory there.")); return; }
  box.append(el("p", { class: "hint" }, "Let your password open this memory on your other devices: type it once here. Then signing in on a device is all it takes."),
    passwordForm("Use my password", async m => {
      await sy.keepLock().catch(() => false);
      m.textContent = (await sy.passwordState().catch(() => ({}))).locked ? "Done: signing in on another device now opens your memory there." : "It could not be done just now. Try again in a moment.";
    }));
}

// ─── What website Lodestone learns, and the Wisdom Canon ─────────────────
// The memory website Lodestone keeps (kv "companion": the model-written profile,
// its Wheel, summaries, the reading canon) is the practitioner's, synced like
// the rest. The app reads it into its prompt (heldBlock), asks harmonism.io to
// run the learning jobs on it every tenth reply here, and drives the reading
// canon through it. Both need the harmonism.io account; the memory travels
// with the request and nothing of it is kept there (lodestone-learn.php,
// member/reading-api.php).

if (DESKTOP) held.configure({
  post: (path, body) => DESKTOP.heldCall(path, body),
  account: () => DESKTOP.syncAccount(),
});
const heldAccount = () => (DESKTOP ? DESKTOP.syncAccount() : hosted.account()).catch(() => null);

async function maybeLearn() {
  if (!syncAvailable()) return;
  const n = ((await store.kv.get("held:learnSince")) || 0) + 1;
  await store.kv.set("held:learnSince", n);
  if (n < 10) return;
  const blocked = await store.kv.get("held:learnBlocked");
  if (blocked && Date.now() - blocked < 7 * 864e5) return;
  if (!(await heldAccount())) return;
  try {
    await held.heldCall("lodestone-learn.php", { withRecent: true });
    await store.kv.set("held:learnSince", 0);
    S.heldBlocks = ((await store.kv.get("companion")) || {}).blocks || null;
  } catch (e) {
    // Without the website's consent the jobs do not run; asked again in a week.
    if (e.code === "consent_required" || e.status === 403) await store.kv.set("held:learnBlocked", Date.now());
  }
}

// ─── The Wisdom Canon, on this device (canon.js) ─────────────────────────────
// The arc, its taper, the station and the margin are kept here and travel in
// sync; no server is asked. A check-in that comes due is folded into the next
// answer (the website's pull delivery): nothing arrives that was not asked for.
// Website accounts keep their own server arcs on harmonism.io; the app's are its own.

async function saveReading() { await store.kv.set("reading", S.reading); syncSoon(); }
const anchorName = a => String(a).split("|").pop();

async function renderReading() {
  const box = $("#readingBody"), st = $("#readingStatus");
  if (!box) return;
  $("#readingBox").hidden = false;
  box.innerHTML = "";
  const R = S.reading || (S.reading = canon.emptyState());
  const arc = canon.activeArc(R);
  if (arc) {
    const p = canon.progress(R, arc), stn = canon.station(arc, p.current);
    st.textContent = `${arc.title}${arc.author ? `, ${arc.author}` : ""}: day ${p.day_index} of ${p.total_days} · ${p.completed} of ${p.units} ${arc.unit_label} read${p.finished ? " · finished" : ""}.`;
    const left = canon.taperRemaining(R, arc.id);
    const unitSel = el("select", { "aria-label": "Station" }, Array.from({ length: arc.units }, (_, i) => {
      const s2 = canon.station(arc, i + 1), done = R.progress[arc.id]?.[i + 1]?.completed_at > 0;
      return el("option", { value: i + 1 }, `${done ? "✓ " : ""}${s2.heading}`);
    }));
    unitSel.value = String(p.current);
    const seam = el("select", { "aria-label": "Kind of note" }, el("option", { value: "mine" }, "my own"), el("option", { value: "text" }, "the text"), el("option", { value: "harmonism" }, "Harmonism"));
    const note = el("textarea", { rows: "2", placeholder: "In the margin, in your own words" });
    const unit = () => Number(unitSel.value);
    box.append(
      el("div", { class: "canon-station" },
        el("div", { class: "cs-head" }, el("b", {}, stn.heading), stn.native ? el("small", {}, ` · ${stn.native}`) : null),
        stn.anchors.length ? el("p", { class: "fine" }, "Adjacent ground, once it is read: ", stn.anchors.map(anchorName).join(" · ")) : null,
        el("div", { class: "canon-bar" }, el("i", { style: `width:${Math.round(p.completed / p.units * 100)}%` }))),
      el("label", {}, "Station", unitSel),
      el("div", { class: "row-btns" },
        el("button", { class: "btn primary", type: "button", onclick: async () => { canon.markRead(R, arc, unit()); await saveReading(); renderReading(); } }, "I have read it"),
        el("button", { class: "btn ghost", type: "button", title: "Note that you opened it today; a station opened three times over more than a day without finishing gets a question about the pace", onclick: async () => { canon.openStation(R, arc.id, unit()); await saveReading(); toast("Noted: opened."); } }, "Opened it"),
        R.progress[arc.id]?.[unit()]?.completed_at ? el("button", { class: "btn ghost", type: "button", onclick: async () => { canon.unmarkRead(R, arc, unit()); await saveReading(); renderReading(); } }, "Not read after all") : null),
      el("div", { class: "canon-note" }, note, el("div", { class: "row-btns" }, seam,
        el("button", { class: "btn ghost", type: "button", onclick: async () => { if (canon.addNote(R, arc.id, unit(), seam.value, note.value)) { note.value = ""; await saveReading(); renderReading(); } } }, "Keep it in the margin"))));
    const ns = canon.notes(R, arc.id, 8);
    if (ns.length) box.append(el("ul", { class: "canon-notes" }, ns.map(n => el("li", {}, el("small", {}, `${n.seam === "mine" ? "mine" : n.seam} · ${arc.unit_label.replace(/s$/, "")} ${n.unit_index}`), n.body))));
    box.append(el("p", { class: "fine" }, `${CADENCE_LINE(arc)} ${left.pending ? `${left.pending} question${left.pending === 1 ? "" : "s"} left in the plan, the last of them the close.` : ""}`),
      el("button", { class: "btn ghost block", type: "button", onclick: async () => { if (!confirm(`Release your reading of ${arc.title}? The margin notes stay.`)) return; canon.closeArc(R, arc.id, "released"); await saveReading(); renderReading(); } }, "Release this reading"));
    return;
  }
  const last = [...R.arcs].reverse().find(a => a.state === "closed");
  st.textContent = last ? `Your last reading: ${last.title} (${last.closed_reason === "completed" ? "finished" : "released"}). The margin notes stay with it.` : "Lodestone walks you through a book of the canon at the pace you choose, asks about it now and then, less and less, and then hands you back to the text.";
  const work = el("select", {});
  for (const [t, label] of [["threshold", "The Threshold, in its order"], ["cartography", "One per cartography"], ["standalone", "The Perennial Core"]]) {
    const list = canon.track(t); if (!list.length) continue;
    work.append(el("optgroup", { label }, list.map(w => el("option", { value: w.key }, `${t === "threshold" ? w.position + ". " : ""}${w.title}, ${w.author}`))));
  }
  const units = el("input", { type: "number", min: "1", max: "400" });
  const unitNote = el("p", { class: "fine" });
  const pace = el("select", {}, Object.entries(canon.PACES).map(([k, v]) => el("option", { value: k }, v.label)));
  const cadence = el("select", {}, Object.entries(canon.CADENCES).map(([k, v]) => el("option", { value: k }, v)));
  const discuss = el("select", {}, Object.entries(canon.DISCUSS).map(([k, v]) => el("option", { value: k }, v)));
  const hour = el("select", {}, el("option", { value: "-1" }, "no fixed hour"), Array.from({ length: 24 }, (_, h) => el("option", { value: h }, `${String(h).padStart(2, "0")}:00`)));
  const plan = el("div", { class: "canon-plan" });
  const opts = () => { const w = canon.resolveWork(work.value), pc = canon.PACES[pace.value]; return { work_key: work.value, units: Number(units.value) || w.units, pace_num: pc.num, pace_days: pc.days, cadence: cadence.value, discuss: discuss.value, sitting_hour: Number(hour.value) }; };
  const show = () => {
    const w = canon.resolveWork(work.value);
    if (document.activeElement !== units) units.value = String(w.units);
    unitNote.textContent = `${w.note ? w.note + " " : ""}${w.units} ${w.unit_label}${w.titles ? ", named" : ", numbered: their headings differ between translations"}. Editions divide some works differently: correct the count if yours does.`;
    const pv = canon.preview(opts());
    plan.replaceChildren(el("b", {}, `${pv.days} days, to ${canon.formatDate(pv.end)}.`), " ",
      pv.contacts ? `Lodestone asks ${pv.contacts} time${pv.contacts === 1 ? "" : "s"} in all, week by week ${pv.series.join(" · ")}: fewer as you go, none in the last week. Then one closing question on ${canon.formatDate(pv.close)}, and it steps away.` : `No questions on the way; one closing question on ${canon.formatDate(pv.close)}.`,
      el("br"), el("small", {}, "The plan is fixed now: nothing adds a question to it later. No streaks, no counts of days."));
  };
  [work, pace, cadence, discuss].forEach(x => x.addEventListener("change", () => { if (x === work) units.value = ""; show(); }));
  units.addEventListener("input", show);
  box.append(el("label", {}, "Work", work), unitNote, el("label", {}, `Divisions in your edition`, units), el("label", {}, "Pace", pace),
    el("label", {}, "Lodestone asks about it", cadence), el("label", {}, "Talk about the reading", discuss), el("label", {}, "When you usually read", hour), plan,
    el("button", { class: "btn primary block", type: "button", onclick: async () => { canon.createArc(R, opts()); await saveReading(); toast("The reading begins."); renderReading(); } }, "Begin the reading"));
  show();
}
const CADENCE_LINE = arc => arc.discuss === "no" ? "You asked for the plan only: Lodestone raises nothing about it." : arc.discuss === "on_demand" ? "Lodestone speaks of it only when you do." : `Lodestone asks ${canon.CADENCES[arc.cadence]}, less as the arc goes on, inside your next conversation.`;

// ─── What Lodestone learns, the Wheel's movements, writing first, the guide ──

const emptyLearned = () => ({ summary: "", summaryEdited: false, wheel: {}, context: null, fluency: 0, bodily: 0, pending: [], history: [], costLog: [], lastCount: 0, lastRun: 0, updatedAt: 0 });
async function loadPathState() {
  S.learned = { ...emptyLearned(), ...((await store.kv.get("learned")) || {}) };
  S.reading = (await store.kv.get("reading")) || canon.emptyState();
  S.outreachState = (await store.kv.get("outreach")) || { sentLog: [] };
}
async function saveLearned() { S.learned.updatedAt = Date.now(); await store.kv.set("learned", S.learned); syncSoon(); }
// The window and the Telegram bridge share one store: what one learned, the other reads before it writes.
async function freshLearned() { const v = await store.kv.get("learned"); if (v && (v.updatedAt || 0) >= (S.learned?.updatedAt || 0)) S.learned = { ...emptyLearned(), ...v }; }
const learningOn = () => S.settings.learn !== false;
const outreachOn = () => S.settings.outreach !== false;
const levelName = i => cap(LEVELS[i] || "unknown");
const pillarName = k => (PILLARS.find(([x]) => x === k) || [k, cap(k)])[1];

/** The calibration blocks of a turn, read before this message advances them (Telegram's order). */
function calibrationFor(text) {
  const L = S.learned || emptyLearned();
  const blocks = [learning.fluencyBlock(L.fluency), learning.opennessBlock(L.bodily), learning.contextBlocks(L.context)].filter(Boolean).join("\n\n");
  const advance = async () => {
    await freshLearned();
    if (!S.learned) return;
    let changed = false;
    if (S.learned.fluency < 3 && learning.detectHarmonistTerms(text).length) { S.learned.fluency++; changed = true; }
    const floor = learning.detectBodilyOpenness(text);
    if (floor > S.learned.bodily) { S.learned.bodily = floor; changed = true; }
    if (changed) await saveLearned();
  };
  return { blocks, advance };
}

/** The reading arc's block, and the check-in folded into this answer if one is due. */
function readingFor() {
  const R = S.reading; const arc = R && canon.activeArc(R);
  if (!arc) return { block: "", due: null };
  let due = canon.dueCheckin(R);
  if (due) {
    const kind = canon.decideKind(R, arc, due.kind);
    if (arc.discuss === "no" && kind !== "close") { canon.markCheckin(R, due.id, "skipped"); due = null; }
    else due = { ...due, kind };
  }
  return { block: canon.readingBlock(R, arc, due), due, arc };
}

/** After an answer: the check-in it carried is spent; the learning may be due. */
async function afterTurn(turn) {
  if (turn?.readingDue && S.reading) {
    canon.markCheckin(S.reading, turn.readingDue.id, "queued", turn.readingDue.kind);
    if (turn.readingDue.kind === "close") canon.closeArc(S.reading, turn.readingArc.id, "completed");
    await saveReading();
  }
  learnLocally();
}

// The learning: every ten of the practitioner's messages, three calls on the
// model in use, after the answer is on screen. Never on harmonism.io's hosted
// models (it would spend the daily allowance on messages nobody sent) and never
// with no model.
let learnJob = null;
function canLearnHere() { return learningOn() && S.engineReady && S.engine && !["reader", "hosted"].includes(S.engine.kind) && S.where !== "harmonism.io"; }

async function complete(system, user, maxTokens = 1500) {
  let out = "";
  for await (const part of S.engine.stream([{ role: "system", content: system }, { role: "user", content: user }], { maxTokens, temperature: 0.2, background: true })) out = part;
  const u = usageNow(true);
  if (u) { S.learned.costLog = [...(S.learned.costLog || []), { ts: Date.now(), ...u }].slice(-500); }
  return out;
}

async function learnLocally({ force = false } = {}) {
  if (learnJob || !S.learned || !canLearnHere()) return false;
  const all = (await store.messages.all()).filter(m => !m.meta?.crisis && !m.meta?.care && !m.meta?.notice && !m.meta?.review && !m.meta?.outreach && !["harmonic-profile", "crisis-template"].includes(m.meta?.model)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const count = all.filter(m => m.role === "user").length;
  if (!force && count - (S.learned.lastCount || 0) < learning.LEARN_EVERY) return false;
  const job = (async () => {
    await S.summaryJob;
    while (S.busy) await new Promise(r => setTimeout(r, 1500));
    await freshLearned();
    const small = S.engine.kind === "device";
    const recent = all.slice(-60);
    let convo = learning.conversationText(recent);
    if (S.where) convo = leaveOut(convo);   // learning on a rented model reads no secrets either (1.13.1)
    if (small && convo.length > 12000) convo = convo.slice(-12000);
    // What they reported of their practices is evidence too, in their own words.
    const prac = (S.practices || []).filter(p => !p.archived && p.log?.length).map(p => `- [${p.pillar}] ${p.text}: ${p.log.slice(-6).map(l => `${l.status} ${new Date(l.ts).toISOString().slice(0, 10)}`).join(", ")}`);
    const evidence = prac.length ? `${convo}\n\nTheir own practice check-ins (held / partly / not):\n${prac.join("\n")}` : convo;
    try {
      if (!S.learned.summaryEdited || force) {
        const sum = (await complete(learning.PROFILE_PROMPT, learning.profileRequest(S.learned.summary, convo), 1200)).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (sum.length > 40) S.learned.summary = sum.slice(0, 6000);
      }
      const w = learning.parseJson(await complete(learning.WHEEL_PROMPT, learning.wheelRequest(S.wheel, S.learned.wheel, evidence), 1500));
      if (w && typeof w === "object") {
        const r = learning.applyWheelUpdates(S.wheel, S.learned.wheel, w);
        S.learned.wheel = r.learned;
        for (const pr of r.proposals) {
          S.learned.pending = (S.learned.pending || []).filter(x => x.pillar !== pr.pillar);
          S.learned.pending.push(pr);
        }
        if (r.proposals.length) notifyProposals(r.proposals);
      }
      const c = learning.cleanContext(learning.parseJson(await complete(learning.CONTEXT_PROMPT, learning.contextRequest(S.learned.context, (S.where ? leaveOut : x => x)(learning.conversationText(all.slice(-30)))), 800)), S.learned.context);
      if (c) S.learned.context = c;
      try { await proposeLifeBook(all); } catch (e) { console.warn("[life book]", e); }
      S.learned.lastCount = count; S.learned.lastRun = Date.now();
      await saveLearned();
      renderCheckins();
      if (!$("#drawerMe").hidden) renderMe();
      return true;
    } catch (e) { console.warn("[learning]", e); return false; }
  })();
  learnJob = job;
  try { return await job; } finally { learnJob = null; }
}

// ─── The Wheel's movements ───────────────────────────────────────────────────
// A level the evidence moved waits for the practitioner as a proposal. Accepted,
// it moves their Wheel, enters its history, and a rise is marked: the one thing
// in Lodestone that is scored is the Wheel itself, which moves only with their
// life. Nothing is scored for using the app, and the reading carries no score.

function notify(title, body, onClick) {
  const visible = document.visibilityState === "visible" && document.hasFocus();
  if (visible || !("Notification" in window)) return false;
  const go = () => { try { const n = new Notification(title, { body, silent: false }); n.onclick = () => { window.focus(); onClick?.(); n.close(); }; } catch {} };
  if (Notification.permission === "granted") go();
  else if (Notification.permission !== "denied") Notification.requestPermission().then(p => { if (p === "granted") go(); }).catch(() => {});
  return true;
}

function notifyProposals(list) {
  const up = list.filter(p => p.to > p.from);
  const text = list.map(p => `${pillarName(p.pillar)}: ${levelName(p.from)} → ${levelName(p.to)}`).join(" · ");
  notify(up.length ? "Your Wheel is moving" : "Your Wheel has shifted", `${text}. Lodestone asks you to confirm it.`, () => { closeDrawers(); renderCheckins(); });
}

async function answerProposal(pr, accept) {
  await freshLearned();
  S.learned.pending = (S.learned.pending || []).filter(x => x.id !== pr.id);
  const before = learning.wheelScore(S.wheel);
  S.learned.history = [...(S.learned.history || []), { id: pr.id, ts: Date.now(), pillar: pr.pillar, from: pr.from, to: pr.to, source: "lodestone", accepted: !!accept, evidence: pr.evidence }].slice(-500);
  if (accept) {
    S.wheel[pr.pillar] = pr.to;
    await store.kv.set("wheel", S.wheel);
  }
  await saveLearned();
  renderCheckins();
  if (!$("#drawerMe").hidden) renderMe();
  if (accept && pr.to > pr.from) celebrate(pr, before, learning.wheelScore(S.wheel));
  else if (accept) toast(`${pillarName(pr.pillar)} now reads ${levelName(pr.to)}. The Wheel moves both ways; it is a reading, not a verdict.`, 6000);
}

function celebrate(pr, before, after) {
  const box = $("#levelUp");
  box.replaceChildren(
    el("div", { class: "lu-ring", style: `--pc:${PILLAR_COLOR(pr.pillar)}` }, el("span", {}, `+${after - before}`)),
    el("div", { class: "lu-text" }, el("strong", {}, pr.from ? `${pillarName(pr.pillar)} rises to ${levelName(pr.to)}` : `${pillarName(pr.pillar)} enters your Wheel at ${levelName(pr.to)}`), el("span", {}, `Your Wheel: ${after} of ${learning.MAX_SCORE}`)),
    el("button", { type: "button", class: "lu-x", "aria-label": "Close", onclick: () => { box.hidden = true; } }, "×"));
  box.hidden = false; box.classList.remove("show"); void box.offsetWidth; box.classList.add("show");
  clearTimeout(celebrate.t); celebrate.t = setTimeout(() => { box.hidden = true; }, 9000);
  notify(pr.from ? `${pillarName(pr.pillar)} rises to ${levelName(pr.to)}` : `${pillarName(pr.pillar)} enters your Wheel at ${levelName(pr.to)}`, `Your Wheel: ${after} of ${learning.MAX_SCORE}.`);
}

function proposalCards() {
  return (S.learned?.pending || []).map(pr => el("div", { class: "checkin proposal", style: `--pc:${PILLAR_COLOR(pr.pillar)}` },
    el("p", {}, el("b", {}, pr.from ? `${pillarName(pr.pillar)}: ${levelName(pr.from)} → ${levelName(pr.to)}. ` : `${pillarName(pr.pillar)}: a first reading, ${levelName(pr.to)}. `),
      !pr.from ? "You have not placed this pillar yet; from what you have told Lodestone, this is where it stands." : pr.to > pr.from ? "From what you have told Lodestone, this pillar has grown." : "From what you have told Lodestone, this pillar has slipped back.",
      pr.evidence ? el("span", { class: "pr-ev" }, ` “${pr.evidence}”`) : null),
    el("div", { class: "row" },
      el("button", { type: "button", onclick: () => answerProposal(pr, true) }, !pr.from ? "Yes, that fits" : pr.to > pr.from ? "Yes, it has" : "Yes, that is fair"),
      el("button", { type: "button", onclick: () => answerProposal(pr, false) }, "Not yet"),
      el("button", { type: "button", onclick: () => { answerProposal(pr, false); send(`About my ${pillarName(pr.pillar)} pillar: I want to look at where it really stands.`); } }, "Talk it through"))));
}

// ─── Writing first (outreach.js) ─────────────────────────────────────────────
// Hourly while Lodestone is open, between 9:00 and 21:00: if a trigger passes the
// gates (a week since the last, confidence 0.70), the message is composed on the
// model in use and put in a conversation of its own; a system notification
// carries it when the window is not in front. The own Telegram bot does the same
// from its hidden page; one log, so a week's gap holds across both.

let outreachBusy = false;
/** Decide and compose; logs the send. Returns { text, type } or null. `via`: "window" or "telegram". */
async function composeOutreach(via, { force = false } = {}) {
  if (outreachBusy || !outreachOn() || !S.engineReady || !S.engine || ["reader", "hosted"].includes(S.engine.kind) || S.where === "harmonism.io") return null;
  const h = new Date().getHours();
  if (!force && (h < 9 || h >= 21)) return null;
  outreachBusy = true;
  try {
    S.outreachState = (await store.kv.get("outreach")) || S.outreachState || { sentLog: [] };
    S.learned = { ...emptyLearned(), ...((await store.kv.get("learned")) || {}) };
    const msgs = await store.messages.all();
    const user = { ...outreach.userStats(msgs.filter(m => !m.meta?.outreach)), name: S.profile?.name || "" };
    const d = outreach.decide({ user, wheel: S.wheel, learned: S.learned?.wheel || {}, sentLog: S.outreachState.sentLog || [] });
    if (!d.winner) return null;
    while (S.busy) await new Promise(r => setTimeout(r, 2000));
    const person = personContext({ profile: S.profile, wheel: S.wheel, practices: S.practices, assessment: S.assessment, learned: learning.learnedLines(S.learned) });
    const tier = S.engine.tier;
    const system = outreach.composeSystem({ backbone: tier.backbone === "full" ? S.pack.runtime.backbone.full : S.pack.runtime.backbone.light, personContext: person, trigger: d.winner, name: S.profile?.name || "this practitioner" });
    let text = "";
    for await (const part of S.engine.stream([{ role: "system", content: system }, { role: "user", content: "Compose the outreach message now." }], { maxTokens: 600, temperature: 0.7, background: true })) text = part;
    text = stripRetrievalNote(text).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (text.length < 20) return null;
    S.outreachState.sentLog = [...(S.outreachState.sentLog || []), { ts: Date.now(), type: d.winner.type, via }].slice(-50);
    await store.kv.set("outreach", S.outreachState); syncSoon();
    return { text, type: d.winner.type, usage: usageNow(true) };
  } catch (e) { console.warn("[outreach]", e); return null; }
  finally { outreachBusy = false; }
}

// ─── The week (1.13, after Rosebud's weekly reflection) ───────────────────────
// Off until chosen. Once a week, at the day and hour chosen, Lodestone writes a
// short review of the week: what came back, what held, what moved, one question
// for the week ahead (presence.js WEEK_INSTRUCTIONS). Written on the model in
// use (never harmonism.io's hosted one), into a conversation of its own; through
// the Telegram bot when the window is not open. The log rides in the synced
// "outreach" record, so two devices do not both write it. A week with almost
// nothing said gets no review: there is nothing to reflect.

const reviewSettings = () => ({ on: false, day: 0, hour: 18, ...(S.settings.review || {}) });
let reviewBusy = false;
async function composeReview(via, { force = false } = {}) {
  const rs = reviewSettings();
  if (reviewBusy || (!rs.on && !force) || !S.engineReady || !S.engine || ["reader", "hosted"].includes(S.engine.kind) || S.where === "harmonism.io") return null;
  const now = Date.now(), due = presence.dueAt(now, rs.day, rs.hour);
  S.outreachState = (await store.kv.get("outreach")) || S.outreachState || { sentLog: [] };
  // One review a week, whichever device or page writes it, whatever day or hour was chosen since:
  // any review (or one being written, for an hour) within the last six days counts.
  const taken = r => !r.failed && r.ts > now - 6 * 864e5 && (!r.pending || now - r.ts < 3600000);
  if (!force && (S.outreachState.reviews || []).some(taken)) return null;
  reviewBusy = true;
  let mark = null;
  if (!force) {
    mark = { week: due, ts: now, via, pending: true };
    S.outreachState.reviews = [...(S.outreachState.reviews || []), mark].slice(-30);
    await store.kv.set("outreach", S.outreachState);
  }
  const settle = async patch => {
    if (!mark) return;
    S.outreachState = (await store.kv.get("outreach")) || S.outreachState;
    S.outreachState.reviews = (S.outreachState.reviews || []).map(r => r.ts === mark.ts && r.via === via ? { week: due, ts: now, via, ...patch } : r);
    await store.kv.set("outreach", S.outreachState); syncSoon();
  };
  try {
    const from = force ? now - 7 * 864e5 : due - 7 * 864e5, to = force ? now : due;
    const msgs = (await store.messages.since(from)).filter(m => m.ts < to);
    const mine = msgs.filter(m => m.role === "user" && !m.meta?.notice);
    if (mine.length < 3 && !force) { await settle({ skipped: true }); mark = null; return null; }
    while (S.busy) await new Promise(r => setTimeout(r, 2000));
    S.learned = { ...emptyLearned(), ...((await store.kv.get("learned")) || {}) };
    const threads = new Map((await store.threads.list()).map(t => [t.id, t.title]));
    const material = (S.where ? leaveOut : x => x)(presence.weekMaterial({ msgs, practices: S.practices || [], moves: (S.learned.history || []).map(h => ({ ...h, pillar: pillarName(h.pillar), from: levelName(h.from), to: levelName(h.to) })), context: S.learned.context, from, to, threads }));
    const person = personContext({ profile: S.profile, wheel: S.wheel, practices: S.practices, assessment: S.assessment, learned: learning.learnedLines(S.learned) });
    const system = `${presence.WEEK_INSTRUCTIONS}\n\n${person}\n\n<the_week>\n${material}\n</the_week>`;
    let text = "";
    for await (const part of S.engine.stream([{ role: "system", content: system }, { role: "user", content: "Write my review of this week now." }], { maxTokens: 700, temperature: 0.6, background: true })) text = part;
    text = stripRetrievalNote(text).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (text.length < 40) return null;
    await settle({}); mark = null;
    const span = `${new Date(from).toLocaleDateString(undefined, { day: "numeric", month: "short" })}–${new Date(to - 1).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
    return { text, span, week: due, usage: usageNow(true), via };
  } catch (e) { console.warn("[review]", e); return null; }
  finally {
    reviewBusy = false;
    if (mark) await settle({ failed: true }).catch(() => {});   // not written: the next hour tries again
  }
}

async function storeReview(r) {
  const th = await store.threads.create(`The week · ${r.span}`);
  await store.messages.add({ threadId: th.id, role: "assistant", content: r.text, meta: { review: r.week, model: S.engine.describe(), ...(r.via === "telegram" ? { channel: "telegram" } : {}), ...(r.usage ? { usage: r.usage } : {}) } });
  th.updated = Date.now(); await store.threads.put(th);
  return th;
}

async function maybeReview(opts = {}) {
  const r = await composeReview("window", opts);
  if (!r) return null;
  const th = await storeReview(r);
  if (threadsDocked()) renderThreadList();
  const open = async () => { await openThread(await store.threads.get(th.id)); };
  if (opts.force) await open();
  else if (!notify("Lodestone: your week", r.text.slice(0, 180), open)) toast("Your week's review is at the top of your conversations.", 6000);
  return r.text;
}

/** The window's delivery: a conversation of its own, and a notification when the window is not in front. */
async function maybeOutreach(opts = {}) {
  const r = await composeOutreach("window", opts);
  if (!r) return null;
  const th = await store.threads.create("Lodestone wrote");
  await store.messages.add({ threadId: th.id, role: "assistant", content: r.text, meta: { outreach: r.type, model: S.engine.describe(), ...(r.usage ? { usage: r.usage } : {}) } });
  th.updated = Date.now(); await store.threads.put(th);
  if (threadsDocked()) renderThreadList();
  const open = async () => { await openThread(await store.threads.get(th.id)); };
  if (!notify("Lodestone", r.text.slice(0, 180), open)) toast("Lodestone wrote to you: it is at the top of your conversations.", 6000);
  return r.text;
}

// ─── Sharing with a human guide ──────────────────────────────────────────────
// Telegram's /share gave a guide a code to read the profile on the server.
// Here the practitioner chooses what to include and Lodestone makes a document
// on this computer: a page to print or save as PDF, or Markdown. It is sent to
// no one; they give it to their guide themselves.

const SHARE_PARTS = [
  ["wheel", "My Wheel and how it has moved"],
  ["learned", "What Lodestone has learned of me"],
  ["notes", "What I wrote about myself"],
  ["practices", "My practices and how they have held"],
  ["assessment", "My Harmonic Profile summary"],
  ["context", "What I am in the middle of now"],
  ["reading", "My reading of the canon and my margin notes"],
];

function shareMarkdown(parts) {
  const has = k => parts.includes(k);
  const name = S.profile?.name || "A practitioner";
  const out = [`# ${name} — for my guide`, "", `*Prepared in Lodestone on ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}. I chose what is in it.*`, ""];
  if (has("wheel")) {
    out.push("## The Wheel", "", `Score: ${learning.wheelScore(S.wheel)} of ${learning.MAX_SCORE}.`, "");
    for (const [k, n] of PILLARS) out.push(`- **${n}**: ${levelName(S.wheel[k] || 0)}`);
    const moves = (S.learned?.history || []).filter(h => h.accepted !== false && h.to !== h.from).slice(-12);
    if (moves.length) { out.push("", "How it has moved:", ""); for (const h of moves) out.push(`- ${new Date(h.ts).toLocaleDateString()} — ${pillarName(h.pillar)}: ${levelName(h.from)} → ${levelName(h.to)}${h.source === "you" ? " (my own correction)" : ""}${h.evidence ? ` — “${h.evidence}”` : ""}`); }
    out.push("");
  }
  if (has("learned") && (S.learned?.summary || Object.keys(S.learned?.wheel || {}).length)) {
    out.push("## What Lodestone has learned", "", S.learned.summary || "", "");
    for (const [k, n] of PILLARS) { const p = S.learned.wheel?.[k]; if (!p) continue; const bits = [p.concerns && `concerns: ${p.concerns}`, p.strengths && `strengths: ${p.strengths}`, p.edges && `growth edges: ${p.edges}`, p.resistance && "resistance noted"].filter(Boolean); if (bits.length) out.push(`- **${n}** — ${bits.join("; ")}`); }
    out.push("");
  }
  if (has("notes") && S.profile?.notes?.trim()) out.push("## In my own words", "", S.profile.notes.trim(), "");
  if (has("practices")) {
    const ps = (S.practices || []).filter(p => !p.archived);
    if (ps.length) { out.push("## Practices", ""); for (const p of ps) { const log = (p.log || []).slice(-10); const held = log.filter(l => l.status === "held").length; out.push(`- [${pillarName(p.pillar)}] ${p.text} — every ${p.cadence} day${p.cadence > 1 ? "s" : ""}${log.length ? `; of the last ${log.length} check-ins, ${held} held` : ""}`); } out.push(""); }
  }
  if (has("assessment") && S.assessment) out.push("## Harmonic Profile", "", String(S.assessment).slice(0, 4000), "");
  if (has("context") && S.learned?.context) {
    const c = S.learned.context, lines = [c.capsule && `Now: ${c.capsule}`, c.state?.open_commitments?.length && `Committed to: ${c.state.open_commitments.join("; ")}`, c.state?.pending_threads?.length && `Open threads: ${c.state.pending_threads.join("; ")}`].filter(Boolean);
    if (lines.length) out.push("## What I am in the middle of", "", ...lines.map(l => `- ${l}`), "");
  }
  if (has("reading") && S.reading) {
    const arc = canon.activeArc(S.reading) || [...S.reading.arcs].reverse()[0];
    if (arc) { const p = canon.progress(S.reading, arc); out.push("## Reading", "", `${arc.title}${arc.author ? `, ${arc.author}` : ""}: ${p.completed} of ${p.units} ${arc.unit_label} read.`, ""); for (const n of canon.notes(S.reading, arc.id, 20)) out.push(`- (${n.seam}, ${arc.unit_label.replace(/s$/, "")} ${n.unit_index}) ${n.body}`); out.push(""); }
  }
  out.push("---", "*Lodestone reads Harmonism against a life; a guide reads the life. Lodestone's notes are a starting point, not a verdict.*");
  return out.join("\n");
}

function download(name, type, text) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function shareFiles(parts, kind) {
  const md = shareMarkdown(parts), base = `${(S.profile?.name || "Lodestone").replace(/[\\/:*?"<>|]+/g, " ").trim()} — for my guide`;
  if (kind === "md") return download(`${base}.md`, "text/markdown", md);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${base.replace(/</g, "&lt;")}</title><style>body{font:16px/1.6 Georgia,'Iowan Old Style',serif;color:#1a1a2e;max-width:720px;margin:40px auto;padding:0 20px}h1{font-size:1.9rem;margin-bottom:.2em}h2{font-size:1.25rem;margin-top:1.8em;border-bottom:1px solid #ddd;padding-bottom:.2em}em{color:#555}li{margin:.2em 0}hr{border:0;border-top:1px solid #ddd;margin:2em 0}@media print{body{margin:0}}</style></head><body>${render(md)}</body></html>`;
  download(`${base}.html`, "text/html", html);
}

function renderShare() {
  const box = $("#shareBody"); if (!box) return;
  const checks = SHARE_PARTS.map(([k, label]) => { const c = el("input", { type: "checkbox", value: k }); c.checked = !["context", "assessment"].includes(k); return el("label", { class: "check" }, c, el("span", {}, label)); });
  const parts = () => checks.map(l => l.querySelector("input")).filter(c => c.checked).map(c => c.value);
  box.replaceChildren(...checks,
    el("div", { class: "row-btns" },
      el("button", { class: "btn primary", type: "button", onclick: () => shareFiles(parts(), "html") }, "A page to print or send"),
      el("button", { class: "btn ghost", type: "button", onclick: () => shareFiles(parts(), "md") }, "Markdown"),
      el("button", { class: "btn ghost", type: "button", onclick: () => { navigator.clipboard?.writeText(shareMarkdown(parts())); toast("Copied."); } }, "Copy")));
}

// ─── Your path: the learned profile and the score ────────────────────────────

function renderLearned() {
  const box = $("#learnedBody"); if (!box || !S.learned) return;
  const L = S.learned;
  const score = learning.wheelScore(S.wheel);
  $("#wheelScore").replaceChildren(el("b", {}, String(score)), el("span", {}, ` of ${learning.MAX_SCORE}`));
  const sum = el("textarea", { rows: "7", placeholder: "Nothing yet. Lodestone writes its notes here after every ten of your messages; you can correct them." });
  sum.value = L.summary || "";
  sum.addEventListener("change", async () => { L.summary = sum.value.trim(); L.summaryEdited = true; await saveLearned(); toast("Kept. Lodestone will build on your version; it rewrites it again only when you ask it to learn now."); });
  const pill = PILLARS.map(([k, n]) => { const p = L.wheel?.[k]; if (!p) return null; const bits = [p.strengths && `strong: ${p.strengths}`, p.concerns && `concern: ${p.concerns}`, p.edges && `edge: ${p.edges}`, p.resistance && "you seem to keep this one at a distance"].filter(Boolean); return bits.length ? el("li", { style: `--pc:${PILLAR_COLOR(k)}` }, el("b", {}, n), " — ", bits.join(" · ")) : null; }).filter(Boolean);
  const c = L.context;
  const ctx = c && (c.capsule || c.state?.open_commitments?.length || c.state?.pending_threads?.length) ? el("div", { class: "kv" },
    c.capsule ? el("div", {}, el("b", {}, "Now: "), c.capsule) : null,
    c.state?.open_commitments?.length ? el("div", {}, el("b", {}, "You committed to: "), c.state.open_commitments.join("; ")) : null,
    c.state?.pending_threads?.length ? el("div", {}, el("b", {}, "Left open: "), c.state.pending_threads.join("; ")) : null) : null;
  const learnT = el("input", { type: "checkbox" }); learnT.checked = learningOn();
  learnT.onchange = async () => { S.settings.learn = learnT.checked; await store.kv.set("settings", S.settings); renderLearned(); };
  const outT = el("input", { type: "checkbox" }); outT.checked = outreachOn();
  outT.onchange = async () => { S.settings.outreach = outT.checked; await store.kv.set("settings", S.settings); };
  const moves = (L.history || []).filter(h => h.to !== h.from).slice(-8).reverse();
  const learnCost = sumUsage((L.costLog || []).filter(x => x.ts > Date.now() - 30 * 864e5));
  box.replaceChildren(
    el("label", { class: "check" }, learnT, el("span", {}, "Learn from our conversations: every ten of your messages, Lodestone reads them back and updates its notes and your Wheel's evidence. It runs on the model you use, on this computer when the model is here.")),
    el("label", {}, "Lodestone's notes on you", sum),
    pill.length ? el("ul", { class: "learned-pillars" }, pill) : null,
    ctx,
    el("div", { class: "kv" },
      el("div", {}, el("b", {}, "Harmonist vocabulary: "), `${cap(learning.FLUENCY_NAMES[L.fluency] || "new")} — Lodestone uses the terms as far as you have used them yourself.`),
      el("div", {}, el("b", {}, "The body: "), `${cap(learning.OPENNESS_NAMES[L.bodily] || "closed")} — Lodestone speaks of the body and sexuality only as openly as you have.`),
      L.lastRun ? el("div", {}, `Last learned ${new Date(L.lastRun).toLocaleString()}${learnCost.priced ? ` · ${fmtCost(learnCost.cost)} in the last 30 days` : ""}.`) : null),
    moves.length ? el("div", {}, el("h5", { class: "sub-h" }, "How your Wheel has moved"), el("ul", { class: "wheel-history" }, moves.map(h => el("li", { class: h.accepted === false ? "declined" : h.to > h.from ? "up" : "down" },
      el("span", {}, new Date(h.ts).toLocaleDateString(undefined, { day: "numeric", month: "short" })), ` ${pillarName(h.pillar)} ${levelName(h.from)} → ${levelName(h.to)}`, h.accepted === false ? " (not yet)" : h.source === "you" ? " (yours)" : "")))) : null,
    el("div", { class: "row-btns" },
      el("button", { class: "btn ghost", type: "button", disabled: !canLearnHere(), title: canLearnHere() ? "" : "Needs a model, and not harmonism.io's hosted one", onclick: async e => { e.target.disabled = true; e.target.textContent = "Learning…"; const ok = await learnLocally({ force: true }); toast(ok ? "Lodestone has read your conversations again." : "Nothing was learned just now.", 4000); renderLearned(); } }, "Learn now"),
      el("button", { class: "btn ghost", type: "button", onclick: async () => { if (!confirm("Forget what Lodestone has learned? Your Wheel, your notes and your conversations stay.")) return; S.learned = { ...emptyLearned(), history: L.history }; await saveLearned(); renderLearned(); renderCheckins(); } }, "Forget what it learned")),
    el("label", { class: "check" }, outT, el("span", {}, "Lodestone may write first: after a silence longer than your usual rhythm, or when your Wheel is ready for its next step. Once a week at most, in waking hours, while Lodestone is open; through your own Telegram bot too, if you paired one.")),
    reviewControls());
}

function reviewControls() {
  const rs = reviewSettings();
  const save = async patch => { S.settings.review = { ...reviewSettings(), ...patch }; await store.kv.set("settings", S.settings); };
  const on = el("input", { type: "checkbox", id: "reviewOn" }); on.checked = rs.on; on.onchange = () => save({ on: on.checked });
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const day = el("select", { "aria-label": "Day of the review" }, days.map((d, i) => { const o = el("option", { value: String(i) }, d); if (i === rs.day) o.selected = true; return o; }));
  day.onchange = () => save({ day: +day.value });
  const hour = el("select", { "aria-label": "Hour of the review" }, [7, 8, 9, 12, 17, 18, 19, 20, 21].map(h => { const o = el("option", { value: String(h) }, `${h}:00`); if (h === rs.hour) o.selected = true; return o; }));
  hour.onchange = () => save({ hour: +hour.value });
  const now = el("button", { class: "btn ghost", type: "button", id: "reviewNow", disabled: !canLearnHere(), title: canLearnHere() ? "" : "Needs a model, and not harmonism.io's hosted one",
    onclick: async e => { e.target.disabled = true; e.target.textContent = "Writing…"; const t = await maybeReview({ force: true }); if (!t) toast("No review could be written just now.", 4000); e.target.disabled = false; e.target.textContent = "Write the last seven days now"; } }, "Write the last seven days now");
  return el("div", { class: "review-box" },
    el("label", { class: "check" }, on, el("span", {}, "A review of my week: once a week, a short examen of what came back, what held, what moved, and one question for the week ahead. No scores, no streaks; a week with almost nothing said gets none.")),
    el("div", { class: "row-btns" }, day, hour, now));
}
const HP_PENDING = "munai-hp-pending";
const assessmentUrl = () => "/assessment.php?return=lodestone";

function renderAccount(statusEl, btnsEl, a) {
  btnsEl.innerHTML = "";
  if (a) {
    statusEl.textContent = `Signed in as ${a.email}.`;
    btnsEl.append(el("button", { class: "btn ghost", type: "button", onclick: async () => {
      if (await signOutOfAccount()) location.reload();
    } }, "Sign out"));
  } else {
    const L = accountLinks();
    statusEl.textContent = "Not signed in. A new account is confirmed by email; then sign in here.";
    btnsEl.append(el("a", { class: "btn ghost", href: L.signIn }, "Sign in"), el("a", { class: "btn ghost", href: L.register }, "Create an account"));
  }
}

// ─── The account ─────────────────────────────────────────────────────
// What harmonism.io's member dashboard holds, in the app on every device: who is
// signed in, the plan, the consent Lodestone on harmonism.io works under, the
// Sovereignty Bundle, and the community to come. Lodestone Desktop reaches these
// through its own allowlisted calls (desktop/src/main.js "account-call").
async function accountCall(method, path, body = null) {
  if (DESKTOP) {
    if (!DESKTOP.accountCall) throw new Error("Update Lodestone Desktop to see this here.");
    const r = await DESKTOP.accountCall(method, path, body);
    if (!r?.ok) { const e = new Error(r?.message || "harmonism.io could not be reached."); e.code = r?.code; throw e; }
    return r.json;
  }
  const res = await hosted.call(location.origin + "/" + path, { method, ...(body != null ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || j.error || `harmonism.io answered ${res.status}.`);
  return j;
}

async function renderAccountBox() {
  const box = $("#acctBody"); if (!box) return;
  box.innerHTML = "";
  const acct = await heldAccount();
  const site = DESKTOP ? "https://harmonism.io" : location.origin;
  const ext = (href, text) => el("a", { href, target: "_blank", rel: "noopener" }, text);
  if (!acct || acct.expired || acct.computer) {
    box.append(el("p", { class: "hint" }, acct?.expired ? `Your sign-in as ${acct.email} has expired on this computer.` : "Not signed in. Your account holds sync, the Sovereignty Bundle and the consent Lodestone on harmonism.io works under; Lodestone works without it."));
    if (DESKTOP) box.append(desktopSignIn(() => renderAccountBox(), acct?.email));
    else { const L = accountLinks(); box.append(el("div", { class: "row-btns" }, el("a", { class: "btn ghost", href: L.signIn }, "Sign in"), el("a", { class: "btn ghost", href: L.register }, "Create an account"))); }
    box.append(el("h5", {}, "Community"), el("p", { class: "hint" }, "Practitioner directory and reading groups — opening soon."));
    return;
  }
  // Who, and the plan.
  const who = el("p", {}, `Signed in as ${acct.email}. `, el("button", { class: "link-btn", type: "button", onclick: async () => { if (await signOutOfAccount()) location.reload(); } }, "Sign out"), " · ", ext(site + "/member/reset.php", "Change password"));
  const plan = el("p", { class: "hint" }, "Plan: …");
  box.append(who, plan);
  accountCall("GET", "member/dashboard-api.php?action=membership").then(m => {
    const st = m.status || "free";
    const until = t => t ? new Date(t * 1000).toLocaleDateString() : "";
    plan.textContent = st === "paid" ? `Plan: Harmonia Member${m.expires_at ? `, access until ${until(m.expires_at)}` : m.renews_at ? `, renews ${until(m.renews_at)}` : ""}.`
      : st === "comp" ? `Plan: Complimentary Member${m.comp_expires_at ? `, until ${until(m.comp_expires_at)}` : ""}.`
      : "Plan: free. On harmonism.io's hosted models: ten messages a day the first month, then three. Lodestone on a computer you own, or a model under your own key, has no limit.";
    if (st === "paid") plan.append(" ", ext(site + "/member/dashboard.php", "Manage the subscription on harmonism.io"));
  }).catch(e => { plan.textContent = "Plan: " + (e.code === "auth" ? "sign in again to see it." : "could not be read just now."); });

  // Privacy: the consent harmonism.io processes under (GDPR Art. 7(3)).
  const consent = el("div", { class: "hint" }, "Loading…");
  box.append(el("h5", {}, "Privacy"),
    el("p", { class: "hint" }, "Lodestone on harmonism.io processes what you share — health, psychological state, spiritual practice — under the consent you gave with your first message there. You can withdraw it at any time; the next message there asks again. Lodestone on this device, with a model on this device, processes nothing elsewhere. ", ext(site + "/privacy.php", "The privacy policy")),
    consent);
  const showConsent = d => {
    consent.innerHTML = "";
    if (d?.has_consent) {
      const when = d.consented_at ? new Date(typeof d.consented_at === "number" ? d.consented_at * 1000 : d.consented_at).toLocaleDateString() : "";
      const w = el("button", { class: "btn ghost small", type: "button", onclick: async () => {
        if (!confirm("Withdraw your consent for Lodestone to process health, psychological and spiritual information on harmonism.io?\n\nThe next message you send to Lodestone on harmonism.io will ask for fresh consent before continuing.")) return;
        w.disabled = true;
        try { const r = await accountCall("POST", "member/companion-consent.php", { action: "revoke" }); if (r.success === false) throw new Error(r.error || "refused"); showConsent({ has_consent: false }); toast("Consent withdrawn. The next message on harmonism.io asks again.", 5000); }
        catch (e) { w.disabled = false; toast("Could not withdraw consent: " + (e.message || e), 6000); }
      } }, "Withdraw consent");
      consent.append(el("p", {}, el("span", { class: "acct-dot on" }), "Consent active", when ? ` · granted ${when}` : ""), w);
    } else consent.append(el("p", {}, el("span", { class: "acct-dot" }), "No active consent. Lodestone on harmonism.io asks for it before your first message there."));
  };
  accountCall("POST", "member/companion-consent.php", { action: "status" }).then(showConsent).catch(e => { consent.textContent = e.code === "auth" ? "Sign in again to see it." : "Could not be read just now."; });

  // The Sovereignty Bundle.
  const bundle = el("div", {}, el("p", { class: "hint" }, "Loading…"));
  box.append(el("h5", {}, "Sovereignty Bundle"),
    el("p", { class: "hint" }, "The entire publishable Harmonism corpus as Markdown, with starter templates for Cowork, Claude.ai and ChatGPT and Lodestone's doctrinal backbone, for building your own companion. Yours to keep, read offline, and bring to any AI tool."),
    bundle);
  accountCall("GET", "member/sovereignty-bundle.php?status=1").then(d => {
    bundle.innerHTML = "";
    if (d.gated) return bundle.append(el("p", { class: "hint" }, "The bundle is free; sign in again to download it."));
    if (!d.available) return bundle.append(el("p", { class: "hint" }, "Being prepared on harmonism.io: look again shortly."));
    const size = d.size_bytes ? `${(d.size_bytes / 1048576).toFixed(1)} MB` : "";
    bundle.append(el("button", { class: "btn ghost", type: "button", onclick: async () => {
      if (DESKTOP) { const r = await DESKTOP.accountOpenBundle?.(); if (!r?.ok) toast(r?.message || "Update Lodestone Desktop to download it here.", 6000); else toast("The download opens in your browser.", 4000); return; }
      try { const tok = await hosted.token(); location.href = "/member/sovereignty-bundle.php?token=" + encodeURIComponent(tok); } catch (e) { toast(String(e.message || e)); }
    } }, `Download the Sovereignty Bundle${d.version ? ` (v${d.version}${size ? `, ${size}` : ""})` : size ? ` (${size})` : ""}`));
  }).catch(e => { bundle.innerHTML = ""; bundle.append(el("p", { class: "hint" }, e.code === "auth" ? "Sign in again to download it." : "Could not be reached just now."), el("p", { class: "fine" }, ext(site + "/downloads#the-sovereignty-bundle", "Or download it from harmonism.io"))); });

  box.append(el("h5", {}, "Community"), el("p", { class: "hint" }, "Practitioner directory and reading groups — opening soon."));
}

// ─── The Harmonic Profile as a page ─────────────────────────────────
// What harmonism.io's dashboard showed as an eight-page PDF, drawn here from
// this device's memory: the Wheel as Lodestone reads it now, the assessment's
// code, and what Lodestone has noted per pillar. profileview.js holds the
// reading; this opens it, keeps it current, and prints it.
async function profileInput() {
  const tables = ((await store.kv.get("companion")) || {}).state?.tables || {};
  const notes = {};
  for (const r of tables.wheel_profile || []) notes[r.pillar] = { concerns: r.primary_concerns || "", edges: r.growth_edges || "", resistance: r.resistance_noted || "" };
  // The name the person gave Lodestone (Your path → What Lodestone knows about you), nothing guessed.
  const name = S.profile?.name || "";
  return { name, wheel: S.wheel || {}, hp: decodeHP(await store.kv.get("hp_code")), notes, situation: tables.clients?.[0]?.situation_capsule || "" };
}
async function refreshProfileView() {
  const box = $("#profileView"), inl = $("#hpInline");
  const page = !!box && !box.hidden, inline = !!inl && !$("#drawerMe")?.hidden;
  if (!page && !inline) return;
  let html;
  try { html = renderProfile(buildProfile(await profileInput())); }
  catch (e) { console.error(e); html = `<p class="pv-muted">The profile could not be drawn: ${String(e.message || e).replace(/</g, "&lt;")}</p>`; }
  if (page) $("#pvBody").innerHTML = html;
  // Your path carries the profile itself, under the Wheel it is read from.
  // Before any assessment the page would be all blanks: the button shows it as it stands.
  if (inline) { inl.hidden = !S.assessment; inl.innerHTML = S.assessment ? html : ""; }
}
async function openProfileView() {
  const box = $("#profileView"); if (!box) return;
  box.hidden = false; document.body.classList.add("pv-open");
  await refreshProfileView();
  box.scrollTop = 0; $("#pvClose")?.focus();
}
function closeProfileView() {
  const box = $("#profileView"); if (!box) return;
  box.hidden = true; document.body.classList.remove("pv-open");
}
document.addEventListener("click", e => {
  const t = e.target.closest?.("#pvClose, #pvPrint, .pv-ask");
  if (!t) return;
  if (t.id === "pvClose") return closeProfileView();
  if (t.id === "pvPrint") return window.print();
  // "Ask Lodestone": the question goes into the message box, for the person to send.
  closeProfileView(); closeDrawers();
  const input = $("#input"); input.value = t.dataset.ask || ""; autosize(); input.focus();
});
// Esc closes the profile page alone; Your path stays open beneath it.
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#profileView")?.hidden) { e.stopImmediatePropagation(); closeProfileView(); } });

/** Where this memory lives, said where the person looks for it: Your path. */
async function renderMemoryLine() {
  const hp = $("#hpBox"); if (!hp) return;
  let line = $("#memLine");
  if (!line) { line = el("p", { id: "memLine", class: "mem-line" }); $("#drawerMe .me-body").before(line); }
  line.innerHTML = "";
  const open = () => { renderSettings(); openDrawer("#drawerSettings"); setTimeout(() => $("#setSync")?.scrollIntoView({ block: "start" }), 150); };
  if (!syncAvailable()) { line.hidden = true; return; }
  line.hidden = false;
  const sy = syncer();
  const conf = await sy.conf().catch(() => ({}));
  const acct = await accountTransport().account().catch(() => null);
  if (conf.on) {
    line.append(el("span", { class: "mem-dot on" }), el("span", { class: "mem-text" }, conf.error ? `Synced memory: not synced just now (${conf.error.message || "error"}).` : `One memory across your devices${acct?.email ? `, as ${acct.email}` : ""}${conf.last ? `, synced ${ago(conf.last)}` : ""}.`),
      " ", el("button", { class: "link-btn", type: "button", onclick: async e => { e.target.disabled = true; const r = await sy.now(); toast(r?.ok === false ? `Not synced: ${r.message}` : "Synced.", 3000); renderMemoryLine(); } }, "Sync now"));
  } else {
    line.append(el("span", { class: "mem-dot" }), el("span", { class: "mem-text" }, acct?.expired
      ? `Your sign-in as ${acct.email} has expired on this computer: sign in again to sync.`
      : acct?.email && (S.autoState === "join" || S.autoState === "passphrase")
      ? `Your memory syncs on your other devices, as ${acct.email}. Let this one in to have it here.`
      : acct?.email
      ? `This memory is on this device only. Turn on sync so your profile, Wheel and conversations are the same on harmonism.io, your phone and your computer (${acct.email}).`
      : "This memory is on this device only. Sign in, and it syncs with harmonism.io and your other devices by itself."),
      " ", el("button", { class: "btn primary small", type: "button", onclick: acct?.email && (S.autoState === "join" || S.autoState === "passphrase") ? openSyncSetup : open },
        acct?.email && (S.autoState === "join" || S.autoState === "passphrase") ? "Let this device in" : acct && !acct.expired ? "Turn on sync" : "Sign in"));
  }
}

async function renderHP() {
  const box = $("#hpBtns"); if (!box) return;
  box.innerHTML = "";
  const st = $("#hpStatus");
  st.textContent = S.assessment
    ? "Taken. Your Wheel reading above began from it; below is the profile as it stands now, redrawn whenever the Wheel moves. Retake the assessment when your life has moved."
    : "Not taken yet. The assessment reads where you stand across the eight pillars, your Enneagram and your constitution, about twenty minutes; Lodestone then reads you through it.";
  // What Lodestone holds, said plainly: the same text it reads.
  let shown = $("#hpShown");
  // Folded away: the profile itself is drawn below; this is the text behind it.
  if (!shown) { shown = el("div", { id: "hpShown", class: "kv" }); st.after(el("details", { id: "hpShownWrap", class: "hp-shown" }, el("summary", {}, "The text Lodestone reads"), shown)); }
  shown.innerHTML = "";
  $("#hpShownWrap").hidden = !S.assessment;
  const said = String(S.assessment || "").replace(/^Altitude ([\d.?]+)\/10\. Wheel: /, "Altitude: $1/10\nWheel: ");
  if (S.assessment) for (const line of said.split("\n").filter(Boolean)) {
    const m = line.match(/^([^:]{2,40}):\s*(.*)$/);
    shown.append(el("div", {}, m ? el("b", {}, m[1] + ": ") : "", m ? m[2] : line));
  }
  box.append(el("a", { class: "btn " + (S.assessment ? "ghost" : "primary"), href: assessmentUrl() }, S.assessment ? "Retake the assessment" : "Take the assessment"));
  // The full profile: a page of Lodestone's own, drawn from this memory and
  // redrawn when the Wheel moves; printable as PDF.
  box.append(el("button", { class: "btn ghost", type: "button", id: "hpView", onclick: () => openProfileView() }, S.assessment ? "Open as a page · print or save as PDF" : "See your profile so far"));
  // A code from the end of the assessment, or kept from before, goes in here.
  const ta = el("textarea", { id: "hpPaste", rows: 3, placeholder: "HP::…", spellcheck: "false", autocomplete: "off" });
  const go = el("button", { class: "btn ghost", type: "button", onclick: async () => {
    const code = ta.value.replace(/\s+/g, "");
    if (!isHPCode(code)) { toast("That is not a Harmonic Profile code: it begins with HP:: and has no spaces.", 5000); return; }
    if (S.assessment && !confirm("Replace your Harmonic Profile with this one? Your notes, practices and conversations stay as they are.")) return;
    const reply = await ingestHPCode(code);
    if (!reply || !reply.startsWith("I have your Harmonic Profile")) { toast(reply || "The code could not be read.", 6000); return; }
    toast("Your Harmonic Profile is in Lodestone.", 4000);
    syncSoon(500);
    renderMe(); renderCheckins();
  } }, "Take in this code");
  const det = el("details", { class: "hp-paste" }, el("summary", {}, S.assessment ? "Replace it with a code" : "I have a Harmonic Profile code"),
    el("p", { class: "fine" }, "The code the assessment shows at the end. It is read on this device and kept in your memory, so your other devices and harmonism.io have it once they sync."), ta, go);
  box.after(det);
  document.querySelectorAll(".hp-paste").forEach(d => { if (d !== det) d.remove(); });
  if (!DESKTOP && phoneRoutesAvailable()) {
    const a = await hosted.account().catch(() => null);
    if (!a) {
      st.append(" You need a harmonism.io account to bring the result back here.");
      const L = accountLinks();
      box.append(el("a", { class: "btn ghost", href: L.signIn }, "Sign in"), el("a", { class: "btn ghost", href: L.register }, "Create an account"));
    }
  }
}

/** Takes in a profile the assessment left for Lodestone on this device. */
async function takeAssessment() {
  let code = null;
  try { code = localStorage.getItem(HP_PENDING); } catch {}
  if (!code) return;
  try { localStorage.removeItem(HP_PENDING); } catch {}
  if (!isHPCode(code)) return;
  if (S.assessment && !confirm("Replace your earlier Harmonic Profile with the new one? Your notes and practices stay as they are.")) return;
  const reply = await ingestHPCode(code);
  if (!reply) return;
  if (!S.thread) S.thread = await store.threads.create("Harmonic Profile");
  const label = "(Harmonic Profile from the assessment)";
  const um = { threadId: S.thread.id, role: "user", content: label };
  um.id = await store.messages.add(um);
  const am = { threadId: S.thread.id, role: "assistant", content: reply, meta: { model: "harmonic-profile" } };
  am.id = await store.messages.add(am);
  S.history.push({ ...um, ts: Date.now() }, am);
  await touchThread(); renderChat();
  if (threadsDocked()) renderThreadList();
  toast("Your Harmonic Profile is in Lodestone.", 5000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.pack) takeAssessment(); });
// Back in the app: the paired computer may have changed its model meanwhile.
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.engine?.kind === "server" && !DESKTOP) refreshWhere(); });

// ─── The model menu on a phone or in a browser ───────────────────────
// The desktop builds its menu from the main process; here it is built from the
// routes this device holds: the OpenRouter key, the account, the computer that
// served this page, and no model.

async function refreshWebChip() {
  if (DESKTOP || !$("#modelRow")) return;
  // Shown whenever there is a model to change: the menu itself offers the
  // routes not yet set up (a key to paste, an account to sign in to).
  const pc = isNative() ? await pairing.get().catch(() => null) : null;
  const show = !!S.engine && (phoneRoutesAvailable() || !!pc || localInferenceAvailable());
  $("#modelRow").hidden = !show;
  if (!show) return;
  if (S.engine.kind === "hosted") await hosted.status().catch(() => null);   // the model's name, not its id
  $("#modelChipLabel").textContent = S.engine.describe();
  $("#modelChip").classList.toggle("rented", S.engine.kind === "hosted" || S.engine.kind === "openrouter" || (S.engine.kind === "server" && !!S.where));
}

/**
 * The web app's model menu, in the order of setup: the account, OpenRouter,
 * the practitioner's computer, this browser, no model. Each group says who reads
 * each turn. A route not set up yet is one step away inside the menu: a key pasted
 * here, or the account's sign-in.
 */
async function toggleWebMenu() {
  const menu = $("#modelMenu");
  if (!menu.hidden) return closeModelMenu();
  const phoneOk = phoneRoutesAvailable();
  const key = phoneOk ? await secrets.get("openrouter").catch(() => null) : null;
  const acct = phoneOk ? await hosted.account().catch(() => null) : null;
  const cur = { tier: S.settings.tier, model: S.settings.remote?.tier === S.settings.tier ? S.settings.remote.model || "" : "" };
  const item = (label, sub, active, choice) => el("button", {
    class: "model-item" + (active ? " active" : ""), type: "button", role: "menuitemradio", "aria-checked": active ? "true" : "false",
    onclick: () => switchWebTo(choice),
  }, el("span", { class: "n" }, label), sub ? el("span", { class: "s" }, sub) : null);
  const kids = [];
  if (phoneOk) {
    if (acct) {
      let st = null; try { st = await hosted.status(); } catch {}
      const count = st && st.cap > 0 && st.remaining != null ? ` · ${st.remaining} of ${st.cap} left today` : "";
      kids.push(el("div", { class: "model-group" }, `Your harmonism.io account — harmonism.io reads each turn${count}`));
      const list = st?.models?.length ? st.models : RECOMMENDED;
      const curH = cur.model || list.find(x => x.default)?.id || DEFAULT_REMOTE;
      for (const m of list) kids.push(item(m.label, `${m.maker} · ${m.licence} · tested with Lodestone`, cur.tier === "hosted" && curH === m.id, { tier: "hosted", model: m.id }));
    } else {
      kids.push(el("div", { class: "model-group" }, "Your harmonism.io account — harmonism.io reads each turn"));
      kids.push(el("button", { class: "model-item", type: "button", onclick: async () => { closeModelMenu(); S.preferTier = "hosted"; S.engineReady = false; S.engine = null; await showSetup(); } },
        el("span", { class: "n" }, "Sign in for ten free messages a day"), el("span", { class: "s" }, "DeepSeek V4.1 Flash and the other tested models")));
    }
    kids.push(el("div", { class: "model-group" }, "OpenRouter, your key — OpenRouter reads each turn"));
    if (key) {
      for (const m of RECOMMENDED) kids.push(item(m.label, `${m.maker} · ${m.licence} · tested with Lodestone`, cur.tier === "openrouter" && (cur.model || DEFAULT_REMOTE) === m.id, { tier: "openrouter", model: m.id }));
      if (cur.tier === "openrouter" && cur.model && !RECOMMENDED.some(m => m.id === cur.model)) kids.push(item(cur.model, assess(cur.model).note, true, { tier: "openrouter", model: cur.model }));
      const inp = el("input", { type: "text", placeholder: "Any other model id", spellcheck: "false", "aria-label": "Another model id on OpenRouter" });
      const go = () => { const id = inp.value.trim(); if (id) switchWebTo({ tier: "openrouter", model: id }); };
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      kids.push(el("div", { class: "model-other" }, inp, el("button", { type: "button", class: "btn ghost", onclick: go }, "Use")));
    } else {
      // The key, pasted here: tested, kept on this device, and DeepSeek V4.1 Flash begins.
      const inp = el("input", { type: "password", placeholder: "Paste an OpenRouter key: sk-or-…", autocomplete: "off", spellcheck: "false", "aria-label": "OpenRouter key", id: "menuOrKey" });
      const msg = el("p", { class: "model-note", role: "status" }, "No daily limit; you pay OpenRouter for what you use. ", el("a", { href: "https://openrouter.ai/settings/keys", target: "_blank", rel: "noopener" }, "Make a key"), ".");
      const go = async () => {
        const k = inp.value.trim(); if (!k) return;
        msg.textContent = "Asking OpenRouter…";
        try { await testOpenRouter(k, DEFAULT_REMOTE); await secrets.set("openrouter", k); switchWebTo({ tier: "openrouter", model: DEFAULT_REMOTE }); }
        catch (e) { msg.textContent = String(e.message || e); }
      };
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      kids.push(el("div", { class: "model-other" }, inp, el("button", { type: "button", class: "btn ghost", onclick: go }, "Use")), msg);
    }
  }
  const pc = isNative() ? await pairing.get().catch(() => null) : null;
  if (pc) { const w = await desktopWhere(pc.base); if (w !== undefined) S.pairedWhere = w; }
  if (pc) kids.push(el("div", { class: "model-group" }, S.pairedWhere ? `Your computer — it rents from ${HOST_LABEL[S.pairedWhere] || S.pairedWhere}` : "Your computer — nothing leaves your network"), item(`Lodestone Desktop · ${pc.name}`, `over your Wi-Fi, at ${pc.base}`, cur.tier === "server" && !!S.settings.server?.paired, { tier: "server", computer: true }));
  let sameOrigin = false; try { sameOrigin = !!S.settings.server?.baseUrl && new URL(S.settings.server.baseUrl).origin === location.origin; } catch {}
  if (S.settings.server?.model && sameOrigin) kids.push(el("div", { class: "model-group" }, "Your computer — nothing leaves your network"), item(S.settings.server.model, "the model server that served this page", cur.tier === "server", { tier: "server" }));
  if (localInferenceAvailable() && TIERS.standard) {
    kids.push(el("div", { class: "model-group" }, "In this browser — nothing leaves this device"));
    for (const k of TIERS.standard.models) kids.push(item(k, `${MODELS[k].note} · about ${Math.round(MODELS[k].gb)} GB, downloaded once`, cur.tier === "standard" && (S.settings.modelKey || TIERS.standard.models[0]) === k, { tier: "standard", modelKey: k }));
  }
  kids.push(el("div", { class: "model-group" }, "No model"), item("Read and search only", "the passages that bear on a question", cur.tier === "reader", { tier: "reader" }));
  kids.push(el("button", { class: "model-manage", type: "button", onclick: async () => { closeModelMenu(); S.engineReady = false; S.engine = null; await showSetup(); } }, "Keys, account and where Lodestone thinks…"));
  menu.replaceChildren(...kids);
  menu.hidden = false; $("#modelChip").setAttribute("aria-expanded", "true");
}

async function switchWebTo(choice) {
  closeModelMenu();
  if (S.busy) { toast("Wait for this answer to finish, then change the model."); return; }
  if (choice.tier === "standard" && !(S.settings.tier === "standard" && S.settings.modelKey === choice.modelKey)) {
    const m = MODELS[choice.modelKey];
    if (!confirm(`Think with ${choice.modelKey} in this browser? The first time, it downloads about ${Math.round(m.gb)} GB and runs on this computer's graphics card; after that it works offline and nothing you say leaves this device.`)) return;
  }
  S.settings.tier = choice.tier;
  if (choice.tier === "openrouter" || choice.tier === "hosted") S.settings.remote = { tier: choice.tier, model: choice.model || "" };
  if (choice.tier === "standard") S.settings.modelKey = choice.modelKey;
  if (choice.computer) { const p = await pairing.get(); if (p) S.settings.server = await computerServer(p); }
  await store.kv.set("settings", S.settings);
  S.engineReady = false; S.engine = makeEngine(); updateBadge();
  try { await S.engine.load((p, t) => engineStatus(shorten(t || "Loading the model…"), p)); S.engineReady = true; engineStatus(null); }
  catch (e) { toast(String(e.message || e), 6000); }
  await refreshWhere();
  updateBadge();
  $("#chat").append(el("div", { class: "model-switch", role: "status" }, `Now thinking with ${S.engine.describe()}`));
  $("#chat").scrollTop = $("#chat").scrollHeight;
  refreshWebChip();
}

function renderMe() {
  renderHP();
  renderMemoryLine();
  renderReading();
  renderLearned();
  renderShare();
  $("#meName").value = S.profile.name || "";
  $("#meCountry").value = S.profile.country || "";
  $("#meNotes").value = S.profile.notes || "";
  const sel = $("#prPillar");
  if (!sel.options.length) PILLARS.forEach(([k, n]) => sel.append(el("option", { value: k }, n)));
  const ul = $("#practiceList"); ul.innerHTML = "";
  for (const p of S.practices.filter(x => !x.archived)) {
    const last = (p.log || []).slice(-6).map(l => l.status === "held" ? "●" : l.status === "partly" ? "◐" : "○").join(" ");
    ul.append(el("li", { style: `--pc:${PILLAR_COLOR(p.pillar)}` },
      el("span", {}, p.text),
      el("small", {}, `${cap(p.pillar)} · every ${p.cadence} day${p.cadence > 1 ? "s" : ""}${last ? " · " + last : ""}`),
      el("button", { type: "button", title: "Release this practice", onclick: async () => { p.archived = Date.now(); await savePractices(); renderMe(); renderCheckins(); } }, "Release")));
  }
  renderWheel();
}

function renderWheel() {
  const rows = $("#wheelRows"); rows.innerHTML = "";
  for (const [k, n] of PILLARS) {
    const s = el("select", { "aria-label": n }, LEVELS.map((l, i) => el("option", { value: i }, l)));
    s.value = S.wheel[k] || 0;
    s.onchange = async () => {
      const from = Number(S.wheel[k]) || 0, to = Number(s.value);
      S.wheel[k] = to; await store.kv.set("wheel", S.wheel); drawWheel();
      if (S.learned && from !== to) { S.learned.history = [...(S.learned.history || []), { id: `${k}-you-${Date.now()}`, ts: Date.now(), pillar: k, from, to, source: "you", accepted: true }].slice(-500); S.learned.pending = (S.learned.pending || []).filter(p => p.pillar !== k); await saveLearned(); renderCheckins(); renderLearned(); }
    };
    rows.append(el("div", { class: "wheel-row", style: `--pc:${PILLAR_COLOR(k)}` }, el("span", {}, n), s));
  }
  drawWheel();
}

// The Wheel as Harmonia draws it (Harmonia media/Design/Wheels/wheel-of-harmony.svg):
// Presence at the centre; Recreation at the top, then clockwise Nature,
// Relationships, Matter, Health, Service, Learning. The rows beside it keep the
// Way of Harmony's order; only the drawing follows the canonical figure.
const WHEEL_RING = ["recreation", "nature", "relationships", "matter", "health", "service", "learning"];
function drawWheel() {
  const svg = $("#wheelSvg"); const R = 78; const NS = "http://www.w3.org/2000/svg";
  svg.setAttribute("viewBox", "-168 -104 336 208");
  svg.innerHTML = "";
  const mk = (t, a) => { const n = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) n.setAttribute(k, v); svg.append(n); return n; };
  const name = Object.fromEntries(PILLARS);
  for (let lv = 1; lv <= 6; lv++) mk("circle", { r: R * lv / 6, fill: "none", stroke: "var(--border-light)", "stroke-width": 0.6 });
  const pts = [];
  WHEEL_RING.forEach((k, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / WHEEL_RING.length;
    const c = Math.cos(a), s = Math.sin(a);
    mk("line", { x1: 0, y1: 0, x2: R * c, y2: R * s, stroke: "var(--border-light)", "stroke-width": 0.6 });
    const v = Math.max(0, Math.min(6, Number(S.wheel[k]) || 0)) / 6;
    pts.push([+(R * v * c).toFixed(2), +(R * v * s).toFixed(2)]);
    const dot = mk("circle", { cx: R * v * c, cy: R * v * s, r: 3.2, fill: PILLAR_COLOR(k), stroke: "none" });
    const lv = LEVELS[Number(S.wheel[k]) || 0];
    dot.append(Object.assign(document.createElementNS(NS, "title"), { textContent: `${name[k]}: ${lv}` }));
    const t = mk("text", { x: (R + 9) * c, y: (R + 9) * s + 3, "text-anchor": Math.abs(c) < 0.2 ? "middle" : c > 0 ? "start" : "end", fill: PILLAR_COLOR(k) });
    t.textContent = name[k];
  });
  mk("polygon", { points: pts.map(p => p.join(",")).join(" "), fill: "var(--accent)", "fill-opacity": 0.18, stroke: "var(--accent-secondary)", "stroke-width": 1 });
  const pv = Math.max(0, Math.min(6, Number(S.wheel.presence) || 0)) / 6;
  refreshProfileView();
  const pc = mk("circle", { r: 6 + 14 * pv, fill: PILLAR_COLOR("presence"), "fill-opacity": 0.35, stroke: PILLAR_COLOR("presence") });
  pc.append(Object.assign(document.createElementNS(NS, "title"), { textContent: `Presence: ${LEVELS[Number(S.wheel.presence) || 0]}` }));
}

// ─── Library & reader ────────────────────────────────────────────────────────

function renderLibrary(q = "") {
  const ul = $("#libList"); ul.innerHTML = "";
  const arts = S.pack.corpus.articles;
  const meta = S.pack.runtime.pack;
  $("#libMeta").textContent = `${meta.articles} articles on this device · pack of ${new Date(meta.built_at).toLocaleDateString()}`;
  if (q.trim()) {
    for (const i of S.retriever.searchArticles(q)) ul.append(libItem(i));
    if (!ul.children.length) ul.append(el("li", { class: "hint" }, "Nothing matches."));
    return;
  }
  const groups = new Map();
  arts.forEach((a, i) => {
    const parts = a.p.split("/");
    const g = parts.length > 1 ? parts[0] : "Harmonia";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });
  const order = ["Harmonia", "Philosophy", "Wheel of Harmony", "World", "The Living Papers"];
  for (const g of [...groups.keys()].sort((a, b) => (order.indexOf(a) + 99) % 100 - (order.indexOf(b) + 99) % 100)) {
    ul.append(el("li", { class: "group" }, g));
    groups.get(g).sort((x, y) => arts[x].p.localeCompare(arts[y].p)).forEach(i => ul.append(libItem(i)));
  }
}

function libItem(i) {
  const a = S.pack.corpus.articles[i];
  const where = a.p.split("/").slice(1, -1).join(" · ");
  return el("li", { "data-i": i, class: i === readerArticle ? "active" : "" }, el("button", { type: "button", onclick: () => openReader(i) }, a.t, where ? el("small", {}, where) : null));
}

// The Library is one window: the list on the left, the article on the
// right. An article opened from a conversation opens there too, its place in
// the list shown.
let readerArticle = null;
function openLibrary() {
  if (!$("#libList").children.length) renderLibrary($("#libSearch").value);
  const d = $("#drawerLibrary");
  if (d.hidden) openDrawer("#drawerLibrary");
  showReader(readerArticle != null);
}
function showReader(on) {
  $("#drawerLibrary").classList.toggle("reading", on);
  $("#readerPane").hidden = !on; $("#libEmpty").hidden = on;
  if (!on) $("#readerTitle").textContent = "Library";
}
function openReader(i) {
  const a = S.pack.corpus.articles[i]; readerArticle = i;
  $("#readerTitle").textContent = a.t;
  $("#readerMeta").textContent = [a.l, a.s, a.d].filter(Boolean).join(" · ");
  $("#readerBody").innerHTML = render(a.x);
  $("#readerOnline").href = a.u;
  openLibrary();
  showReader(true);
  $("#drawerLibrary .lib-main").scrollTop = 0;
  document.querySelectorAll("#libList li.active").forEach(li => li.classList.remove("active"));
  const li = document.querySelector(`#libList li[data-i="${i}"]`);
  if (li) { li.classList.add("active"); li.scrollIntoView({ block: "nearest" }); }
}

// ─── Settings ────────────────────────────────────────────────────────────────

// Settings → Advanced: folders Lodestone may read
async function renderFolders(r) {
  if (!DESKTOP?.foldersList) return;
  r = r || await DESKTOP.foldersList().catch(() => ({ folders: [] }));
  const box = $("#setFolders"); box.innerHTML = "";
  for (const p of r.folders) box.append(el("div", { class: "folder-row" }, el("span", { class: "p", title: p }, p),
    el("button", { class: "btn ghost", type: "button", onclick: async () => renderFolders(await DESKTOP.foldersRemove(p)) }, "Remove")));
  if (!r.folders.length) box.append(el("p", { class: "fine" }, "No folder yet."));
  $("#setFolderReread").hidden = !r.folders.length;
  renderVault();
  $("#setFoldersStats").textContent = r.stats ? `${r.stats.files.toLocaleString()} files read, ${r.stats.chunks.toLocaleString()} passages${r.stats.skipped ? ` (${r.stats.skipped} files over 2 MB left out)` : ""}.` : "";
  $("#setFoldersWhere").textContent = S.where
    ? `Lodestone is thinking with a rented model (${S.where}): the passages it uses from these folders travel with each message to that provider, which can read them.`
    : "Lodestone is thinking on this computer: nothing from these folders leaves it.";
}

// Settings → Spoken replies, and the chip under the message box.
const MODE_LABEL = { text: "Text", voice: "Voice", both: "Both", mirror: "Mirror" };
const MODE_HINT = {
  text: "Answers are read, not heard. Any answer can still be heard with Listen.",
  voice: "Answers are spoken; the text waits folded under them, a click away.",
  both: "Answers are written and spoken together.",
  mirror: "When you dictate a message, the answer is spoken; when you type, it is written.",
};
async function saveVoice(patch) {
  S.settings.voice = { ...voiceSettings(), ...patch };
  await store.kv.set("settings", S.settings);
  renderVoiceChip();
  if (!$("#drawerSettings").hidden) renderVoiceSettings();
}

async function renderVoiceSettings() {
  const box = $("#setVoice"); if (!box) return;
  box.hidden = false;
  const v = voiceSettings();
  // Which voice reads: a natural one wherever it can be reached, else the device's own.
  const plan = await voicePlan().catch(() => null), c = voiceCredsCache || { keys: {}, own: {} };
  const natural = !!plan || v.source === "provider";
  $("#setVoiceSource").hidden = $("#setVoiceSourceHint").hidden = false;
  [...$("#setVoiceSource").children].forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === (natural ? "provider" : "device"))));
  $("#setVoiceSourceHint").textContent = plan ? voicePlanLine(plan)
    : v.source === "provider" ? "No natural voice can be reached yet: paste a key below, think with OpenRouter or your harmonism.io account, or sign in to it. Until then this device's own voices read."
    : v.source === "device" ? "Answers are read by this device's own voices: nothing leaves it."
    : convLocal() && hasVoiceRoute() ? "Lodestone is thinking on this device, so its voice stays here too: choose Natural voice to have answers read by Grok's voices instead."
    : "This device's own voices read: nothing leaves it. A natural voice needs an OpenRouter, xAI or OpenAI key, or your harmonism.io account.";
  if (plan?.zdr) $("#setVoiceSourceHint").append(" ", el("button", { type: "button", class: "btn ghost small", onclick: async () => {
    clearPolicyBlocks(); S.voiceSubNoted = false; speaker.stop();
    toast("Lodestone will try Grok's voices again on the next answer; if OpenRouter still refuses them, ElevenLabs reads.", 6000);
    renderVoiceSettings(); renderVoiceChip();
  } }, "Try Grok's voices again"));
  const cloudBox = $("#setVoiceCloud");
  if (cloudBox) {
    cloudBox.hidden = v.source === "device";
    const fsel = $("#setVoiceFamily");
    const reach = fam => FAMILIES[fam].via.some(r => r === "account" ? c.account : !!c.keys[r]);
    fsel.replaceChildren(...Object.entries(FAMILIES).map(([k, f]) => el("option", { value: k }, `${f.label} — ${f.voices}${reach(k) ? "" : f.via.includes("openai") ? " (needs an OpenAI key)" : " (needs an OpenRouter key)"}`)));
    fsel.value = FAMILIES[v.family] ? v.family : "grok";
    $("#setVoiceFamilyNote").textContent = `${FAMILIES[fsel.value].label}: ${FAMILIES[fsel.value].note}.`;
    const kept = VOICE_KEYS.filter(k => c.own?.[k]);
    $("#setVoiceKeys").replaceChildren(
      document.createTextNode(kept.length ? "Kept for voice, encrypted on this device: " : c.conv === "openrouter" ? "The OpenRouter key Lodestone thinks with already reads aloud; a key here is only needed for another provider." : "One key can serve both: an OpenRouter key reads aloud as well as thinks. A key here is used for voice alone and kept encrypted on this device."),
      ...kept.flatMap((k, i) => [document.createTextNode(i ? ", " : ""), el("b", {}, ROUTE_LABEL[k]), document.createTextNode(" "),
        el("button", { type: "button", class: "btn ghost small", onclick: async () => { await secrets.del("voice-" + k); speaker.stop(); toast(`The ${ROUTE_LABEL[k]} key for voice is removed.`, 4000); renderVoiceSettings(); renderVoiceChip(); } }, "Remove")]));
  }
  const deviceOnly = !!plan;
  for (const id of ["setVoiceNameRow", "setVoiceLangNote", "setVoiceDeviceHint"]) { const e = $("#" + id); if (e) e.hidden = deviceOnly; }
  [...$("#setVoiceMode").children].forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.v === v.mode)); if (b.dataset.v === "mirror") { b.disabled = !canRecord(); b.title = canRecord() ? MODE_HINT.mirror : "Mirror follows dictation, which Lodestone Desktop has"; } });
  [...$("#setVoiceGender").children].forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === v.gender)));
  $("#setVoiceHint").textContent = MODE_HINT[v.mode];
  $("#setVoiceRate").value = String(v.rate || 1);
  const lang = S.settings.lang && S.settings.lang !== "auto" ? S.settings.lang : (navigator.language || "en").slice(0, 2);
  const list = await voice.voices();
  const cands = voice.voicesFor(list, lang);
  const sel = $("#setVoiceName");
  const auto = voice.pickVoice(list, lang, v.gender);
  sel.replaceChildren(el("option", { value: "" }, auto ? `Best ${v.gender} voice (now ${auto.name})` : "No voice for this language"),
    ...cands.map(c => el("option", { value: c.voiceURI }, `${c.name}${voice.genderOf(c) ? ` · ${voice.genderOf(c)}` : ""} · ${c.lang}`)));
  sel.value = v.names?.[lang] && cands.some(c => c.voiceURI === v.names[lang]) ? v.names[lang] : "";
  sel.dataset.lang = lang;
  $("#setVoiceLangNote").textContent = `For ${{ en: "English", fr: "French", es: "Spanish", ar: "Arabic", pt: "Portuguese", de: "German" }[lang] || lang}; each language keeps its own choice. ${cands.length} voice${cands.length === 1 ? "" : "s"} on this computer.`;
}

function renderVoiceChip() {
  const b = $("#voiceChip"); if (!b) return;
  b.hidden = !$("#modelRow");
  if (!voicePlanCache && !voiceCredsCache) voicePlan().catch(() => null);   // settles the menu's "Read by" for later
  const v = voiceSettings();
  $("#voiceChipLabel").textContent = v.mode === "text" ? "Text" : `${MODE_LABEL[v.mode]} · ${v.gender === "male" ? "male" : "female"}`;
  b.classList.toggle("on", v.mode !== "text");
  b.title = `Spoken replies: ${MODE_HINT[v.mode]} Click to change.`;
}

async function toggleVoiceMenu() {
  const menu = $("#voiceMenu");
  if (!menu.hidden) { menu.hidden = true; $("#voiceChip").setAttribute("aria-expanded", "false"); return; }
  closeModelMenu();
  const v = voiceSettings();
  const plan = await voicePlan().catch(() => null), fam = FAMILIES[plan?.family || v.family] || FAMILIES.grok;
  const openVoiceSettings = () => { renderSettings(); openDrawer("#drawerSettings"); setTimeout(() => $("#setVoice")?.scrollIntoView({ block: "start" }), 150); };
  const item = (label, sub, active, fn, disabled = false) => el("button", { class: "model-item" + (active ? " active" : ""), type: "button", role: "menuitemradio", "aria-checked": String(active), disabled, onclick: () => { menu.hidden = true; fn(); } }, el("span", { class: "n" }, label), sub ? el("span", { class: "s" }, sub) : null);
  menu.replaceChildren(
    el("div", { class: "model-group" }, "Lodestone answers in"),
    ...voice.MODES.map(k => item(MODE_LABEL[k], MODE_HINT[k], v.mode === k, () => saveVoice({ mode: k }), k === "mirror" && !canRecord())),
    el("div", { class: "model-group" }, "Read by"),
    item(`Natural voice — ${fam.label}`, plan ? `through ${ROUTE_LABEL[plan.route]}; the answer's text goes to it` : hasVoiceRoute() ? "the answer's text goes to the provider" : "needs a key or your account: Settings", !!plan, async () => { speaker.stop(); await saveVoice({ source: "provider" }); if (!(await voicePlan().catch(() => null))) openVoiceSettings(); }),
    item(`${HERE === "this device" ? "This device's" : "This computer's"} voices`, "nothing leaves it", !plan, () => { speaker.stop(); saveVoice({ source: "device" }); }),
    el("div", { class: "model-group" }, plan ? `Voice — ${fam.voices}` : `Voice — ${HERE}'s own; nothing leaves it`),
    item("Female", "", v.gender === "female", () => saveVoice({ gender: "female" })),
    item("Male", "", v.gender === "male", () => saveVoice({ gender: "male" })),
    el("button", { class: "model-manage", type: "button", onclick: () => { menu.hidden = true; openVoiceSettings(); } }, "Choose the voice and speed…"));
  menu.hidden = false; $("#voiceChip").setAttribute("aria-expanded", "true");
}

function renderRecallSetting() {
  const box = $("#setRecall"); if (!box) return;
  box.checked = recallOn();
  box.onchange = async () => { S.settings.recall = box.checked; await store.kv.set("settings", S.settings); if (box.checked) recallSoon(2000); renderRecallSetting(); };
  const where = $("#setRecallWhere");
  if (where) where.textContent = !S.retriever?.embedQuery ? "Deep retrieval is not loaded on this device, so nothing is recalled here." : S.where && recallOn() ? `What is recalled travels with the message to ${S.where}, which can read it.` : "";
}

async function renderSettings() {
  renderRecallSetting();
  renderFolders();
  renderLifeBook();
  renderSync();
  renderAccountBox();
  renderDictation();
  renderVoiceSettings();
  renderUsageSummary();
  const t = TIERS[S.settings.tier];
  const kvBox = $("#setEngine"); kvBox.innerHTML = "";
  kvBox.append(el("div", {}, el("b", {}, t.label)), el("div", {}, S.engine ? S.engine.describe() : ""),
    el("div", {}, t.engine === "none" ? "No model: questions bring back passages of the corpus" : `Context ${S.engine?.tier.ctx || t.ctx} tokens · ${t.backbone === "server" ? "harmonism.io's current" : t.backbone === "full" ? "full" : "light"} doctrinal backbone`));
  const sel = $("#setModel"); sel.innerHTML = "";
  const acct = $("#setAccount"); acct.innerHTML = ""; acct.hidden = true;
  if (!DESKTOP && (t.engine === "hosted" || t.engine === "openrouter")) {
    // Phone routes: change the model in place; sign out or forget the key.
    const reengine = async model => {
      S.settings.remote = { tier: S.settings.tier, model };
      await store.kv.set("settings", S.settings);
      S.engine = makeEngine();
      try { await S.engine.load(); S.engineReady = true; engineStatus(null); } catch (e) { S.engineReady = false; toast(String(e.message || e)); }
      updateBadge();
      $("#chat").append(el("div", { class: "model-switch", role: "status" }, `Now thinking with ${S.engine.describe()}`));
      refreshWebChip();
    };
    sel.parentElement.hidden = false;
    if (t.engine === "hosted") {
      let st = null;
      try { st = await hosted.status(); } catch (e) { kvBox.append(el("div", {}, String(e.message || e))); }
      if (st) kvBox.append(el("div", {}, `Signed in as ${st.email}${st.cap > 0 && st.remaining != null ? ` · ${st.remaining} of ${st.cap} messages left today` : ""}`));
      const list = st?.models || [];
      for (const m of list) sel.append(el("option", { value: m.id }, `${m.label} · ${m.maker} · ${m.licence}`));
      if (!list.length) sel.parentElement.hidden = true;
      sel.value = S.settings.remote?.model || list.find(m => m.default)?.id || list[0]?.id || "";
      sel.onchange = () => reengine(sel.value);
      acct.append(el("button", { class: "btn ghost", type: "button", onclick: async () => {
        if (await signOutOfAccount()) location.reload();
      } }, "Sign out"));
    } else {
      for (const m of RECOMMENDED) sel.append(el("option", { value: m.id }, `${m.label} · ${m.maker} · tested with Lodestone`));
      const cur = S.settings.remote?.model;
      if (cur && !RECOMMENDED.some(m => m.id === cur)) sel.append(el("option", { value: cur }, `${cur} · ${assess(cur).note}`));
      sel.value = cur || RECOMMENDED[0]?.id;
      sel.onchange = () => reengine(sel.value);
      acct.append(el("button", { class: "btn ghost", type: "button", onclick: async () => {
        if (!confirm("Forget the OpenRouter key on this device? Your conversations stay.")) return;
        await secrets.del("openrouter"); S.engineReady = false; updateBadge(); closeDrawers(); S.engine = null; await showSetup();
      } }, "Forget the key"));
    }
    acct.hidden = false;
  } else if (DESKTOP) {
    const info = await DESKTOP.info().catch(() => ({}));
    kvBox.innerHTML = "";
    S.where = info.remote?.host || null;
    kvBox.append(el("div", {}, el("b", {}, S.where ? `Rented from ${S.where}, with your key` : "On this computer")), el("div", {}, info.label || "Lodestone's model"),
      el("div", {}, "Context 32,768 tokens · full doctrinal backbone"));
    sel.parentElement.hidden = true;
    $("#setChangeTier").textContent = "Change model…";
    $("#setCheckUpdate").textContent = "Check for updates (Lodestone and the corpus)";
    S.desktopVersion = info.version || null;
  } else if (t.engine === "webllm") {
    sel.parentElement.hidden = false;
    for (const k of t.models) sel.append(el("option", { value: k }, `${k} · ${MODELS[k].openness} · ~${MODELS[k].gb} GB · ${MODELS[k].note}`));
    sel.value = S.settings.modelKey;
    sel.onchange = async () => {
      S.settings.modelKey = sel.value; await store.kv.set("settings", S.settings);
      S.engineReady = false; S.engine = makeEngine(); closeDrawers();
      engineStatus("Loading the model…", 0.05);
      try { await S.engine.load((p, tx) => engineStatus(shorten(tx || "Loading…"), p)); S.engineReady = true; engineStatus(null); }
      catch (e) { engineStatus(`Model unavailable: ${e.message}`, 0); }
      updateBadge();
    };
  } else sel.parentElement.hidden = true;

  [...$("#setTheme").children].forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === (S.settings.theme || "dark"))));
  $("#setLang").value = S.settings.lang || "auto";
  const p = S.pack.runtime.pack;
  $("#setCorpus").innerHTML = "";
  $("#setCorpus").append(
    el("div", {}, el("b", {}, `${p.articles} articles`), ` · ${p.chunks} passages · ${(p.corpus_bytes / 1e6).toFixed(1)} MB`),
    el("div", {}, `Built ${new Date(p.built_at).toLocaleString()} · backbone v${p.backbone_full_version}`),
    el("div", {}, `Retrieval: ${retrievalMode()}`));
  // Offline readiness, stated rather than assumed. The first deploy registered no
  // service worker at all (one missing icon failed the install) and nothing in the
  // interface said so — the app looked fine until the network went away.
  const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
  const swReady = !!(reg && reg.active);
  const offlineReady = DESKTOP || swReady;
  const remoteKind = S.engine && (S.engine.kind === "hosted" || S.engine.kind === "openrouter");
  const modelReady = S.engine && S.engine.kind === "server" ? null : await (S.engine ? S.engine.isCached() : Promise.resolve(false));
  const line = el("div", {});
  line.append(el("b", {}, offlineReady ? "Works offline" : "Not yet offline-ready"));
  const detail = offlineReady
    ? (DESKTOP
        ? (S.where ? ` — the app, the corpus and your memory are on this computer; the model is rented from ${S.where} and needs the internet.` : " — the app, the corpus and the model are all on this computer.")
        : S.engine?.kind === "reader"
        ? " — the app and the corpus are on this device, and no model is used."
        : remoteKind
        ? ` — the app, the corpus and your memory are on this device; the model is reached on ${S.engine.where} and needs the internet. Without it, the Library still works.`
        : modelReady === null
        ? " — the app and corpus are on this device; the model lives on your computer, so it needs that machine reachable."
        : modelReady
          ? " — app, corpus and model are all on this device. Try airplane mode."
          : " — app and corpus are stored; the model has not finished downloading.")
    : " — this browser has not stored the app. Reload once while online; if it persists, the page may be served over plain http, which forbids offline storage.";
  line.append(detail);
  $("#setCorpus").append(line);

  $("#setAbout").textContent = DESKTOP
    ? (S.where
        ? `Lodestone${S.desktopVersion ? " " + S.desktopVersion : ""}. Retrieval, the safeguards and memory run on this computer; each turn's question and context go to ${S.where}, which answers it. There is no telemetry. Lodestone, the corpus and the library update only when you ask.`
        : `Lodestone${S.desktopVersion ? " " + S.desktopVersion : ""}. Inference, retrieval and memory run on this computer. There is no telemetry. Lodestone, the corpus and the library update only when you ask.`)
    : remoteKind
    ? `Lodestone. Retrieval, the safeguards and memory run on this device; each turn's question and context go to ${S.engine.where}, which answers it. There is no telemetry. The corpus updates only when you ask it to.`
    : "Lodestone. Inference, retrieval and memory run on hardware you own. There is no telemetry. The corpus updates only when you ask it to.";
}

// ─── Chrome ──────────────────────────────────────────────────────────────────

// Focus goes into what opens and comes back where it was (1.13.1): with the
// cursor left in the hidden message box, Enter sent a message under Settings.
let drawerReturn = null;
function openDrawer(sel) {
  document.querySelectorAll(".drawer").forEach(d => { if ("#" + d.id !== sel && !isDocked(d)) d.hidden = true; });
  const d = $(sel);
  if (!drawerReturn || !document.contains(drawerReturn)) drawerReturn = document.activeElement;
  d.hidden = false; $("#scrim").hidden = false;
  if (!d.hasAttribute("role")) { d.setAttribute("role", "dialog"); const h = d.querySelector(".drawer-head h3"); if (h) { h.id = h.id || d.id + "Title"; d.setAttribute("aria-labelledby", h.id); } }
  if (d.classList.contains("page")) openPage(d);
  setTimeout(() => { if (!d.hidden && !d.contains(document.activeElement)) (d.querySelector(".drawer-head [data-close], .drawer-head button") || d).focus?.(); }, 30);
}

// ─── Settings and Your path as full-window pages ─────────────────────
// The chat steps aside while one is open. The list on the left is drawn from
// the page's own sections (section[data-nav]), so a section shown or hidden
// (Sync, Spoken replies, the Wisdom Canon) comes and goes in the list with it;
// it follows the reading as the page scrolls.
const pageSpy = new WeakMap();
function openPage(d) {
  const main = d.querySelector(".page-main");
  if (!d.querySelector(".page-nav-items")) return;   // the Library: its list is its own
  drawPageNav(d);
  if (!pageSpy.has(d)) {
    let t = 0;
    let settle = 0;
    const spy = () => {
      if (d._navHold) { clearTimeout(settle); settle = setTimeout(() => { d._navHold = null; }, 160); return; }
      cancelAnimationFrame(t); t = requestAnimationFrame(() => markPageNav(d));
    };
    // A wheel or a key is the reader moving on: the list follows again.
    for (const ev of ["wheel", "touchmove", "keydown"]) main.addEventListener(ev, () => { d._navHold = null; }, { passive: true });
    main.addEventListener("scroll", spy, { passive: true });
    // Sections that appear or vanish while the page is open.
    new MutationObserver(() => { if (!d.hidden) drawPageNav(d); }).observe(d.querySelector(".me-body, .settings-body"), { subtree: true, attributes: true, attributeFilter: ["hidden"] });
    pageSpy.set(d, true);
  }
  main.scrollTop = 0; d._navHold = null;
  renderVault();
  if (d.id === "drawerMe") refreshProfileView();
}
function pageSections(d) {
  return [...d.querySelectorAll("section[data-nav]")].filter(s => !s.hidden && s.offsetParent !== null && s.parentElement.closest("section") === null);
}
function drawPageNav(d) {
  const box = d.querySelector(".page-nav-items"); if (!box) return;
  const key = pageSections(d).map(s => s.dataset.nav).join("|");
  if (box.dataset.key === key) return markPageNav(d);
  box.dataset.key = key; box.innerHTML = "";
  for (const sec of pageSections(d)) {
    const ic = sec.querySelector("h4 svg")?.cloneNode(true);
    const b = el("button", { type: "button", "data-for": sec.dataset.nav }, ...(ic ? [ic] : []), el("span", {}, sec.dataset.nav));
    // The item clicked stays lit while the page glides to it.
    b.onclick = () => { d._navHold = sec.dataset.nav; sec.scrollIntoView({ block: "start", behavior: "smooth" }); setPageNavOn(d, sec.dataset.nav); };
    box.append(b);
  }
  markPageNav(d);
}
function setPageNavOn(d, name) {
  d.querySelectorAll(".page-nav-items button").forEach(b => b.classList.toggle("on", b.dataset.for === name));
}
function markPageNav(d) {
  const main = d.querySelector(".page-main"); if (!main) return;
  const secs = pageSections(d); if (!secs.length) return;
  const top = main.getBoundingClientRect().top + 90;
  let cur = secs[0];
  for (const s of secs) if (s.getBoundingClientRect().top <= top) cur = s;
  // At the very bottom the last section is the one being read, however short.
  if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) cur = secs[secs.length - 1];
  setPageNavOn(d, cur.dataset.nav);
}

// ─── The vault: the folder Lodestone works in, always in view ─────────────────
// The top bar of Lodestone Desktop names it; Settings and Your path name it at
// the foot of their lists, with the folders Lodestone may read.
const homeShort = p => String(p || "").replace(/^\/(Users|home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
async function renderVault() {
  const chip = $("#btnVault");
  if (!DESKTOP?.lifebookStatus) { if (chip) chip.hidden = true; document.querySelectorAll(".vault-line").forEach(x => (x.innerHTML = "")); return; }
  await loadLifeBookStatus();
  const lb = S.lifeBook, on = !!lb?.vault;
  // The path as the person knows it: ~/Notes/MyVault, or its last two folders when long.
  const short = on ? homeShort(lb.vault) : "";
  const name = short.length <= 26 ? short : "…/" + lb.vault.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  const lbRel = on ? (String(lb.dir || "").slice(String(lb.vault).length).replace(/^[\\/]+/, "") || "Lodestone") + "/" : "";
  let folders = [];
  try { folders = (await DESKTOP.foldersList())?.folders || []; } catch {}
  const goSettings = () => { renderSettings(); openDrawer("#drawerSettings"); setTimeout(() => $("#setLifeBook")?.scrollIntoView({ block: "start" }), 150); };
  if (chip) {
    chip.hidden = false;
    chip.classList.toggle("none", !on);
    $("#btnVaultLbl").textContent = on ? name : "Choose a vault";
    chip.title = on
      ? `Lodestone works in ${homeShort(lb.vault)}: its life book is ${homeShort(lb.dir)} (${lb.notes.toLocaleString()} note${lb.notes === 1 ? "" : "s"})${folders.length ? `, and it reads ${folders.length} folder${folders.length === 1 ? "" : "s"}` : ""}.`
      : "No vault chosen: Lodestone keeps no life book yet. Click to choose your Obsidian vault.";
    chip.onclick = goSettings;
  }
  for (const box of document.querySelectorAll(".vault-line")) {
    box.innerHTML = "";
    if (on) box.append(el("div", {}, el("b", {}, "Vault"), el("span", { class: "p", title: lb.vault }, homeShort(lb.vault))),
      el("div", {}, `Life book: ${lbRel} · ${lb.notes.toLocaleString()} note${lb.notes === 1 ? "" : "s"}`));
    else box.append(el("div", {}, el("b", {}, "Vault"), "None chosen yet."));
    if (folders.length) box.append(el("div", {}, el("b", {}, "Reads"), ...folders.map(f => el("span", { class: "p", title: f, style: "display:block" }, homeShort(f)))));
    box.append(on && DESKTOP.lifebookOpen ? el("button", { type: "button", onclick: () => DESKTOP.lifebookOpen() }, "Show the vault folder") : el("button", { type: "button", onclick: goSettings }, "Choose your vault…"));
  }
}
function closeDrawers() {
  const was = [...document.querySelectorAll(".drawer")].some(d => !d.hidden && !isDocked(d));
  document.querySelectorAll(".drawer").forEach(d => { if (!isDocked(d)) d.hidden = true; });
  $("#scrim").hidden = true;
  if (was) { const r = drawerReturn; drawerReturn = null; if (r && document.contains(r) && r.offsetParent !== null) r.focus?.(); else $("#input")?.focus(); }
}

// Conversations stay docked on the left in a wide window (the default); the
// list button folds them away and the choice is remembered. Narrow windows and
// phones keep the sliding drawer.
const DOCK_KEY = "munai-threads-docked";
const wideMQ = matchMedia("(min-width: 900px)");
function dockWanted() { try { return localStorage.getItem(DOCK_KEY) !== "0"; } catch { return true; } }
function threadsDocked() { return document.documentElement.classList.contains("threads-docked"); }
function isDocked(d) { return d.id === "drawerThreads" && threadsDocked(); }
function syncDock() {
  const on = dockWanted() && wideMQ.matches && !$("#main").hidden;
  const was = threadsDocked();
  document.documentElement.classList.toggle("threads-docked", on);
  if (on) { $("#drawerThreads").hidden = false; renderThreadList(); }
  else if (was) $("#drawerThreads").hidden = true;
}
function setDock(on) { try { localStorage.setItem(DOCK_KEY, on ? "1" : "0"); } catch {} syncDock(); }
wideMQ.addEventListener("change", syncDock);

function autosize() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(180, t.scrollHeight) + "px"; }

let toastT;
// ─── Desktop: the model menu ────────────────────────────────────────────────
// Every model on this computer, and the rented ones under the saved key, chosen
// without leaving the conversation. The thread goes on; the next answer comes
// from the model chosen. A line in the chat marks the change (not stored, never
// sent to the model).

const recLabel = (q, id) => (q?.recommended || []).find(m => m.id === id)?.label || id;

/** The model in use, named as the practitioner knows it (the desktop's model list, or the engine's own description). */
function modelLabelOf(q, withCount = false) {
  if (!q?.current) return null;
  if (q.current.kind === "local") return q.local.find(m => m.id === q.current.id)?.label || "A model on this computer";
  if (q.current.kind === "remote") return `${recLabel(q, q.current.model)} · ${q.remote?.host || "rented"}`;
  if (q.current.kind === "hosted") return `${(q.hostedModels || []).find(m => m.id === q.current.model)?.label || q.current.model} · harmonism.io${withCount && q.hosted?.remaining != null && q.hosted.cap > 0 ? ` · ${q.hosted.remaining} left today` : ""}`;
  if (q.current.kind === "upstream") return q.current.label;
  return null;
}
function currentModelLabel() {
  if (DESKTOP) return modelLabelOf(S.models) || S.engine?.describe() || null;
  if (S.engine?.kind === "openrouter") return `${RECOMMENDED.find(m => m.id === S.engine.model)?.label || S.engine.model} · OpenRouter`;
  return S.engine?.describe() || null;
}

async function refreshModelChip() {
  const q = await DESKTOP.quickModels().catch(() => null);
  if (!q) return;
  S.models = q;
  const label = modelLabelOf(q, true) || "Choose a model";
  $("#modelChipLabel").textContent = label;
  $("#modelChip").classList.toggle("rented", q.current.kind === "remote" || q.current.kind === "hosted");
  $("#modelRow").hidden = false;
}

function closeModelMenu() { $("#modelMenu").hidden = true; $("#modelChip").setAttribute("aria-expanded", "false"); }

async function toggleModelMenu() {
  const menu = $("#modelMenu");
  if (!menu.hidden) return closeModelMenu();
  await refreshModelChip();
  const q = S.models; if (!q) return;
  const cur = q.current;
  const item = (label, sub, active, choice) => el("button", {
    class: "model-item" + (active ? " active" : ""), type: "button", role: "menuitemradio", "aria-checked": active ? "true" : "false",
    onclick: () => switchModelTo(choice, label),
  }, el("span", { class: "n" }, label), sub ? el("span", { class: "s" }, sub) : null);
  const kids = [];
  kids.push(el("div", { class: "model-group" }, "On this computer — nothing leaves it"));
  if (q.local.length) for (const m of q.local) kids.push(item(m.label, [m.hand, m.vision ? "sees images" : ""].filter(Boolean).join(" · "), cur.kind === "local" && cur.id === m.id, { kind: "local", id: m.id }));
  else kids.push(el("p", { class: "model-note" }, "No model downloaded yet."));
  if (q.hosted) {
    const h = q.hosted;
    const count = h.error ? h.error : h.cap > 0 && h.remaining != null ? `${h.remaining} of ${h.cap} left today` : h.cap === 0 ? "no daily limit" : "";
    kids.push(el("div", { class: "model-group" }, `Your harmonism.io account${count ? ` — ${count}` : ""} · each turn goes to harmonism.io`));
    for (const m of q.hostedModels || []) kids.push(item(m.label, `${m.maker} · ${m.licence} · tested with Lodestone`, cur.kind === "hosted" && cur.model === m.id, { kind: "hosted", model: m.id }));
  }
  if (q.remote?.hasKey) {
    kids.push(el("div", { class: "model-group" }, `Rented from ${q.remote.host} — the provider reads each turn`));
    const seen = new Set();
    for (const m of q.recommended) { seen.add(m.id); kids.push(item(m.label, `${m.maker} · ${m.licence} · tested with Lodestone`, cur.kind === "remote" && cur.model === m.id, { kind: "remote", model: m.id })); }
    for (const id of q.recent) if (!seen.has(id)) { seen.add(id); kids.push(item(id, q.assess?.[id]?.note || "not tested against the doctrine", cur.kind === "remote" && cur.model === id, { kind: "remote", model: id })); }
    const inp = el("input", { type: "text", placeholder: "Any other model id", spellcheck: "false", "aria-label": "Another model id" });
    const go = () => { const id = inp.value.trim(); if (id) switchModelTo({ kind: "remote", model: id }, id); };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    kids.push(el("div", { class: "model-other" }, inp, el("button", { type: "button", class: "btn ghost", onclick: go }, "Use")));
  } else {
    kids.push(el("p", { class: "model-note" }, q.hosted ? "A model rented under your own key (OpenRouter, Venice…) is set up in Model…" : "Ten free messages a day with your harmonism.io account, or a model rented under your own key: both in Model…"));
  }
  kids.push(el("button", { class: "model-manage", type: "button", onclick: () => { closeModelMenu(); DESKTOP.openModels(); } }, "Models and keys…"));
  menu.replaceChildren(...kids);
  menu.hidden = false; $("#modelChip").setAttribute("aria-expanded", "true");
}

async function switchModelTo(choice, label) {
  closeModelMenu();
  if (S.busy) { toast("Wait for this answer to finish, then change the model."); return; }
  const q = S.models;
  if (q && ((choice.kind === "local" && q.current.kind === "local" && q.current.id === choice.id) || (choice.kind === "remote" && q.current.kind === "remote" && q.current.model === choice.model))) return;
  S.engineReady = false; updateBadge();
  $("#modelChipLabel").textContent = choice.kind === "local" ? `Waking ${label}…` : `Switching to ${label}…`;
  try {
    await DESKTOP.switchModel(choice);
    S.where = (await DESKTOP.info().catch(() => ({}))).remote?.host || null;
    $("#chat").append(el("div", { class: "model-switch", role: "status" }, `Now thinking with ${choice.kind === "remote" ? recLabel(q, choice.model) : label}`));
    $("#chat").scrollTop = $("#chat").scrollHeight;
  } catch (e) {
    toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), 6000);
  } finally {
    S.engineReady = true; updateBadge();
    await refreshModelChip();
  }
}

function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
const cap = s => (s || "").charAt(0).toUpperCase() + (s || "").slice(1);

// ─── Attachments (desktop) ───────────────────────────────────────────────────
// Read on this computer the moment they are added (attach.js); what is read
// waits in the bar above the message box and goes with the next message.

function renderAttachBar() {
  const bar = $("#attachBar"); if (!bar) return;
  bar.innerHTML = "";
  bar.hidden = !S.pending.length;
  for (const it of S.pending) {
    const what = it.status === "reading" ? (it.statusText || "Reading…")
      : it.status === "error" ? it.error
      : it.data?.note || (it.data?.images?.length ? "image" : `${(it.data?.text?.length || 0).toLocaleString()} characters`);
    bar.append(el("span", { class: "attach-chip" + (it.status === "error" ? " err" : "") },
      el("span", { class: "n", title: it.name }, `📎 ${it.name}`), el("small", {}, what),
      el("button", { type: "button", "aria-label": `Remove ${it.name}`, onclick: () => { S.pending = S.pending.filter(x => x !== it); renderAttachBar(); } }, "×")));
  }
}

// At most this many waiting at once; a folder dropped gives its readable files up to it.
const MAX_PENDING = 20;
// Formats a browser cannot open (old Word, HEIC, TIFF…): the desktop converts them on this computer.
const convertFile = DESKTOP?.convertFile ? async file => {
  const r = await DESKTOP.convertFile(file.name || "file", await file.arrayBuffer());
  return r && !r.error ? r : null;
} : null;

async function addFiles(list) {
  list = (list || []).filter(Boolean);
  if (!list.length) return;
  const room = MAX_PENDING - S.pending.length;
  if (room <= 0) { toast(`${MAX_PENDING} attachments wait already: send them, or remove some.`, 5000); return; }
  if (list.length > room) { toast(`${list.length} files: the first ${room} are attached (${MAX_PENDING} at most per message).`, 6000); list = list.slice(0, room); }
  // The same file twice (dropped, then picked again) is attached once.
  const key = f => `${f.name}|${f.size}|${f.lastModified}`;
  const have = new Set(S.pending.map(x => x.key));
  list = list.filter(f => { const k = key(f); if (have.has(k)) return false; have.add(k); return true; });
  const items = list.map(file => ({ file, key: key(file), name: file.name || "pasted image", kind: kindOf(file), status: "reading", statusText: (file.size || 0) > 20e6 ? `Reading ${sizeLabel(file.size)}…` : "Reading…" }));
  S.pending.push(...items); renderAttachBar();
  for (const item of items) {
    const { file } = item;
    const say = t => { item.statusText = t; renderAttachBar(); };
    try {
      if (!S.pending.includes(item)) continue;   // removed while the ones before it were read
      let info = DESKTOP ? await DESKTOP.info().catch(() => ({})) : await webAttachInfo();
      if (item.kind === "audio" && !DESKTOP) {
        say("Waiting for the speech model…");
        const route = await chooseSpeechRoute("To read recordings");
        if (!route) throw new Error("Not transcribed.");
        if (route === "provider") {
          const p = voiceProvider();
          say(`Sending it to ${PROVIDER_LABEL[p]} to be written out…`);
          const text = await cloudTranscribe(p, file, dictCode(), await voiceCtx(p));
          if (!text) throw new Error("Nothing was heard in it.");
          item.data = { name: item.name, kind: "audio", text, note: `recording, written out by ${PROVIDER_LABEL[p]}` };
        }
      } else if (item.kind === "audio" && !info.asr) {
        if (!confirm("To read recordings and videos, Lodestone needs its speech model (about 250 MB). It is downloaded once and runs on this computer: the recording goes nowhere. Download it now?")) throw new Error("Not transcribed.");
        const off = DESKTOP.onProgress?.(p => { if (p.what === "speech" && p.total) say(`Downloading the speech model… ${Math.round(p.done / p.total * 100)}%`); });
        const r = await DESKTOP.asrDownload(); off?.();
        if (!r.ok) throw new Error(r.message || "The speech model could not be downloaded.");
      }
      let vision = info.vision?.state || "no";
      if (item.kind === "image" && vision === "download") {
        if (confirm(`To see images, ${info.label || "this model"} needs its vision component (${Math.round((info.vision.size || 0) / 1e6)} MB), downloaded once. Lodestone then restarts the model, which takes a few seconds. Download it now?`)) {
          const off = DESKTOP.onProgress?.(p => { if (p.what === "vision" && p.total) say(`Downloading the model's vision… ${Math.round(p.done / p.total * 100)}%`); });
          const r = await DESKTOP.visionDownload(); off?.();
          if (!r.ok) throw new Error(r.message || "The vision component could not be downloaded.");
          vision = "yes";
        }
      }
      const canSee = vision === "yes" || vision === "maybe";
      if (item.kind === "image" && !canSee) throw new Error(vision === "download" ? "Not attached: the model cannot see images until its vision is downloaded." : `${info.label || "This model"} cannot see images. A Gemma model, or a rented model such as Claude, can.`);
      const language = speechLanguage(S.settings.lang && S.settings.lang !== "auto" ? S.settings.lang : navigator.language);
      item.data = item.data || await readAttachment(file, { canSee, language, status: say, convert: convertFile });
      if (item.data.kind === "pdf" && item.data.scanned && !item.data.images?.length && !item.data.text) throw new Error("This PDF is pictures of pages, and the model in use cannot see. Attach it with a model that can see.");
      if (!item.data.text?.trim() && !item.data.images?.length) throw new Error(item.kind === "audio" ? "Nothing was heard in it." : "Nothing readable in it.");
      item.kind = item.data.kind;
      item.status = "ready";
      // A short recording with nothing typed: the transcript becomes the message, for the practitioner to read over and send.
      if (item.kind === "audio" && item.data.text && item.data.text.length < 1500 && !$("#input").value.trim()) {
        $("#input").value = item.data.text; autosize(); $("#input").focus();
        S.pending = S.pending.filter(x => x !== item);
        toast(item.data.note?.includes("written out by") ? `Written out by ${PROVIDER_LABEL[voiceProvider()] || "the provider"}. Read it over, then send.` : `Transcribed on ${HERE}. Read it over, then send.`, 5000);
        S.dictated = true;
      }
    } catch (e) {
      item.status = "error"; item.error = String(e.message || e);
    }
    delete item.file;   // the bytes are let go once read
    renderAttachBar();
  }
}

/** The files a drop carries, a dropped folder walked for its files (hidden ones and dependencies left out). */
async function droppedFiles(dt) {
  const entries = [...(dt.items || [])].map(it => it.kind === "file" && it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some(e => e.isDirectory)) return [...(dt.files || [])];
  const out = [];
  const fileOf = e => new Promise(res => e.file(res, () => res(null)));
  const list = d => new Promise(res => { const r = d.createReader(), all = []; const step = () => r.readEntries(b => { if (!b.length) return res(all); all.push(...b); step(); }, () => res(all)); step(); });
  async function walk(e, depth) {
    if (out.length > 400 || depth > 6 || /^\.|^(node_modules|__MACOSX|\$RECYCLE\.BIN)$/.test(e.name)) return;
    if (e.isFile) { const f = await fileOf(e); if (f) out.push(f); return; }
    for (const c of (await list(e)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) await walk(c, depth + 1);
  }
  for (const e of entries) await walk(e, 0);
  // From a folder, only what can be read: kinds known by name, and nothing large of no known kind.
  const readable = out.filter(f => kindOf(f) !== "unknown" || f.size < 2e6);
  if (out.length > readable.length) toast(`${out.length - readable.length} file${out.length - readable.length > 1 ? "s" : ""} of kinds Lodestone does not read left out.`, 5000);
  return readable;
}

// ─── Voice through a provider ─────────────────────────────────────────
// Only where the conversation already goes to a provider (OpenRouter under the
// practitioner's key, or harmonism.io's hosted models), and only when chosen:
// the device's speech model and voices stay the private default.
const voiceProvider = () => (DESKTOP ? null : providerOf(S.engine));
async function voiceCtx(p) { return p === "openrouter" ? { key: await secrets.get("openrouter") } : { call: (u, i) => hosted.call(u, i) }; }
const dictViaProvider = () => !!voiceProvider() && S.settings.dictSource === "provider";
const speakViaProvider = () => !!voicePlanCache;

// ─── Natural voices ─────────────────────────────────────────────────
// Answers are read by a natural voice wherever one can be reached (voicecloud.js):
// the conversation's own provider first, so that one key or one account serves
// both, then a key given for voice alone. Where the conversation stays on the
// device, the voice stays too, unless a key was given for voice or the natural
// voice was chosen. "This device's voices" in Settings keeps every answer here.
let voicePlanCache = null, voiceCredsCache = null;
onVoiceSubstitute((from, to) => {
  if (S.voiceSubNoted) return; S.voiceSubNoted = true;
  toast(`Your OpenRouter account accepts only providers that keep nothing, which ${FAMILIES[from].label}'s voice is not: ${FAMILIES[to].label}'s ${FAMILIES[to].voices} read instead. Settings → Spoken replies says how to hear ${FAMILIES[from].voices}.`, 9000);
});
const VOICE_KEYS = ["openrouter", "xai", "openai"];   // kept as secrets "voice-<kind>", encrypted on this device
const hasVoiceRoute = () => !!voiceCredsCache && (voiceCredsCache.account || VOICE_KEYS.some(k => voiceCredsCache.keys[k]));
function convRoute() {
  if (DESKTOP) { const c = S.models?.current?.kind; return c === "hosted" ? "account" : c === "remote" && S.models?.remote?.preset === "openrouter" ? "openrouter" : null; }
  return providerOf(S.engine);
}
const convLocal = () => DESKTOP ? ["local", "upstream"].includes(S.models?.current?.kind) : (S.engine?.kind === "device" || S.engine?.kind === "reader" || (S.engine?.kind === "server" && !S.where));
async function voiceCreds() {
  const g = n => secrets.get(n).catch(() => null);
  if (DESKTOP && !S.models) { try { S.models = await DESKTOP.quickModels(); } catch {} }
  const conv = convRoute();
  const own = {}; for (const k of VOICE_KEYS) own[k] = await g("voice-" + k);
  // The key Lodestone thinks with reads aloud too: one key for both.
  const convKey = conv === "openrouter" ? (DESKTOP ? await DESKTOP.syncKeyGet?.().catch(() => null) : await g("openrouter")) : null;
  const textKey = !DESKTOP && !convKey ? await g("openrouter") : null;
  const account = DESKTOP ? !!(S.models?.hosted && DESKTOP.voiceSpeak) : !!(await hosted.account().catch(() => null));
  return (voiceCredsCache = { conv, own, account, keys: { openrouter: convKey || own.openrouter || textKey, xai: own.xai, openai: own.openai }, voiceKey: VOICE_KEYS.some(k => own[k]) });
}
/** The natural voice that will read, { route, family, ctx, instead }, or null for the device's own. */
async function voicePlan() {
  const v = voiceSettings();
  const c = await voiceCreds();
  if (v.source === "device") return (voicePlanCache = null);
  if (v.source !== "provider" && convLocal() && !c.voiceKey) return (voicePlanCache = null);
  const have = { openrouter: !!c.keys.openrouter, xai: !!c.keys.xai, openai: !!c.keys.openai, account: c.account };
  const r = chooseRoute(v.family, have, c.conv);
  if (!r) return (voicePlanCache = null);
  if (r.route === "openrouter") { const f = orFamilyFor(r.family); if (f !== r.family) Object.assign(r, { family: f, zdr: true }); }
  const ctx = r.route === "account" ? (DESKTOP ? { speak: (t, gd, l) => DESKTOP.voiceSpeak(t, gd, l) } : { call: (u, i) => hosted.call(u, i) }) : { key: c.keys[r.route] };
  return (voicePlanCache = { ...r, ctx });
}
function voicePlanLine(plan) {
  if (!plan) return "";
  const f = FAMILIES[plan.family], c = voiceCredsCache || {};
  const via = plan.route === "account" ? "your harmonism.io account (Harmonia's voices, 20,000 characters a day)"
    : plan.route === c.conv ? `${ROUTE_LABEL[plan.route]}, on the key Lodestone thinks with`
    : c.own?.[plan.route] ? `${ROUTE_LABEL[plan.route]}, on the key you gave for voice` : `${ROUTE_LABEL[plan.route]}, on your key`;
  return `Read by ${f.label}'s ${f.voices}, through ${via}: the text of each answer goes to ${ROUTE_LABEL[plan.route]} to be read.${plan.zdr ? " (Your OpenRouter account accepts only providers that keep nothing, and Grok's voice is not one: allow it at openrouter.ai/settings/privacy, or paste an xAI key, to hear Ara and Rex.)" : ""}${plan.instead ? ` (${FAMILIES[voiceSettings().family]?.label || "The voice chosen"} needs an OpenRouter key.)` : ""} Answers to someone in distress are never read unasked.`;
}
/** The language to tell the provider: the one set for dictation or replies, else let it hear. */
const dictCode = () => { const l = S.settings.dictLang && S.settings.dictLang !== "auto" ? S.settings.dictLang : S.settings.lang && S.settings.lang !== "auto" ? S.settings.lang : ""; return l ? l.slice(0, 2) : null; };

/**
 * How a recording is written out on the web: "provider", "device" (the speech
 * model is here), or null (not now). Asked once when both are possible.
 */
async function chooseSpeechRoute(why, dictating = false) {
  const p = voiceProvider();
  if (p && S.settings.dictSource === "provider") return "provider";
  if (S.settings.dictSource !== "provider" && await speechWeb.speechReady()) return "device";
  if (p && !S.settings.dictSource) {
    const viaP = confirm(`${why}: write it out through ${PROVIDER_LABEL[p]}?\n\nOK — the recording is sent to ${PROVIDER_LABEL[p]}${p === "account" ? " and the transcription service it uses" : ""}, which writes it out. Nothing to download.\nCancel — download the speech model once (about ${speechWeb.MB} MB); your voice then stays on this device.\n\nSettings → Dictation changes this at any time.`);
    S.settings.dictSource = viaP ? "provider" : "device"; await store.kv.set("settings", S.settings);
    if (viaP) return "provider";
  }
  return (await ensureWebSpeech(why, dictating)) ? "device" : null;
}

// ─── Attachments and dictation in the web app ───────────────────────
// What the model in use can take, as Lodestone Desktop's info() says it: a
// rented or account model "maybe" sees images (a provider's model cannot be
// checked from here, as on the desktop); the browser's own small models and
// reading without a model do not.
async function webAttachInfo() {
  const k = S.engine?.kind;
  return { asr: await speechWeb.speechReady(), vision: { state: ["openrouter", "hosted", "server"].includes(k) ? "maybe" : "no" }, label: S.engine?.describe?.() || "This model" };
}

/** The speech model in this browser, downloaded once with the practitioner's leave. Resolves true when ready now. */
let speechDl = null;
async function ensureWebSpeech(why, dictating = false) {
  if (await speechWeb.speechReady()) return true;
  if (!speechWeb.speechStorable()) { toast("This browser cannot keep the speech model (it needs a secure page and storage).", 6000); return false; }
  if (speechDl) { toast("The speech model is still downloading.", 3000); return false; }
  const phone = isHandheld();
  if (!confirm(`${why}, Lodestone needs its speech model (Whisper small, about ${speechWeb.MB} MB). It is downloaded once into this browser, from Hugging Face, checked, and runs on ${HERE}: your voice goes nowhere.${phone ? " On a phone, use Wi-Fi for the download; transcribing is slower than on a computer." : ""} Download it now?`)) return false;
  D.working = true; setMic();
  let last = -1;
  speechDl = speechWeb.downloadSpeech((done, total) => { const pc = Math.floor(done / total * 100); if (pc >= last + 5) { last = pc; toast(`Downloading the speech model… ${pc}%`, 4000); } });
  try {
    await speechDl;
    toast(dictating ? "The speech model is ready. Press the microphone and speak." : "The speech model is ready.", 5000);
    if (!$("#drawerSettings").hidden) renderDictation();
    return !dictating;   // dictation starts when the practitioner presses again, not when the download ends
  } catch (e) { toast(String(e.message || e), 8000); return false; }
  finally { speechDl = null; D.working = false; setMic(); }
}

// ─── Dictation (desktop) ─────────────────────────────────────────────────────
// Click the microphone, speak, click again: the clip is turned into text by
// Whisper on this computer (the speech model attachments already use,
// asr-worker.js) and lands in the message box at the caret. It is never sent
// by itself, so it can be read over first. Lode sends the voice to a provider
// under a key; Lodestone does not: on this computer, nothing leaves.

const D = { rec: null, timer: null, start: 0, working: false };
const canRecord = () => !!((DESKTOP ? DESKTOP.asrDownload : (speechWeb.speechStorable() && window.Worker) || voiceProvider()) && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
const dictLanguage = () => speechLanguage(S.settings.dictLang && S.settings.dictLang !== "auto" ? S.settings.dictLang
  : S.settings.lang && S.settings.lang !== "auto" ? S.settings.lang : navigator.language);

function setMic() {
  const b = $("#micBtn"); if (!b) return;
  b.hidden = !canRecord();
  b.disabled = D.working;
  b.classList.toggle("recording", !!D.rec);
  b.classList.toggle("working", D.working);
  b.setAttribute("aria-pressed", D.rec ? "true" : "false");
  const label = D.working ? `Transcribing on ${HERE}…` : D.rec ? "Stop and write it in" : "Dictate";
  b.title = D.rec || D.working ? label : `${label}${DESKTOP ? " (⇧⌘D)" : ""}: transcribed on ${HERE}`;
  b.setAttribute("aria-label", label);
}

// ─── A conversation by voice (1.13, after Sesame's and Pi's) ──────────────────
// Hands free: Lodestone listens, hears the end of what was said by the silence
// after it, writes it out (on this computer, or through the provider chosen in
// Settings → Dictation), sends it, speaks the answer, and listens again.
// Speaking over the answer interrupts it. Each turn is an ordinary message: the
// crisis gate, the care layer and the day's limits hold as in writing; a crisis
// answer, or the pause bell, ends the conversation by voice so it can be read.
// Esc, End, or two minutes of silence end it.

const T = { on: false, phase: "off", gen: 0, stream: null, ctx: null, an: null, buf: null, mr: null, chunks: [], tick: null, noise: 0.01, speechAt: 0, voiceAt: 0, listenAt: 0, barge: 0 };
const TALK_SILENCE_MS = 1100, TALK_MIN_SPEECH_MS = 350, TALK_IDLE_MS = 120000;

function talkLevel() {
  if (!T.an) return 0;
  T.an.getFloatTimeDomainData(T.buf);
  let s = 0; for (const v of T.buf) s += v * v;
  return Math.sqrt(s / T.buf.length);
}

function setTalk(label) {
  const bar = $("#talkbar"), b = $("#talkBtn");
  if (b) { b.classList.toggle("on", T.on); b.setAttribute("aria-pressed", T.on ? "true" : "false"); b.hidden = !canRecord(); }
  if (!bar) return;
  bar.hidden = !T.on;
  bar.dataset.phase = T.phase;
  if (label) $("#talkLabel").textContent = label;
}

async function talkStart() {
  // One start at a time (1.13.1): a double click opened two microphones, one never closed.
  if (T.on || T.starting || D.rec || D.working || D.starting) return;
  T.starting = true;
  let stream;
  try {
    if (!(await ensureSpeechModel())) return;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { toast(e?.name === "NotAllowedError" ? "The microphone is not allowed for Lodestone." : `The microphone could not be opened: ${e.message || e}`, 7000); return; }
  } finally { T.starting = false; }
  if (T.on || D.rec) { stream.getTracks().forEach(t => t.stop()); return; }
  T.stream = stream;
  try { T.ctx = new AudioContext(); T.ctx.resume?.().catch(() => {}); T.an = T.ctx.createAnalyser(); T.an.fftSize = 1024; T.ctx.createMediaStreamSource(stream).connect(T.an); T.buf = new Float32Array(T.an.fftSize); }
  catch { stream.getTracks().forEach(t => t.stop()); toast("The microphone's sound cannot be read here."); return; }
  T.on = true; T.noise = 0.01;
  primeSpeech();
  toast("A conversation by voice: speak when you are ready. Esc or End stops it.", 4500);
  talkListen();
  T.tick = setInterval(talkTick, 50);
}

function talkRecord() {
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(t => MediaRecorder.isTypeSupported?.(t)) || "";
  T.chunks = [];
  T.mr = new MediaRecorder(T.stream, mime ? { mimeType: mime } : undefined);
  T.mr.ondataavailable = e => { if (e.data?.size) T.chunks.push(e.data); };
  T.mr.start(250);
}

function talkListen() {
  if (!T.on) return;
  try { if (T.mr?.state === "recording") T.mr.stop(); } catch {}
  T.gen++;   // whatever was under way (a transcription, an answer) no longer moves the conversation on
  T.phase = "listening"; T.speechAt = 0; T.voiceAt = 0; T.barge = 0; T.listenAt = Date.now();
  talkRecord();
  setTalk("Listening: speak when you are ready");
}

function talkTick() {
  if (!T.on) return;
  const lvl = talkLevel(), now = Date.now();
  const th = Math.max(0.012, T.noise * 3);
  $("#talkMeter")?.style.setProperty("--lvl", Math.min(1, Math.max(0.04, lvl * 8)).toFixed(3));
  if (T.phase === "listening") {
    if (lvl > th) { if (!T.speechAt) T.speechAt = now; T.voiceAt = now; }
    else if (!T.speechAt) T.noise = T.noise * 0.95 + lvl * 0.05;
    if (T.speechAt && now - T.voiceAt > TALK_SILENCE_MS) {
      if (T.voiceAt - T.speechAt >= TALK_MIN_SPEECH_MS) talkHeard();
      else { T.speechAt = 0; T.voiceAt = 0; }   // a cough, a click: not speech
    } else if (!T.speechAt && now - T.listenAt > TALK_IDLE_MS) talkEnd("The conversation by voice ended after two minutes of silence.");
  } else if ((T.phase === "speaking" || T.phase === "answering") && speaker.active) {
    // Speaking over the answer stops it (the voice, and the writing if it is still going), and Lodestone listens.
    T.barge = lvl > th * 2.2 ? T.barge + 50 : Math.max(0, T.barge - 25);
    if (T.barge >= 300) { speaker.stop(); if (S.busy) stopAnswer(); talkListen(); }
  }
}

function talkHeard() {
  T.phase = "writing";
  const via = dictViaProvider() ? voiceProvider() : null;
  setTalk(via ? `Writing it out through ${PROVIDER_LABEL[via]}…` : `Writing it out on ${HERE}…`);
  const mr = T.mr, gen = T.gen;
  mr.onstop = async () => {
    const blob = new Blob(T.chunks, { type: mr.mimeType || "audio/webm" });
    let text = "";
    try {
      const p = dictViaProvider() ? voiceProvider() : null;
      text = p ? await cloudTranscribe(p, blob, dictCode(), await voiceCtx(p)) : await transcribeClip(blob, dictLanguage());
    } catch (e) { toast(`Not heard: ${e.message || e}`, 5000); }
    if (!T.on || gen !== T.gen) return;
    text = String(text || "").trim();
    if (!text) { talkListen(); return; }
    T.phase = "answering"; setTalk("Lodestone is answering…");
    while (S.busy) await new Promise(r => setTimeout(r, 200));   // an answer stopped by speaking over it is still closing
    const before = S.history.length;
    // Sent as it was heard: the message box, and what waits in it, are left as they are (1.13.1).
    S.dictated = true;
    await send(text);
    if (!T.on || gen !== T.gen) return;   // spoken over: the new words lead now
    if (S.history.length === before) { talkEnd("Lodestone could not answer just now; your words are in the message box."); return; }
    // A crisis answer, or the crisis line after a care moment: read, not heard in passing.
    const tail = S.history.slice(before);
    if (tail.some(m => m.meta?.crisis || m.meta?.notice === "care")) { talkEnd("The conversation by voice has paused: please read what Lodestone wrote."); return; }
    if (speaker.active) { T.phase = "speaking"; setTalk("Lodestone is speaking: speak to interrupt"); }
    else talkListen();
  };
  try { mr.stop(); } catch { talkListen(); }
}

function talkEnd(why = "") {
  if (!T.on) return;
  T.on = false; T.phase = "off";
  speaker.stop();   // ended, the voice stops too (1.13.1)
  clearInterval(T.tick); T.tick = null;
  try { if (T.mr?.state === "recording") { T.mr.onstop = null; T.mr.stop(); } } catch {}
  T.stream?.getTracks().forEach(t => t.stop()); T.stream = null;
  try { T.ctx?.close(); } catch {}
  T.ctx = null; T.an = null;
  setTalk();
  if (why) toast(why, 5000);
}

/** The speech model is downloaded once, on first use, with the practitioner's leave. */
async function ensureSpeechModel() {
  if (!DESKTOP) return (await chooseSpeechRoute("To dictate", true)) !== null;
  const info = await DESKTOP.info().catch(() => ({}));
  if (info.asr) return true;
  if (!confirm("To dictate, Lodestone needs its speech model (Whisper, about 250 MB). It is downloaded once and runs on this computer: your voice goes nowhere. Download it now?")) return false;
  D.working = true; setMic();
  const off = DESKTOP.onProgress?.(p => { if (p.what === "speech" && p.total) toast(`Downloading the speech model… ${Math.round(p.done / p.total * 100)}%`, 4000); });
  try {
    const r = await DESKTOP.asrDownload();
    if (!r.ok) { toast(r.message || "The speech model could not be downloaded.", 6000); return false; }
    toast("The speech model is ready. Click the microphone, or the voice button, and speak.", 5000);
    if (!$("#drawerSettings").hidden) renderDictation();
    return false;   // the practitioner starts speaking when ready, not when the download ends
  } finally { off?.(); D.working = false; setMic(); }
}

async function micToggle() {
  if (D.working || D.starting || T.on || T.starting) return;
  if (D.rec) return micStop();
  D.starting = true;   // one start at a time (1.13.1)
  let stream;
  try {
    if (!(await ensureSpeechModel())) return;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { toast(e?.name === "NotAllowedError" ? (DESKTOP ? "The microphone is not allowed. On a Mac: System Settings → Privacy & Security → Microphone → Lodestone." : "The microphone is not allowed for this page. Allow it in the browser's settings for harmonism.io, then try again.") : `The microphone could not be opened: ${e.message || e}`, 7000); return; }
  } finally { D.starting = false; }
  if (D.rec || T.on) { stream.getTracks().forEach(t => t.stop()); return; }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(t => MediaRecorder.isTypeSupported?.(t)) || "";
  const chunks = [];
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  mr.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  const rec = { mr, stream, chunks, level: levelMeter(stream), discard: false };
  mr.onstop = () => { endCapture(rec); if (!rec.discard) dictated(new Blob(chunks, { type: mr.mimeType || mime || "audio/webm" })); };
  D.rec = rec; D.start = Date.now();
  mr.start(250);
  D.timer = setInterval(drawRec, 100);
  $("#recLabel").textContent = "Listening";
  $("#recbar").classList.remove("working");
  $("#recbar").hidden = false; drawRec(); setMic();
}

function levelMeter(stream) {
  let ctx = null;
  try {
    ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    return { ctx, read() { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.min(1, Math.sqrt(s / buf.length) * 6); } };
  } catch { try { ctx?.close(); } catch {} return null; }
}

function drawRec() {
  const secs = Math.floor((Date.now() - D.start) / 1000);
  $("#recTime").textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const lvl = D.rec?.level ? D.rec.level.read() : 0;
  $("#recMeter").style.setProperty("--lvl", Math.max(0.04, lvl).toFixed(3));
}

function endCapture(rec) {
  clearInterval(D.timer);
  rec.stream.getTracks().forEach(t => t.stop());
  try { rec.level?.ctx.close(); } catch {}
  if (D.rec === rec) D.rec = null;
  $("#recbar").hidden = true;
  setMic();
}

function micStop() { try { D.rec?.mr.stop(); } catch {} }

function micDiscard() {
  const rec = D.rec; if (!rec) return;
  rec.discard = true;
  try { rec.mr.stop(); } catch { endCapture(rec); }
  toast("Discarded.", 1500);
}

async function dictated(blob) {
  if (!blob.size) { toast("Nothing was recorded."); return; }
  D.working = true; setMic();
  $("#recLabel").textContent = `Transcribing on ${HERE}…`; $("#recTime").textContent = ""; $("#recbar").classList.add("working"); $("#recbar").hidden = false;
  try {
    const p = dictViaProvider() ? voiceProvider() : null;
    if (p) $("#recLabel").textContent = `Writing it out through ${PROVIDER_LABEL[p]}…`;
    const text = p ? await cloudTranscribe(p, blob, dictCode(), await voiceCtx(p)) : await transcribeClip(blob, dictLanguage());
    if (!text) { toast("Nothing was heard."); return; }
    insertDictation(text);
  } catch (e) { toast(`Not transcribed: ${e.message || e}`, 6000); }
  finally { D.working = false; setMic(); $("#recbar").hidden = true; $("#recbar").classList.remove("working"); }
}

/** Put dictated text at the caret, with a space when it continues a word. */
function insertDictation(text) {
  const box = $("#input");
  const at = box.selectionStart ?? box.value.length, end = box.selectionEnd ?? at;
  const before = box.value.slice(0, at), after = box.value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^\s/.test(after) ? " " : "";
  box.value = before + lead + text + tail + after;
  const caret = (before + lead + text).length;
  box.focus(); box.setSelectionRange(caret, caret);
  autosize();
  S.dictated = true;   // for the mirror mode: this message was spoken
}

async function renderDictation() {
  if (!$("#setDictKv")) return;
  const info = DESKTOP ? await DESKTOP.info().catch(() => ({})) : { asr: await speechWeb.speechReady() };
  const kv = $("#setDictKv");
  kv.replaceChildren(el("div", {}, el("b", {}, info.asr ? "Ready" : "Not downloaded yet"), info.asr ? ` · Whisper small, on ${HERE}` : ` · downloaded once, on first use (about ${speechWeb.MB} MB)`));
  if (!DESKTOP && !canRecord()) kv.append(el("div", { class: "fine" }, "This browser cannot record or keep the speech model here."));
  // Through the provider, where the route has one.
  const p = voiceProvider(), src = S.settings.dictSource === "provider" && p ? "provider" : "device";
  $("#setDictSource").hidden = $("#setDictSourceHint").hidden = !p;
  if (p) {
    [...$("#setDictSource").children].forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.v === src)); if (b.dataset.v === "provider") b.textContent = `Through ${PROVIDER_LABEL[p]}`; });
    $("#setDictSourceHint").textContent = src === "provider"
      ? `Your recordings go to ${PROVIDER_LABEL[p]}${p === "account" ? " and the transcription service it uses (fifteen minutes a day)" : ", charged to your key"}, which writes them out. Nothing to download.`
      : `Whisper writes them out on this device; your voice goes nowhere. Downloaded once (about ${speechWeb.MB} MB).`;
  }
  $("#setDictDownload").hidden = !!info.asr;
  $("#setDictLang").value = S.settings.dictLang || "auto";
}

async function renderUsageSummary() {
  const kv = $("#setUsageKv"); if (!kv) return;
  const month = Date.now() - 30 * 864e5;
  const recent = sumUsage((await store.messages.all()).filter(m => m.meta?.usage && (m.ts || 0) >= month).map(m => m.meta.usage));
  const conv = sumUsage([...S.history.map(m => m.meta?.usage), S.thread?.side]);
  const cap = Number(S.settings.spendCap) || 0;
  $("#setCap").value = cap > 0 ? String(cap) : "";
  $("#setCapNote").textContent = cap > 0 ? `This month so far: ${fmtCost(await monthSpend())} of ${fmtCost(cap)}.` : "No limit set.";
  kv.replaceChildren(
    el("div", {}, el("b", {}, "This conversation: "), conv.turns ? `${conv.priced ? fmtCost(conv.cost) : "no cost"} · ${kTok(conv.in)} in, ${kTok(conv.out)} out` : "nothing recorded yet"),
    el("div", {}, el("b", {}, "Last 30 days: "), recent.turns ? `${recent.priced ? fmtCost(recent.cost) : "no cost"} · ${recent.turns} answer${recent.turns === 1 ? "" : "s"}` : "nothing recorded yet"));
}

function bindChrome() {
  $("#composer").addEventListener("submit", e => { e.preventDefault(); if (S.busy) stopAnswer(); else send(); });
  watchChatScroll();
  $("#setCap").addEventListener("change", async e => {
    const v = Number(String(e.target.value).replace(/[$,\s]/g, ""));
    S.settings.spendCap = Number.isFinite(v) && v > 0 ? Math.round(v * 1e4) / 1e4 : 0;
    await store.kv.set("settings", S.settings);
    try { localStorage.removeItem("lodestone-cap-warned"); } catch {}
    renderUsageSummary(); $("#capCard").hidden = true;
  });
  // Shortcuts: ⌘N a new conversation, ⌘F find one, ⌘, Settings, Esc stops an answer being written.
  document.addEventListener("keydown", e => {
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    if ($("#main").hidden) return;
    if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newThread(); }
    else if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      if (!threadsDocked()) { if (wideMQ.matches) setDock(true); else { renderThreadList(); openDrawer("#drawerThreads"); } }
      setTimeout(() => { $("#threadSearch").focus(); $("#threadSearch").select(); }, 50);
    }
    else if (mod && e.key === ",") { e.preventDefault(); renderSettings(); openDrawer("#drawerSettings"); }
    else if (e.key === "Escape" && !S.busy && speaker.active && !D.rec && ![...document.querySelectorAll(".drawer")].some(d => !d.hidden && !isDocked(d))) { e.preventDefault(); speaker.stop(); }
    // Esc in the conversation search clears it; Esc with a menu or a card open closes that, not the answer.
    else if (e.key === "Escape" && document.activeElement === $("#threadSearch") && threadQuery) { e.preventDefault(); e.stopImmediatePropagation(); $("#threadSearch").value = ""; threadQuery = ""; renderThreadList(); }
    else if (e.key === "Escape" && S.busy && !D.rec && ![...document.querySelectorAll(".drawer")].some(d => !d.hidden && !isDocked(d)) && !document.querySelector(".row-menu, .signin-ask") && ($("#modelMenu")?.hidden ?? true)) { e.preventDefault(); stopAnswer(); }
  }, true);
  // Dictation (desktop): ⇧⌘D starts and stops; Esc while listening discards, before it can close a drawer.
  setMic();
  $("#micBtn").onclick = () => micToggle();
  $("#talkBtn").onclick = () => (T.on ? talkEnd() : talkStart());
  $("#talkEnd").onclick = () => talkEnd();
  setTalk();
  $("#recCancel").onclick = () => micDiscard();
  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "d" && canRecord()) { e.preventDefault(); micToggle(); }
    else if (e.key === "Escape" && D.rec) { e.preventDefault(); e.stopImmediatePropagation(); micDiscard(); }
    else if (e.key === "Escape" && T.on && !document.querySelector(".signin-ask")) { e.preventDefault(); e.stopImmediatePropagation(); talkEnd(); }
    else if (e.key === "Escape" && document.querySelector(".row-menu")) { e.stopImmediatePropagation(); closeThreadMenu(); }
  }, true);
  // Conversations: search, the row menu, usage and costs
  let tq; $("#threadSearch").addEventListener("input", e => { clearTimeout(tq); tq = setTimeout(() => { threadQuery = e.target.value; renderThreadList(); }, 160); });
  document.addEventListener("click", e => { if (!e.target.closest(".row-menu")) closeThreadMenu(); });
  $("#threadList").addEventListener("scroll", closeThreadMenu, { passive: true });
  $("#drawerThreads").addEventListener("scroll", closeThreadMenu, { passive: true });
  $("#costLine").onclick = openUsage;
  $("#openReadings").onclick = async () => { await renderReadings(); openDrawer("#drawerReadings"); $("#readingsSearch").focus(); };
  let rq; $("#readingsSearch").addEventListener("input", () => { clearTimeout(rq); rq = setTimeout(drawReadings, 140); });
  $("#readingsKind").onchange = drawReadings;
  $("#readingsExport").onclick = exportReadings;
  $("#setUsageOpen").onclick = openUsage;
  $("#usageTabs").onclick = e => { const d = e.target.dataset?.d; if (d != null) renderUsage(Number(d)); };
  $("#setDictLang").onchange = async e => { S.settings.dictLang = e.target.value; await store.kv.set("settings", S.settings); };
  $("#setDictSource").onclick = async e => { const k = e.target.closest("button")?.dataset.v; if (!k) return; S.settings.dictSource = k; await store.kv.set("settings", S.settings); renderDictation(); setMic(); };
  $("#setVoiceSource").onclick = e => { const k = e.target.closest("button")?.dataset.v; if (k) { speaker.stop(); saveVoice({ source: k }); } };
  // Spoken replies
  renderVoiceChip();
  $("#voiceChip").onclick = e => { e.stopPropagation(); toggleVoiceMenu(); };
  document.addEventListener("click", e => { if (!e.target.closest("#voiceWrap")) { $("#voiceMenu").hidden = true; $("#voiceChip").setAttribute("aria-expanded", "false"); } });
  $("#setVoiceMode").onclick = e => { const k = e.target.closest("button")?.dataset.v; if (k && !e.target.closest("button").disabled) saveVoice({ mode: k }); };
  $("#setVoiceGender").onclick = e => { const k = e.target.closest("button")?.dataset.v; if (k) saveVoice({ gender: k }); };
  $("#setVoiceRate").onchange = e => saveVoice({ rate: Number(e.target.value) || 1 });
  $("#setVoiceName").onchange = e => { const v = voiceSettings(); saveVoice({ names: { ...(v.names || {}), [e.target.dataset.lang]: e.target.value } }); };
  $("#setVoiceFamily") && ($("#setVoiceFamily").onchange = e => { speaker.stop(); saveVoice({ family: e.target.value, source: voiceSettings().source === "device" ? "device" : "provider" }); });
  $("#setVoiceKeySave") && ($("#setVoiceKeySave").onclick = async () => {
    const inp = $("#setVoiceKey"), key = inp.value.trim();
    if (!key) { toast("Paste a key first.", 3000); return; }
    const k = keyKind(key);
    if (!k.kind) { toast(k.why, 7000); return; }
    const btn = $("#setVoiceKeySave"); btn.disabled = true; btn.textContent = "Checking…";
    try {
      await testVoiceKey(k.kind, key);
      await secrets.set("voice-" + k.kind, key);
      if (k.kind === "openrouter") clearPolicyBlocks();   // another account may allow what this one refused
      inp.value = "";
      const fam = k.kind === "xai" ? "grok" : k.kind === "openai" ? "openai" : voiceSettings().family;
      await saveVoice({ source: "provider", family: FAMILIES[fam] ? fam : "grok" });
      toast(`The ${ROUTE_LABEL[k.kind]} key works: answers are now read by ${FAMILIES[voicePlanCache?.family || "grok"].label}'s voices.`, 6000);
    } catch (e) { toast(String(e.message || e), 7000); }
    finally { btn.disabled = false; btn.textContent = "Save the key"; }
  });
  $("#setVoiceTry").onclick = async () => {
    if (speaker.active && speaker.key === "try") { speaker.stop(); return; }
    const lang = $("#setVoiceName").dataset.lang || "en";
    const line = { fr: "Parle depuis là où tu te tiens. La Roue commence par la Présence.", es: "Habla desde donde estás. La Rueda empieza por la Presencia.", ar: "تكلّم من حيث تقف. تبدأ العجلة بالحضور.", pt: "Fala a partir de onde estás. A Roda começa pela Presença.", de: "Sprich von dort, wo du stehst. Das Rad beginnt mit der Präsenz." }[lang] || "Speak from where you are. The Wheel begins with Presence.";
    if (await startSpeaking("try", lang)) speaker.feed(line, true);
  };
  $("#setDictDownload").onclick = () => ensureSpeechModel();
  $("#webBtn").onclick = () => {
    if (!S.webNext) {
      let told = false; try { told = localStorage.getItem("munai-web-consent") === "1"; } catch {}
      if (!told) {
        const viaProvider = !DESKTOP && ["openrouter", "hosted"].includes(S.engine?.kind);
        if (!confirm(viaProvider
          ? `Look this up online?\n\nYour question will be searched on the web by ${S.engine.kind === "hosted" ? "harmonism.io's provider, OpenRouter," : "OpenRouter"} (its search engine, Exa, receives it), and the results are read with you. Nothing else goes beyond the turn already sent.\n\nThis applies to the next question only.`
          : DESKTOP
          ? "Look this up online?\n\nYour question will be sent to a search engine (DuckDuckGo, or Wikipedia when DuckDuckGo does not answer), and the pages it finds will be opened from this computer. Nothing else leaves: not your conversations, not your notes.\n\nThis applies to the next question only."
          : "Look this up on Wikipedia?\n\nYour question will be sent to Wikipedia's search, and the introductions of the articles it finds are read with you. (Lodestone Desktop searches the whole web; a browser can read only Wikipedia.) Nothing else leaves: not your conversations, not your notes.\n\nThis applies to the next question only.")) return;
        try { localStorage.setItem("munai-web-consent", "1"); } catch {}
      }
    }
    setWebNext(!S.webNext); $("#input").focus();
  };
  $("#input").addEventListener("input", autosize);
  // Attachments on every surface: the desktop, the web app and the phone read them alike.
  $("#attachBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
  // Drop anywhere in the window: the whole window shows it takes files. Never
  // left to the browser, which would open the file in place of Lodestone.
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  const dropShown = on => document.body.classList.toggle("dropping", on);
  window.addEventListener("dragenter", e => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; dropShown(true); } });
  window.addEventListener("dragleave", e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; dropShown(false); } });
  window.addEventListener("dragover", e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  window.addEventListener("drop", async e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dropShown(false);
    addFiles(await droppedFiles(e.dataTransfer));
  });
  // Paste anywhere but another field: a file copied in the Finder or Explorer, or a picture.
  document.addEventListener("paste", e => {
    const fs = [...(e.clipboardData?.files || [])];
    if (!fs.length) return;
    const t = e.target;
    if (t !== $("#input") && t?.closest?.("input, textarea, [contenteditable=true]")) return;
    e.preventDefault(); addFiles(fs);
  });
  if (DESKTOP) {
    if (DESKTOP.quickModels) {
      $("#modelChip").onclick = e => { e.stopPropagation(); toggleModelMenu(); };
      document.addEventListener("click", e => { if (!$("#modelRow").contains(e.target)) closeModelMenu(); });
      document.addEventListener("keydown", e => { if (e.key === "Escape") closeModelMenu(); });
      refreshModelChip();
    }
  }
  if (!DESKTOP) {
    $("#modelChip").onclick = e => { e.stopPropagation(); toggleWebMenu(); };
    document.addEventListener("click", e => { if (!$("#modelRow").contains(e.target)) closeModelMenu(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeModelMenu(); });
  }
  $("#input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isHandheld()) { e.preventDefault(); if (!S.busy) send(); } });
  $("#scrim").onclick = closeDrawers;
  document.querySelectorAll("[data-close]").forEach(b => (b.onclick = closeDrawers));
  $("#btnThreads").onclick = () => {
    if (wideMQ.matches) { setDock(!threadsDocked()); return; }
    renderThreadList(); openDrawer("#drawerThreads");
  };
  $("#drawerThreads [data-close]").onclick = () => { if (threadsDocked()) setDock(false); else closeDrawers(); };
  $("#newThread").onclick = newThread;
  $("#btnLibrary").onclick = () => { renderLibrary($("#libSearch").value); openLibrary(); };
  let lt; $("#libSearch").oninput = e => { clearTimeout(lt); lt = setTimeout(() => renderLibrary(e.target.value), 180); };
  // On a phone the article covers the list; this brings the list back.
  $("#readerBack").onclick = () => $("#drawerLibrary").classList.remove("reading");
  $("#readerAsk").onclick = () => {
    const a = S.pack.corpus.articles[readerArticle]; closeDrawers();
    $("#input").value = `Walk me through "${a.t}" from where I stand.`; autosize(); $("#input").focus();
  };
  $("#btnMe").onclick = () => { renderMe(); openDrawer("#drawerMe"); };
  $("#btnSettings").onclick = $("#btnSettingsSide").onclick = () => { renderSettings(); openDrawer("#drawerSettings"); };
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawers(); });

  const saveProfile = async () => {
    S.profile.name = $("#meName").value.trim();
    S.profile.country = $("#meCountry").value.trim().toUpperCase();
    S.profile.notes = $("#meNotes").value;
    await store.kv.set("profile", S.profile);
  };
  ["#meName", "#meCountry", "#meNotes"].forEach(s => $(s).addEventListener("change", saveProfile));
  $("#meNotes").addEventListener("blur", saveProfile);

  $("#practiceForm").onsubmit = async e => {
    e.preventDefault();
    const text = $("#prText").value.trim(); if (!text) return;
    S.practices.push({ id: String(Date.now()), text, pillar: $("#prPillar").value, cadence: Number($("#prCadence").value), created: Date.now(), log: [] });
    await savePractices();
    $("#prText").value = ""; renderMe(); renderCheckins();
  };

  $("#setTheme").onclick = async e => {
    const v = e.target.dataset?.v; if (!v) return;
    S.settings.theme = v; applyTheme(v); await store.kv.set("settings", S.settings); renderSettings();
  };
  $("#setLang").onchange = async e => { S.settings.lang = e.target.value; await store.kv.set("settings", S.settings); };
  if (DESKTOP?.foldersAdd) {
    $("#setFolderAdd").onclick = async () => { try { renderFolders(await DESKTOP.foldersAdd()); } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), 6000); } };
    $("#setFolderReread").onclick = async () => { $("#setFoldersStats").textContent = "Reading…"; renderFolders(await DESKTOP.foldersReread()); };
  }
  if (DESKTOP?.lifebookChoose) {
    $("#setLbChoose").onclick = async () => { try { S.lifeBook = await DESKTOP.lifebookChoose(); lbCache.at = 0; renderLifeBook(); renderChat(); renderVault(); } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), 7000); } };
    $("#setLbForget").onclick = async () => { S.lifeBook = await DESKTOP.lifebookForget(); lbCache = { at: 0, entries: [] }; renderLifeBook(); renderChat(); renderVault(); };
    $("#setLbOpen").onclick = () => DESKTOP.lifebookOpen();
  }
  $("#setChangeTier").onclick = async () => {
    closeDrawers();
    if (DESKTOP) return DESKTOP.openModels();
    S.engineReady = false; S.engine = null; await showSetup();
  };
  $("#setCheckUpdate").onclick = async () => {
    const m = $("#setUpdateMsg");
    if (DESKTOP) return DESKTOP.openUpdates();
    m.textContent = "Asking…";
    try {
      const r = await corpusPack.checkForUpdate();
      if (!r.newer) { m.textContent = "This device holds the current corpus."; return; }
      m.textContent = `A newer pack exists (${r.remote.articles} articles, built ${new Date(r.remote.built_at).toLocaleDateString()}).`;
      m.append(" ", el("button", { class: "btn ghost", type: "button", onclick: async () => {
        m.textContent = "Downloading…";
        await corpusPack.install({ semantic: S.settings.semantic !== false, onProgress: (k, f) => (m.textContent = `Downloading ${k}… ${Math.round(f * 100)}%`) });
        const { corpus, runtime, embeddings } = await corpusPack.load();
        S.pack = { runtime, corpus };
        const eq = S.retriever?.embedQuery;
        S.retriever = new Retriever({ corpus, runtime, embeddings });
        if (eq && embeddings) S.retriever.embedQuery = eq;
        m.textContent = "Corpus updated."; renderSettings(); updateBadge();
      } }, "Update now"));
    } catch (e) { m.textContent = `No answer from the corpus origin (${e.message}). Offline is fine; try again when connected.`; }
  };
  $("#setExport").onclick = async () => {
    const data = await store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `munai-memory-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
  };
  $("#setImport").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      await store.importAll(JSON.parse(await f.text()), { merge: true, mergeKv: importMerge });
      S.profile = (await store.kv.get("profile")) || {}; S.wheel = (await store.kv.get("wheel")) || {}; S.practices = (await store.kv.get("practices")) || [];
      await openLatestThread(); renderCheckins(); toast("Memory imported");
    } catch (err) { toast(err.message); }
    e.target.value = "";
  };
  $("#setWipe").onclick = async () => {
    if (!confirm("Erase conversations, practices, notes, the corpus and cached models from this device? This cannot be undone.")) return;
    try { const w = await import("../vendor/web-llm.js"); for (const k of Object.values(MODELS)) { await w.deleteModelAllInfoInCache(k.id).catch(() => {}); await w.deleteModelAllInfoInCache(k.f32).catch(() => {}); } } catch {}
    await store.wipeEverything();
    location.reload();
  };
  document.addEventListener("click", e => {
    const h = e.target.closest("[data-open-help]");
    if (h) { e.preventDefault(); openDrawer("#drawerHelp"); $("#drawerHelp").scrollTop = 0; return; }
    const a = e.target.closest("[data-open-article]");
    if (!a || !S.pack) return;
    e.preventDefault();
    const i = S.pack.corpus.articles.findIndex(x => x.p === a.dataset.openArticle);
    if (i >= 0) openReader(i);
  });
}

// ─── one memory per person ───────────────────────────────────────────────────

/** Signing out: the memory stays on this device unless this is a shared computer (or the person says otherwise). */
async function signOutOfAccount() {
  if (!confirm("Sign out of harmonism.io on this device?")) return false;
  const shared = await held.sharedComputer.get().catch(() => false);
  const keep = shared
    ? !confirm("This device is marked as a shared computer. Remove your Lodestone memory from it?\n\nOK: remove it. With sync on, it comes back when you sign in again.\nCancel: keep it here.")
    : confirm("Keep your Lodestone memory on this device for when you sign in again?\n\nOK: keep it (your own computer).\nCancel: remove it from this device (a shared computer). With sync on, it comes back when you sign in again.");
  try { const a = await accountTransport().account().catch(() => null); if (a?.email) await unlock.forget(a.email); } catch {}
  try { await held.signOutHere({ keep }); } catch (e) { console.warn("[memory]", e); }
  if (DESKTOP && DESKTOP.hostedSignOut) await DESKTOP.hostedSignOut().catch(() => {});
  await hosted.signOut();
  return true;
}

/** Another account signed in (or out) in another tab, or in the desktop's own sign-in: open the right memory. */
async function followAccount() {
  if (!syncAvailable()) return;
  try { const r = await held.bind(); if (r.changed) location.reload(); } catch {}
}

/** Memory this device held before this account signed in here: asked once whether it is theirs. */
async function askDeviceMemory() {
  if (!syncAvailable()) return;
  const o = await held.deviceOffer().catch(() => ({ offer: false }));
  if (!o.offer) return;
  const a = await heldAccount();
  if (confirm(`This device holds a Lodestone memory from before ${a?.email || "you"} signed in here: conversations, notes and what Lodestone has learned. Is it yours?\n\nOK: it joins your memory.\nCancel: it stays with this device, apart from yours, and Lodestone will not ask again.`)) {
    await held.adoptDevice(); location.reload();
  } else await held.declineDevice();
}

addEventListener("focus", followAccount);
document.addEventListener("visibilitychange", () => { if (!document.hidden) followAccount(); });
addEventListener("storage", e => { if (e.key && e.key.startsWith("sb-") && e.key.endsWith("-auth-token")) followAccount(); });

boot().then(() => askDeviceMemory()).catch(e => { console.error(e); document.body.insertAdjacentHTML("beforeend", `<p style="padding:20px">Lodestone could not start: ${String(e.message || e)}</p>`); });
