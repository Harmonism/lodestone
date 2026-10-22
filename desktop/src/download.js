// download.js — fetch a model file once, resumably, and prove it is the right one.
//
// The file lands as <name>.part while it downloads; an interrupted download
// (closed app, lost connection, sleep) resumes from where it stopped. When it is
// complete its SHA-256 is compared with the one Hugging Face publishes, and only
// then is it renamed into place. A file that fails the check is deleted.

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

async function freeBytes(dir) {
  try { const s = await fs.promises.statfs(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

function partialBytes(dest) {
  try { return fs.statSync(dest + ".part").size; } catch { return 0; }
}

/**
 * @param {object} o
 * @param {(url: string, init: object) => Promise<Response>} o.fetch  Electron's net.fetch (system proxy aware) or global fetch
 * @param {string} o.url  @param {string} o.dest  @param {number} o.size  @param {string} o.sha256
 * @param {(p: {phase: string, done: number, total: number, rate?: number}) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
async function download({ fetch, url, dest, size, sha256, onProgress = () => {}, signal }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  let have = partialBytes(dest);
  if (have > size) { fs.truncateSync(part, 0); have = 0; }

  const need = size - have + 512 * 1024 * 1024;
  const free = await freeBytes(path.dirname(dest));
  if (free < need) {
    const gb = n => (n / 1e9).toFixed(1);
    throw new Error(`There is not enough free space on this computer: the download needs ${gb(need)} GB more and ${gb(free)} GB is free.`);
  }

  // Busy servers (429, 5xx) and dropped connections are retried with a growing
  // pause, each time resuming from the bytes already on disk.
  for (let attempt = 0; ; attempt++) {
    try { await fetchInto({ fetch, url, part, size, signal, onProgress }); break; }
    catch (e) {
      if (signal?.aborted || e.permanent || attempt >= 6) throw e;
      onProgress({ phase: "retry", done: partialBytes(dest), total: size, wait: 2 ** attempt * 2 });
      await new Promise(r => setTimeout(r, 2 ** attempt * 2000));
    }
  }
  if (partialBytes(dest) !== size) throw new Error("The download ended before it finished. Try again; it resumes from where it stopped.");

  // Verify. Reading 17 GB back takes a minute on an SSD; the practitioner sees it.
  onProgress({ phase: "verify", done: 0, total: size });
  const hash = crypto.createHash("sha256");
  let read = 0, last = 0;
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(part, { highWaterMark: 4 * 1024 * 1024 });
    s.on("data", c => {
      hash.update(c); read += c.length;
      if (Date.now() - last > 250) { last = Date.now(); onProgress({ phase: "verify", done: read, total: size }); }
      if (signal?.aborted) s.destroy(new Error("aborted"));
    });
    s.on("end", resolve); s.on("error", reject);
  });
  if (hash.digest("hex") !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error("The downloaded file was damaged in transit and has been removed. Please download it again.");
  }
  fs.renameSync(part, dest);
  onProgress({ phase: "done", done: size, total: size });
  return dest;
}

async function fetchInto({ fetch, url, part, size, signal, onProgress }) {
  let have = 0;
  try { have = fs.statSync(part).size; } catch {}
  if (have >= size) return;
  const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, cache: "no-store" });
  if (!res.ok) {
    const e = new Error(res.status === 429 || res.status >= 500
      ? `The download server is busy (${res.status}). Try again in a few minutes; the download resumes where it stopped.`
      : `The download server answered ${res.status}.`);
    e.permanent = !(res.status === 429 || res.status >= 500);
    throw e;
  }
  if (have && res.status !== 206) have = 0;           // the server ignored the resume request
  const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
  // A write that fails (a full disk) ends the download with its reason (1.13.1):
  // unheard, it was an uncaught error and a download waiting forever on "drain".
  let failed = null;
  const failure = new Promise((_, reject) => out.on("error", e => {
    failed = e;
    reject(e.code === "ENOSPC" ? Object.assign(new Error("The disk is full: free some space, then download again; it resumes where it stopped."), { permanent: true }) : e);
  }));
  failure.catch(() => {});
  const reader = res.body.getReader();
  let done = have, last = 0, lastBytes = have, rate = 0;
  try {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (failed) await failure;
      if (!out.write(value)) await Promise.race([new Promise(r => out.once("drain", r)), failure]);
      done += value.length;
      const now = Date.now();
      if (now - last > 250) {
        const inst = (done - lastBytes) / ((now - last) / 1000 || 1);
        rate = last ? rate * 0.8 + inst * 0.2 : inst;
        last = now; lastBytes = done;
        onProgress({ phase: "download", done, total: size, rate });
      }
    }
  } finally {
    try { reader.cancel().catch(() => {}); } catch {}
    if (failed) out.destroy(); else await new Promise(r => out.end(r));
  }
  if (failed) await failure;
}

/**
 * Download every file of a model into `dir`, one after another, reporting
 * progress over the whole model. Files already complete are skipped, so a
 * model split into shards resumes at the shard where it stopped.
 */
async function downloadModel({ fetch, files, urlFor, dir, onProgress = () => {}, signal }) {
  const total = files.reduce((n, f) => n + f.size, 0);
  fs.mkdirSync(dir, { recursive: true });
  const need = total - modelBytes(files, dir) + 512 * 1024 * 1024;
  const free = await freeBytes(dir);
  if (free < need) {
    const gb = n => (n / 1e9).toFixed(1);
    throw new Error(`There is not enough free space on this computer: the download needs ${gb(need)} GB more and ${gb(free)} GB is free.`);
  }
  let before = 0;
  for (const f of files) {
    const dest = path.join(dir, path.basename(f.path));
    let complete = false;
    try { complete = fs.statSync(dest).size === f.size; } catch {}
    if (!complete) {
      await download({
        fetch, url: urlFor(f.path), dest, size: f.size, sha256: f.sha256, signal,
        onProgress: p => onProgress({ ...p, done: before + p.done, total, phase: p.phase === "done" ? "download" : p.phase }),
      });
    }
    before += f.size;
  }
  onProgress({ phase: "done", done: total, total });
}

/** Bytes already on disk for a model, complete shards and partial ones. */
function modelBytes(files, dir) {
  let n = 0;
  for (const f of files) {
    const dest = path.join(dir, path.basename(f.path));
    try { n += fs.statSync(dest).size; continue; } catch {}
    n += partialBytes(dest);
  }
  return n;
}

module.exports = { download, downloadModel, modelBytes, partialBytes, freeBytes };
