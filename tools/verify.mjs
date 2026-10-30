#!/usr/bin/env node
// verify.mjs — check a copy of Lodestone against what was published.
//
//   node tools/verify.mjs web     [--url https://lodestone.harmonism.io/app/] [--tag web-vN] [--repo DIR]
//   node tools/verify.mjs desktop [PATH]                                       [--tag desktop-vX.Y.Z] [--repo DIR]
//
// web      fetches every file of the web app as lodestone.harmonism.io serves it now
//          and compares it, byte for byte (SHA-256), with the release it claims to be
//          (the version in its sw.js names the tag, web-vN).
// desktop  reads an installed Lodestone Desktop (PATH: Lodestone.app on a Mac, or the
//          folder that holds app.asar; found by itself in the usual places) and compares
//          its interface (web/), its own code (inside app.asar), its third-party
//          packages (by version, against the lock file) and its model engine (engine/)
//          with the release its version names (desktop-vX.Y.Z).
//
// What it is compared with: the release's SHA256SUMS, fetched from Codeberg and from
// GitHub, two hosts Harmonia does not run, which must agree. With --repo DIR, a clone
// checked out at the tag instead: its files are hashed here, so nothing is taken on
// trust from SHA256SUMS either. Node 18 or later; nothing to install. Exit code 0 when
// everything checked matches, 1 when something differs, 2 when it could not check.
//
// What it cannot tell you: that the release itself holds nothing harmful (AUDIT.md
// is for that), or that the server shows everyone the same files at every hour (run
// it again, from elsewhere, when it matters).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const HOSTS = {
  Codeberg: tag => `https://codeberg.org/harmonism/lodestone/raw/tag/${tag}/`,
  GitHub: tag => `https://raw.githubusercontent.com/Harmonism/lodestone/refs/tags/${tag}/`,
};
const args = process.argv.slice(2);
const mode = args[0];
const opt = k => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : null; };
const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] || "").startsWith("--"))[0] || null;
if (!["web", "desktop"].includes(mode)) {
  console.log("Usage:\n  node tools/verify.mjs web [--url URL] [--tag web-vN] [--repo DIR]\n  node tools/verify.mjs desktop [PATH] [--tag desktop-vX.Y.Z] [--repo DIR]");
  process.exit(2);
}

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const say = (...a) => console.log(...a);
const fail = msg => { console.error("✘ " + msg); process.exit(2); };

/** path → hash, from SHA256SUMS text. */
function parseSums(text) {
  const m = new Map();
  for (const line of String(text).split("\n")) { const r = line.match(/^([0-9a-f]{64}) [ *]?(.+)$/); if (r) m.set(r[2], r[1]); }
  return m;
}

async function getText(url) {
  const r = await fetch(url, { cache: "no-store", redirect: "follow" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

/** The published hashes for a tag: both hosts agreeing, or a local checkout hashed here. */
async function released(tag) {
  const repo = opt("--repo");
  if (repo) {
    const root = path.resolve(repo), sums = new Map();
    // Only what a copy of Lodestone is made of, with what publishing leaves out left out here too,
    // so a working folder gives the same list as a clone.
    const SKIP = /^(app\/corpus|app\/vendor\/models\/.*\.onnx$|desktop\/(node_modules|dist|release|release-old|build-res|site-en|keys)|desktop\/engines\/[^/]+\/)|(^|\/)(\.DS_Store|node_modules)$|\.bak-/;
    const walk = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(root, p).split(path.sep).join("/");
      if (SKIP.test(rel) || SKIP.test(rel + "/")) continue;
      if (e.isDirectory()) walk(p); else if (e.isFile()) sums.set(rel, sha(fs.readFileSync(p)));
    } };
    walk(path.join(root, "app")); walk(path.join(root, "desktop"));
    say(`Release: ${tag}, from the files of ${root} (hashed here).`);
    const own = path.join(root, "SHA256SUMS");
    if (fs.existsSync(own)) {
      const listed = parseSums(fs.readFileSync(own, "utf8")); let off = 0;
      for (const [p, h] of listed) if ((p.startsWith("app/") || p.startsWith("desktop/")) && sums.has(p) && sums.get(p) !== h) off++;
      say(off ? `  ✘ its SHA256SUMS disagrees with its own files in ${off} place(s)` : "  ✔ its SHA256SUMS agrees with its files");
    }
    return { sums, raw: p => fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), "utf8") : null };
  }
  const got = {};
  for (const [name, base] of Object.entries(HOSTS)) {
    try { got[name] = await getText(base(tag) + "SHA256SUMS"); } catch (e) { got[name] = null; say(`  · ${name}: not reached (${e.message})`); }
  }
  const texts = Object.values(got).filter(Boolean);
  if (!texts.length) fail(`No host had ${tag}/SHA256SUMS. Is the tag published? (Releases before tagging began cannot be checked this way: use --repo on a clone at the matching commit.)`);
  if (texts.length === 2 && texts[0] !== texts[1]) fail("Codeberg and GitHub hold different SHA256SUMS for this tag. Do not trust either; report it.");
  say(`Release: ${tag}, SHA256SUMS from ${Object.entries(got).filter(([, t]) => t).map(([n]) => n).join(" and ")}${texts.length === 2 ? ", identical" : " only"}.`);
  const ok = Object.entries(got).find(([, t]) => t)[0];
  return { sums: parseSums(texts[0]), raw: async p => { try { return await getText(HOSTS[ok](tag) + p); } catch { return null; } } };
}

