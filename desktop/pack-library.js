// pack-library.js — the English library, packed as one archive for the installers.
//
// The library ships as a single site-en.tar.gz inside the app, not as 5,678
// loose files, and the app unpacks it into its data folder on first launch
// (main.js, ensureLibrary). A signed Mac app seals every file in its bundle by
// name, and filenames with accents (…reading-žižek, …gabor-maté) can be stored
// on a Mac in a different Unicode form than the one signed on Linux; macOS then
// calls the whole app damaged. One archive has one plain name.
//
// Run before electron-builder (the dist scripts and build-mac.sh do).
const fs = require("fs");
const path = require("path");
const tar = require("tar");

const src = path.join(__dirname, "site-en");
const out = path.join(__dirname, "build-res");
const meta = JSON.parse(fs.readFileSync(path.join(src, ".pack.json"), "utf8"));
// 1.17.3 shipped the 22 Oct library because site-en/ was never refreshed: refuse
// to pack a library older than the latest published pack in ../.site-packs/.
const idx = path.join(__dirname, "..", ".site-packs", "index.json");
if (fs.existsSync(idx) && !process.env.LODESTONE_ALLOW_STALE_LIBRARY) {
  const latest = JSON.parse(fs.readFileSync(idx, "utf8")).packs.en;
  if (latest && latest.sha256 !== meta.sha256) {
    console.error(`site-en/ is built ${meta.built_at}; ../.site-packs/en.tar.gz is built ${latest.built_at}.\n` +
      "Unpack the latest pack into site-en/ (README, Build) or set LODESTONE_ALLOW_STALE_LIBRARY=1.");
    process.exit(1);
  }
}
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(src).filter(f => f !== ".pack.json" && f !== ".DS_Store");
tar.c({ gzip: { level: 9 }, cwd: src, file: path.join(out, "site-en.tar.gz"), portable: true,
        filter: p => !p.endsWith(".DS_Store"), sync: true }, files);
const { lang, ...rest } = meta;
fs.writeFileSync(path.join(out, "site-en.json"), JSON.stringify(rest));
console.log(`site-en.tar.gz: ${(fs.statSync(path.join(out, "site-en.tar.gz")).size / 1e6).toFixed(0)} MB, built ${meta.built_at}`);
