// launcher.js — what the window shows before the conversation opens.
//   Usual launch:  "Waking Lodestone…" for a few seconds, then Lodestone.
//   First launch:  one download, then the same.
//   Lodestone → Model…: switch, download or remove models, or add one from Hugging Face.
//   Lodestone → Check for Updates… / Library Languages and Updates…: the app, the
//   corpus and the library.
const D = window.desktop;
const $ = s => document.querySelector(s);
const Q = new URLSearchParams(location.search);
const screen = Q.get("screen");
const gb = n => n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.round(n / 1e6) + " MB";
const sign = n => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1);
const SCREENS = ["#waking", "#welcome", "#failed", "#manage", "#library"];
const show = id => SCREENS.forEach(s => { $(s).hidden = s !== id; });

let S = null, chosen = null, busy = false;

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}
const model = id => S.catalog.find(m => m.id === id);
const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function figures(m) {
  if (!m.ugi) return null;
  const u = m.ugi, b = u.base;
  return el("div", { class: "figs" },
    `Answers ${u.w.toFixed(1)}/10 on contested questions${b ? ` (original ${b.w.toFixed(1)})` : ""} · capability ${u.natint.toFixed(1)}${b ? ` (${sign(u.natint - b.natint)})` : ""} · political score ${sign(u.lean)} · ${m.hand}`);
}

function card(m, { selectable = false } = {}) {
  const tight = S.memGB < m.minMem - 1;
  const tag = m.id === S.defaultId ? `Recommended for this computer${m.weaker ? " · smaller and weaker" : ""}${m.untested ? " · not yet tested against the doctrine" : ""}`
    : tight ? `Needs ${m.minMem} GB of memory — this computer has ${Math.round(S.memGB)}`
    : m.untested ? `Untested${m.weaker ? " · smaller and weaker" : ""} · for ${m.minMem} GB of memory or more`
    : m.custom ? `Your choice · about ${m.minMem} GB of memory` : `For ${m.minMem} GB of memory or more`;
  // Where the weights come from. A link inside a card that is itself a button:
  // the click opens the page in the browser and does not select the card.
  const source = m.page ? el("span", { class: "src" }, "From ", el("span", {
    class: "link", role: "link", title: m.page,
    onclick: ev => { ev.preventDefault(); ev.stopPropagation(); window.open(m.page); },
  }, m.repo), " on Hugging Face, where the files can also be downloaded by hand") : null;
  const kids = [
    el("span", { class: "tag" + (tight || (m.untested && m.id !== S.defaultId) ? " warn" : "") }, tag),
    el("span", { class: "name" }, m.label, el("span", { class: "size" }, ` · ${gb(m.size)}`)),
    el("span", { class: "why" }, m.why),
    figures(m),
    source,
  ];
  if (!selectable) return el("div", { class: "pick" }, kids);
  return el("button", { type: "button", class: "opt" + (tight ? " tight" : ""), "aria-pressed": String(m.id === chosen), onclick: () => { if (!busy) { chosen = m.id; renderWelcome(); } } }, kids);
}

// ─── Waking ──────────────────────────────────────────────────────────────────

async function wake(id, { back = false } = {}) {
  show("#waking");
  const m = model(id);
  $("#wakingTitle").textContent = "Waking Lodestone";
  $("#wakingText").textContent = `Loading ${m ? m.label.split(" · ")[0] : "the model"} into memory. A few seconds; longer the first time.`;
  const r = await D.start(id);
  if (r.ok) { $("#wakingText").textContent = "Ready."; return back ? D.goBack() : D.openApp(); }
  failed(r, id);
}

