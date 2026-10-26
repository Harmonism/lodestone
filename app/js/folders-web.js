// folders-web.js — the folders Lodestone may read, in the web app (Lodestone Desktop: desktop/src/folders.js).
//
// The same index and the same search as the desktop's, over the browser's File System
// Access API: the practitioner picks each folder, the browser asks whether Lodestone may
// read it, and the permission is the browser's. Read-only (Lodestone never asks to write),
// Markdown, text and Org only, nothing outside the folders picked. The folder handles are
// kept in this browser's IndexedDB, never synced; the browser may ask again after a
// restart, and Settings then offers "Allow again". Chromium browsers on a computer only
// (Chrome, Edge, Brave, Arc); elsewhere the section says so.
// The passages go into the turn's context, which travels with the turn to the provider of
// a rented model, as on the desktop (Settings says so).

const EXT = /\.(md|markdown|txt|org)$/i;
const SKIP = new Set(["node_modules", ".git", ".obsidian", ".trash", ".Trash", "__pycache__", ".venv", "dist", "build"]);
const MAX_FILES = 20000, MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 400 * 1024 * 1024, CHUNK = 1200, STALE_MS = 15 * 60 * 1000;
const STOP = new Set(("the and for are but not you all any can had her was one our out his has how its may new now see two way who did get him let say she too use that this with have from they will would there their what about which when your said each than then them these some into more only other also just like over such very what were been being does doing here where while why because could should after before most much many own same both few under again once off down well even back still against through during above below between les des une est que qui dans pour par sur avec pas plus son ses aux elle ils nous vous mais comme tout sont été être fait ces cet cette leur leurs").split(" "));
const tokens = s => (String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !STOP.has(w));
const tf = tk => { const m = new Map(); for (const w of tk) m.set(w, (m.get(w) || 0) + 1); return m; };

export const foldersSupported = () => typeof window !== "undefined" && "showDirectoryPicker" in window && !!window.indexedDB;

// ── the handles, in IndexedDB (a handle cannot go in localStorage or sync) ──
const DB = "lodestone-folders", ST = "handles";
const db = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(ST, mode); const out = fn(t.objectStore(ST)); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); }); };
const all = () => tx("readonly", s => s.getAll());

const granted = async h => { try { return (await h.queryPermission({ mode: "read" })) === "granted"; } catch { return false; } };

let chunks = null, builtAt = 0, df = new Map(), avg = 1, stats = null;
const invalidate = () => { chunks = null; };

async function build() {
  const out = [], st = { files: 0, chunks: 0, skipped: 0, waiting: 0 };
  let total = 0;
  for (const { handle } of await all()) {
    if (!(await granted(handle))) { st.waiting++; continue; }
    const stack = [[handle, handle.name]];
    while (stack.length && st.files < MAX_FILES && total < MAX_TOTAL) {
      const [dir, rel] = stack.pop();
      try {
        for await (const e of dir.values()) {
          if (e.name.startsWith(".")) continue;
          if (e.kind === "directory") { if (!SKIP.has(e.name)) stack.push([e, rel + "/" + e.name]); continue; }
          if (!EXT.test(e.name)) continue;
          let f; try { f = await e.getFile(); } catch { continue; }
          if (f.size > MAX_FILE) { st.skipped++; continue; }
          const text = await f.text().catch(() => null); if (text == null) continue;
          total += f.size; st.files++;
          const file = rel + "/" + e.name;
          let buf = "";
          const flush = () => { const t = buf.trim(); if (t.length > 40) { const tk = tokens(t); if (tk.length) out.push({ file, text: t, tf: tf(tk), len: tk.length }); } buf = ""; };
          for (const para of text.replace(/^---\n[\s\S]*?\n---\n/, "").split(/\n\s*\n/)) {
            if (buf.length + para.length > CHUNK && buf) flush();
            buf += (buf ? "\n\n" : "") + para.slice(0, CHUNK * 2);
          }
          flush();
          if (st.files >= MAX_FILES || total >= MAX_TOTAL) break;
        }
      } catch { /* a folder moved or refused: passed over */ }
    }
  }
  df = new Map();
  for (const c of out) for (const w of c.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  avg = out.reduce((n, c) => n + c.len, 0) / (out.length || 1);
  chunks = out; builtAt = Date.now(); st.chunks = out.length; stats = st;
  return st;
}

/** The same shape as Lodestone Desktop's foldersList(): { folders: [names], stats, waiting: [ids] }. */
async function list() {
  const rows = await all();
  const waiting = [];
  for (const r of rows) if (!(await granted(r.handle))) waiting.push(r.id);
  return { folders: rows.map(r => r.name), ids: rows.map(r => r.id), waiting, stats };
}

export const webFolders = {
  async foldersList() { return list(); },
  async foldersAdd() {
    let handle;
    try { handle = await window.showDirectoryPicker({ id: "lodestone-folders", mode: "read" }); }
    catch (e) { if (e?.name === "AbortError") return list(); throw e; }
    const rows = await all();
    for (const r of rows) if (await r.handle.isSameEntry?.(handle).catch(() => false)) return list();   // already there
    const id = (crypto.randomUUID?.() || String(Date.now()));
    await tx("readwrite", s => s.put({ id, name: handle.name, handle, added: Date.now() }));
    invalidate(); await build();
    return list();
  },
  async foldersRemove(name) {
    const r = (await all()).find(x => x.name === name || x.id === name);
    if (r) await tx("readwrite", s => s.delete(r.id));
    invalidate(); if ((await all()).length) await build(); else stats = null;
    return list();
  },
  /** Asks the browser again for every folder it no longer lets Lodestone read. Needs a click. */
  async foldersAllow() {
    for (const r of await all()) if (!(await granted(r.handle))) { try { await r.handle.requestPermission({ mode: "read" }); } catch {} }
    invalidate(); await build();
    return list();
  },
  async foldersReread() { invalidate(); await build(); return list(); },
  /** The best passages for a question: at most `k`, at most `budget` characters in all. */
  async searchFolders(question, { k = 6, budget = 7000 } = {}) {
    if (!(await all()).length) return [];
    if (!chunks || Date.now() - builtAt > STALE_MS) await build();
    const q = [...new Set(tokens(question))];
    if (!q.length || !chunks.length) return [];
    const N = chunks.length, k1 = 1.4, b = 0.75, scored = [];
    for (const c of chunks) {
      let s = 0;
      for (const w of q) {
        const f = c.tf.get(w); if (!f) continue;
        const n = df.get(w) || 0, idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / avg));
      }
      if (s > 0) scored.push([s, c]);
    }
    scored.sort((a, z) => z[0] - a[0]);
    const out = []; let used = 0;
    for (const [s, c] of scored) {
      if (out.length >= k || used + c.text.length > budget) break;
      if (s < 1.5) break;   // weak matches only add noise
      out.push({ file: c.file, text: c.text }); used += c.text.length;
    }
    return out;
  },
};
