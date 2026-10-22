// site.js — the harmonism.io library on this computer.
//
// The English site ships inside the app as one archive (resources/site/
// site-en.tar.gz) and is unpacked into the app's data folder (site/en/) on first
// launch. Other languages, and newer English packs, are downloaded on request
// into the same folder. Packs are built by
// tools/build-site-packs.py and published at /lodestone-app/site/.

const fs = require("fs");
const path = require("path");
const tar = require("tar");

const LANGS = {
  en: "English", fr: "Français", es: "Español", ar: "العربية", pt: "Português",
  de: "Deutsch", zh: "中文", ja: "日本語", hi: "हिन्दी", ru: "Русский",
};

class Site {
  /** @param {{ bundled: string|null, userDir: string }} o  bundled = English read in place (development only); userDir = <userData>/site */
  constructor({ bundled, userDir }) {
    this.bundled = bundled; this.userDir = userDir;
    fs.mkdirSync(userDir, { recursive: true });
  }

  /** The folder serving a language, or null when it is not on this computer. */
  root(lang) {
    const user = path.join(this.userDir, lang);
    if (fs.existsSync(path.join(user, ".pack.json"))) return user;
    if (lang === "en" && this.bundled && fs.existsSync(this.bundled)) return this.bundled;
    return null;
  }

  info(lang) {
    const r = this.root(lang);
    if (!r) return null;
    // "shipped": the library that came with the app, whether read in place
    // (a development run) or unpacked from the app's archive on first launch.
    try { const m = JSON.parse(fs.readFileSync(path.join(r, ".pack.json"), "utf8")); return { ...m, shipped: r === this.bundled || !!m.shipped }; }
    catch { return { shipped: r === this.bundled }; }
  }

  installed() {
    return Object.keys(LANGS).filter(l => this.root(l)).map(l => ({ lang: l, name: LANGS[l], ...this.info(l) }));
  }

  /**
   * Resolve a URL path to a file. Returns { file } or { missingLang } or null.
   * /fr/… belongs to the French pack; everything else to the English one.
   */
  resolve(urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath.split("?")[0]); } catch { return null; }
    const seg = p.split("/")[1] || "";
    const lang = seg !== "en" && LANGS[seg] ? seg : "en";
    const root = this.root(lang);
    if (!root) return { missingLang: lang };
    // Language packs hold their own prefix (fr/…); the English pack sits at the root.
    const base = lang === "en" ? root : path.dirname(root);
    const clean = path.normalize(p).replace(/^([/\\])+/, "");
    const tries = clean.endsWith("/") || clean === "" ? [clean + "index.html"]
      : path.extname(clean) ? [clean] : [clean, clean + "/index.html", clean + ".html"];
    for (const t of tries) {
      const file = path.join(base, t);
      if (!file.startsWith(base + path.sep) && file !== base) return null;
      try { if (fs.statSync(file).isFile()) return { file, lang }; } catch {}
    }
    return null;
  }

  /** Unpack a downloaded pack (already verified) and put it in place of the old one. */
  async install(lang, archive, meta) {
    // Clearing a large tree on macOS can fail with ENOTEMPTY or EBUSY while
    // Spotlight or another process touches it: retry, and never let a leftover
    // stop the new library from going in place.
    const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    const tidy = (p) => { try { rm(p); } catch (e) { console.warn(`[library] could not clear ${path.basename(p)} (${e.code || e.message}); left for later`); } };
    fs.mkdirSync(this.userDir, { recursive: true });
    for (const n of fs.readdirSync(this.userDir)) if (/^\.(old|staging)-[a-z]+-\d+$/.test(n)) tidy(path.join(this.userDir, n));
    let staging = path.join(this.userDir, `.staging-${lang}`);
    tidy(staging);
    if (fs.existsSync(staging)) staging += `-${Date.now()}`;
    fs.mkdirSync(staging, { recursive: true });
    await tar.x({ file: archive, cwd: staging, strict: true, preservePaths: false });
    const unpacked = lang === "en" ? staging : path.join(staging, lang);
    if (!fs.existsSync(path.join(unpacked, "index.html"))) throw new Error("The downloaded library pack is incomplete.");
    fs.writeFileSync(path.join(unpacked, ".pack.json"), JSON.stringify({ lang, ...meta, installed_at: new Date().toISOString() }));
    const dest = path.join(this.userDir, lang);
    let old = path.join(this.userDir, `.old-${lang}`);
    tidy(old);
    if (fs.existsSync(old)) old += `-${Date.now()}`;   // a stubborn leftover is swept on a later install
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(unpacked, dest);
    tidy(old);
    tidy(staging);
  }

  remove(lang) {
    if (lang === "en") return false; // the shipped English library stays
    if (!Object.prototype.hasOwnProperty.call(LANGS, lang)) return false;   // a language Lodestone knows, never a path (1.13.1)
    fs.rmSync(path.join(this.userDir, lang), { recursive: true, force: true });
    return true;
  }
}

module.exports = { Site, LANGS };