function failed(r, id) {
  show("#failed");
  $("#failText").textContent = r.message;
  $("#failDetail").textContent = r.detail || "";
  const acts = $("#failActions"); acts.innerHTML = "";
  if (/is missing/.test(r.message)) {
    acts.append(el("button", { class: "primary", onclick: async () => { await refresh(); chosen = id; renderWelcome(); show("#welcome"); begin(); } }, "Download the missing part"));
  } else if (/could not be loaded/.test(r.message)) {
    acts.append(el("button", { class: "primary", onclick: async () => {
      await D.deleteModel(id); await refresh(); chosen = id; renderWelcome(); show("#welcome"); begin();
    } }, "Download it again"));
  } else {
    acts.append(el("button", { class: "primary", onclick: () => wake(id) }, "Try again"));
  }
  if (r.smaller) acts.append(el("button", {
    onclick: async () => { chosen = r.smaller.id; if (r.smaller.downloaded) wake(r.smaller.id); else { await refresh(); chosen = r.smaller.id; renderWelcome(); show("#welcome"); } },
  }, r.smaller.downloaded ? `Use ${r.smaller.label} instead` : `Use a smaller model instead (${gb(r.smaller.size)})`));
  acts.append(el("button", { class: "link", onclick: () => manageScreen() }, "Choose another model"));
}

// ─── First launch ────────────────────────────────────────────────────────────

function renderWelcome() {
  const m = model(chosen);
  $("#welcomeText").textContent = `A language model that lives on this computer: one download of ${gb(m.size)}, chosen for its ${Math.round(S.memGB)} GB of memory. After that Lodestone opens in seconds, works with no internet, and nothing you say leaves this computer.`
    + (S.memGB < S.minMem - 1 ? ` Lodestone needs ${S.minMem} GB of memory for its smallest model, and this computer has ${Math.round(S.memGB)}: it may answer very slowly or not start at all.` : "");
  $("#pick").replaceChildren(card(m));
  const list = $("#list"); list.innerHTML = "";
  S.catalog.filter(x => x.id !== "tiny" || x.id === S.defaultId).forEach(x => list.append(card(x, { selectable: true })));
  const btn = $("#begin");
  btn.disabled = busy;
  btn.textContent = m.downloaded ? "Begin" : m.partial ? `Resume download (${gb(m.partial)} of ${gb(m.size)})` : `Download and begin · ${gb(m.size)}`;
  const short = S.freeBytes < m.size - m.partial + 5e8;
  $("#dlError").hidden = !short;
  if (short) $("#dlError").textContent = `This computer has ${gb(S.freeBytes)} free; the model needs ${gb(m.size - m.partial)}. Free some space, or choose a smaller model below.`;
}

function progressTo(bar, text) {
  return p => {
    if (p.phase === "download") {
      $(bar).style.width = (p.done / p.total * 100).toFixed(1) + "%";
      const left = p.rate > 0 ? (p.total - p.done) / p.rate : 0;
      const eta = left > 5400 ? `about ${Math.round(left / 3600)} hours left` : left > 90 ? `about ${Math.round(left / 60)} minutes left` : left > 0 ? "less than two minutes left" : "";
      $(text).textContent = `${gb(p.done)} of ${gb(p.total)}${p.rate ? ` · ${(p.rate / 1e6).toFixed(1)} MB/s` : ""}${eta ? ` · ${eta}` : ""}`;
    } else if (p.phase === "verify") {
      $(bar).style.width = (p.done / p.total * 100).toFixed(1) + "%";
      $(text).textContent = "Checking the download is complete and undamaged…";
    } else if (p.phase === "retry") {
      $(text).textContent = `The download server is busy. Trying again in ${p.wait} seconds…`;
    } else if (p.phase === "done") {
      $(bar).style.width = "100%"; $(text).textContent = "Downloaded.";
    }
  };
}

async function begin() {
  const m = model(chosen);
  if (m.downloaded) return wake(m.id);
  busy = true; renderWelcome();
  $("#dl").hidden = false; $("#dlError").hidden = true; $("#others").open = false; $("#others").hidden = true;
  $("#begin").hidden = true;
  try {
    await D.download(m.id);
    busy = false;
    return wake(m.id);
  } catch (e) {
    busy = false; await refresh(); renderWelcome();
    $("#begin").hidden = false; $("#others").hidden = false; $("#dl").hidden = true;
    const msg = clean(e);
    if (!/abort/i.test(msg)) { $("#dlError").hidden = false; $("#dlError").textContent = msg; }
  }
}

