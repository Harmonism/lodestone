// main.js — the Lodestone web app's controller (in the browser, on a phone, and in Lodestone Desktop's window).
import * as store from "./store.js";
import * as corpusPack from "./corpus.js";
import { Retriever, wantsWhole, isFollowUp } from "./retrieval.js";
import { Embedder } from "./embedder.js";
import { TIERS, MODELS, probeWebGPU, DeviceEngine, ServerEngine, ReaderEngine, isHandheld, isIOS, localInferenceAvailable, defaultModelFor, smallerModelThan } from "./engine.js";
import { HostedEngine, OpenRouterEngine, hosted, secrets, phoneRoutesAvailable, RECOMMENDED, refreshRecommended, assess, testOpenRouter, accountLinks } from "./phone.js";
import { heldBlock, buildSystem, fitMessages, estTokens, PILLARS, LEVELS, webBlock, foldersBlock, earlierBlock, fullArticleBlock, stripRetrievalNote, summaryBlock, summaryRequest } from "./prompt.js";
import { detectLang, detectCrisis, buildCrisisResponse, detectWitness, witnessBlock, governorBlock } from "./safety.js";
import { render } from "./md.js";
import { readAttachment, filesBlock, kindOf, speechLanguage } from "./attach.js";
import { isHPCode, parseHP } from "./hp.js";
import { Sync, SyncError } from "./sync.js";
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
  assessment: null, pending: [],
};

// ─── Boot ────────────────────────────────────────────────────────────────────

// ─── Desktop app ─────────────────────────────────────────────────────────────
// Inside the Lodestone desktop app (desktop/), the model runs in an engine
// bundled with the app and is served on this same origin under /v1. There is
// nothing to choose: setup runs by itself and the practitioner lands in the
// conversation. The bridge is exposed by desktop/src/preload.js.
const DESKTOP = window.lodestoneDesktop || window.munaiDesktop || null;   // munaiDesktop: desktop builds before the rename
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

