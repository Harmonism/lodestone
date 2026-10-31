// main.js — Lodestone as a desktop application.
//
// One app, one window. Everything Lodestone needs is inside it: the web app, the
// corpus, the retrieval model, the model engine (llama.cpp) and the English
// library of harmonism.io. The only thing not shipped is the language model
// itself, which is several gigabytes; the first launch downloads it, once, with
// a progress bar, and checks it.
//
// Every launch after that: the engine loads the model in the background while
// a short "Waking Lodestone" screen shows, then the conversation opens.
//
// The window's pages are served from this process at http://127.0.0.1:47863/:
// the library at /, Lodestone at /lodestone-app/. The practitioner never sees that
// address; it is fixed because the browser storage holding conversations,
// practices and memory is bound to it.
//
// The network is used only when the practitioner asks: a model download, an
// update of the corpus, the library or the app itself, or "Look this up online"
// on a question. No telemetry, no automatic update check.

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, session, net, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ─── Name, and the data folders of the earlier names ─────────────────────────
// The app was "MunAI Offline" until 1.2 and "MunAI" from 1.2 to 1.8; each kept
// its model, conversations, practices and memory in a folder of that name.
// The newest existing one is used where it is: Chromium has already opened the
// new folder by the time this runs, so moving an old one into place is not
// possible, and nothing is gained by copying.
const APP_NAME = "Lodestone";
app.setName(APP_NAME);
(() => {
  const appData = app.getPath("appData");
  const now = path.join(appData, APP_NAME);
  if (app.getPath("userData") !== now) return;                         // set explicitly (tests)
  if (fs.existsSync(path.join(now, "desktop.json"))) return;           // already a Lodestone install
  for (const legacy of ["MunAI", "MunAI Offline"]) {
    const before = path.join(appData, legacy);
    if (fs.existsSync(path.join(before, "desktop.json"))) { app.setPath("userData", before); return; }
  }
})();

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const { createServer, APP } = require("./server");
const { Engine, engineDir, EXE } = require("./engine");
const { download, downloadModel, modelBytes, freeBytes } = require("./download");
const models = require("./models");
const { ggufInfo } = require("./gguf");
const { Site, LANGS } = require("./site");
const { Updates } = require("./updates");
const { Companion } = require("./companion");
const { lookUp } = require("./weblookup");
const remote = require("./remote");
const { Hosted, BASE: HARMONISM } = require("./hosted");
const speech = require("./speech");
const whisperLocal = require("./whisperlocal");
const { TelegramBridge } = require("./telegram");
const { FolderIndex } = require("./folders");
const { LifeBook } = require("./lifebook");
const { SyncStore } = require("./syncstore");
const { createPhoneAccess } = require("./pairing");

const PORT = 47863;

// ─── Config ─────────────────────────────────────────────────────────────────