// ─── Lodestone → Model… ──────────────────────────────────────────────────────────

async function manageScreen() {
  await refresh();
  show("#manage");
  const current = S.upstream || S.remote || S.hosted?.active ? null : S.chosen;
  renderRemote();
  renderHosted();
  $("#manageText").textContent = S.hosted?.active
    ? `Lodestone is thinking with ${hostedLabel(S.hosted.model)} through your harmonism.io account. Everything else stays on this computer.`
    : S.remote
    ? `Lodestone is thinking with ${remoteLabel(S.remote.model)}, rented from ${S.remote.host} with your key. Everything else stays on this computer.`
    : S.upstream
    ? `Lodestone is using your own model server at ${S.upstream}.`
    : `Lodestone is thinking with ${model(current)?.label || "—"}. This computer has ${Math.round(S.memGB)} GB of memory and ${gb(S.freeBytes)} free on its disk.`;
  $("#upstream").value = S.upstream || "";
  const list = $("#manageList"); list.innerHTML = "";
  const shown = S.catalog.filter(x => x.id !== "tiny" || x.id === S.defaultId)
    .sort((a, b) => a.size - b.size);   // lightest to heaviest; the one in use is tagged "In use"
  for (const m of shown) {
    const inUse = m.id === current;
    const actions = el("div", { class: "row" });
    if (m.downloaded) {
      if (!inUse) actions.append(el("button", { class: "primary", onclick: () => wake(m.id) }, "Use this model"));
      if (!inUse) actions.append(el("button", { class: "link", onclick: async () => {
        if (!await ask(`Remove ${m.label} from this computer? It frees ${gb(m.size)}; you can download it again later.`)) return;
        await D.deleteModel(m.id); manageScreen();
      } }, `Remove (frees ${gb(m.size)})`));
    } else {
      actions.append(el("button", { onclick: () => manageDownload(m.id) }, m.partial ? `Resume download (${gb(m.partial)} of ${gb(m.size)})` : `Download · ${gb(m.size)}${m.parts > 1 ? ` in ${m.parts} parts` : ""}`));
    }
    if (m.custom && !inUse) actions.append(el("button", { class: "link", onclick: async () => {
      if (!await ask(`Take ${m.label} off the list${m.partial ? ` and delete its files (${gb(m.partial)})` : ""}?`)) return;
      await D.removeCustom(m.id); manageScreen();
    } }, "Take off the list"));
    const c = card(m);
    if (inUse) c.prepend(el("span", { class: "tag ok" }, "In use"));
    c.append(actions);
    list.append(c);
  }
  const left = S.leftovers.reduce((n, f) => n + f.size, 0);
  const lo = $("#leftovers"); lo.hidden = !left; lo.innerHTML = "";
  if (left) lo.append(`Files from a model Lodestone no longer offers take ${gb(left)}. `,
    el("button", { class: "link", onclick: async () => { await D.removeLeftovers(); manageScreen(); } }, "Delete them"));
}

// ─── A model the practitioner rents ──────────────────────────────────────────

function renderRemote() {
  const sel = $("#rPreset");
  if (!sel.options.length) for (const [k, p] of Object.entries(S.presets)) sel.append(el("option", { value: k }, p.label));
  const cur = S.remote;
  if (!cur && S.presets.openrouter) sel.value = "openrouter";   // DeepSeek V4.1 Flash on OpenRouter first
  if (cur) { sel.value = cur.preset; $("#rUrl").value = cur.baseUrl; $("#rModel").value = cur.model; $("#rKey").placeholder = cur.hasKey ? "Saved — leave empty to keep it" : ""; }
  $("#remoteNow").hidden = !cur;
  if (cur) $("#remoteNow").textContent = `In use: ${cur.model} from ${cur.host}.`;
  $("#rClear").hidden = !cur;
  presetChanged(!cur);
}

