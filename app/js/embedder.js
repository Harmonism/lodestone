// embedder.js — main-thread handle on embed-worker.js.
export class Embedder {
  constructor() {
    this.w = null; this.pending = new Map(); this.seq = 0; this.ready = false;
  }
  start(onProgress) {
    if (this.w) return this.readyP;
    this.w = new Worker(new URL("./embed-worker.js", import.meta.url), { type: "module" });
    this.readyP = new Promise((resolve, reject) => {
      const files = new Map();
      this.w.onmessage = ({ data }) => {
        if (data.type === "progress") {
          files.set(data.file, [data.loaded, data.total]);
          let g = 0, t = 0; for (const [a, b] of files.values()) { g += a; t += b; }
          onProgress && onProgress(t ? g / t : 0, g);
        } else if (data.type === "ready") { this.ready = true; resolve(); }
        else if (data.type === "vec") { this.pending.get(data.id)?.resolve(data.vec); this.pending.delete(data.id); }
        else if (data.type === "error") {
          if (data.id != null && this.pending.has(data.id)) { this.pending.get(data.id).reject(new Error(data.error)); this.pending.delete(data.id); }
          else reject(new Error(data.error));
        }
      };
      this.w.onerror = e => reject(e);
      this.w.postMessage({ type: "init" });
    });
    return this.readyP;
  }
  embed(text) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.w.postMessage({ type: "embed", id, text });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("embed timeout")); } }, 20000);
    });
  }
}