const userDir = () => app.getPath("userData");
const cfgPath = () => path.join(userDir(), "desktop.json");
const modelsDir = () => path.join(userDir(), "models");
const memGB = Math.round(os.totalmem() / 1073741824 * 10) / 10;
let cfg = {
  model: null,          // catalog id, or "hf:…" for one the practitioner added
  custom: [],           // models added from Hugging Face (Advanced)
  upstream: null,       // Advanced: an OpenAI-compatible server the practitioner runs instead
  remote: null,         // a model the practitioner rents: { preset, baseUrl, model, key } (key encrypted, remote.js)
  telegram: null,       // the practitioner's own bot: { token (encrypted), chatId, pairCode, outreach, lastOutreach } (telegram.js)
  lan: false,
  declinedMove: null,   // the version for which "Not now" was chosen
  auth: null,           // harmonism.io's beta password, encrypted by the OS keychain
  braveKey: null,       // optional, for "Look this up online"
  folders: [],          // folders Lodestone may read, chosen in Settings → Advanced
  lifeBook: null,       // the vault whose Lodestone/ folder is the life book, chosen in Settings → Life book
  theme: "dark",        // the app's light or dark, told by the app (set-theme), so the setup pages follow it
};
// The settings hold the encrypted keys, the Telegram token, the pairings: a
// file that cannot be read is moved aside, not overwritten by the defaults at
// the next save, and every save goes to a file beside it renamed into place,
// so a crash or a full disk mid-write leaves the last good one (1.12, after Lode).
let cfgUnreadable = null, cfgLocked = false;
function loadCfg() {
  let raw;
  // Only a file that is not there means "no settings yet" (1.13.1): a file held
  // by another program for a moment (an antivirus, a backup) is tried again, and
  // if it still cannot be read, nothing is saved over it this session.
  for (let i = 0; ; i++) {
    try { raw = fs.readFileSync(cfgPath(), "utf8"); break; }
    catch (e) {
      if (e.code === "ENOENT") return;
      if (i >= 4) {
        // Refused for good (its permissions changed): kept aside, as an unreadable
        // file is, and Lodestone starts from its defaults. Held: nothing is saved over it.
        if (e.code === "EACCES" || e.code === "EPERM") {
          const aside = cfgPath() + ".unreadable-" + Date.now();
          try { fs.renameSync(cfgPath(), aside); cfgUnreadable = aside; console.warn(`[config] desktop.json could not be read (${e.code}); kept as ${path.basename(aside)}`); return; } catch {}
        }
        cfgLocked = true; console.warn(`[config] desktop.json could not be read (${e.code}); nothing will be saved over it this session`); return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  try { cfg = { ...cfg, ...JSON.parse(raw) }; }
  catch {
    cfgUnreadable = cfgPath() + ".corrupt-" + Date.now();
    try { fs.renameSync(cfgPath(), cfgUnreadable); } catch {}
    console.warn(`[config] desktop.json could not be read; kept as ${path.basename(cfgUnreadable)}, starting from the defaults`);
  }
}
function saveCfg() {
  if (cfgLocked) return;
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    const tmp = `${cfgPath()}.${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, cfgPath());
  } catch (e) { console.warn("[config] not saved: " + e.message); }
}

// ─── Models ─────────────────────────────────────────────────────────────────

const allModels = () => [...models.CATALOG, ...(cfg.custom || [])];
const byId = id => allModels().find(m => m.id === id) || null;
const dirOf = m => path.join(modelsDir(), m.id.replace(/[^A-Za-z0-9._-]+/g, "_"));
const fileOf = (m, f) => path.join(dirOf(m), path.basename(f.path));
const firstFile = m => fileOf(m, m.files[0]);
// A model on the Prism engine counts as downloaded only once that engine is here
// too, so "Download" fetches whichever is missing. Which models need it: those
// the catalog marks (`engine: "prism"`), and any file whose tensor types say so,
// read from its head as Quarry desktop does (gguf.js), so a ternary file added
// from Hugging Face runs as well. Read once per file and remembered.
const prismDir = () => path.join(userDir(), "engines", models.PRISM_ENGINE.tag);
const hasPrism = () => fs.existsSync(path.join(prismDir(), EXE));
const needsMemo = new Map();
function needsOf(m) {
  if (!m) return null;
  if (m.engine) return m.engine;
  const f = firstFile(m);
  let st; try { st = fs.statSync(f); } catch { return null; }
  const k = `${f}:${st.size}:${st.mtimeMs}`;
  if (!needsMemo.has(k)) { let n = null; try { n = ggufInfo(f).needs; } catch {} needsMemo.set(k, n); }
  return needsMemo.get(k);
}
const engineFor = m => needsOf(m) === "prism" ? prismDir() : null;
const isDownloaded = m => (!m.engine || hasPrism()) && m.files.every(f => { try { return fs.statSync(fileOf(m, f)).size === f.size; } catch { return false; } });

/**
 * Fetch and unpack the Prism engine: one archive from the fork's GitHub release,
 * checked against its SHA-256 by download(), unpacked with the system's tar
 * (bsdtar on macOS and Windows 10+, which reads .zip too), and moved into place
 * only once llama-server is found inside it.
 */
async function ensurePrism({ signal, onProgress = () => {} } = {}) {
  if (hasPrism()) return;
  const a = models.prismAsset();
  if (!a) throw new Error("This model needs Prism ML's engine, which has no build for this kind of computer.");
  const root = path.dirname(prismDir());
  const archive = path.join(root, a.name), tmp = prismDir() + ".unpack";
  await download({ fetch: (u, init) => net.fetch(u, init), url: a.url, dest: archive, size: a.size, sha256: a.sha256, signal, onProgress: p => onProgress({ ...p, what: "engine" }) });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    require("child_process").execFileSync("tar", ["-xf", archive, "-C", tmp], { windowsHide: true, stdio: "ignore" });
  } catch { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error("Prism ML's engine was downloaded but could not be unpacked on this computer."); }
  // The macOS and Linux archives hold one folder; the Windows one is flat.
  const find = d => fs.existsSync(path.join(d, EXE)) ? d
    : fs.readdirSync(d, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => find(path.join(d, x.name))).find(Boolean) || null;
  const bin = find(tmp);
  if (!bin) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error("Prism ML's engine archive does not contain llama-server."); }
  fs.rmSync(prismDir(), { recursive: true, force: true });
  fs.renameSync(bin, prismDir());
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
}

/**
 * Start the engine on model `m`: the bundled one, or Prism ML's when the model
 * needs it, fetched first if it is not here yet (a file downloaded before this
 * version, or added by hand). A file of tensor types neither engine reads is
 * refused before anything starts.
 */
async function startEngine(m, { mmproj = null, onStatus = () => {} } = {}) {
  const needs = needsOf(m);
  if (needs === "unknown") throw new Error("This model file uses a format neither of Lodestone's engines can read.");
  if (needs === "prism" && !hasPrism()) { onStatus("Fetching Prism ML's engine, which this model needs…"); await ensurePrism(); }
  return engine.start(firstFile(m), { mmproj, dir: engineFor(m), onStatus });
}
const chosenModel = () => byId(cfg.model) || byId(models.defaultFor(memGB));
// A model's vision projector, if the catalog names one; downloaded on first use.
const mmprojOf = m => m?.mmproj ? path.join(dirOf(m), path.basename(m.mmproj.path)) : null;
const hasMmproj = m => { const p = mmprojOf(m); try { return !!p && fs.statSync(p).size === m.mmproj.size; } catch { return false; } };
const asrRoot = () => path.join(userDir(), "asr");
/** Can the current model see an image? "yes", "maybe" (a provider's model we cannot check), "download", or "no". */
function visionState() {
  if (cfg.remote) return { state: remote.normalize(cfg.remote).kind === "anthropic" ? "yes" : "maybe" };
  if (cfg.upstream) return { state: "maybe" };
  const m = chosenModel();
  if (!m?.mmproj) return { state: "no" };
  return hasMmproj(m) ? { state: "yes" } : { state: "download", size: m.mmproj.size };
}

/** 1.1 kept each model as a single file in models/; 1.2 gives each its own folder (shards). */
/**
 * Follow-up (October 25, 2026): the page moved a saved choice of a retired
 * model id to its successor (main.js boot), but the desktop keeps its own choice
 * in desktop.json, which nothing moved. A retired id there fell outside the
 * tested list, so its turns went out without the reasoning cap or the token
 * floor, and DeepSeek spent every token deliberating: the answer showed as "…".
 */
function migrateRetiredRemote() {
  let moved = false;
  for (const k of ["remote", "remoteSaved"]) {
    const c = cfg[k];
    if (c && typeof c.model === "string" && remote.RETIRED[c.model.trim()]) { cfg[k] = { ...c, model: remote.RETIRED[c.model.trim()] }; moved = true; }
  }
  if (moved) saveCfg();
}

function migrateModels() {
  let names = [];
  try { names = fs.readdirSync(modelsDir()); } catch { return; }
  for (const m of models.CATALOG) {
    if (m.files.length !== 1) continue;
    const name = path.basename(m.files[0].path);
    for (const n of [name, name + ".part"]) {
      if (!names.includes(n)) continue;
      try { fs.mkdirSync(dirOf(m), { recursive: true }); fs.renameSync(path.join(modelsDir(), n), path.join(dirOf(m), n)); } catch {}
    }
  }
}

/** Model files left from a model Lodestone no longer offers (the Qwen3.5 9B of 1.1). */
function leftovers() {
  let out = [];
  try {
    for (const n of fs.readdirSync(modelsDir())) {
      const p = path.join(modelsDir(), n);
      const st = fs.statSync(p);
      if (st.isFile() && /\.gguf(\.part)?$/i.test(n)) out.push({ name: n, size: st.size });
    }
  } catch {}
  return out;
}

// ─── Engine, library, updates, server ───────────────────────────────────────

const engine = new Engine({
  dir: engineDir(app.isPackaged, process.resourcesPath),
  logFile: path.join(userDir(), "engine.log"),   // not the shared temporary folder (1.12)
  pidFile: path.join(userDir(), "engine.pid"),
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { engine.killNow(); app.exit(0); });
process.on("exit", () => engine.killNow());

const webRoot = app.isPackaged ? path.join(process.resourcesPath, "web") : path.resolve(__dirname, "..", "..", "app");
const site = new Site({
  // Installed copies carry the English library as one archive (pack-library.js),
  // placed in the data folder by ensureLibrary(); a development run reads site-en/.
  bundled: app.isPackaged ? null : path.resolve(__dirname, "..", "site-en"),
  userDir: path.join(userDir(), "site"),
});

const password = {
  get() {
    if (password.session) return password.session;
    if (!cfg.auth) return null;
    try { return safeStorage.decryptString(Buffer.from(cfg.auth, "base64")); } catch { return null; }
  },
  set(user, pass) {
    const b = Buffer.from(`${user}:${pass}`).toString("base64");
    password.session = b;
    try { if (safeStorage.isEncryptionAvailable()) { cfg.auth = safeStorage.encryptString(b).toString("base64"); saveCfg(); } } catch {}
  },
  clear() { password.session = null; cfg.auth = null; saveCfg(); },
  session: null,
};
const updates = new Updates({
  fetch: (u, init) => net.fetch(u, init), dir: path.join(userDir(), "updates"),
  bundledCorpus: path.join(webRoot, "corpus"), site, getAuth: () => password.get(),
  appVersion: app.getVersion(), platform: installerKind(),
  catalog: {
    validate: models.validateCatalog, hash: models.catalogHash,
    bundledHash: () => models.catalogHash(models.validateCatalog({ schema: 1, ...models.bundledData(remote.BUNDLED_RECOMMENDED) })),
  },
});

// A model list fetched from harmonism.io replaces the shipped one. A
// model it no longer lists stays while it is downloaded or chosen.
const keepModel = m => cfg.model === m.id || isDownloaded(m);
function useCatalog(data) { models.applyCatalog(data, keepModel); remote.setRecommended(data.recommended); }
function loadStoredCatalog() { const s = updates.storedCatalog(); if (s) useCatalog(s.data); }

/** Which installer this copy of Lodestone came from, as latest.json names it. */
function installerKind() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (process.platform === "win32") return "win-x64";
  return process.env.APPIMAGE ? "linux-appimage" : "linux-deb";
}

// A rented model's key: decrypted from the keychain when first needed, or held
// for this session only where the system offers no keychain.
const remoteKey = {
  session: null,
  get() {
    if (remoteKey.session) return remoteKey.session;
    // The key of the rented model in use, or of the last one used: switching to a
    // model on this computer keeps it, so the switch back needs no key again.
    const enc = cfg.remote?.key || cfg.remoteSaved?.key;
    if (!enc) return null;
    try { return (remoteKey.session = safeStorage.decryptString(Buffer.from(enc, "base64"))); } catch { return null; }
  },
  /** Returns true when the key was stored encrypted, false when it is kept for this session only. */
  set(key) {
    remoteKey.session = key;
    try { if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(key).toString("base64"); } catch {}
    return null;
  },
};
// The harmonism.io account for hosted mode: its refresh token kept
// encrypted like a key; nothing is stored where the keychain is unavailable.
const hosted = new Hosted({
  fetch: (u, init) => net.fetch(u, init),
  load: () => {
    const h = cfg.hosted;
    if (!h?.refresh) return hostedSession;
    try { return { email: h.email, refresh: safeStorage.decryptString(Buffer.from(h.refresh, "base64")) }; } catch { return null; }
  },
  save: v => {
    if (!v) { hostedSession = null; cfg.hosted = null; if (cfg.remote?.preset === "harmonism") cfg.remote = null; saveCfg(); return; }
    let enc = null;
    try { if (safeStorage.isEncryptionAvailable()) enc = safeStorage.encryptString(v.refresh).toString("base64"); } catch {}
    hostedSession = enc ? null : v;
    cfg.hosted = { email: v.email, refresh: enc };
    delete cfg.hostedExpired;
    saveCfg();
  },
  // The account stays known when its sign-in expires, so Lodestone keeps the
  // same person's memory open and asks only for the password again.
  onExpired: email => { cfg.hostedExpired = email; saveCfg(); },
});
let hostedSession = null;
remote.setHosted(hosted);
const isHosted = c => c?.preset === "harmonism";
// The rented model under the practitioner's own key, apart from hosted mode.
const byok = () => (cfg.remote && !isHosted(cfg.remote)) ? cfg.remote : (cfg.remoteSaved && !isHosted(cfg.remoteSaved) ? cfg.remoteSaved : null);

const remoteWhere = () => cfg.remote ? remote.hostOf(remote.normalize(cfg.remote).baseUrl) : null;

const upstream = () => cfg.remote
  ? { url: origin() + "/v1", isEngine: false, remote: true, where: remoteWhere() }
  : cfg.upstream
  ? { url: cfg.upstream.replace(/\/+$/, ""), isEngine: false }
  : { url: engine.running ? engine.url + "/v1" : null, isEngine: true, key: engine.running ? engine.apiKey : null };
const companion = new Companion({ webRoot, corpusRoot: () => updates.corpusRoot(), upstream });
// The Lodestone app for Android: pairing by a code under Use from Your
// Phone (pairing.js), and the synced copy kept on this computer (syncstore.js),
// the same ciphertext as harmonism.io's, for sync that never leaves the home network.
const syncStore = new SyncStore(path.join(userDir(), "sync", "records.json"));
const computerName = () => os.hostname().replace(/\.(local|lan|home)$/i, "");
const phoneAccess = createPhoneAccess({
  sync: syncStore,
  // where: the provider this computer rents its model from, or null when it runs
  // the model itself, so a phone thinking through it can say which. No secret:
  // whoever reaches /v1 on this Wi-Fi reaches that model anyway.
  hello: () => ({ app: "lodestone-desktop", name: computerName(), version: app.getVersion(), where: remoteWhere() }),
  load: () => cfg.paired || [],
  save: list => { cfg.paired = list; saveCfg(); },
});

const server = createServer({
  webRoot, site, companion, corpusRoot: () => updates.corpusRoot(), asrRoot, phone: phoneAccess,
  getConfig: () => {
    if (cfg.remote) return { upstream: null, isEngine: false, remote: { conf: cfg.remote, key: remoteKey.get(), fetch: (u, init) => net.fetch(u, init) } };
    const u = upstream(); return { upstream: u.url, isEngine: u.isEngine, key: u.key || null };
  },
});
let port = PORT;
const origin = () => `http://127.0.0.1:${port}`;
const appURL = () => origin() + APP;

async function startServer() {
  try {
    port = await server.listen(PORT, cfg.lan);
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    port = await server.listen(0, cfg.lan);
    dialog.showMessageBox({
      type: "warning", title: APP_NAME,
      message: "Another program is using Lodestone's usual address.",
      detail: "Lodestone works normally for this session, but your earlier conversations will only reappear after that program is closed and Lodestone is opened again.",
    });
  }
}

// ─── Telegram ───────────────────────────────────────────────────────────────
// The bot's messages are answered by a hidden page of Lodestone itself (bridge
// mode), so they pass through the same harness and land in the same memory as
// the window's conversations.

const tgToken = {
  session: null,
  get() {
    if (tgToken.session) return tgToken.session;
    if (!cfg.telegram?.token) return null;
    try { return (tgToken.session = safeStorage.decryptString(Buffer.from(cfg.telegram.token, "base64"))); } catch { return null; }
  },
};
let bridgeWin = null, bridgeReady = null, bridgeSeq = 0;
const bridgePending = new Map();

function openBridge() {
  if (bridgeWin) return bridgeReady;
  bridgeReady = new Promise(resolve => { openBridge.resolve = resolve; });
  bridgeWin = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  lockDown(bridgeWin);
  bridgeWin.loadURL(appURL() + "?bridge=telegram");
  bridgeWin.on("closed", () => {
    bridgeWin = null; bridgeReady = null;
    for (const [, p] of bridgePending) p.reject(new Error("Lodestone's page closed."));
    bridgePending.clear();
  });
  return bridgeReady;
}

async function askBridge(req) {
  const ready = openBridge();
  const ok = await Promise.race([ready, new Promise(r => setTimeout(() => r(false), 90000))]);
  if (!ok) throw new Error("Lodestone is still waking on the computer. Try again in a minute.");
  const id = ++bridgeSeq;
  return new Promise((resolve, reject) => {
    bridgePending.set(id, { resolve, reject });
    setTimeout(() => { if (bridgePending.delete(id)) reject(new Error("Lodestone took too long to answer.")); }, 10 * 60 * 1000);
    bridgeWin.webContents.send("bridge-request", { id, ...req });
  });
}

const telegram = new TelegramBridge({
  fetch: (u, init) => net.fetch(u, init),
  getToken: () => tgToken.get(),
  cfg: () => cfg.telegram || {},
  save: patch => { cfg.telegram = { ...(cfg.telegram || {}), ...patch }; saveCfg(); },
  ask: askBridge,
  log: s => console.warn(s),
});

// ─── Windows ────────────────────────────────────────────────────────────────

let win = null, phoneWin = null, returnTo = null;
const icon = path.join(__dirname, "..", "build", "icon.png");

/** A harmonism.io address the app can show from this computer, or null. */
function localFor(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^(www\.)?harmonism\.io$/.test(u.hostname)) return null;
  if (/\.php$/.test(u.pathname) || u.pathname.startsWith("/audio/")) return null;
  const local = origin() + u.pathname + u.search + u.hash;
  if (u.pathname.startsWith(APP)) return local;
  const r = site.resolve(u.pathname);
  return r?.file || r?.missingLang ? local : null;
}

function lockDown(w) {
  // On a Mac the Edit menu's paste is ⌘V; Ctrl+V is bound here too, for a
  // Windows-convention keyboard. The Edit menu's role already binds Ctrl+V on
  // Windows and Linux, so this rests there.
  if (process.platform === "darwin") {
    w.webContents.on("before-input-event", (e, input) => {
      if (input.type === "keyDown" && input.control && !input.meta && !input.shift && !input.alt && input.key === "v") { e.preventDefault(); w.webContents.paste(); }
    });
  }
  // Links to harmonism.io open here when the page is in the library; other
  // links open in the practitioner's own browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    // Lodestone's own origin by its parsed origin (1.13.1): "http://127.0.0.1:47863@evil.example/" began with it.
    let own = false; try { own = new URL(url).origin === origin(); } catch {}
    const local = own ? url : localFor(url);
    if (local) w.loadURL(local);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(origin() + "/") || ownPage(url)) return;
    e.preventDefault();
    const local = localFor(url);
    if (local) w.loadURL(local);
    else if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

function createWindow(first = null) {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 380, minHeight: 520,
    title: APP_NAME, backgroundColor: themeBg(), show: false,
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true,
    },
  });
  lockDown(win);
  // Opens filling the screen (maximized, not full screen); the size above is what it returns to when un-maximized.
  win.once("ready-to-show", () => { win.maximize(); win.show(); });
  win.on("closed", () => {
    win = null;
    // The hidden Telegram page is a window too; without this, closing Lodestone's
    // only visible window would leave it running unseen on Windows and Linux.
    if (process.platform !== "darwin") app.quit();
  });
  showLauncher(first);
}