function presetChanged(fill = true) {
  const p = S.presets[$("#rPreset").value];
  $("#rNote").textContent = p.note;
  $("#rUrlRow").hidden = $("#rPreset").value !== "custom";
  if (fill) { $("#rUrl").value = p.baseUrl; $("#rModel").value = p.model; }
  $("#rKey").placeholder = (S.remote?.hasKey && S.remote.preset === $("#rPreset").value) ? "Saved — leave empty to keep it" : p.keyHint;
  const rec = p.recommended || [];
  $("#rRecBox").hidden = !rec.length;
  $("#rRec").replaceChildren(...rec.map(m => el("button", {
    class: "link", title: `${m.maker} · ${m.licence}${m.note ? " · " + m.note : ""}`,
    onclick: ev => { ev.preventDefault(); $("#rModel").value = m.id; showAssess(); },
  }, m.label)), ...(p.offered || []).map(m => el("button", {
    class: "link", title: `${m.maker} · ${m.licence} · ${m.note}`,
    onclick: ev => { ev.preventDefault(); $("#rModel").value = m.id; showAssess(); },
  }, `${m.label} (not recommended)`)));
  showAssess();
  const a = $("#rKeyLink"); a.hidden = !p.keyUrl;
  a.onclick = ev => { ev.preventDefault(); if (p.keyUrl) window.open(p.keyUrl); };
}

// Same rule as remote.js's assess(); keep the two identical.
const CLOSED_ID = /^(anthropic\/|x-ai\/|claude|grok|o\d)|^(openai\/)?(gpt-(?!oss)|chatgpt|o\d)|^(google\/)?gemini/i;
function showAssess() {
  const preset = $("#rPreset").value, id = $("#rModel").value.trim(), box = $("#rAssess");
  const rec = (S.presets[preset]?.recommended || []).some(m => m.id === id);
  const closed = preset === "anthropic" || CLOSED_ID.test(id);
  const off = (S.presets[preset]?.offered || []).some(m => m.id === id);
  box.hidden = !id || rec;
  box.textContent = off ? "Not recommended · doctrinal fidelity. Strong otherwise; closed weights." : closed ? "Closed weights · not tested against the doctrine." : "Not tested against the doctrine.";
  box.classList.toggle("warn", closed || off);
}

const remoteConf = () => ({ preset: $("#rPreset").value, baseUrl: $("#rUrl").value.trim(), model: $("#rModel").value.trim() });

async function listRemoteModels() {
  const box = $("#rError"); box.hidden = true;
  const btn = $("#rList"); btn.disabled = true; btn.textContent = "Asking the provider…";
  try {
    const ids = await D.remoteModels(remoteConf(), $("#rKey").value);
    $("#rModels").replaceChildren(...ids.map(id => el("option", { value: id })));
    btn.textContent = `${ids.length} models — pick one in the box`;
  } catch (e) { box.hidden = false; box.textContent = clean(e); btn.textContent = "List the models this key can use"; }
  finally { btn.disabled = false; }
}

// ─── harmonism.io account: hosted models, ten messages a day, then five ─────────

const hostedLabel = id => (S.hosted?.recommended || []).find(m => m.id === id)?.label || id;
const remoteLabel = id => Object.values(S.presets || {}).flatMap(p => [...(p.recommended || []), ...(p.offered || [])]).find(m => m.id === id)?.label || id;
const left = st => st && st.cap > 0 && st.remaining != null ? `${st.remaining} of ${st.cap} messages left today` : st && st.cap === 0 ? "no daily limit on this account" : "";

async function renderHosted() {
  const h = S.hosted || {};
  const acct = h.account;
  $("#hSignedOut").hidden = !!acct;
  $("#hSignedIn").hidden = !acct;
  $("#hError").hidden = true;
  if (!acct) return;
  $("#hWho").textContent = `Signed in as ${acct.email}.`;
  const sel = $("#hModel");
  if (!sel.options.length) for (const m of h.recommended || []) sel.append(el("option", { value: m.id }, `${m.label} — ${m.maker}, ${m.licence}`));
  if (h.model) sel.value = h.model;
  $("#hUse").textContent = h.active ? "Use this model" : "Use my harmonism.io account";
  $("#hLeft").textContent = "";
  try {
    const st = await D.hostedStatus();
    $("#hLeft").textContent = st?.error ? st.error : left(st);
  } catch (e) { $("#hLeft").textContent = clean(e); }
}