function report(rows, notes) {
  const unserved = rows.filter(r => r.state === "unserved");
  if (unserved.length) { notes = [`${unserved.length} .svg file(s) not compared: the host serves every .svg request as a .png, and the app uses none of them (its marks are drawn inline).`, ...notes]; rows = rows.filter(r => r.state !== "unserved"); }
  const bad = rows.filter(r => r.state !== "same");
  say("");
  for (const r of bad) say(`  ✘ ${r.state.padEnd(9)} ${r.path}${r.note ? "  — " + r.note : ""}`);
  say(`\n${rows.length - bad.length} of ${rows.length} files identical to the release.`);
  for (const n of notes) say("  · " + n);
  say(bad.length ? "\nRESULT: DIFFERS from the release. Do not rely on this copy until you know why." : "\nRESULT: identical to the release, for everything checked.");
  process.exit(bad.length ? 1 : 0);
}

// ─── the web app ──────────────────────────────────────────────────────────────
async function web() {
  let url = opt("--url") || "https://lodestone.harmonism.io/app/";
  if (!url.endsWith("/")) url += "/";
  const sw = await getText(url + "sw.js").catch(e => fail(`Could not fetch ${url}sw.js (${e.message}).`));
  const n = (sw.match(/const VERSION = "[^"]*?-v(\d+)"/) || [])[1];
  const tag = opt("--tag") || (n ? `web-v${n}` : null);
  if (!tag) fail("This sw.js names no version; give --tag.");
  say(`Checking ${url} (it says it is shell v${n || "?"}).`);
  const { sums } = await released(tag);
  const files = [...sums.keys()].filter(p => p.startsWith("app/") && !p.startsWith("app/corpus/")).sort();
  const rows = [];
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < files.length) {
      const p = files[next++], u = url + p.slice(4).split("/").map(encodeURIComponent).join("/");
      try {
        // A redirect is not followed: a file answered from elsewhere is not the release's file.
        const r = await fetch(u, { cache: "no-store", redirect: "manual" });
        const moved = r.status >= 300 && r.status < 400;
        // The host rewrites .svg requests (its firewall's rule), so an .svg is never served as itself;
        // the app draws its marks inline in index.html.
        if (p.endsWith(".svg") && (moved || r.status === 404 || /png/.test(r.headers.get("content-type") || ""))) { rows.push({ path: p, state: "unserved" }); continue; }
        if (r.status === 404 || moved) { rows.push({ path: p, state: "missing", note: moved ? `sent elsewhere (${r.headers.get("location") || r.status})` : undefined }); continue; }
        if (!r.ok) { rows.push({ path: p, state: "unreached", note: String(r.status) }); continue; }
        const h = sha(Buffer.from(await r.arrayBuffer()));
        rows.push({ path: p, state: h === sums.get(p) ? "same" : "different" });
      } catch (e) { rows.push({ path: p, state: "unreached", note: e.message }); }
    }
  }));
  rows.sort((a, b) => a.path.localeCompare(b.path));
  report(rows, [
    "Every file the release ships was fetched as served now. index.html, main.js and every module they import are among them, so the code a browser runs is the release's.",
    "Not covered: the library (corpus/), built from the vault and not code; the retrieval model's weights (vendor/models/*.onnx), published by their makers on Hugging Face.",
    "A server can serve different files at another hour or to another person. Run it again, from another network, when it matters.",
  ]);
}

// ─── Lodestone Desktop ────────────────────────────────────────────────────────
function resourcesDir(given) {
  const tries = given ? [given, path.join(given, "Contents", "Resources"), path.join(given, "resources")] : [
    "/Applications/Lodestone.app/Contents/Resources",
    path.join(os.homedir(), "Applications", "Lodestone.app", "Contents", "Resources"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Lodestone", "resources"),
    path.join(process.env.ProgramFiles || "", "Lodestone", "resources"),
    "/opt/Lodestone/resources", "/usr/lib/lodestone/resources",
  ];
  for (const t of tries) if (t && fs.existsSync(path.join(t, "app.asar"))) return t;
  fail(given ? `No app.asar under ${given}.` : "Lodestone Desktop was not found in the usual places: give its path (Lodestone.app, or the folder holding app.asar).");
}

/** The files inside an asar archive: name → Buffer (unpacked ones read beside it). */
function readAsar(file) {
  const buf = fs.readFileSync(file);
  const pickle = buf.readUInt32LE(4), len = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + len).toString("utf8"));
  const base = 8 + pickle, out = new Map();
  const walk = (node, pre) => { for (const [name, n] of Object.entries(node.files || {})) {
    const p = pre ? `${pre}/${name}` : name;
    if (n.files) walk(n, p);
    else if (n.link) continue;
    else if (n.unpacked) { const u = path.join(file + ".unpacked", ...p.split("/")); if (fs.existsSync(u)) out.set(p, fs.readFileSync(u)); }
    else { const o = base + Number(n.offset); out.set(p, buf.subarray(o, o + n.size)); }
  } };
  walk(header, "");
  return out;
}

