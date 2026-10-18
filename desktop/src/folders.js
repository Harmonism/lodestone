// folders.js — folders the practitioner lets Lodestone read.
//
// Read-only. The practitioner chooses each folder in Settings → Advanced; Lodestone
// never writes, moves or deletes anything in it, and reads nothing outside it
// (symbolic links are not followed). Text files only: Markdown, plain text, Org.
// The index lives in memory, is built on first use and refreshed when it is more
// than fifteen minutes old or a folder is added or removed. Nothing is sent
// anywhere by this module: the passages it returns go into the turn's context,
// which stays on the computer with a local model and travels with the turn to
// the provider with a rented one (the Settings text says so).

const fs = require("fs");
const path = require("path");

const EXT = new Set([".md", ".markdown", ".txt", ".org"]);
const SKIP = new Set(["node_modules", ".git", ".obsidian", ".trash", ".Trash", "__pycache__", ".venv", "dist", "build"]);
const MAX_FILES = 20000, MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 400 * 1024 * 1024, CHUNK = 1200, STALE_MS = 15 * 60 * 1000;
const STOP = new Set(("the and for are but not you all any can had her was one our out his has how its may new now see two way who did get him let say she too use that this with have from they will would there their what about which when your said each than then them these some into more only other also just like over such very what were been being does doing here where while why because could should after before most much many own same both few under again once off down well even back still against through during above below between les des une est que qui dans pour par sur avec pas plus son ses aux elle ils nous vous mais comme tout sont été être fait ces cet cette leur leurs").split(" "));
const tokens = s => (String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !STOP.has(w));

class FolderIndex {
  /** @param {() => string[]} getFolders */
  constructor(getFolders) { this.getFolders = getFolders; this.chunks = null; this.builtAt = 0; this.stats = { files: 0, chunks: 0, skipped: 0 }; }

  invalidate() { this.chunks = null; }

  build() {
    const chunks = [], stats = { files: 0, chunks: 0, skipped: 0 };
    let total = 0;
    for (const root of this.getFolders()) {
      let realRoot; try { realRoot = fs.realpathSync(root); } catch { continue; }
      const label = path.basename(realRoot);
      const stack = [realRoot];
      while (stack.length && stats.files < MAX_FILES && total < MAX_TOTAL) {
        const dir = stack.pop();
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (e.name.startsWith(".") && e.name !== ".") continue;
          const p = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(p); continue; }
          if (!e.isFile() || !EXT.has(path.extname(e.name).toLowerCase())) continue;
          let st; try { st = fs.statSync(p); } catch { continue; }
          if (st.size > MAX_FILE) { stats.skipped++; continue; }
          let text; try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
          total += st.size; stats.files++;
          const rel = path.join(label, path.relative(realRoot, p));
          // passages of about CHUNK characters, cut at paragraph breaks
          let buf = "";
          const flush = () => { const t = buf.trim(); if (t.length > 40) { const tk = tokens(t); if (tk.length) chunks.push({ file: rel, text: t, tf: tf(tk), len: tk.length }); } buf = ""; };
          for (const para of text.replace(/^---\n[\s\S]*?\n---\n/, "").split(/\n\s*\n/)) {
            if (buf.length + para.length > CHUNK && buf) flush();
            buf += (buf ? "\n\n" : "") + para.slice(0, CHUNK * 2);
          }
          flush();
          if (stats.files >= MAX_FILES || total >= MAX_TOTAL) break;
        }
      }
    }
    // document frequencies for BM25
    const df = new Map();
    for (const c of chunks) for (const w of c.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    this.df = df; this.avg = chunks.reduce((n, c) => n + c.len, 0) / (chunks.length || 1);
    this.chunks = chunks; this.builtAt = Date.now();
    stats.chunks = chunks.length; this.stats = stats;
    return stats;
  }

  /** The best passages for a question: at most `k`, at most `budget` characters in all. */
  search(question, { k = 6, budget = 7000 } = {}) {
    if (!this.getFolders().length) return [];
    if (!this.chunks || Date.now() - this.builtAt > STALE_MS) this.build();
    const q = [...new Set(tokens(question))];
    if (!q.length || !this.chunks.length) return [];
    const N = this.chunks.length, k1 = 1.4, b = 0.75;
    const scored = [];
    for (const c of this.chunks) {
      let s = 0;
      for (const w of q) {
        const f = c.tf.get(w); if (!f) continue;
        const n = this.df.get(w) || 0, idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / this.avg));
      }
      if (s > 0) scored.push([s, c]);
    }
    scored.sort((a, b2) => b2[0] - a[0]);
    const out = []; let used = 0;
    for (const [s, c] of scored) {
      if (out.length >= k || used + c.text.length > budget) break;
      if (s < 1.5) break;   // weak matches only add noise
      out.push({ file: c.file, text: c.text }); used += c.text.length;
    }
    return out;
  }
}

function tf(tk) { const m = new Map(); for (const w of tk) m.set(w, (m.get(w) || 0) + 1); return m; }

module.exports = { FolderIndex };