async function hostedSignIn() {
  const box = $("#hError"); box.hidden = true;
  const btn = $("#hSignIn"); btn.disabled = true; btn.textContent = "Signing in…";
  try {
    await D.hostedSignIn($("#hEmail").value, $("#hPassword").value);
    $("#hPassword").value = "";
    await refresh(); await renderHosted();
  } catch (e) { box.hidden = false; box.textContent = clean(e); }
  finally { btn.disabled = false; btn.textContent = "Sign in"; }
}

async function hostedUse() {
  const box = $("#hError"); box.hidden = true;
  try { await D.hostedUse($("#hModel").value); await refresh(); D.openApp(); }
  catch (e) { box.hidden = false; box.textContent = clean(e); }
}

async function saveRemote() {
  const box = $("#rError"); box.hidden = true;
  const btn = $("#rSave"); btn.disabled = true; btn.textContent = "Connecting…";
  try {
    const r = await D.setRemote(remoteConf(), $("#rKey").value);
    $("#rKey").value = "";
    if (!r.persisted) alert("This computer offers no keychain, so the key is kept only until Lodestone closes. You will be asked for it again next time.");
    await refresh();
    D.openApp();
  } catch (e) { box.hidden = false; box.textContent = clean(e); }
  finally { btn.disabled = false; btn.textContent = "Connect and use"; }
}

async function addCustom() {
  const box = $("#hfError"); box.hidden = true;
  const btn = $("#hfAdd"); btn.disabled = true; btn.textContent = "Reading…";
  try {
    const m = await D.addCustom($("#hfInput").value);
    $("#hfInput").value = "";
    await manageScreen();
    if (!m.downloaded) manageDownload(m.id);
  } catch (e) { box.hidden = false; box.textContent = clean(e); }
  finally { btn.disabled = false; btn.textContent = "Add"; }
}

async function manageDownload(id) {
  if (busy) return;
  busy = true;
  $("#mdl").hidden = false; $("#mError").hidden = true;
  try {
    await D.download(id);
    busy = false; $("#mdl").hidden = true;
    manageScreen();
  } catch (e) {
    busy = false; $("#mdl").hidden = true;
    const msg = clean(e);
    if (!/abort/i.test(msg)) { $("#mError").hidden = false; $("#mError").textContent = msg; }
    manageScreen();
  }
}

// ─── Lodestone → Library Languages and Updates… ─────────────────────────────────

let L = null, remote = null, libBusy = false, appReady = null;
const day = iso => iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "—";

async function libraryScreen() {
  show("#library");
  L = await D.library();
  renderLibrary();
  await checkRemote();
}

// A Mac whose DNS server is on the local network (usually the router) answers
// Lodestone only if macOS lets Lodestone onto that network. When it does not, every
// browser opens harmonism.io while Lodestone reports the name unresolved.
const dnsHint = m => (/ERR_NAME_NOT_RESOLVED/.test(m) && L?.platform?.startsWith("mac"))
  ? " If harmonism.io opens in your browser, macOS is keeping Lodestone from your router, which looks up web addresses for this computer. Turn Lodestone on in System Settings → Privacy & Security → Local Network, then quit and reopen Lodestone. If Lodestone is not listed there, add 1.1.1.1 under System Settings → Network → Details → DNS."
  : "";

async function checkRemote() {
  $("#corpusActions").replaceChildren(el("span", { class: "fine" }, "Asking harmonism.io what is new…"));
  $("#appActions").replaceChildren();
  const r = await D.checkUpdates();
  if (!r.ok) {
    remote = null;
    $("#login").hidden = !r.needsLogin;
    renderLibrary(r.needsLogin ? null : `harmonism.io could not be reached (${r.message}).${dnsHint(r.message)} Everything here keeps working offline.`);
    return;
  }
  $("#login").hidden = true;
  remote = r;
  renderLibrary();
}

