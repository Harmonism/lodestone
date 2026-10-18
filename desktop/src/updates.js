// updates.js — bring the corpus, the doctrinal backbone and the library up to date
// from harmonism.io, when the practitioner asks and never otherwise.
//
//   /lodestone-app/corpus/runtime.json   corpus pack and backbone (built on every deploy)
//   /lodestone-app/corpus/corpus.json, embeddings.json, embeddings.bin
//   /lodestone-app/site/index.json       the library packs, one per language
//   /lodestone-app/download/latest.json  the newest version of the app itself
//   /lodestone-app/models/catalog.json   the models the app offers
//
// Corpus files land in <userData>/updates/corpus and are served in place of the
// ones the app shipped with; the Lodestone page takes them in on its next opening.
// While harmonism.io sits behind its beta password, the practitioner enters it
// once; it is kept encrypted with the operating system's keychain.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { download } = require("./download");

const ORIGIN = process.env.MUNAI_UPDATE_ORIGIN || "https://harmonism.io";
// /munai-offline/ until October 17, 2026; the site redirects it, so
// versions built before still update.
const BASE = ORIGIN + "/lodestone-app/";
const CORPUS_FILES = ["runtime.json", "corpus.json", "embeddings.json", "embeddings.bin"];

class NeedsLogin extends Error { constructor() { super("harmonism.io asked for its password."); this.needsLogin = true; } }

class Updates {
  /** @param {{ fetch, dir: string, bundledCorpus: string, site: import("./site").Site, getAuth: () => string|null, appVersion: string, platform: string }} o */
  constructor({ fetch, dir, bundledCorpus, site, getAuth, appVersion, platform, catalog }) {
    this.fetch = fetch; this.dir = dir; this.bundledCorpus = bundledCorpus; this.site = site; this.getAuth = getAuth;
    this.catalog = catalog;   // { validate, hash, bundledHash } from models.js
    this.catalogFile = path.join(dir, "models.json");
    this.appVersion = appVersion; this.platform = platform;
    this.corpusDir = path.join(dir, "corpus");
  }

  headers() {
    const a = this.getAuth();
    return a ? { Authorization: "Basic " + a } : {};
  }

  async get(p, { json = true } = {}) {
    const res = await this.fetch(BASE + p, { headers: this.headers(), cache: "no-store" });
    if (res.status === 401) throw new NeedsLogin();
    if (!res.ok) throw new Error(`harmonism.io answered ${res.status} for ${p}.`);
    return json ? res.json() : res;
  }

  /** The corpus folder to serve: the updated one when complete, else the shipped one. */
  corpusRoot() {
    return CORPUS_FILES.slice(0, 2).every(f => fs.existsSync(path.join(this.corpusDir, f))) ? this.corpusDir : this.bundledCorpus;
  }

  localRuntime() {
    try { return JSON.parse(fs.readFileSync(path.join(this.corpusRoot(), "runtime.json"), "utf8")).pack; } catch { return null; }
  }

  /** Ask harmonism.io what is newer. Downloads nothing. */
  async check() {
    const soft = p => this.get(p).catch(e => { if (e.needsLogin) throw e; return null; });
    const [runtime, index, latest, cat] = await Promise.all([this.get("corpus/runtime.json"), soft("site/index.json"), soft("download/latest.json"), soft("models/catalog.json")]);
    const local = this.localRuntime();
    const corpus = {
      local, remote: runtime.pack,
      newer: !local || runtime.pack.corpus_hash !== local.corpus_hash,
    };
    const site = {};
    for (const [lang, p] of Object.entries(index?.packs || {})) {
      const have = this.site.info(lang);
      site[lang] = { ...p, installed: !!have, newer: !!have && have.sha256 !== p.sha256 };
    }
    let models = null;
    if (cat?.catalog_hash) {
      const local = this.localCatalog();
      models = { remote: { built_at: cat.built_at || null, count: Array.isArray(cat.models) ? cat.models.length : 0 }, newer: cat.catalog_hash !== local.hash };
    }
    return { corpus, site, siteAvailable: !!index, app: this.appFrom(latest), models };
  }

  /** The model list in use: a fetched one when present and sound, else the one shipped. */
  storedCatalog() {
    // A list fetched under another version of the app is set aside: a new version ships its own, newer list.
    try { const d = JSON.parse(fs.readFileSync(this.catalogFile, "utf8")); if (d.app_version !== this.appVersion) return null; return { data: this.catalog.validate(d), hash: d.catalog_hash, built_at: d.built_at || null }; }
    catch { return null; }
  }
  localCatalog() {
    const s = this.storedCatalog();
    return s ? { hash: s.hash, built_at: s.built_at, updated: true } : { hash: this.catalog.bundledHash(), built_at: null, updated: false };
  }