async function boot() {
  if (await leaveOldPath()) return;
  if (await reloadForBridge()) return;
  // One memory per person: the signed-in account's own, or the device's when
  // no one is signed in, opened before anything of it is read.
  if (syncAvailable()) { try { await held.bind(); } catch (e) { console.warn("[memory]", e?.message || e); } }
  await migrateCaches();
  S.settings = (await store.kv.get("settings")) || { theme: "dark", lang: "auto" };
  if (BRIDGE) return startBridge();
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

async function showSetup() {
  $("#main").hidden = true; $("#setup").hidden = false; syncDock();
  S.gpu = await probeWebGPU();
  const served = await detectLocalServer();
  const box = $("#tierChoices"); box.innerHTML = "";
  const localOk = localInferenceAvailable();
  const phoneOk = phoneRoutesAvailable();
  // On a phone Lodestone stands on its own: OpenRouter under the practitioner's key
  // first, then the account, then their computer.
  let chosen = S.settings.tier || (served ? "server" : localOk && S.gpu.ok ? "standard" : !localOk && phoneOk ? "openrouter" : "server");
  if (!TIERS[chosen]) chosen = null;                 // a tier this build withdrew: choose again
  if (!localOk && TIERS[chosen]?.engine === "webllm") chosen = phoneOk ? "openrouter" : "server";
  if (!phoneOk && (chosen === "hosted" || chosen === "openrouter")) chosen = "server";
  // What each phone route has proved before Begin is allowed.
  const ready = { hosted: !!(await hosted.account().catch(() => null)), openrouter: false };
  const orSaved = S.settings.remote?.tier === "openrouter" ? S.settings.remote.model : "";
  const srv = S.settings.server || {};
  $("#srvUrl").value = srv.baseUrl || (served ? served.baseUrl : "http://localhost:11434/v1");
  $("#srvModel").value = srv.model || (served?.models?.[0] || "");
  $("#srvCtx").value = srv.ctx || 32768;

  const TAGS = { server: "owned hardware", hosted: "free account · internet", openrouter: "your own key · internet", reader: "no model · offline" };
  // A phone's own page cannot call a plain-http server on the home network
  // (an https page may not), so there "your computer" is a pointer to the
  // copy Lodestone Desktop serves to phones, unless this page is that copy.
  const phoneComputer = !localOk && !served && window.isSecureContext;
  // In the Android app the route pairs with Lodestone Desktop instead.
  const nativePair = isNative();
  let paired = nativePair ? await pairing.get().catch(() => null) : null;
  if (nativePair && S.preferComputer) { chosen = "server"; S.preferComputer = false; }
  const ORDER = !localOk ? ["openrouter", "hosted", "server", "reader"] : ["standard", "server", "openrouter", "hosted", "reader"];
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
    note.textContent = `On-device inference needs WebGPU, and this browser has none (${S.gpu.reason}). Use recent Chrome, Edge or Safari (iOS 26 or later), or point Lodestone at a model server on your computer.`;
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
    $("#hStatus").textContent = a ? `Thinks with the models hosted Lodestone runs on, as ${a.email}.` : "Sign in to your harmonism.io account above first.";
    if (a) hosted.status(true).then(st => { if (st?.cap > 0 && st.remaining != null) $("#hStatus").textContent += ` ${st.remaining} of ${st.cap} messages left today.`; }).catch(() => {});
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

  $("#beginSetup").onclick = async () => {
    $("#beginSetup").disabled = true;
    const server = chosen !== "server" ? null
      : nativePair && phoneComputer && paired ? await computerServer(paired)
      : { baseUrl: $("#srvUrl").value.trim(), model: $("#srvModel").value.trim(), ctx: Number($("#srvCtx").value) || 32768 };
    if (chosen === "openrouter") {
      await secrets.set("openrouter", $("#orKey").value.trim());
      S.settings.remote = { tier: "openrouter", model: orModel() };
    } else if (chosen === "hosted") {
      S.settings.remote = { tier: "hosted", model: S.settings.remote?.tier === "hosted" ? S.settings.remote.model : "" };
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
  S.profile = (await store.kv.get("profile")) || {};
  S.wheel = (await store.kv.get("wheel")) || {};
  S.practices = (await store.kv.get("practices")) || [];
  S.assessment = (await store.kv.get("assessment")) || null;
  S.heldBlocks = ((await store.kv.get("companion")) || {}).blocks || null;

  engineStatus("Opening the corpus…", 0.05);
  const { corpus, runtime, embeddings } = await corpusPack.load();
  S.pack = { runtime, corpus };
  await new Promise(r => setTimeout(r, 30));
  S.retriever = new Retriever({ corpus, runtime, embeddings });
  console.info(`[retrieval] ${corpus.chunks.length} chunks indexed in ${S.retriever.buildMs} ms`);

  if (embeddings && S.settings.semantic !== false) {
    S.embedder = S.embedder || new Embedder();
    S.embedder.start().then(() => { S.retriever.embedQuery = t => S.embedder.embed(t); updateBadge(); })
      .catch(e => console.warn("[semantic] unavailable, keyword retrieval only:", e.message));
  }

  await openLatestThread();
  syncDock();
  renderCheckins();
  await refreshWhere();
  showHomeNote();
  await takeAssessment();
  refreshWebChip();
  startSync();
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

async function openLatestThread() {
  const list = await store.threads.list();
  S.thread = list[0] || null;
  await loadThread();
}

async function loadThread() {
  S.history = S.thread ? await store.messages.forThread(S.thread.id) : [];
  renderChat();
  if (threadsDocked()) renderThreadList();
}

async function newThread() {
  S.thread = null; S.history = [];
  renderChat(); closeDrawers(); if (threadsDocked()) renderThreadList(); $("#input").focus();
}

async function renderThreadList() {
  const ul = $("#threadList"); ul.innerHTML = "";
  for (const t of await store.threads.list()) {
    const li = el("li", { class: S.thread && S.thread.id === t.id ? "active" : "" },
      el("button", { class: "t", type: "button", onclick: async () => { S.thread = t; await loadThread(); closeDrawers(); } },
        el("span", {}, t.title), el("small", {}, new Date(t.updated).toLocaleString())),
      el("button", { class: "del", type: "button", "aria-label": "Delete", onclick: async e => {
        e.stopPropagation();
        if (!confirm("Delete this conversation from this device?")) return;
        await store.threads.remove(t.id);
        if (S.thread && S.thread.id === t.id) await openLatestThread();
        renderThreadList();
      } }, "×"));
    ul.append(li);
  }
}

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
  for (const m of S.history) chat.append(msgNode(m));
  chat.scrollTop = chat.scrollHeight;
}

function msgNode(m) {
  const isUser = m.role === "user";
  const body = el("div", { class: "body" + (isUser ? "" : " prose"), dir: "auto" });
  if (isUser) body.textContent = m.content;
  else body.innerHTML = render(m.content);
  const wrap = el("div", { class: `msg ${m.role}${m.meta?.crisis ? " crisis" : ""}` });
  if (!isUser) wrap.append(sprite("avatar"));
  const col = el("div", { class: "col", style: isUser ? "display:flex;flex-direction:column;align-items:flex-end;max-width:85%;min-width:0" : "flex:1;min-width:0" }, body);
  if (isUser && m.meta?.files?.length) col.prepend(el("div", { class: "msg-files" }, m.meta.files.map(f => el("span", { title: f.note || f.kind }, `📎 ${f.name}${f.images ? ` · ${f.images} image${f.images > 1 ? "s" : ""}` : ""}`))));
  if (!isUser && (m.meta?.sources?.length || m.meta?.web?.length || m.meta?.yours?.length)) col.append(sourcesNode(m.meta.sources || [], m.meta.web || [], m.meta.yours || []));
  const actions = el("div", { class: "actions" });
  if (isUser) {
    actions.append(el("button", { type: "button", onclick: () => remember(m.content) }, "Remember this about me"));
  } else if (!m.meta?.crisis) {
    actions.append(el("button", { type: "button", onclick: () => { navigator.clipboard?.writeText(m.content); toast("Copied"); } }, "Copy"));
    actions.append(el("button", { type: "button", onclick: () => { openDrawer("#drawerMe"); renderMe(); $("#prText").focus(); } }, "Make a practice of this"));
  }
  col.append(actions);
  wrap.append(col);
  body.addEventListener("click", onLinkClick);
  return wrap;
}

function sourcesNode(paths, web = [], yours = []) {
  const box = el("div", { class: "sources" });
  for (const f of yours) box.append(el("span", { class: "own-src", title: "From a folder you let Lodestone read" }, "▸ " + f.split(/[\\/]/).pop()));
  for (const w of web) {
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

  // 2c — attachments: this message's, then up to three read earlier in the
  // conversation, so a follow-up question can still reach them. With a rented
  // model the window widens to hold them; the bundled engine's stays at 32k.
  const earlier = [];
  for (let i = history.length - 1; i >= 0 && earlier.length < 3; i--) {
    for (const f of history[i].meta?.files || []) if (f.text && earlier.length < 3) earlier.push({ ...f, earlier: true });
  }
  const all = [...files, ...earlier];
  if ((all.length || full.length) && S.where) tier = { ...tier, ctx: 160000 };
  let filesBudget = 60000;

  // 3 — per-turn blocks
  const w = detectWitness(text, lang, runtime.witness);
  const since = await store.messages.since(Date.now() - 864e5);
  const count24h = since.filter(m => m.role === "user").length + 1;
  const person = { profile: S.profile, wheel: S.wheel, practices: S.practices, assessment: S.assessment };
  let system, fitted;
  for (;;) {
    system = buildSystem({ tier, runtime, person, where: S.where || null, device: !DESKTOP && isHandheld() ? "device" : "computer", turn: {
      files: filesBlock(all, filesBudget),
      folders: foldersBlock(yours),
      summary: summaryBlock(summary?.text),
      article: articleBlocks(),
      vault: S.retriever.format(hits),
      earlier: earlierBlock(history, titleOf),
      web: webBlock(web),
      witness: w ? witnessBlock(w.strength) : "",
      governor: governorBlock(count24h),
      held: heldBlock(S.heldBlocks),
    } });
    // turns already folded into the summary are not sent a second time
    fitted = fitMessages({ system, history: history.filter(m => !m.meta?.crisis && !(summary && m.id <= summary.through)), current: text, tier });
    const over = estTokens(system) + estTokens(text) > tier.ctx - tier.maxTokens - 64;
    if (!over) break;
    if (yours.length) { yours = yours.slice(0, -1); continue; }   // small context: shed folder passages first
    if (hits.length) { hits = hits.slice(0, -1); continue; }   // then retrieval
    if (all.length && filesBudget > 3000) { filesBudget = Math.floor(filesBudget * 0.6); continue; }   // then shorten the files
    if (full.length > 1) { full.pop(); articleBudget = Math.min(articleBudget, arts[full[0]].x.length); continue; }   // then the second article
    if (full.length && articleBudget > 3000) { articleBudget = Math.floor(articleBudget * 0.8); continue; }   // last, the first one
    break;
  }
  const sources = [...new Set([...full.map(a => arts[a].p), ...hits.map(h => arts[h.article].p)])];
  const images = files.flatMap(f => f.images || []);
  return { tier, fitted, w, web, sources, images, hits, yours: [...new Set(yours.map(r => r.file))] };
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
const storedFiles = files => files.map(f => ({ name: f.name, kind: f.kind, note: f.note || null, text: f.text ? f.text.slice(0, 60000) : "", cut: f.cut || 0, images: (f.images || []).length }));

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

async function send(prefill) {
  const input = $("#input");
  let text = (prefill ?? input.value).trim();
  if (S.busy) return;
  if (S.pending.some(x => x.status === "reading")) { toast("Still reading the attachments…"); return; }
  const files = prefill == null ? S.pending.filter(x => x.status === "ready").map(x => x.data) : [];
  if (!text && files.length) text = files.length > 1 ? "Read what I attached." : `Read ${files[0].name}.`;
  if (!text) return;
  if (!S.engineReady && !isHPCode(text)) {
    toast(S.engine?.kind === "hosted" || S.engine?.kind === "openrouter"
      ? "Lodestone cannot reach its model yet: Settings → Change where Lodestone thinks. Your words are kept."
      : "The model is still waking. Your words are kept.", 6000);
    return;
  }
  S.busy = true; input.value = ""; autosize(); setSending(true);
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

    const getWeb = DESKTOP && S.webNext ? async () => {
      setWebNext(false);
      toast("Looking this up online…", 4000);
      let web = [];
      try { web = await DESKTOP.webLookup(text); }
      catch (e) { toast(`Could not look it up online (${String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}). Answering from the corpus.`, 7000); }
      if (!web.length) toast("Nothing useful came back from the web; answering from the corpus.", 5000);
      return web;
    } : null;
    await S.summaryJob;   // one model, one slot: a summary in progress finishes first
    const turn = await prepareTurn(text, S.history, { getWeb, files, folders: true, summary: threadSummary(S.thread) });

    if (turn.crisis) {
      const uid = await store.messages.add({ threadId: S.thread.id, role: "user", content: text, ...(files.length ? { meta: { files: storedFiles(files) } } : {}) });
      const am = { threadId: S.thread.id, role: "assistant", content: turn.reply, meta: { crisis: turn.crisis.category, model: "crisis-template" } };
      am.id = await store.messages.add(am);
      S.history.push({ id: uid, threadId: S.thread.id, role: "user", content: text, ts: Date.now() }, am);
      await touchThread();
      renderChat();
      return;
    }
    const { tier, fitted, w, web, sources, images } = turn;

    const um = { threadId: S.thread.id, role: "user", content: text, ...(files.length ? { meta: { files: storedFiles(files) } } : {}) };
    um.id = await store.messages.add(um);
    S.history.push(um);
    const chat = $("#chat");
    if (chat.querySelector(".empty")) chat.innerHTML = "";
    chat.append(msgNode(um));

    if (S.engine.kind === "reader") {
      const rm = { threadId: S.thread.id, role: "assistant", content: readerReply(turn.hits), meta: { sources, model: "corpus-only" } };
      rm.id = await store.messages.add(rm);
      S.history.push(rm);
      chat.append(msgNode(rm)); chat.scrollTop = chat.scrollHeight;
      await touchThread();
      return;
    }

    const am = { threadId: S.thread.id, role: "assistant", content: "", meta: { sources, web: web.map(r => ({ title: r.title, url: r.url })), yours: turn.yours, model: S.engine.describe(), witness: w?.strength || null } };
    const node = msgNode(am); chat.append(node);
    const body = node.querySelector(".body"); body.classList.add("typing");
    chat.scrollTop = chat.scrollHeight;

    let out = "";
    const t0 = performance.now();
    for await (const partial of S.engine.stream(withImages(fitted.messages, images), { maxTokens: tier.maxTokens })) {
      out = partial;
      body.innerHTML = render(stripRetrievalNote(out));
      if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160) chat.scrollTop = chat.scrollHeight;
    }
    body.classList.remove("typing");
    out = stripRetrievalNote(out).trim() || "…";
    guard.clear();   // it loaded and answered: nothing for the loop guard to catch
    am.content = out; am.meta.ms = Math.round(performance.now() - t0);
    am.id = await store.messages.add(am);
    S.history.push(am);
    node.replaceWith(msgNode(am));
    await touchThread();
    scheduleSummary(S.thread, S.history);
  } catch (e) {
    console.error(e);
    toast(`Something failed: ${e.message || e}`);
  } finally {
    S.busy = false; setSending(false);
    if (threadsDocked()) renderThreadList();
    syncSoon(5000);
    maybeLearn();
  }
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
    S.embedder.start().then(() => { S.retriever.embedQuery = t => S.embedder.embed(t); })
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

  if (r.kind === "new") { await bridgeThread(true); return true; }

  if (r.kind === "due") return duePractices().map(p => ({ id: p.id, pillar: cap(p.pillar), text: p.text }));

  if (r.kind === "checkin") {
    const p = S.practices.find(x => String(x.id) === String(r.practiceId));
    if (!p) return "That practice is no longer on your list.";
    if (r.status === "talk") return p.text;
    if (!["held", "partly", "not"].includes(r.status)) return "Noted.";
    p.log = p.log || []; p.log.push({ ts: Date.now(), status: r.status });
    p.lastCheckin = Date.now();
    await store.kv.set("practices", S.practices);
    return r.status === "held" ? "Noted: it held." : r.status === "partly" ? "Noted: partly." : "Noted: it did not hold.";
  }

  if (r.kind !== "message") throw new Error("Unknown request.");
  const text = String(r.text || "").trim().slice(0, 8000);
  if (!text) return "…";
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
  const turn = await prepareTurn(text, history, { summary: threadSummary(th) });
  await store.messages.add({ threadId: th.id, role: "user", content: text, meta: { channel: "telegram" } });
  if (turn.crisis) {
    await store.messages.add({ threadId: th.id, role: "assistant", content: turn.reply, meta: { crisis: turn.crisis.category, model: "crisis-template", channel: "telegram" } });
    th.updated = Date.now(); await store.threads.put(th);
    return turn.reply;
  }
  let out = "";
  const t0 = performance.now();
  for await (const partial of S.engine.stream(turn.fitted.messages, { maxTokens: turn.tier.maxTokens })) out = partial;
  out = stripRetrievalNote(out).trim() || "…";
  await store.messages.add({ threadId: th.id, role: "assistant", content: out, meta: { sources: turn.sources, model: S.engine.describe(), witness: turn.w?.strength || null, channel: "telegram", ms: Math.round(performance.now() - t0) } });
  th.updated = Date.now(); await store.threads.put(th);
  scheduleSummary(th, await store.messages.forThread(th.id));
  const idx = new Map(S.pack.corpus.articles.map(a => [a.p, a]));
  const read = turn.sources.map(s => idx.get(s)).filter(Boolean).slice(0, 4).map(a => a.u ? `[${a.t}](${a.u})` : a.t);
  return read.length ? `${out}\n\nDrawn from: ${read.join(" · ")}` : out;
}

async function touchThread() {
  S.thread.updated = Date.now();
  await store.threads.put(S.thread);
}

// ─── The discussion summary ──────────────────────────────────────────────────
// Once a thread holds SUMMARY_AFTER turns the summary does not yet cover, all but
// the last SUMMARY_KEEP are folded into a short summary kept with the thread and
// sent in place of those turns. It runs after the reply is on screen, on the
// model the practitioner is already using, and never on harmonism.io's hosted
// models: a summary there would spend the daily allowance on a message nobody sent.
const SUMMARY_AFTER = 40, SUMMARY_KEEP = 16;

const threadSummary = th => (th?.summary ? { text: th.summary, through: th.summaryThrough || 0 } : null);

function scheduleSummary(thread, history) {
  if (!thread || S.summaryJob || !S.engineReady || S.engine?.kind === "reader" || S.engine?.kind === "hosted" || S.where === "harmonism.io") return;
  const pending = history.filter(m => m.id > (thread.summaryThrough || 0) && !m.meta?.crisis);
  if (pending.length < SUMMARY_AFTER) return;
  const fold = pending.slice(0, pending.length - SUMMARY_KEEP);
  const titles = new Map(S.pack.corpus.articles.map(a => [a.p, a.t]));
  const job = (async () => {
    try {
      const messages = summaryRequest({ previous: thread.summary || "", turns: fold, titleOf: p => titles.get(p) });
      let out = "";
      for await (const partial of S.engine.stream(messages, { maxTokens: 600, temperature: 0.2 })) out = partial;
      out = stripRetrievalNote(out).trim();
      if (out.length < 40) return;
      thread.summary = out; thread.summaryThrough = fold[fold.length - 1].id; thread.summaryAt = Date.now();
      await store.threads.put(thread);
      if (thread === S.thread) renderChat();
    } catch (e) { console.warn("[summary]", e); }
  })();
  S.summaryJob = job;
  job.finally(() => { if (S.summaryJob === job) S.summaryJob = null; });
}

function setSending(on) {
  const b = $("#sendBtn");
  b.classList.toggle("stop", on);
  b.setAttribute("aria-label", on ? "Stop" : "Send");
  b.innerHTML = on ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';
}

async function remember(text) {
  const notes = (S.profile.notes || "").trim();
  S.profile.notes = (notes ? notes + "\n" : "") + "• " + text.trim();
  await store.kv.set("profile", S.profile);
  toast("Added to what Lodestone knows about you");
}

// ─── Accompaniment: practices and check-ins ─────────────────────────────────

function duePractices() {
  const now = Date.now();
  return S.practices.filter(p => !p.archived && now - (p.lastCheckin || p.created) >= p.cadence * 864e5);
}

function renderCheckins() {
  const box = $("#checkins"); box.innerHTML = "";
  for (const p of duePractices().slice(0, 2)) {
    const answer = async (status, talk) => {
      if (status) { p.log = p.log || []; p.log.push({ ts: Date.now(), status }); }
      p.lastCheckin = Date.now();
      await store.kv.set("practices", S.practices);
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
// Off until switched on. The memory is encrypted here under the
// practitioner's sync passphrase and kept on harmonism.io under their account
// (sync.js). The web app reaches the endpoint on its own origin with the
// website's session; Lodestone Desktop through its main process, which holds the
// account.

const SYNC_DISCLOSURE = "Sync keeps a copy of your conversations, notes, Wheel, practices and Harmonic Profile on harmonism.io, so Lodestone on your phone and on your computer share one memory. Each device encrypts it with your sync passphrase before it leaves, and the passphrase never does: harmonism.io stores only what it cannot read, and Harmonia cannot read it. What harmonism.io sees is your account, how much you sync and when. If you forget the passphrase the synced copy cannot be opened again; each device still keeps its own memory.";
const SYNC_WEB_NOTE = "On the website, this rests on Lodestone's code being as published; Lodestone Desktop carries its own copy of the code.";
const syncAvailable = () => !!(window.isSecureContext && crypto?.subtle) && !BRIDGE;

const SYNC_DISCLOSURE_COMPUTER = "Sync through your computer keeps a copy of your conversations, notes, Wheel, practices and Harmonic Profile in Lodestone Desktop, on that computer, so the phones paired with it share one memory with it. Nothing goes to harmonism.io. Each device encrypts the copy with your sync passphrase before it leaves, so it is unreadable even in the computer's own files. Devices sync while they are on the same Wi-Fi as the computer and Lodestone Desktop is open. If you forget the passphrase the synced copy cannot be opened again; each device still keeps its own memory.";

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
    renderCheckins();
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
  if (!$("#drawerSettings").hidden) renderSync();
}

let syncT = null;
function syncSoon(ms = 4000) { clearTimeout(syncT); syncT = setTimeout(() => syncer()?.now(), ms); }
async function startSync() {
  const sy = syncer();
  if (!sy || !(await sy.isOn())) return;
  sy.now();
  if (S.syncHooks) return;
  S.syncHooks = true;
  document.addEventListener("visibilitychange", () => syncSoon(document.hidden ? 0 : 800));
  setInterval(() => { if (!document.hidden) syncer()?.now(); }, 5 * 60 * 1000);
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
      if (!acct) {
        box.append(fine, el("p", { class: "hint" }, "Sync through the account needs your harmonism.io account."));
        if (DESKTOP) box.append(desktopSignIn(() => renderSync()));
        else { const L = accountLinks(); box.append(el("div", { class: "row-btns" }, el("a", { class: "btn ghost", href: L.signIn }, "Sign in"), el("a", { class: "btn ghost", href: L.register }, "Create an account"))); }
        return;
      }
      box.append(fine, el("button", { class: "btn ghost block", type: "button", id: "syncOn", onclick: () => syncSetup("account", acct.email) }, "Turn on sync…"));
    } else {
      box.append(fine, el("button", { class: "btn ghost block", type: "button", id: "syncOn", onclick: () => syncSetup("computer", comp) }, "Turn on sync…"));
    }
    return;
  }

  const via = conf.via === "computer" ? "computer" : "account";
  const acct = await sy.t.account().catch(() => null);
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
}

function desktopSignIn(done) {
  const email = el("input", { type: "email", placeholder: "Email", autocomplete: "username" });
  const pass = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const msg = el("p", { class: "hint", role: "status" });
  const go = el("button", { class: "btn ghost block", type: "button", onclick: async () => {
    go.disabled = true; msg.textContent = "Signing in…";
    try { await DESKTOP.syncSignIn(email.value, pass.value); done(); followAccount(); }
    catch (e) { msg.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); go.disabled = false; }
  } }, "Sign in to harmonism.io");
  return el("div", { class: "sync-form" }, email, pass, go, msg,
    el("p", { class: "fine" }, "No account? ", el("a", { href: "https://harmonism.io/member/register.php", target: "_blank", rel: "noopener" }, "Create one at harmonism.io"), ", confirm it by email, then sign in here."));
}

async function syncSetup(via, label, replace = false) {
  const box = $("#syncBody"), st = $("#syncStatus");
  box.innerHTML = "";
  st.textContent = "Looking for a synced copy…";
  const sy = syncer();
  await sy.setConf({ via, error: null });
  let r;
  try { r = await sy.remote(); } catch (e) { toast(String(e.message || e)); return renderSync(); }
  const exists = !!r.meta && !replace;
  const place = via === "computer" ? (DESKTOP ? "this computer" : label) : "your account";
  const pass = el("input", { type: "password", id: "syncPass", placeholder: "Sync passphrase", autocomplete: exists ? "current-password" : "new-password", spellcheck: "false" });
  const pass2 = el("input", { type: "password", id: "syncPass2", placeholder: "The same passphrase again", autocomplete: "new-password", spellcheck: "false" });
  const key = el("input", { type: "checkbox", id: "syncSetupKey" });
  const msg = el("p", { class: "hint", role: "status", id: "syncMsg" });
  st.textContent = exists
    ? `${place[0].toUpperCase() + place.slice(1)} already has a synced copy, started ${new Date(r.meta.created * 1000).toLocaleDateString()} (${mb(r.bytes)}). Enter its passphrase: what is on this device joins it.`
    : `Choose a sync passphrase${via === "account" ? ` for ${label}` : ""}. Each device you sync asks for it once. Write it down somewhere safe: no one, Harmonia included, can recover it.`;
  const go = el("button", { class: "btn primary block", type: "button", id: "syncGo", onclick: async () => {
    if (!exists && pass.value !== pass2.value) { msg.textContent = "The two passphrases differ."; return; }
    if (replace && !confirm(`This erases the synced copy on ${place} and starts a new one under the new passphrase. Every device keeps its own memory; the others will ask for the new passphrase.`)) return;
    go.disabled = true; msg.textContent = "Encrypting and syncing… this takes a few seconds.";
    try {
      const res = exists ? await sy.join(pass.value, { key: key.checked }) : await sy.create(pass.value, { key: key.checked, replace: !!r.meta });
      startSync();
      toast(res.ok ? "Sync is on." : `Sync is on, but the first sync failed: ${res.message}`, 5000);
      renderSync();
    } catch (e) { msg.textContent = String(e.message || e); go.disabled = false; }
  } }, exists ? "Unlock and sync" : "Encrypt and sync");
  box.append(el("div", { class: "sync-form" }, pass, exists ? "" : pass2,
    el("label", { class: "check" }, key, el("span", {}, "Also sync my OpenRouter key")),
    go, msg,
    exists ? el("button", { class: "btn ghost block", type: "button", id: "syncForgot", onclick: () => syncSetup(via, label, true) }, "Forgot the passphrase? Start again") : "",
    el("button", { class: "btn ghost block", type: "button", onclick: () => renderSync() }, "Cancel")),
    el("p", { class: "fine" }, via === "computer" ? SYNC_DISCLOSURE_COMPUTER : SYNC_DISCLOSURE));
  pass.focus();
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

async function renderReading() {
  const box = $("#readingBody"), st = $("#readingStatus");
  if (!box) return;
  box.innerHTML = "";
  $("#readingBox").hidden = !syncAvailable();
  if (!syncAvailable()) return;
  const acct = await heldAccount();
  if (!acct) {
    st.textContent = "A guided reading of the canon's works, at the pace you choose, with Lodestone alongside. It needs your harmonism.io account.";
    if (!DESKTOP) { const L = accountLinks(); box.append(el("div", { class: "row-btns" }, el("a", { class: "btn ghost", href: L.signIn }, "Sign in"), el("a", { class: "btn ghost", href: L.register }, "Create an account"))); }
    else box.append(el("p", { class: "fine" }, "Sign in under Settings → Sync."));
    return;
  }
  st.textContent = "Opening your reading…";
  let r;
  try { r = await held.heldCall("member/reading-api.php", { action: "arc" }); }
  catch (e) { st.textContent = `The reading could not be opened: ${e.message}`; return; }
  const act = async (body, label) => {
    st.textContent = label;
    try { await held.heldCall("member/reading-api.php", body); } catch (e) { toast(e.message); }
    renderReading();
  };
  if (r.active) {
    const p = r.progress || {};
    st.textContent = `${r.arc.title}: ${p.completed || 0} of ${p.units} ${r.arc.unit_label || "parts"} read${p.behind ? `, ${p.behind} behind your pace` : ""}${p.finished ? ". Finished." : "."}`;
    if (r.station?.name) box.append(el("p", {}, "Now: ", el("b", {}, r.station.name)));
    const note = el("textarea", { id: "readingNote", rows: "2", placeholder: "A note in the margin (optional)" });
    box.append(
      el("div", { class: "row-btns" },
        p.finished ? "" : el("button", { class: "btn primary", type: "button", id: "readingDone", onclick: () => act({ action: "done" }, "Marking it read…") }, "I have read it"),
        el("button", { class: "btn ghost", type: "button", onclick: () => { if (confirm(`Close your reading of ${r.arc.title}? What you noted stays in your memory.`)) act({ action: "close" }, "Closing…"); } }, "Close this reading")),
      note,
      el("button", { class: "btn ghost block", type: "button", onclick: () => { if (note.value.trim()) act({ action: "note", seam: "mine", body: note.value.trim() }, "Keeping the note…"); } }, "Keep the note"));
    for (const n of (r.notes || []).slice(0, 5)) box.append(el("p", { class: "fine" }, `${n.unit}. ${n.body}`));
    return;
  }
  st.textContent = "No reading under way. Choose a work and a pace; Lodestone follows where you are and asks about it now and then.";
  let canon;
  try { canon = await held.heldCall("member/reading-api.php", { action: "canon" }); } catch (e) { st.textContent = e.message; return; }
  const work = el("select", { id: "readingWork" });
  for (const [track, label] of [["threshold", "The threshold"], ["cartography", "The cartography"], ["standalone", "Standing alone"]]) {
    const list = canon[track] || [];
    if (!list.length) continue;
    const g = el("optgroup", { label });
    for (const w of list) g.append(el("option", { value: w.key }, `${w.title}, ${w.author} (${w.units} ${w.unit_label})`));
    work.append(g);
  }
  const pace = el("select", { id: "readingPace" });
  for (const p of canon.paces || []) pace.append(el("option", { value: p.code }, p.label));
  box.append(el("label", {}, "Work", work), el("label", {}, "Pace", pace),
    el("button", { class: "btn primary block", type: "button", id: "readingStart", onclick: () => act({ action: "start", work_key: work.value, pace: pace.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }, "Beginning…") }, "Begin the reading"));
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

async function renderHP() {
  const box = $("#hpBtns"); if (!box) return;
  box.innerHTML = "";
  const st = $("#hpStatus");
  st.textContent = S.assessment
    ? "Taken. Your Wheel reading below comes from it, and Lodestone reads the rest. Retake it when your life has moved."
    : "Not taken yet. The assessment reads where you stand across the eight pillars, your Enneagram and your constitution, about twenty minutes; Lodestone then reads you through it.";
  box.append(el("a", { class: "btn " + (S.assessment ? "ghost" : "primary"), href: assessmentUrl() }, S.assessment ? "Retake the assessment" : "Take the assessment"));
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
  const key = await secrets.get("openrouter").catch(() => null);
  const acct = await hosted.account().catch(() => null);
  const pc = isNative() ? await pairing.get().catch(() => null) : null;
  const show = phoneRoutesAvailable() && !!S.engine && (key || acct || pc || ["hosted", "openrouter"].includes(S.engine.kind));
  $("#modelRow").hidden = !show;
  if (!show) return;
  $("#modelChipLabel").textContent = S.engine.describe();
  $("#modelChip").classList.toggle("rented", S.engine.kind === "hosted" || S.engine.kind === "openrouter" || (S.engine.kind === "server" && !!S.where));
}

async function toggleWebMenu() {
  const menu = $("#modelMenu");
  if (!menu.hidden) return closeModelMenu();
  const key = await secrets.get("openrouter").catch(() => null);
  const acct = await hosted.account().catch(() => null);
  const cur = { tier: S.settings.tier, model: S.settings.remote?.model || "" };
  const item = (label, sub, active, choice) => el("button", {
    class: "model-item" + (active ? " active" : ""), type: "button", role: "menuitemradio", "aria-checked": active ? "true" : "false",
    onclick: () => switchWebTo(choice),
  }, el("span", { class: "n" }, label), sub ? el("span", { class: "s" }, sub) : null);
  const kids = [];
  if (key) {
    kids.push(el("div", { class: "model-group" }, "OpenRouter, your key — OpenRouter reads each turn"));
    for (const m of RECOMMENDED) kids.push(item(m.label, `${m.maker} · ${m.licence} · tested with Lodestone`, cur.tier === "openrouter" && cur.model === m.id, { tier: "openrouter", model: m.id }));
    if (cur.tier === "openrouter" && cur.model && !RECOMMENDED.some(m => m.id === cur.model)) kids.push(item(cur.model, assess(cur.model).note, true, { tier: "openrouter", model: cur.model }));
  }
  if (acct) {
    let st = null; try { st = await hosted.status(); } catch {}
    const count = st && st.cap > 0 && st.remaining != null ? ` — ${st.remaining} of ${st.cap} left today` : "";
    kids.push(el("div", { class: "model-group" }, `Your harmonism.io account${count}`));
    const list = st?.models || [];
    for (const m of list) kids.push(item(m.label, `${m.maker} · ${m.licence} · tested with Lodestone`, cur.tier === "hosted" && (cur.model || list.find(x => x.default)?.id) === m.id, { tier: "hosted", model: m.id }));
    if (!list.length) kids.push(item("Hosted Lodestone", "the default model", cur.tier === "hosted", { tier: "hosted", model: "" }));
  }
  const pc = isNative() ? await pairing.get().catch(() => null) : null;
  if (pc) { const w = await desktopWhere(pc.base); if (w !== undefined) S.pairedWhere = w; }
  if (pc) kids.push(el("div", { class: "model-group" }, S.pairedWhere ? `Your computer — it rents from ${HOST_LABEL[S.pairedWhere] || S.pairedWhere}` : "Your computer — nothing leaves your network"), item(`Lodestone Desktop · ${pc.name}`, `over your Wi-Fi, at ${pc.base}`, cur.tier === "server" && !!S.settings.server?.paired, { tier: "server", computer: true }));
  let sameOrigin = false; try { sameOrigin = !!S.settings.server?.baseUrl && new URL(S.settings.server.baseUrl).origin === location.origin; } catch {}
  if (S.settings.server?.model && sameOrigin) kids.push(el("div", { class: "model-group" }, "Your computer — nothing leaves your network"), item(S.settings.server.model, "the model server that served this page", cur.tier === "server", { tier: "server" }));
  kids.push(el("div", { class: "model-group" }, "No model"), item("Read and search only", "the passages that bear on a question", cur.tier === "reader", { tier: "reader" }));
  kids.push(el("button", { class: "model-manage", type: "button", onclick: async () => { closeModelMenu(); S.engineReady = false; S.engine = null; await showSetup(); } }, "Keys, account and where Lodestone thinks…"));
  menu.replaceChildren(...kids);
  menu.hidden = false; $("#modelChip").setAttribute("aria-expanded", "true");
}

async function switchWebTo(choice) {
  closeModelMenu();
  if (S.busy) { toast("Wait for this answer to finish, then change the model."); return; }
  S.settings.tier = choice.tier;
  if (choice.tier === "openrouter" || choice.tier === "hosted") S.settings.remote = { tier: choice.tier, model: choice.model || "" };
  if (choice.computer) { const p = await pairing.get(); if (p) S.settings.server = await computerServer(p); }
  await store.kv.set("settings", S.settings);
  S.engineReady = false; S.engine = makeEngine(); updateBadge();
  try { await S.engine.load(); S.engineReady = true; engineStatus(null); }
  catch (e) { toast(String(e.message || e), 6000); }
  await refreshWhere();
  $("#chat").append(el("div", { class: "model-switch", role: "status" }, `Now thinking with ${S.engine.describe()}`));
  $("#chat").scrollTop = $("#chat").scrollHeight;
  refreshWebChip();
}

function renderMe() {
  renderHP();
  renderReading();
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
      el("button", { type: "button", title: "Release this practice", onclick: async () => { p.archived = Date.now(); await store.kv.set("practices", S.practices); renderMe(); renderCheckins(); } }, "Release")));
  }
  renderWheel();
}

function renderWheel() {
  const rows = $("#wheelRows"); rows.innerHTML = "";
  for (const [k, n] of PILLARS) {
    const s = el("select", { "aria-label": n }, LEVELS.map((l, i) => el("option", { value: i }, l)));
    s.value = S.wheel[k] || 0;
    s.onchange = async () => { S.wheel[k] = Number(s.value); await store.kv.set("wheel", S.wheel); drawWheel(); };
    rows.append(el("div", { class: "wheel-row", style: `--pc:${PILLAR_COLOR(k)}` }, el("span", {}, n), s));
  }
  drawWheel();
}

function drawWheel() {
  // Presence the central pillar, seven peripheral pillars around it.
  const svg = $("#wheelSvg"); const R = 88; const NS = "http://www.w3.org/2000/svg";
  svg.innerHTML = "";
  const mk = (t, a) => { const n = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) n.setAttribute(k, v); svg.append(n); return n; };
  const ring = PILLARS.slice(1);
  for (let lv = 1; lv <= 6; lv++) mk("circle", { r: R * lv / 6, stroke: "var(--border-light)", "stroke-width": 0.6 });
  const pts = [];
  ring.forEach(([k, n], i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / ring.length;
    mk("line", { x1: 0, y1: 0, x2: R * Math.cos(a), y2: R * Math.sin(a), stroke: "var(--border-light)", "stroke-width": 0.6 });
    const v = (S.wheel[k] || 0) / 6;
    pts.push([R * v * Math.cos(a), R * v * Math.sin(a)]);
    mk("circle", { cx: R * v * Math.cos(a), cy: R * v * Math.sin(a), r: 3.2, fill: PILLAR_COLOR(k), stroke: "none" });
    const t = mk("text", { x: (R + 12) * Math.cos(a), y: (R + 12) * Math.sin(a) + 3, "text-anchor": "middle" });
    t.textContent = n.slice(0, 5);
  });
  mk("polygon", { points: pts.map(p => p.join(",")).join(" "), fill: "var(--accent)", "fill-opacity": 0.18, stroke: "var(--accent-secondary)", "stroke-width": 1 });
  const pv = (S.wheel.presence || 0) / 6;
  mk("circle", { r: 6 + 16 * pv, fill: PILLAR_COLOR("presence"), "fill-opacity": 0.35, stroke: PILLAR_COLOR("presence") });
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
  return el("li", {}, el("button", { type: "button", onclick: () => openReader(i) }, a.t, where ? el("small", {}, where) : null));
}