function renderApp() {
  const a = remote?.app, cur = L.appVersion;
  $("#appText").textContent = `This is Lodestone ${cur}.`;
  const box = $("#appActions"); box.innerHTML = "";
  if (appReady) {
    const how = L.platform.startsWith("mac")
      ? "Lodestone quits and the new disk image opens: drag Lodestone onto Applications and choose Replace. Your conversations and model stay."
      : L.platform === "win-x64" ? "Lodestone quits and the installer opens. Your conversations and model stay."
      : L.platform === "linux-appimage" ? "Lodestone replaces itself and opens again. Your conversations and model stay."
      : "The package opens in your software installer. Open Lodestone again once it is installed.";
    box.append(el("span", {}, `Lodestone ${appReady.version} is downloaded. ${how}`),
      el("button", { class: "primary", onclick: installApp }, L.platform.startsWith("mac") ? "Quit and open the disk image" : "Install"));
  } else if (a?.newer) {
    box.append(el("span", {}, `Lodestone ${a.latest} is available${a.released ? `, released ${day(a.released)}` : ""}.`),
      el("button", { class: "primary", disabled: libBusy, onclick: downloadApp }, `Download · ${gb(a.size)}`));
  } else if (a?.latest) box.append(el("span", { class: "ok-box" }, "This is the newest version."));
  else if (remote) box.append(el("span", { class: "fine" }, "harmonism.io does not list a newer version for this computer."));
}

async function downloadApp() {
  libBusy = true; renderLibrary();
  $("#adl").hidden = false; $("#appError").hidden = true; $("#abar").style.width = "0";
  const r = await D.downloadApp();
  libBusy = false; $("#adl").hidden = true;
  if (r.ok) appReady = r;
  else if (r.needsLogin) $("#login").hidden = false;
  else if (!/abort/i.test(r.message)) { $("#appError").hidden = false; $("#appError").textContent = r.message; }
  renderLibrary();
}

async function installApp() {
  const r = await D.installApp();
  if (!r.ok) { $("#appError").hidden = false; $("#appError").textContent = r.message; return; }
  $("#appActions").replaceChildren(el("span", { class: "fine" }, r.quits === false ? "The installer is open." : "Closing Lodestone…"));
}
$("#apause").onclick = () => D.cancelDownload();

function renderLibrary(problem = null) {
  renderApp();
  const c = L.corpus;
  $("#corpusText").textContent = c
    ? `${c.articles.toLocaleString()} articles, built ${day(c.built_at)}${c.backbone_full_version ? `, doctrinal backbone ${c.backbone_full_version}` : ""}.${L.corpusUpdated ? " Updated from harmonism.io." : ""}`
    : "—";
  const ca = $("#corpusActions"); ca.innerHTML = "";
  if (problem) ca.append(el("span", { class: "fine" }, problem), el("button", { class: "link", onclick: checkRemote }, "Try again"));
  else if (remote?.corpus.newer) {
    const rc = remote.corpus.remote;
    ca.append(el("span", {}, `A newer one is published: ${rc.articles.toLocaleString()} articles, built ${day(rc.built_at)}.`),
      el("button", { class: "primary", disabled: libBusy, onclick: updateCorpus }, "Update"));
  } else if (remote) ca.append(el("span", { class: "ok-box" }, "This is the current corpus."));
  $("#forgetRow").hidden = !L.hasPassword;

  // The model list: the models Lodestone offers, updated like the corpus.
  const lm = L.models;
  if (lm) $("#modelsText").textContent = `Model list: ${lm.count} models${lm.updated ? `, updated from harmonism.io${lm.built_at ? " " + day(lm.built_at) : ""}` : ", as shipped with this version"}.`;
  const ma = $("#modelsActions"); ma.innerHTML = "";
  if (!problem && remote?.models?.newer)
    ma.append(el("span", {}, `A newer model list is published (${remote.models.remote.count} models). Downloading it fetches no model.`),
      el("button", { class: "primary", disabled: libBusy, onclick: updateModels }, "Update"));
  else if (remote?.models) ma.append(el("span", { class: "ok-box" }, "This is the current model list."));

  const list = $("#langList"); list.innerHTML = "";
  for (const l of L.langs) {
    const pub = remote?.site?.[l.lang];
    const row = el("div", { class: "pick lang" });
    const status = l.installed
      ? (l.shipped ? "Included with the app" : `On this computer · ${day(l.built_at || l.installed_at)}`)
      : pub ? `${gb(pub.size)} to download` : remote ? "Not published yet" : "";
    row.append(el("span", { class: "name" }, l.name, el("span", { class: "size" }, status ? ` · ${status}` : "")));
    const acts = el("div", { class: "row" });
    if (pub?.newer) acts.append(el("button", { class: "primary", disabled: libBusy, onclick: () => installLang(l.lang) }, `Update · ${gb(pub.size)}`));
    if (!l.installed && pub) acts.append(el("button", { class: Q.get("lang") === l.lang ? "primary" : "", disabled: libBusy, onclick: () => installLang(l.lang) }, `Download · ${gb(pub.size)}`));
    if (l.installed && !l.shipped && l.lang !== "en") acts.append(el("button", { class: "link", onclick: async () => {
      if (!await ask(`Remove the ${l.name} library from this computer?`)) return;
      await D.removeLanguage(l.lang); L = await D.library(); renderLibrary();
    } }, "Remove"));
    if (acts.childNodes.length) row.append(acts);
    list.append(row);
  }
}