/** The setup pages. `screen`: "models" or "library"; returns to the current page afterwards. */
function showLauncher(screen = null, extra = {}) {
  if (!win) return;
  const cur = win.webContents.getURL();
  if (screen && cur.startsWith(origin())) returnTo = cur;
  win.loadFile(path.join(__dirname, "launcher.html"), { query: screen ? { screen, ...extra, theme: uiTheme() } : { theme: uiTheme() } });
}
// The setup pages wear the app's light or dark (1.17.2): they were always dark,
// so Settings › Change model… turned a light window dark.
const uiTheme = () => cfg.theme === "light" ? "light" : "dark";
const themeBg = () => uiTheme() === "light" ? "#f8f6f2" : "#0a0a14";
function openApp() { win?.loadURL(appURL()); }
function openLibraryHome() { win?.loadURL(origin() + "/"); }
/** Your path or the life book, in the app (October 26, 2026): at once when the app is open, else after it loads (?open=). */
function openInApp(what) {
  if (!win) return;
  const cur = win.webContents.getURL();
  if (cur.startsWith(appURL())) win.webContents.executeJavaScript(`window.lodestoneOpen && window.lodestoneOpen(${JSON.stringify(what)})`).catch(() => {});
  else win.loadURL(appURL() + "?open=" + encodeURIComponent(what));
}