let readerArticle = null;
function openReader(i) {
  const a = S.pack.corpus.articles[i]; readerArticle = i;
  $("#readerTitle").textContent = a.t;
  $("#readerMeta").textContent = [a.l, a.s, a.d].filter(Boolean).join(" · ");
  $("#readerBody").innerHTML = render(a.x);
  $("#readerOnline").href = a.u;
  openDrawer("#drawerReader");
  $("#drawerReader").scrollTop = 0;
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
  $("#setFoldersStats").textContent = r.stats ? `${r.stats.files.toLocaleString()} files read, ${r.stats.chunks.toLocaleString()} passages${r.stats.skipped ? ` (${r.stats.skipped} files over 2 MB left out)` : ""}.` : "";
  $("#setFoldersWhere").textContent = S.where
    ? `Lodestone is thinking with a rented model (${S.where}): the passages it uses from these folders travel with each message to that provider, which can read them.`
    : "Lodestone is thinking on this computer: nothing from these folders leaves it.";
}

async function renderSettings() {
  renderFolders();
  renderSync();
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

function openDrawer(sel) {
  document.querySelectorAll(".drawer").forEach(d => { if ("#" + d.id !== sel && !isDocked(d)) d.hidden = true; });
  $(sel).hidden = false; $("#scrim").hidden = false;
}
function closeDrawers() { document.querySelectorAll(".drawer").forEach(d => { if (!isDocked(d)) d.hidden = true; }); $("#scrim").hidden = true; }

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

async function refreshModelChip() {
  const q = await DESKTOP.quickModels().catch(() => null);
  if (!q) return;
  S.models = q;
  let label = "Choose a model";
  if (q.current.kind === "local") label = q.local.find(m => m.id === q.current.id)?.label || "A model on this computer";
  else if (q.current.kind === "remote") label = `${recLabel(q, q.current.model)} · ${q.remote?.host || "rented"}`;
  else if (q.current.kind === "hosted") label = `${(q.hostedModels || []).find(m => m.id === q.current.model)?.label || q.current.model} · harmonism.io${q.hosted?.remaining != null && q.hosted.cap > 0 ? ` · ${q.hosted.remaining} left today` : ""}`;
  else if (q.current.kind === "upstream") label = q.current.label;
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

async function addFiles(list) {
  if (!DESKTOP || !list?.length) return;
  for (const file of list) {
    const item = { name: file.name || "pasted image", kind: kindOf(file), status: "reading", statusText: "Reading…" };
    S.pending.push(item); renderAttachBar();
    const say = t => { item.statusText = t; renderAttachBar(); };
    try {
      if (item.kind === "unsupported") throw new Error("Lodestone reads text, PDF, images and recordings. Save a document as PDF or text.");
      let info = await DESKTOP.info().catch(() => ({}));
      if (item.kind === "audio" && !info.asr) {
        if (!confirm("To read recordings, Lodestone needs its speech model (about 250 MB). It is downloaded once and runs on this computer: the recording goes nowhere. Download it now?")) throw new Error("Not transcribed.");
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
      item.data = await readAttachment(file, { canSee, language, status: say });
      if (item.data.kind === "pdf" && item.data.scanned && !item.data.images?.length && !item.data.text) throw new Error("This PDF is pictures of pages, and the model in use cannot see. Attach it with a model that can see.");
      item.status = "ready";
      // A short recording with nothing typed: the transcript becomes the message, for the practitioner to read over and send.
      if (item.kind === "audio" && item.data.text && item.data.text.length < 1500 && !$("#input").value.trim()) {
        $("#input").value = item.data.text; autosize(); $("#input").focus();
        S.pending = S.pending.filter(x => x !== item);
        toast("Transcribed on this computer. Read it over, then send.", 5000);
      }
    } catch (e) {
      item.status = "error"; item.error = String(e.message || e);
    }
    renderAttachBar();
  }
}

function bindChrome() {
  $("#composer").addEventListener("submit", e => { e.preventDefault(); if (S.busy) S.engine?.interrupt(); else send(); });
  $("#webBtn").onclick = () => {
    if (!S.webNext) {
      let told = false; try { told = localStorage.getItem("munai-web-consent") === "1"; } catch {}
      if (!told) {
        if (!confirm("Look this up online?\n\nYour question will be sent to a search engine (DuckDuckGo, or Wikipedia when DuckDuckGo does not answer), and the pages it finds will be opened from this computer. Nothing else leaves: not your conversations, not your notes.\n\nThis applies to the next question only.")) return;
        try { localStorage.setItem("munai-web-consent", "1"); } catch {}
      }
    }
    setWebNext(!S.webNext); $("#input").focus();
  };
  $("#input").addEventListener("input", autosize);
  if (DESKTOP) {
    $("#attachBtn").onclick = () => $("#fileInput").click();
    $("#fileInput").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
    window.addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
    window.addEventListener("drop", e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });
    $("#input").addEventListener("paste", e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
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
  $("#btnLibrary").onclick = () => { renderLibrary($("#libSearch").value); openDrawer("#drawerLibrary"); };
  let lt; $("#libSearch").oninput = e => { clearTimeout(lt); lt = setTimeout(() => renderLibrary(e.target.value), 180); };
  $("#readerBack").onclick = () => { renderLibrary($("#libSearch").value); openDrawer("#drawerLibrary"); };
  $("#readerAsk").onclick = () => {
    const a = S.pack.corpus.articles[readerArticle]; closeDrawers();
    $("#input").value = `Walk me through "${a.t}" from where I stand.`; autosize(); $("#input").focus();
  };
  $("#btnMe").onclick = () => { renderMe(); openDrawer("#drawerMe"); };
  $("#btnSettings").onclick = () => { renderSettings(); openDrawer("#drawerSettings"); };
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
    await store.kv.set("practices", S.practices);
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
      await store.importAll(JSON.parse(await f.text()), { merge: true });
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