async function updateCorpus() {
  libBusy = true; renderLibrary();
  $("#cdl").hidden = false; $("#cbar").style.width = "5%"; $("#cbarText").textContent = "Downloading the corpus…";
  const r = await D.updateCorpus();
  libBusy = false; $("#cdl").hidden = true;
  L = await D.library();
  if (!r.ok) { if (r.needsLogin) $("#login").hidden = false; renderLibrary(r.message); return; }
  remote.corpus.newer = false; renderLibrary();
  $("#corpusActions").replaceChildren(el("span", { class: "ok-box" }, "Updated. Lodestone takes it in the next time it opens; the library's companion uses it now."));
}

async function updateModels() {
  libBusy = true; renderLibrary();
  const r = await D.updateModels();
  libBusy = false;
  L = await D.library();
  if (!r.ok) { if (r.needsLogin) $("#login").hidden = false; renderLibrary(r.message); return; }
  remote.models.newer = false; renderLibrary();
  $("#modelsActions").replaceChildren(el("span", { class: "ok-box" }, `Updated: ${r.count} models. They appear in Lodestone → Model…; nothing is downloaded until you choose one.`));
}

async function installLang(lang) {
  libBusy = true; renderLibrary();
  $("#ldl").hidden = false; $("#libError").hidden = true; $("#lbar").style.width = "0";
  const r = await D.installLanguage(lang);
  libBusy = false; $("#ldl").hidden = true;
  L = await D.library();
  if (!r.ok) {
    if (r.needsLogin) $("#login").hidden = false;
    else if (!/abort/i.test(r.message)) { $("#libError").hidden = false; $("#libError").textContent = r.message; }
  } else if (remote?.site?.[lang]) remote.site[lang].newer = false;
  renderLibrary();
}

async function login() {
  $("#loginError").hidden = true;
  const r = await D.login($("#user").value.trim(), $("#pass").value);
  if (!r.ok && r.needsLogin) { $("#loginError").hidden = false; $("#loginError").textContent = "That name and password were not accepted."; return; }
  $("#pass").value = "";
  L = await D.library();
  if (!r.ok) { $("#login").hidden = true; return renderLibrary(`harmonism.io could not be reached (${r.message}).${dnsHint(r.message)}`); }
  $("#login").hidden = true; remote = r; renderLibrary();
}
$("#loginBtn").onclick = login;
$("#pass").onkeydown = e => { if (e.key === "Enter") login(); };
$("#forget").onclick = async () => { await D.forgetPassword(); L = await D.library(); renderLibrary(); };
$("#lpause").onclick = () => D.cancelDownload();

