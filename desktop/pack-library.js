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
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(src).filter(f => f !== ".pack.json" && f !== ".DS_Store");
tar.c({ gzip: { level: 9 }, cwd: src, file: path.join(out, "site-en.tar.gz"), portable: true,
        filter: p => !p.endsWith(".DS_Store"), sync: true }, files);
const { lang, ...rest } = meta;
fs.writeFileSync(path.join(out, "site-en.json"), JSON.stringify(rest));
console.log(`site-en.tar.gz: ${(fs.statSync(path.join(out, "site-en.tar.gz")).size / 1e6).toFixed(0)} MB, built ${meta.built_at}`);