function openPhoneWindow() {
  if (phoneWin) return phoneWin.focus();
  phoneWin = new BrowserWindow({
    width: 480, height: 820, resizable: true, title: "Use Lodestone from your phone",
    parent: win || undefined, backgroundColor: themeBg(),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  lockDown(phoneWin);
  phoneWin.setMenuBarVisibility(false);
  phoneWin.loadFile(path.join(__dirname, "phone.html"), { query: { theme: uiTheme() } });
  phoneWin.on("closed", () => { phoneWin = null; });
}

// ─── IPC ────────────────────────────────────────────────────────────────────
// The setup pages (file://) get the full set; pages on the app's own origin
// (Lodestone and the library) get only what their buttons need.

// Lodestone's own setup pages, by their exact files: not any local page a drop could open (1.12).
const OWN_PAGES = ["launcher.html", "phone.html"].map(f => path.join(__dirname, f));
function ownPage(url) {
  if (!String(url || "").startsWith("file:")) return false;
  try { return OWN_PAGES.includes(require("url").fileURLToPath(String(url).split(/[?#]/)[0])); } catch { return false; }
}
const fromSetupPage = e => ownPage(e.senderFrame?.url);
const fromAppPage = e => (e.senderFrame?.url || "").startsWith(origin() + "/");
function handle(name, fn, { app: allowApp = false } = {}) {
  ipcMain.handle(name, async (e, ...args) => {
    if (!fromSetupPage(e) && !(allowApp && fromAppPage(e))) throw new Error("not allowed");
    return fn(e, ...args);
  });
}
const send = (e, ch, payload) => { try { e.sender.send(ch, payload); } catch {} };

let dlCtrl = null;
let engineError = null;
const describe = m => ({
  id: m.id, label: m.label, why: m.why, ugi: m.ugi || null, hand: m.hand, minMem: m.minMem, custom: !!m.custom,
  repo: m.repo, page: models.page(m), untested: !!m.untested, weaker: !!m.weaker, lastResort: !!m.lastResort, size: models.size(m), parts: m.files.length,
  downloaded: isDownloaded(m), partial: modelBytes(m.files, dirOf(m)),
});

handle("status", async () => {
  fs.mkdirSync(modelsDir(), { recursive: true });
  return {
    platform: process.platform, memGB, minMem: models.minMemHere(),
    // The offered list: retired entries appear only to those who have or use them.
    catalog: allModels().filter(x => !x.retired || isDownloaded(x) || cfg.model === x.id).map(describe).sort((a, b) => a.size - b.size),   // lightest first
    defaultId: models.defaultFor(memGB), chosen: chosenModel().id,
    freeBytes: await freeBytes(modelsDir()),
    running: engine.running, upstream: cfg.upstream, engineError,
    remote: cfg.remote && !isHosted(cfg.remote) ? { ...remote.normalize(cfg.remote), label: (remote.PRESETS[cfg.remote.preset] || remote.PRESETS.custom).label, host: remoteWhere(), hasKey: !!remoteKey.get() } : null,
    presets: Object.fromEntries(Object.entries(remote.PRESETS).filter(([, p]) => !p.hidden)),
    hosted: { account: hosted.account(), active: isHosted(cfg.remote), model: isHosted(cfg.remote) ? cfg.remote.model : null, recommended: remote.RECOMMENDED },
    leftovers: leftovers(), returnTo,
  };
});

handle("download", async (e, id) => {
  const m = byId(id);
  if (!m) throw new Error("Unknown model.");
  if (dlCtrl) throw new Error("Another download is running.");
  dlCtrl = new AbortController();
  try {
    await downloadModel({
      fetch: (u, init) => net.fetch(u, init), files: m.files, urlFor: p => models.url(m.repo, p),
      dir: dirOf(m), signal: dlCtrl.signal, onProgress: p => send(e, "progress", p),
    });
    if (needsOf(m) === "prism") await ensurePrism({ signal: dlCtrl.signal, onProgress: p => send(e, "progress", p) });
    return true;
  } finally { dlCtrl = null; }
});

handle("cancel-download", async () => { dlCtrl?.abort(); });

/** Start the engine on `id` (or the chosen model). Resolves when it answers. */
handle("start", async (e, id) => {
  const m = byId(id) || chosenModel();
  if (!isDownloaded(m)) throw new Error("This model has not been downloaded yet.");
  engineError = null;
  try {
    const mmproj = hasMmproj(m) ? mmprojOf(m) : null;
    if (!(engine.running && engine.model === firstFile(m) && (engine.mmproj || null) === mmproj))
      await startEngine(m, { mmproj, onStatus: s => send(e, "log", s) });
    if (cfg.remote && !isHosted(cfg.remote)) cfg.remoteSaved = cfg.remote;
    cfg.model = m.id; cfg.upstream = null; cfg.remote = null; saveCfg();
    return { ok: true };
  } catch (err) {
    engineError = { message: err.message, detail: err.detail || "" };
    const smaller = m.custom ? null : models.smallerThan(m);
    return { ok: false, message: err.message, detail: err.detail || "", smaller: smaller && describe(smaller) };
  }
});

handle("delete-model", async (e, id) => {
  const m = byId(id);
  if (!m) return false;
  if (engine.model === firstFile(m)) await engine.stop();
  fs.rmSync(dirOf(m), { recursive: true, force: true });
  return true;
});

handle("add-custom", async (e, input) => {
  const m = await models.fromHuggingFace(input, (u, init) => net.fetch(u, init));
  cfg.custom = [...(cfg.custom || []).filter(x => x.id !== m.id), m];
  saveCfg();
  return describe(m);
});

handle("remove-custom", async (e, id) => {
  const m = (cfg.custom || []).find(x => x.id === id);
  if (!m) return false;
  if (engine.model === firstFile(m)) await engine.stop();
  fs.rmSync(dirOf(m), { recursive: true, force: true });
  cfg.custom = cfg.custom.filter(x => x.id !== id);
  if (cfg.model === id) cfg.model = null;
  saveCfg();
  return true;
});

handle("remove-leftovers", async () => {
  for (const f of leftovers()) fs.rmSync(path.join(modelsDir(), f.name), { force: true });
  return true;
});

handle("open-app", async () => { openApp(); });
handle("go-back", async () => {
  const to = returnTo; returnTo = null;
  if (to) win?.loadURL(to); else openApp();
});

handle("set-upstream", async (e, url) => {
  cfg.upstream = (url || "").trim() || null;
  if (cfg.upstream) { await engine.stop(); cfg.remote = null; remoteKey.session = null; }
  saveCfg();
  return cfg.upstream;
});

// A rented model. The key given here is tried with one short request before
// anything is saved; an empty key keeps the one already saved.
// The saved key goes only where it was saved for (1.13.1): the same provider at
// the same address. Another preset or address needs its own key.
function keyOr(key, conf) {
  if (typeof key === "string" && key.trim()) return key.trim();
  const saved = byok(), c = remote.normalize(conf);
  if (saved && c && saved.preset === c.preset && String(saved.baseUrl || "").replace(/\/+$/, "") === String(c.baseUrl || "").replace(/\/+$/, "")) return remoteKey.get();
  throw new Error(saved ? "Paste the key for this provider: the key saved is for another one." : "Paste the key for this provider.");
}
handle("remote-models", async (e, conf, key) => remote.listModels((u, init) => net.fetch(u, init), conf, keyOr(key, conf)));
handle("set-remote", async (e, conf, key) => {
  const k = keyOr(key, conf);
  const c = remote.normalize(conf);
  await remote.test((u, init) => net.fetch(u, init), c, k);
  const enc = remoteKey.set(k);
  cfg.remote = { ...c, key: enc };
  cfg.remoteSaved = cfg.remote;
  cfg.remoteRecent = [c.model, ...(cfg.remoteRecent || []).filter(x => x !== c.model)].slice(0, 6);
  cfg.upstream = null;
  await engine.stop();
  saveCfg();
  return { ok: true, persisted: !!enc };
});
// Hosted mode: sign in, use, sign out. Signing in costs no message.
const hostedErr = e => { throw new Error(String(e?.message || e)); };
handle("hosted-sign-in", async (e, email, password) => {
  try { const r = await hosted.signIn(email, password); await stretchForUnlock(r.email, password); return await hosted.status(true); } catch (err) { hostedErr(err); }
});
handle("hosted-status", async () => {
  if (!hosted.signedIn()) return null;
  try { return await hosted.status(); } catch (err) { return { error: String(err.message || err) }; }
}, { app: true });
handle("hosted-use", async (e, model) => {
  if (!hosted.signedIn()) throw new Error("Sign in to your harmonism.io account first.");
  const id = remote.RECOMMENDED.some(m => m.id === model) ? model : remote.PRESETS.harmonism.model;
  if (cfg.remote && !isHosted(cfg.remote)) cfg.remoteSaved = cfg.remote;
  cfg.remote = { preset: "harmonism", baseUrl: remote.PRESETS.harmonism.baseUrl, model: id };
  cfg.upstream = null;
  await engine.stop();
  saveCfg();
  return { ok: true };
});
handle("hosted-sign-out", async () => { hosted.signOut(); delete cfg.hostedExpired; saveCfg(); return true; });

// Sync. The window encrypts every record under the key its devices keep
// before it reaches here; this only carries the ciphertext to
// harmonism.io under the account, whose token the window never holds.
const SYNC_API = HARMONISM + "/lodestone-sync-api.php";
const SYNC_QUERY = /^(\?meta=1|\?unlock=1|\?since=\d{1,15}|\?link=1(&id=[A-Za-z0-9_-]{16,32})?)?$/;   // ?link: handing the sync key to a new device; ?unlock: the lock the password opens (sync.js)
// A sign-in kept here that this build cannot read (an ad-hoc signed update the
// keychain no longer opens to) is the same person's, expired: their memory stays
// open and Lodestone asks for the password again, never for a new account.
const knownAccount = () => cfg.hostedExpired || (cfg.hosted?.email && !hosted.signedIn() ? cfg.hosted.email : null);
handle("sync-account", async () => hosted.account() || (knownAccount() ? { email: knownAccount(), expired: true } : null), { app: true });
handle("sync-sign-in", async (e, email, password) => {
  try { const r = await hosted.signIn(email, password); await stretchForUnlock(r.email, password); return r; } catch (err) { hostedErr(err); }
}, { app: true });
// The password, stretched as unlock.js stretches it (PBKDF2-SHA-256, 600,000
// rounds, the account's email as salt), held here until the window takes it,
// once, to open the synced memory with (sync.js). The password itself is not kept.
let unlockHandoff = null;
async function stretchForUnlock(email, password) {
  email = String(email || "").trim().toLowerCase();
  if (!email || !password) return;
  try {
    const raw = await new Promise((res, rej) => require("crypto").pbkdf2(Buffer.from(String(password).normalize("NFKC"), "utf8"), Buffer.from("lodestone-unlock-v1:" + email, "utf8"), 600000, 32, "sha256", (err, k) => err ? rej(err) : res(k)));
    if (unlockHandoff) unlockHandoff.raw.fill(0);
    unlockHandoff = { email, raw, at: Date.now() };
  } catch {}
}
handle("sync-unlock-take", async () => {
  const h = unlockHandoff; unlockHandoff = null;
  if (!h) return null;
  const out = { email: h.email, raw: h.raw.toString("base64"), at: h.at };
  h.raw.fill(0);
  return out;
}, { app: true });
handle("sync-call", async (e, method, query, body) => {
  method = String(method || "GET").toUpperCase();
  query = String(query || "");
  if (!["GET", "PUT", "POST", "DELETE"].includes(method) || !SYNC_QUERY.test(query)) return { ok: false, code: "bad_request", message: "Not a sync call." };
  if (!hosted.signedIn()) return { ok: false, code: "auth", status: 401, message: cfg.hostedExpired ? "Your harmonism.io sign-in on this computer has expired. Sign in again." : "Sign in to your harmonism.io account first." };
  try {
    const res = await hosted.call({ url: SYNC_API + query, method, headers: body != null ? { "Content-Type": "application/json" } : {}, body: body != null ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, status: res.status, json }
      : { ok: false, status: res.status, code: json.error?.code || "http", message: json.error?.message || `harmonism.io answered ${res.status}.` };
  } catch (err) {
    // Say what went wrong: a sign-in to renew is not an unreachable site.
    const message = String(err.message || err);
    if (err.code === "auth" || /sign (you )?in/i.test(message)) return { ok: false, code: "auth", status: 401, message };
    return { ok: false, code: "network", message: `harmonism.io could not be reached (${message}). Lodestone will sync when you are back online.` };
  }
}, { app: true });
// The OpenRouter key, when the practitioner ticks it: sent from the keychain,
// and a key from another device taken in only where no other provider's is saved.
const isOpenRouter = c => !!c && remote.normalize(c).preset === "openrouter";
// Website Lodestone's memory, held by the practitioner: the Wisdom Canon
// and the learning jobs run on it at harmonism.io for one request each. The
// window sends the memory; this carries it under the account's sign-in.
const HELD_PATHS = new Set(["lodestone-learn.php", "member/reading-api.php"]);
handle("held-call", async (e, path, body) => {
  path = String(path || "");
  if (!HELD_PATHS.has(path)) return { ok: false, code: "bad_request", message: "Not a Lodestone memory call." };
  if (!hosted.signedIn()) return { ok: false, code: "auth", status: 401, message: "Sign in to your harmonism.io account first." };
  try {
    const res = await hosted.call({ url: HARMONISM + "/" + path, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json, message: res.ok ? "" : (json.error || `harmonism.io answered ${res.status}.`) };
  } catch (err) {
    const message = String(err.message || err);
    if (err.code === "auth" || /sign (you )?in/i.test(message)) return { ok: false, code: "auth", status: 401, message };
    return { ok: false, code: "network", message: `harmonism.io could not be reached (${message}).` };
  }
}, { app: true });

// The account's page, in the app: what harmonism.io's dashboard shows,
// reached under the account's sign-in. Only these calls, nothing else.
const ACCOUNT_CALLS = [
  ["POST", "member/companion-consent.php"],          // { action: status | revoke }
  ["GET", "member/sovereignty-bundle.php?status=1"],
  ["GET", "member/dashboard-api.php?action=membership"],
  ["POST", "member/link-telegram.php"],              // { action: verify } — Telegram's memory carried in
];
const ACCOUNT_ACTIONS = { "member/companion-consent.php": ["status", "revoke", "grant"], "member/link-telegram.php": ["verify"] };
handle("account-call", async (e, method, path, body) => {
  method = String(method || "GET").toUpperCase(); path = String(path || "");
  if (!ACCOUNT_CALLS.some(([m, p]) => m === method && p === path)) return { ok: false, code: "bad_request", message: "Not an account call." };
  if (method === "POST" && !(ACCOUNT_ACTIONS[path] || []).includes(body?.action)) return { ok: false, code: "bad_request", message: "Not an account call." };
  if (!hosted.signedIn()) return { ok: false, code: "auth", status: 401, message: cfg.hostedExpired ? "Your harmonism.io sign-in on this computer has expired. Sign in again." : "Sign in to your harmonism.io account first." };
  try {
    const res = await hosted.call({ url: HARMONISM + "/" + path, method, headers: body != null ? { "Content-Type": "application/json" } : {}, body: body != null ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json, message: res.ok ? "" : (json.error?.message || json.error || `harmonism.io answered ${res.status}.`) };
  } catch (err) {
    const message = String(err.message || err);
    if (err.code === "auth" || /sign (you )?in/i.test(message)) return { ok: false, code: "auth", status: 401, message };
    return { ok: false, code: "network", message: `harmonism.io could not be reached (${message}).` };
  }
}, { app: true });
// Help Lodestone improve: a conversation the practitioner read and chose to
// share, already anonymised in the window, goes to lodestone-share.php and
// nowhere else. Signed in, the sign-in goes along only to count shares a day.
handle("share-call", async (e, body) => {
  const action = body?.action;
  if (!["share", "withdraw"].includes(action)) return { ok: false, code: "bad_request", message: "Not a share call." };
  const init = { url: HARMONISM + "/lodestone-share.php", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  try {
    const res = hosted.signedIn() ? await hosted.call(init) : await fetch(init.url, init);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json, message: res.ok ? "" : (json.error?.message || `harmonism.io answered ${res.status}.`) };
  } catch (err) {
    return { ok: false, code: "network", message: `harmonism.io could not be reached (${String(err.message || err)}).` };
  }
}, { app: true });

// Share with your guide: a document sealed in the window (the key never
// leaves it), its receipts, and revoking, to lodestone-guide.php and nowhere else.
handle("guide-share-call", async (e, body) => {
  if (!["create", "status", "revoke"].includes(body?.action)) return { ok: false, code: "bad_request", message: "Not a guide share call." };
  const init = { url: HARMONISM + "/lodestone-guide.php", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  try {
    const res = body.action === "create" && hosted.signedIn() ? await hosted.call(init) : await fetch(init.url, init);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json, message: res.ok ? "" : (json.error?.message || `harmonism.io answered ${res.status}.`) };
  } catch (err) {
    return { ok: false, code: "network", message: `harmonism.io could not be reached (${String(err.message || err)}).` };
  }
}, { app: true });

// The Sovereignty Bundle downloads in the browser, as from the dashboard: its
// address carries a short-lived sign-in, the only way a download link can.
handle("account-open-bundle", async () => {
  if (!hosted.signedIn()) return { ok: false, message: "Sign in to your harmonism.io account first." };
  try { await shell.openExternal(HARMONISM + "/member/sovereignty-bundle.php?token=" + encodeURIComponent(await hosted.token())); return { ok: true }; }
  catch (err) { return { ok: false, message: String(err.message || err) }; }
}, { app: true });

// A natural voice on the harmonism.io account: the answer's text goes to
// lodestone-voice-api.php under the account's sign-in and comes back as MP3,
// read by Grok's Ara or Rex within the account's daily allowance.
handle("voice-speak", async (e, text, gender, lang) => {
  text = String(text || "").slice(0, 1200);
  if (!text.trim()) return { ok: false, code: "bad_request", message: "Nothing to read." };
  if (!hosted.signedIn()) return { ok: false, code: "auth", message: "Sign in to your harmonism.io account first." };
  try {
    const res = await hosted.call({ url: HARMONISM + "/lodestone-voice-api.php?speak=1", method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, gender: gender === "male" ? "male" : "female", lang: String(lang || "en").slice(0, 2) }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); return { ok: false, status: res.status, message: j.error?.message || `harmonism.io answered ${res.status}.` }; }
    return { ok: true, audio: new Uint8Array(await res.arrayBuffer()) };
  } catch (err) { return { ok: false, code: "network", message: `harmonism.io could not be reached (${String(err.message || err)}).` }; }
}, { app: true });

// Sync through this computer: Lodestone's own window reaches the synced
// copy kept here directly; paired phones through the phone server.
handle("sync-local", async (e, method, query, body) => {
  method = String(method || "GET").toUpperCase(); query = String(query || "");
  if (!["GET", "PUT", "POST", "DELETE"].includes(method) || !SYNC_QUERY.test(query)) return { ok: false, code: "bad_request", message: "Not a sync call." };
  const r = syncStore.handle(method, query, body);
  return r.status === 200 ? { ok: true, status: 200, json: r.json } : { ok: false, status: r.status, code: r.json.error?.code || "error", message: r.json.error?.message || "Sync through this computer failed." };
}, { app: true });
handle("sync-key-get", async () => isOpenRouter(byok()) ? remoteKey.get() : null, { app: true });
handle("sync-key-set", async (e, key) => {
  key = String(key || "").trim();
  if (!/^sk-or-[A-Za-z0-9_-]{20,}$/.test(key)) return false;
  const b = byok();
  if (b && !isOpenRouter(b)) return false;
  if (b && remoteKey.get() === key) return true;
  const enc = remoteKey.set(key);
  if (b) {
    if (cfg.remote && !isHosted(cfg.remote)) cfg.remote.key = enc;
    if (cfg.remoteSaved && !isHosted(cfg.remoteSaved)) cfg.remoteSaved.key = enc;
  } else {
    const p = remote.PRESETS.openrouter;
    cfg.remoteSaved = { preset: "openrouter", kind: p.kind, baseUrl: p.baseUrl, model: p.model, key: enc };
  }
  saveCfg();
  return true;
}, { app: true });

handle("clear-remote", async () => { cfg.remote = null; cfg.remoteSaved = null; cfg.remoteRecent = []; remoteKey.session = null; saveCfg(); return true; });

// The model menu in Lodestone's own window: every model on this computer and the
// rented ones under the saved key, switched without leaving the conversation.
// Folders Lodestone may read. Chosen by the practitioner; read-only.
const folderIndex = new FolderIndex(() => (cfg.folders || []).filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }));
handle("folders-list", async () => ({ folders: cfg.folders || [], stats: folderIndex.chunks ? folderIndex.stats : null }), { app: true });
handle("folders-add", async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || win, { title: "A folder Lodestone may read", buttonLabel: "Let Lodestone read it", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths?.[0]) return { folders: cfg.folders || [] };
  const p = r.filePaths[0];
  if (p === os.homedir() || p === path.parse(p).root) throw new Error("Choose a folder inside your home folder, not the whole of it.");
  cfg.folders = [...new Set([...(cfg.folders || []), p])]; saveCfg();
  folderIndex.invalidate();
  const stats = folderIndex.build();
  return { folders: cfg.folders, stats };
}, { app: true });
handle("folders-remove", async (e, p) => { cfg.folders = (cfg.folders || []).filter(x => x !== p); saveCfg(); folderIndex.invalidate(); return { folders: cfg.folders }; }, { app: true });
handle("folders-reread", async () => { folderIndex.invalidate(); return { folders: cfg.folders || [], stats: folderIndex.build() }; }, { app: true });
handle("folders-search", async (e, question) => (cfg.folders || []).length ? folderIndex.search(String(question || "").slice(0, 2000)) : [], { app: true });

// The life book: Lodestone's own folder in the practitioner's vault, the
// one place Lodestone writes, and only a change the practitioner kept from a card.
const lifeBook = new LifeBook(() => { const v = cfg.lifeBook; try { return v && fs.statSync(v).isDirectory() ? v : null; } catch { return null; } });
const lbStatus = () => { const d = lifeBook.dir(); return { vault: d ? cfg.lifeBook : null, dir: d, notes: d ? lifeBook.entries().length : 0 }; };
handle("lifebook-status", async () => lbStatus(), { app: true });
handle("lifebook-choose", async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || win, { title: "Your vault", message: "Lodestone will keep its notes in a folder of its own, Lodestone/, inside it, and write nowhere else.", buttonLabel: "Keep the life book here", properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths?.[0]) return lbStatus();
  const p = r.filePaths[0];
  if (p === os.homedir() || p === path.parse(p).root) throw new Error("Choose your vault's folder, not your whole home folder.");
  cfg.lifeBook = p; saveCfg();
  lifeBook.cache = null;
  lifeBook.ensure();
  return lbStatus();
}, { app: true });
handle("lifebook-forget", async () => { cfg.lifeBook = null; saveCfg(); lifeBook.cache = null; return lbStatus(); }, { app: true });
handle("lifebook-open", async () => { const d = lifeBook.dir(); if (d && fs.existsSync(d)) await shell.openPath(d); return true; }, { app: true });
handle("lifebook-entries", async () => lifeBook.dir() ? lifeBook.entries() : [], { app: true });
handle("lifebook-write", async (e, change) => {
  if (!lifeBook.dir()) throw new Error("No vault is chosen for the life book.");
  const c = change && typeof change === "object" ? change : {};
  const r = lifeBook.write({ op: String(c.op || ""), path: String(c.path || ""), text: c.text == null ? undefined : String(c.text), find: c.find == null ? undefined : String(c.find), replace: c.replace == null ? undefined : String(c.replace), mtime: Number(c.mtime) || 0 });
  return { rel: r.rel, backup: r.backup, mtime: r.mtime };
}, { app: true });

handle("quick-models", async () => {
  const saved = byok();
  const sc = saved ? remote.normalize(saved) : null;
  const preset = sc ? (remote.PRESETS[sc.preset] || remote.PRESETS.custom) : null;
  let hostedInfo = null;
  if (hosted.signedIn()) {
    let st = null; try { st = await hosted.status(); } catch (err) { st = { error: String(err.message || err) }; }
    hostedInfo = { email: hosted.account().email, cap: st?.cap ?? 10, remaining: st?.remaining ?? null, reset_at: st?.reset_at ?? 0, error: st?.error || null };
  }
  const current = isHosted(cfg.remote) ? { kind: "hosted", model: cfg.remote.model }
    : cfg.remote ? { kind: "remote", model: remote.normalize(cfg.remote).model }
    : cfg.upstream ? { kind: "upstream", label: `Your model server (${cfg.upstream})` }
    : { kind: "local", id: chosenModel()?.id };
  return {
    current,
    local: allModels().filter(isDownloaded).sort((a, b) => models.size(a) - models.size(b)).map(m => ({ id: m.id, label: m.label, hand: m.hand || "", vision: !!m.mmproj })),
    remote: sc ? { preset: sc.preset, label: preset.label, host: remote.hostOf(sc.baseUrl), model: sc.model, hasKey: !!remoteKey.get() } : null,
    recommended: preset?.recommended || [],
    offered: preset?.offered || [],
    hosted: hostedInfo,
    hostedModels: remote.RECOMMENDED,
    recent: cfg.remoteRecent || (sc?.model ? [sc.model] : []),
    assess: sc ? Object.fromEntries([...(cfg.remoteRecent || []), sc.model].filter(Boolean).map(id => [id, remote.assess(sc.preset, id)])) : {},
  };
}, { app: true });

handle("switch-model", async (e, choice) => {
  if (choice?.kind === "local") {
    const m = byId(choice.id);
    if (!m || !isDownloaded(m)) throw new Error("This model is not on this computer.");
    if (cfg.remote && !isHosted(cfg.remote)) cfg.remoteSaved = cfg.remote;
    engineError = null;
    const mmproj = hasMmproj(m) ? mmprojOf(m) : null;
    if (!(engine.running && engine.model === firstFile(m) && (engine.mmproj || null) === mmproj))
      await startEngine(m, { mmproj, onStatus: s => send(e, "progress", { what: "engine", text: s }) });
    cfg.model = m.id; cfg.upstream = null; cfg.remote = null; saveCfg();
    return { ok: true, label: m.label };
  }
  if (choice?.kind === "hosted") {
    if (!hosted.signedIn()) throw new Error("Sign in to your harmonism.io account in Model… first.");
    const model = remote.RECOMMENDED.some(m => m.id === choice.model) ? choice.model : remote.PRESETS.harmonism.model;
    if (cfg.remote && !isHosted(cfg.remote)) cfg.remoteSaved = cfg.remote;
    cfg.remote = { preset: "harmonism", baseUrl: remote.PRESETS.harmonism.baseUrl, model }; cfg.upstream = null;
    await engine.stop(); saveCfg();
    return { ok: true, label: `${(remote.RECOMMENDED.find(m => m.id === model) || {}).label || model} · harmonism.io` };
  }
  if (choice?.kind === "remote") {
    const saved = byok();
    if (!saved || !remoteKey.get()) throw new Error("No API key is saved. Open Model… to add one.");
    const model = String(choice.model || "").trim();
    if (!model) throw new Error("Give a model id.");
    cfg.remote = { ...saved, model }; cfg.remoteSaved = cfg.remote; cfg.upstream = null;
    cfg.remoteRecent = [model, ...(cfg.remoteRecent || []).filter(x => x !== model)].slice(0, 6);
    await engine.stop(); saveCfg();
    return { ok: true, label: `${model} · ${remoteWhere()}` };
  }
  throw new Error("Unknown choice.");
}, { app: true });

handle("reveal-log", async () => { shell.showItemInFolder(engine.logFile); });

// Library and updates

handle("library", async () => ({
  langs: Object.entries(LANGS).map(([lang, name]) => ({ lang, name, ...(site.info(lang) || {}), installed: !!site.root(lang) })),
  corpus: updates.localRuntime(), corpusUpdated: updates.corpusRoot() !== path.join(webRoot, "corpus"),
  models: { count: models.CATALOG.length, ...updates.localCatalog() },
  hasPassword: !!password.get(), appVersion: app.getVersion(), platform: installerKind(),
}));

const wrap = async fn => {
  try { return { ok: true, ...(await fn()) }; }
  catch (err) { return { ok: false, needsLogin: !!err.needsLogin, message: err.needsLogin ? "harmonism.io asked for its password." : err.message }; }
};

handle("updates-check", async () => wrap(() => updates.check()));
handle("updates-login", async (e, user, pass) => { password.set(user, pass); return wrap(() => updates.check()); });
handle("updates-forget", async () => { password.clear(); return true; });

handle("update-corpus", async e => wrap(async () => ({ pack: await updates.updateCorpus(p => send(e, "progress", p)) })));
handle("update-models", async () => wrap(async () => { const r = await updates.updateModels(); useCatalog(r.data); return { count: models.CATALOG.length }; }));

handle("install-language", async (e, lang) => {
  if (dlCtrl) return { ok: false, message: "Another download is running." };
  dlCtrl = new AbortController();
  try { return await wrap(async () => { await updates.installLanguage(lang, { signal: dlCtrl.signal, onProgress: p => send(e, "progress", p) }); return {}; }); }
  finally { dlCtrl = null; }
});
handle("remove-language", async (e, lang) => site.remove(lang));

// A newer Lodestone: downloaded into Downloads and checked, then handed to the
// system's own installer. A Mac opens the disk image (drag Lodestone onto
// Applications, Replace); Windows runs the setup; an AppImage is swapped in
// place. Lodestone quits first where the new version cannot replace it otherwise.
let appDownload = null;
handle("download-app", async e => {
  if (dlCtrl) return { ok: false, message: "Another download is running." };
  dlCtrl = new AbortController();
  try {
    return await wrap(async () => {
      appDownload = await updates.downloadApp(app.getPath("downloads"), { signal: dlCtrl.signal, onProgress: p => send(e, "progress", p) });
      return { version: appDownload.version, file: path.basename(appDownload.path) };
    });
  } finally { dlCtrl = null; }
});
handle("install-app", async () => {
  if (!appDownload || !fs.existsSync(appDownload.path)) return { ok: false, message: "The download is no longer there. Download it again." };
  const file = appDownload.path, kind = installerKind();
  if (kind === "linux-appimage") {
    // Written next to the running one and renamed over it: one step, same disk.
    const target = process.env.APPIMAGE, tmp = target + ".new";
    try {
      fs.copyFileSync(file, tmp); fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, target); fs.rmSync(file, { force: true });
      app.relaunch({ execPath: target }); app.quit();
      return { ok: true };
    } catch (err) {
      fs.rmSync(tmp, { force: true }); shell.showItemInFolder(file);
      return { ok: false, message: `Lodestone could not replace itself (${err.message}). The new version is in your Downloads folder.` };
    }
  }
  const failed = await shell.openPath(file);
  if (failed) { shell.showItemInFolder(file); return { ok: false, message: failed }; }
  if (kind !== "linux-deb") setTimeout(() => app.quit(), 1500);
  return { ok: true, quits: kind !== "linux-deb" };
});

// Phone

const phoneStatus = () => {
  const addresses = server.lanAddresses();
  const st = { lan: cfg.lan, port, addresses, paired: phoneAccess.paired() };
  if (cfg.lan && addresses[0]) {
    const p = phoneAccess.code();
    const base = `http://${addresses[0]}:${port}`;
    st.pair = { code: p.code, exp: p.exp, base, url: `lodestone://pair?u=${encodeURIComponent(base)}&c=${p.code}&n=${encodeURIComponent(computerName())}` };
  }
  return st;
};
handle("phone-status", async () => phoneStatus());
handle("unpair", async (e, id) => { phoneAccess.forget(id); return phoneStatus(); });
handle("set-lan", async (e, on) => {
  cfg.lan = !!on; saveCfg();
  await server.close();
  await startServer();
  return phoneStatus();
});
handle("qr", async (e, text) => require("qrcode").toDataURL(text, { margin: 1, width: 260, color: { dark: "#0a0a14", light: "#ffffff" } }));

// Telegram (from the phone window)

// The bot's pairing code (1.13.1): from a cryptographic source, good for thirty
// minutes and five tries, as the phone's code is; the window shows a new one
// when it has expired or been spent, while the bot is not yet paired.
const tgCode = () => ({ pairCode: String(require("crypto").randomInt(0, 1000000)).padStart(6, "0"), pairExp: Date.now() + 30 * 60 * 1000, pairTries: 0 });
const tgState = () => {
  const t = cfg.telegram;
  if (t?.token && !t.chatId && (!t.pairCode || Date.now() > (t.pairExp || 0) || (t.pairTries || 0) >= 5)) { Object.assign(t, tgCode()); saveCfg(); }
  return tgStateNow();
};
const tgStateNow = () => ({
  on: !!cfg.telegram?.token, paired: !!cfg.telegram?.chatId, pairCode: cfg.telegram?.pairCode || null,
  bot: telegram.me?.username || cfg.telegram?.bot || null, outreach: cfg.telegram?.outreach !== false,
  status: telegram.status, error: telegram.lastError, persisted: !!cfg.telegram?.token && cfg.telegram.token !== "session",
});
handle("tg-status", async () => tgState());
handle("tg-set-token", async (e, token) => {
  token = String(token || "").trim();
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error("That does not look like a bot token. @BotFather gives one like 123456789:AA… after /newbot.");
  telegram.stop();
  tgToken.session = token;
  const bot = await telegram.check().catch(err => { tgToken.session = null; throw new Error(`Telegram refused the token (${err.message}).`); });
  let enc = "session";
  try { if (safeStorage.isEncryptionAvailable()) enc = safeStorage.encryptString(token).toString("base64"); } catch {}
  cfg.telegram = { token: enc, bot, chatId: null, ...tgCode(), outreach: true, lastOutreach: 0 };
  saveCfg();
  telegram.start(); openBridge();
  return tgState();
});
handle("tg-outreach", async (e, on) => { cfg.telegram = { ...(cfg.telegram || {}), outreach: !!on }; saveCfg(); return tgState(); });
handle("tg-forget", async () => {
  telegram.stop(); tgToken.session = null; cfg.telegram = null; saveCfg();
  if (bridgeWin) bridgeWin.destroy();
  return tgState();
});

// The hidden Lodestone page answering for Telegram
const fromBridge = e => bridgeWin && e.sender === bridgeWin.webContents;
ipcMain.handle("bridge-ready", e => { if (fromBridge(e)) openBridge.resolve?.(true); });
ipcMain.handle("bridge-reply", (e, id, ok, payload) => {
  if (!fromBridge(e)) return;
  const p = bridgePending.get(id); if (!p) return;
  bridgePending.delete(id);
  ok ? p.resolve(payload) : p.reject(new Error(String(payload || "failed")));
});

// From Lodestone and the library

// Speech on this computer (1.13.2): whisper.cpp on Metal with Whisper large v3
// turbo, the engine and model Quarry uses too (whisperlocal.js, the same file in
// both apps; build-whisper.sh builds the engine). Where the engine is missing
// (a build without it), Whisper small in the page, as before.
const speechEngine = () => whisperLocal.findEngine(whisperLocal.engineCandidates({ resources: app.isPackaged ? process.resourcesPath : null, roots: [path.join(__dirname, "..")] }));
const speechDir = () => whisperLocal.modelDir(app.getPath("appData"));
const asrReady = () => (speechEngine() ? whisperLocal.ready(speechDir()) : speech.ready(asrRoot()));
const asrInfo = () => ({ asr: asrReady(), asrNative: !!speechEngine(), asrMB: speechEngine() ? whisperLocal.MB : Math.round(speech.SIZE / 1e6), asrLabel: speechEngine() ? whisperLocal.LABEL : "Whisper small" });
// Lodestone's vocabulary, as a sentence in the spoken language (app/js/asr-worker.js).
const SPEECH_VOCAB = {
  en: "I was reading Lodestone on Harmonism, a Harmonist reading of Ṛta, the Logos and Dharma, the Sushumna, Jing and Qi, and the Wisdom Canon.",
  fr: "J'ai lu Lodestone sur l'harmonisme, une lecture harmoniste du Ṛta, du Logos et du Dharma, de la Sushumna, du Jing et du Qi, et du Canon de la sagesse.",
  es: "Leía Lodestone sobre el harmonismo, una lectura harmonista del Ṛta, del Logos y del Dharma, de la Sushumna, del Jing y del Qi, y del Canon de la sabiduría.",
  pt: "Eu lia Lodestone sobre o harmonismo, uma leitura harmonista do Ṛta, do Logos e do Dharma, da Sushumna, do Jing e do Qi, e do Cânone da sabedoria.",
  de: "Ich las Lodestone über den Harmonismus, eine harmonistische Lesart von Ṛta, Logos und Dharma, der Sushumna, von Jing und Qi und dem Kanon der Weisheit.",
};
handle("asr-native", async (e, samples, language) => {
  const engine = speechEngine();
  if (!engine) return { ok: false, message: "The speech engine is not in this build." };
  if (!whisperLocal.ready(speechDir())) return { ok: false, message: "The speech model is not downloaded yet." };
  try {
    const audio = samples instanceof Float32Array ? samples : new Float32Array(samples?.buffer || samples || []);
    const r = await whisperLocal.transcribe({ engine, dir: speechDir(), audio, language: language || "", vocabulary: SPEECH_VOCAB });
    return { ok: true, text: r.text, language: r.language };
  } catch (err) { return { ok: false, message: String(err.message || err) }; }
}, { app: true });

handle("info", async () => {
  const version = app.getVersion();
  if (cfg.remote) { const c = remote.normalize(cfg.remote); return { label: `${c.model} · ${remoteWhere()}`, version, remote: { host: remoteWhere(), model: c.model }, vision: visionState(), ...asrInfo() }; }
  if (cfg.upstream) return { label: `Your model server (${cfg.upstream})`, version, ...asrInfo() };
  const m = chosenModel();
  return { label: m.label, id: m.id, version, vision: visionState(), ...asrInfo() };
}, { app: true });

// Attachments (Lodestone's page): the speech model and a model's vision projector,
// each downloaded once, hash-checked, when the practitioner first needs it.
handle("asr-download", async e => {
  if (asrReady()) return { ok: true };
  if (dlCtrl) return { ok: false, message: "Another download is running." };
  dlCtrl = new AbortController();
  try {
    if (speechEngine()) { await whisperLocal.download(speechDir(), { fetch: (u, init) => net.fetch(u, init), signal: dlCtrl.signal, onProgress: p => send(e, "progress", { ...p, what: "speech" }) }); return { ok: true }; }
    await speech.download(asrRoot(), { fetch: (u, init) => net.fetch(u, init), downloadModel, signal: dlCtrl.signal, onProgress: p => send(e, "progress", { ...p, what: "speech" }) });
    return { ok: true };
  } catch (err) { return { ok: false, message: err.message }; }
  finally { dlCtrl = null; }
}, { app: true });
handle("vision-download", async e => {
  const m = chosenModel();
  if (cfg.remote || cfg.upstream || !m?.mmproj) return { ok: false, message: "This model has no vision to add." };
  if (dlCtrl) return { ok: false, message: "Another download is running." };
  dlCtrl = new AbortController();
  try {
    if (!hasMmproj(m)) await downloadModel({
      fetch: (u, init) => net.fetch(u, init), files: [m.mmproj], urlFor: p => models.url(m.mmproj.repo, p),
      dir: dirOf(m), signal: dlCtrl.signal, onProgress: p => send(e, "progress", { ...p, what: "vision" }),
    });
  } catch (err) { dlCtrl = null; return { ok: false, message: err.message }; }
  dlCtrl = null;
  // The engine has to load the projector: a few seconds' restart.
  try { await startEngine(m, { mmproj: mmprojOf(m) }); return { ok: true }; }
  catch (err) { engineError = { message: err.message, detail: err.detail || "" }; return { ok: false, message: `The model could not restart with its vision: ${err.message}` }; }
}, { app: true });
// Formats the page cannot open (old Word, HEIC, TIFF…), converted on this computer (src/convert.js).
handle("convert-file", async (_e, name, bytes) => {
  if (typeof name !== "string" || !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return null;
  return require("./convert").convert(name.slice(0, 255), bytes);
}, { app: true });
handle("open-models", async () => { showLauncher("models"); }, { app: true });
handle("open-updates", async () => { showLauncher("library"); }, { app: true });
handle("open-library", async (e, lang) => { showLauncher("library", lang && LANGS[lang] ? { lang } : {}); }, { app: true });
handle("open-phone", async () => { openPhoneWindow(); }, { app: true });
handle("set-theme", async (e, mode) => {
  if (mode !== "light" && mode !== "dark") return;
  if (cfg.theme !== mode) { cfg.theme = mode; saveCfg(); }
  win?.setBackgroundColor(themeBg());
}, { app: true });
handle("web-lookup", async (e, question) => {
  if (typeof question !== "string" || !question.trim()) return [];
  return lookUp((u, init) => net.fetch(u, init), question, { braveKey: cfg.braveKey || null });
}, { app: true });

// ─── Menu ───────────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === "darwin";
  const ensure = fn => () => { if (!win) createWindow(); fn(); };
  const lodestone = [
    { label: "Talk with Lodestone", accelerator: "CmdOrCtrl+1", click: ensure(openApp) },
    { label: "The Library", accelerator: "CmdOrCtrl+2", click: ensure(openLibraryHome) },
    { label: "Your Path", accelerator: "CmdOrCtrl+3", click: ensure(() => openInApp("path")) },
    { label: "Life Book", accelerator: "CmdOrCtrl+4", click: ensure(() => openInApp("lifebook")) },
    { type: "separator" },
    { label: "Model…", click: ensure(() => showLauncher("models")) },
    { label: "Library Languages and Updates…", click: ensure(() => showLauncher("library")) },
    ...(isMac ? [] : [{ label: "Check for Updates…", click: ensure(() => showLauncher("library")) }]),
    { label: "Use from Your Phone…", click: openPhoneWindow },
  ];
  const nav = [
    { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: () => win?.webContents.navigationHistory.goBack() },
    { label: "Forward", accelerator: isMac ? "Cmd+]" : "Alt+Right", click: () => win?.webContents.navigationHistory.goForward() },
  ];
  const template = [
    ...(isMac
      ? [{ label: APP_NAME, submenu: [{ role: "about" }, { label: "Check for Updates…", click: ensure(() => showLauncher("library")) }, { type: "separator" }, ...lodestone, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }]
      : [{ label: "Lodestone", submenu: [...lodestone, { type: "separator" }, { role: "quit" }] }]),
    { role: "editMenu" },
    { label: "View", submenu: [...nav, { type: "separator" }, { role: "reload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, { type: "separator" }, { role: "toggleDevTools" }] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } else createWindow(); });

/**
 * macOS: an app opened from anywhere but Applications — the disk image, or
 * Downloads — offers to move itself there, and relaunches from its new place.
 * Asked on every such opening; "Not now" holds until the next version. (1.1
 * asked once for ever, and 1.2 shares its settings, so 1.1 users were never
 * asked again.)
 */
async function offerMoveToApplications() {
  if (process.platform !== "darwin" || !app.isPackaged) return;
  try { if (app.isInApplicationsFolder()) return; } catch { return; }
  if (cfg.declinedMove === app.getVersion()) return;
  const { response } = await dialog.showMessageBox({
    type: "question", buttons: ["Move to Applications", "Not now"], defaultId: 0, cancelId: 1,
    message: "Move Lodestone to your Applications folder?",
    detail: "It will then be with your other apps, in Launchpad and Spotlight. An earlier copy there is replaced.",
  });
  if (response !== 0) { cfg.declinedMove = app.getVersion(); saveCfg(); return; }
  try { app.moveToApplicationsFolder(); }
  catch (e) { dialog.showErrorBox(APP_NAME, "Lodestone could not move itself into Applications. Drag it there from this window instead.\n\n" + (e.message || e)); }
}

/** macOS: the app was called "MunAI Offline" until 1.2. Its models and conversations are already here. */
async function offerRemoveOldApp() {
  if (process.platform !== "darwin" || !app.isPackaged || cfg.askedOldApp) return;
  const old = "/Applications/MunAI Offline.app";
  if (!fs.existsSync(old)) return;
  cfg.askedOldApp = true; saveCfg();
  const { response } = await dialog.showMessageBox({
    type: "question", buttons: ["Move it to the Bin", "Keep it"], defaultId: 0, cancelId: 1,
    message: "The earlier “MunAI Offline” app is still in Applications.",
    detail: "Lodestone replaces it and has taken over its model, conversations and memory. The old app is no longer needed.",
  });
  if (response === 0) { try { await shell.trashItem(old); } catch {} }
}

/**
 * The English library that came with this version, unpacked into the data
 * folder on its first launch. A newer English pack already downloaded through
 * Updates is kept.
 */
function libraryToPlace() {
  if (!app.isPackaged) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "site", "site-en.json"), "utf8")); } catch { return null; }
  const have = site.info("en");
  return have && (have.sha256 === meta.sha256 || (have.built_at || "") >= meta.built_at) ? null : meta;
}
async function ensureLibrary(meta) {
  const archive = path.join(process.resourcesPath, "site", "site-en.tar.gz");
  try { await site.install("en", archive, { ...meta, shipped: true }); }
  catch (e) { dialog.showErrorBox(APP_NAME, "Lodestone could not place its library on this computer.\n\n" + (e.message || e)); }
}

// What a page may ask the browser for (1.12, after Lode): Lodestone's own pages
// the microphone (dictation, never the camera), notifications and copying;
// nothing for any other page, the hidden Telegram page included.
const PAGE_PERMS = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen"]);
function pagePermission(wc, permission, details = {}) {
  const url = details.requestingUrl || details.securityOrigin || wc?.getURL?.() || "";
  if (!url.startsWith(origin() + "/") && url !== origin()) return false;
  if (bridgeWin && wc === bridgeWin.webContents) return false;
  if (!PAGE_PERMS.has(permission)) return false;
  if (permission === "media") {
    const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
    return types.length > 0 && types.every(t => t === "audio");
  }
  return true;
}

app.whenReady().then(async () => {
  loadCfg();
  migrateRetiredRemote();
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(pagePermission(wc, permission, details)));
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
    permission === "media" ? (requestingOrigin === origin() || String(requestingOrigin).startsWith(origin() + "/")) && (!details?.mediaType || details.mediaType === "audio")
      : pagePermission(wc, permission, { requestingUrl: requestingOrigin }));
  migrateModels();
  loadStoredCatalog();
  await offerMoveToApplications();
  await offerRemoveOldApp();
  // A new version carries a new web app; the previous one's service worker and
  // HTTP cache would serve it from cache for a launch — 1.5.1's docked
  // conversations ran hidden behind exactly that. Both are dropped once per
  // update. The corpus, conversations and memory live elsewhere and are untouched.
  if (cfg.appVersion !== app.getVersion()) {
    try { await session.defaultSession.clearStorageData({ storages: ["serviceworkers"] }); } catch {}
    try { await session.defaultSession.clearCache(); } catch {}
    cfg.appVersion = app.getVersion(); saveCfg();
  }
  if (!fs.existsSync(path.join(webRoot, "corpus", "corpus.json")))
    dialog.showErrorBox(APP_NAME, "The articles are missing from this installation. Please download Lodestone again from harmonism.io.");
  // A few seconds, once per version: the window says so meanwhile.
  const toPlace = libraryToPlace();
  buildMenu();
  if (toPlace) { createWindow("placing"); await ensureLibrary(toPlace); }
  await startServer();
  if (win) showLauncher(); else createWindow();
  if (cfg.telegram?.token === "session") { cfg.telegram = null; saveCfg(); }   // a token kept for one session only
  if (cfg.telegram?.token) { telegram.start(); openBridge(); }
  if (cfgLocked) dialog.showMessageBox({ type: "warning", message: "Lodestone could not read its settings.", detail: "Another program may be holding the file. Lodestone started with its defaults and will not save over your settings this time; quit and open it again to use them." }).catch(() => {});
  if (cfgUnreadable) dialog.showMessageBox({ type: "warning", message: "Lodestone's settings could not be read.", detail: `They were kept aside as ${path.basename(cfgUnreadable)} in Lodestone's data folder, and Lodestone started from its defaults. The model downloaded on this computer is still there; a rented model's key, the Telegram bot and the paired phones need setting up again.` }).catch(() => {});
});

app.on("activate", () => { if (!win) createWindow(); });
app.on("window-all-closed", () => {
  // On a Mac the app stays in the Dock, which also keeps a phone connected.
  if (process.platform !== "darwin") app.quit();
});
let quitting = false;
app.on("before-quit", e => {
  if (quitting) return;
  e.preventDefault(); quitting = true;
  telegram.stop();
  Promise.allSettled([engine.stop(), server.close()]).finally(() => app.quit());
});