function libraryProgress(p) {
  if (p.app) return progressTo("#abar", "#abarText")(p);
  if (p.phase === "corpus") {
    $("#cbar").style.width = (p.done / p.total * 100).toFixed(0) + "%";
    $("#cbarText").textContent = p.file ? `Downloading ${p.file === "corpus.json" ? "the articles" : "the search vectors"}…` : "Checking…";
  } else if (p.lang) {
    const name = L?.langs.find(x => x.lang === p.lang)?.name || p.lang;
    if (p.phase === "unpack") { $("#lbar").style.width = "100%"; $("#lbarText").textContent = `Placing the ${name} library…`; }
    else if (p.phase === "done") $("#lbarText").textContent = "Done.";
    else progressTo("#lbar", "#lbarText")(p);
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

async function refresh() { S = await D.status(); }

async function boot() {
  show("#waking");
  if (screen === "placing") { $("#wakingText").textContent = "Placing the library on this computer… This happens once, after an installation or an update."; return; }
  await refresh();
  if (screen === "models") return manageScreen();
  if (screen === "library") return libraryScreen();
  if (S.upstream || S.remote || S.hosted?.active) return D.openApp();
  chosen = S.chosen;
  const m = model(chosen);
  if (m?.downloaded) return wake(chosen);
  // First launch, or a download that was interrupted.
  if (!S.catalog.some(x => x.downloaded) || !m) chosen = m ? chosen : S.defaultId;
  renderWelcome();
  show("#welcome");
}

D.onProgress(p => {
  if (p.phase === "corpus" || p.app || p.lang) return libraryProgress(p);
  progressTo("#bar", "#barText")(p); progressTo("#mbar", "#mbarText")(p);
});
D.onLog(t => { $("#wakingText").textContent = t === "Waking Lodestone…" ? $("#wakingText").textContent : t; });
$("#begin").onclick = begin;
$("#pause").onclick = () => D.cancelDownload();
$("#mpause").onclick = () => D.cancelDownload();
// Back to the page the practitioner came from, waking the model first if it is not running.
document.querySelectorAll(".back").forEach(b => b.onclick = async () => {
  await refresh();
  if (S.upstream || S.remote || S.hosted?.active || S.running) return D.goBack();
  const m = model(S.chosen);
  if (m?.downloaded) { await wake(m.id, { back: true }); return; }
  chosen = S.chosen; renderWelcome(); show("#welcome");
});
$("#hfAdd").onclick = addCustom;
$("#hfInput").onkeydown = e => { if (e.key === "Enter") addCustom(); };
$("#saveUpstream").onclick = async () => { await D.setUpstream($("#upstream").value.trim()); await refresh(); if (S.upstream) D.openApp(); else manageScreen(); };
$("#showLog").onclick = () => D.revealLog();
$("#rPreset").onchange = () => presetChanged(true);
$("#rModel").addEventListener("input", showAssess);
$("#rList").onclick = listRemoteModels;
$("#rSave").onclick = saveRemote;
$("#rClear").onclick = async () => { await D.clearRemote(); await refresh(); manageScreen(); };
$("#hSignIn").onclick = hostedSignIn;
$("#hRegister").onclick = ev => { ev.preventDefault(); window.open("https://harmonism.io/member/register.php"); };
$("#hPassword").onkeydown = e => { if (e.key === "Enter") hostedSignIn(); };
$("#hUse").onclick = hostedUse;
$("#hSignOut").onclick = async () => { await D.hostedSignOut(); await refresh(); manageScreen(); };
$("#welcomeHosted").onclick = async () => { await manageScreen(); $("#hostedBox").open = true; $("#hostedBox").scrollIntoView({ behavior: "smooth" }); };
// Own key: OpenRouter, with DeepSeek V4.1 Flash filled in; the other providers stay in the list.
$("#welcomeRemote").onclick = async () => {
  await manageScreen();
  if (!S.remote && S.presets.openrouter) { $("#rPreset").value = "openrouter"; presetChanged(true); }
  $("#remoteBox").open = true; $("#remoteBox").scrollIntoView({ behavior: "smooth" }); $("#rKey").focus();
};

boot().catch(e => { show("#failed"); $("#failText").textContent = clean(e); });