async function desktop() {
  const res = resourcesDir(positional);
  const asar = readAsar(path.join(res, "app.asar"));
  const pkg = JSON.parse(asar.get("package.json")?.toString("utf8") || "{}");
  if (!pkg.version) fail("This app.asar holds no package.json version.");
  const tag = opt("--tag") || `desktop-v${pkg.version}`;
  say(`Checking Lodestone Desktop ${pkg.version} at ${res}.`);
  const { sums, raw } = await released(tag);
  const rows = [], notes = [];
  const cmp = (p, buf, note) => { const h = sums.get(p); rows.push({ path: p, state: !h ? "extra" : sha(buf) === h ? "same" : "different", note: !h ? note || "in this copy, not in the release" : undefined }); };

  // Its interface: web/ is app/ of the release (the library apart).
  const web = path.join(res, "web"), seen = new Set();
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name), rel = "app/" + path.relative(web, p).split(path.sep).join("/");
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && !rel.startsWith("app/corpus/") && !/^app\/vendor\/models\/.*\.onnx$/.test(rel) && e.name !== ".DS_Store") { seen.add(rel); cmp(rel, fs.readFileSync(p)); }
  } };
  if (fs.existsSync(web)) walk(web); else notes.push("No web/ folder found.");
  for (const p of sums.keys()) if (p.startsWith("app/") && !p.startsWith("app/corpus/") && !seen.has(p) && !/^app\/vendor\/models\/.*\.onnx$/.test(p)) rows.push({ path: p, state: "missing" });

  // Its own code: everything in app.asar but its third-party packages.
  const deps = new Map();
  for (const [p, buf] of asar) {
    if (p.startsWith("node_modules/")) {
      // Each package by its place, nested ones too (node_modules/qrcode/node_modules/yargs), as the lock file names them.
      const m = p.match(/^((?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+)\/package\.json$/);
      if (m) { try { const j = JSON.parse(buf.toString("utf8")); if (j.name && j.version) deps.set(m[1], j.version); } catch {} }
      continue;
    }
    cmp("desktop/" + p, buf);
  }
  // The third-party packages: each at the version the release's lock file names.
  const lockText = await raw("desktop/package-lock.json");
  if (lockText) {
    // electron-builder lays the production packages out again when it packs the app, so a package
    // is matched by its name and version against every place the lock file lists it.
    const lock = JSON.parse(lockText).packages || {}, pinned = new Map();
    for (const [k, e] of Object.entries(lock)) { const n = k.split("node_modules/").pop(); if (n && e?.version) { if (!pinned.has(n)) pinned.set(n, new Set()); pinned.get(n).add(e.version); } }
    for (const [place, v] of deps) {
      const name = place.split("node_modules/").pop(), want = pinned.get(name);
      rows.push({ path: `desktop/${place}@${v}`, state: want?.has(v) ? "same" : want ? "different" : "extra", note: want && !want.has(v) ? `the lock file names ${[...want].join(", ")}` : !want ? "not in the lock file" : undefined });
    }
    notes.push(`${deps.size} third-party packages checked by name and version against desktop/package-lock.json (their contents are npm's: compare with the registry if you need more).`);
  } else notes.push(`${deps.size} third-party packages inside app.asar not checked: the release has no desktop/package-lock.json.`);

  // The model engine: llama.cpp's files against the release's list for this platform.
  const eng = path.join(res, "engine");
  if (fs.existsSync(eng)) {
    const files = fs.readdirSync(eng).filter(f => fs.statSync(path.join(eng, f)).isFile());
    let best = null;
    for (const plat of ["darwin-arm64", "darwin-x64", "win32-x64-vulkan", "linux-x64-vulkan"]) {
      const t = await raw(`desktop/engines/${plat}.sha256`); if (!t) continue;
      const list = parseSums(t), hit = files.filter(f => list.has(f)).length;
      if (!best || hit > best.hit) best = { plat, list, hit };
    }
    if (best?.hit) {
      for (const f of files) { const h = best.list.get(f); rows.push({ path: `engine/${f}`, state: !h ? "extra" : sha(fs.readFileSync(path.join(eng, f))) === h ? "same" : "different" }); }
      notes.push(`The model engine (engine/) checked against desktop/engines/${best.plat}.sha256.`);
    } else notes.push("The model engine (engine/) not checked: no matching list in the release.");
  }
  notes.push("Not covered: Electron itself (the app's frame, Frameworks/ on a Mac), whose builds Electron publishes with their own checksums; the dictation engine (whisper/); the library (web/corpus/); the two small models' weights (web/vendor/models/*.onnx), published by their makers on Hugging Face.");
  report(rows.sort((a, b) => a.path.localeCompare(b.path)), notes);
}

(mode === "web" ? web() : desktop()).catch(e => fail(e.stack || e.message));