  /** Fetch the newer model list, check it whole and field by field, keep it. */
  async updateModels() {
    const d = await this.get("models/catalog.json");
    const data = this.catalog.validate(d);
    if (this.catalog.hash(data) !== d.catalog_hash) throw new Error("The model list arrived damaged. Try again.");
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.catalogFile + ".new", JSON.stringify({ ...d, models: data.models, defaults: data.defaults, recommended: data.recommended, app_version: this.appVersion }));
    fs.renameSync(this.catalogFile + ".new", this.catalogFile);
    return { data, built_at: d.built_at || null };
  }

  /** What latest.json says about this computer's installer, or null when it says nothing. */
  appFrom(latest) {
    // Each installer carries its own version: the platforms are not always rebuilt together.
    const f = latest?.files?.[this.platform], v = f?.version || latest?.version;
    if (!v || !f?.name || !f.size || !f.sha256) return { current: this.appVersion, latest: null, newer: false };
    return { current: this.appVersion, latest: v, released: f.released || latest.released || null,
      newer: newerVersion(v, this.appVersion), file: f.name, size: f.size, sha256: f.sha256 };
  }

  /**
   * Download the newer installer into `destDir` (the Downloads folder), checked
   * against latest.json. Returns its path; installing it is up to the caller.
   */
  async downloadApp(destDir, { onProgress = () => {}, signal } = {}) {
    const a = this.appFrom(await this.get("download/latest.json"));
    if (!a.newer) throw new Error("This is already the newest Lodestone.");
    const dest = path.join(destDir, a.file.replace(/^Lodestone-/, `Lodestone-${a.latest}-`));
    // One left in Downloads by an earlier attempt is used only if it checks out.
    if (fs.existsSync(dest) && !(await sameHash(dest, a.sha256))) fs.rmSync(dest, { force: true });
    if (!fs.existsSync(dest)) await download({
      fetch: (u, init) => this.fetch(u, { ...init, headers: { ...(init?.headers || {}), ...this.headers() } }),
      url: BASE + "download/" + a.file, dest, size: a.size, sha256: a.sha256, signal,
      onProgress: e => onProgress({ ...e, app: true }),
    });
    return { path: dest, version: a.latest };
  }

  /** Download the newer corpus pack. The page picks it up the next time it opens. */
  async updateCorpus(onProgress = () => {}) {
    const staging = this.corpusDir + ".new";
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const runtime = await this.get("corpus/runtime.json");
    let emb = null;
    try { emb = await this.get("corpus/embeddings.json"); } catch (e) { if (e.needsLogin) throw e; }
    const files = ["corpus.json", ...(emb && emb.corpus_hash === runtime.pack.corpus_hash ? ["embeddings.bin"] : [])];
    let i = 0;
    for (const f of files) {
      const res = await this.get("corpus/" + f, { json: false });
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(path.join(staging, f), buf);
      onProgress({ phase: "corpus", done: ++i, total: files.length + 1, file: f });
    }
    // The pack's own hash is the proof it arrived whole.
    const corpusBytes = fs.readFileSync(path.join(staging, "corpus.json"));
    const got = crypto.createHash("sha256").update(corpusBytes).digest("hex").slice(0, runtime.pack.corpus_hash.length);
    if (got !== runtime.pack.corpus_hash) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error("The corpus arrived damaged. Try again.");
    }
    fs.writeFileSync(path.join(staging, "runtime.json"), JSON.stringify(runtime));
    if (emb && files.includes("embeddings.bin")) fs.writeFileSync(path.join(staging, "embeddings.json"), JSON.stringify(emb));
    fs.rmSync(this.corpusDir, { recursive: true, force: true });
    fs.renameSync(staging, this.corpusDir);
    onProgress({ phase: "corpus", done: files.length + 1, total: files.length + 1 });
    return runtime.pack;
  }

  /** Download and install one language of the library (or a newer English). */
  async installLanguage(lang, { onProgress = () => {}, signal } = {}) {
    const index = await this.get("site/index.json");
    const p = index.packs?.[lang];
    if (!p) throw new Error("That language is not published yet.");
    const archive = path.join(this.dir, `site-${lang}.tar.gz`);
    await download({
      fetch: (u, init) => this.fetch(u, { ...init, headers: { ...(init?.headers || {}), ...this.headers() } }),
      url: BASE + "site/" + p.file, dest: archive, size: p.size, sha256: p.sha256, signal,
      onProgress: e => onProgress({ ...e, lang }),
    });
    onProgress({ phase: "unpack", lang, done: 0, total: 1 });
    await this.site.install(lang, archive, { sha256: p.sha256, built_at: p.built_at, files: p.files, size: p.size });
    fs.rmSync(archive, { force: true });
    onProgress({ phase: "done", lang, done: 1, total: 1 });
  }
}

function sameHash(file, sha256) {
  return new Promise(resolve => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", d => h.update(d)).on("error", () => resolve(false)).on("end", () => resolve(h.digest("hex") === sha256));
  });
}

/** "1.10.0" > "1.9.2": compares numbers, not text. */
function newerVersion(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

module.exports = { Updates, NeedsLogin, ORIGIN, newerVersion };
