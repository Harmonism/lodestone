// corpus.js — the downloadable corpus pack. Fetched once, kept on the device,
// updated only when the practitioner chooses (SDIP invariant: practitioner-initiated update).

import { blobs, kv } from "./store.js";

const CACHE = "munai-corpus-v1";
const BASE = new URL("../corpus/", import.meta.url);
const FILES = {
  runtime: "runtime.json",
  corpus: "corpus.json",
  embMeta: "embeddings.json",
  emb: "embeddings.bin",
};
const hasCache = () => typeof caches !== "undefined";

async function fetchWithProgress(url, onProgress, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function putLocal(name, bytes) {
  if (hasCache()) {
    const c = await caches.open(CACHE);
    await c.put(new Request(new URL(name, BASE)), new Response(bytes));
  } else {
    await blobs.set("corpus/" + name, bytes);
  }
}

async function getLocal(name) {
  if (hasCache()) {
    const c = await caches.open(CACHE);
    const r = await c.match(new Request(new URL(name, BASE)));
    return r ? new Uint8Array(await r.arrayBuffer()) : null;
  }
  return (await blobs.get("corpus/" + name)) || null;
}

export async function isInstalled() {
  return !!(await kv.get("pack")) && !!(await getLocal(FILES.corpus)) && !!(await getLocal(FILES.runtime));
}

export async function hasSemanticLocal() {
  return !!(await getLocal(FILES.emb)) && !!(await getLocal(FILES.embMeta));
}

/** Download the pack. onProgress(kind, fraction, label). */
export async function install({ semantic = true, onProgress = () => {} } = {}) {
  const rt = await fetchWithProgress(new URL(FILES.runtime, BASE), null, { cache: "no-store" });
  const runtime = JSON.parse(new TextDecoder().decode(rt));
  const corpus = await fetchWithProgress(new URL(FILES.corpus, BASE), (g, t) =>
    onProgress("corpus", t ? g / t : 0, mb(g)), { cache: "no-store" });
  await putLocal(FILES.corpus, corpus);
  await putLocal(FILES.runtime, rt);
  onProgress("corpus", 1, mb(corpus.length));

  let semOk = false;
  if (semantic) {
    try {
      const metaBytes = await fetchWithProgress(new URL(FILES.embMeta, BASE), null, { cache: "no-store" });
      const meta = JSON.parse(new TextDecoder().decode(metaBytes));
      if (meta.corpus_hash === runtime.pack.corpus_hash) {
        const emb = await fetchWithProgress(new URL(FILES.emb, BASE), (g, t) =>
          onProgress("semantic-vectors", t ? g / t : 0, mb(g)), { cache: "no-store" });
        await putLocal(FILES.embMeta, metaBytes);
        await putLocal(FILES.emb, emb);
        semOk = true;
      }
    } catch (e) {
      console.warn("[corpus] embeddings unavailable:", e.message);
    }
  }
  await kv.set("pack", { ...runtime.pack, semantic: semOk, installed_at: Date.now() });
  return { runtime, semantic: semOk };
}

/** Load the installed pack from the device (no network). */
export async function load() {
  const [c, r] = await Promise.all([getLocal(FILES.corpus), getLocal(FILES.runtime)]);
  if (!c || !r) throw new Error("Corpus pack not installed.");
  const dec = new TextDecoder();
  const corpus = JSON.parse(dec.decode(c));
  const runtime = JSON.parse(dec.decode(r));
  let embeddings = null;
  const [eb, em] = await Promise.all([getLocal(FILES.emb), getLocal(FILES.embMeta)]);
  if (eb && em) {
    const meta = JSON.parse(dec.decode(em));
    if (meta.corpus_hash === runtime.pack.corpus_hash && meta.count === corpus.chunks.length) {
      const buf = eb.buffer.slice(eb.byteOffset, eb.byteOffset + eb.byteLength);
      embeddings = {
        meta,
        q: new Int8Array(buf, 0, meta.count * meta.dims),
        scales: new Float32Array(buf, meta.scales_offset, meta.count),
      };
    }
  }
  return { corpus, runtime, embeddings };
}

/** Ask the origin whether a newer pack exists. Never downloads it. */
export async function checkForUpdate() {
  const pack = await kv.get("pack");
  const res = await fetch(new URL(FILES.runtime, BASE), { cache: "no-store" });
  if (!res.ok) throw new Error("Could not reach the corpus origin.");
  const remote = (await res.json()).pack;
  return { current: pack, remote, newer: !pack || remote.corpus_hash !== pack.corpus_hash };
}

export async function remove() {
  if (hasCache()) await caches.delete(CACHE);
  for (const f of Object.values(FILES)) await blobs.del("corpus/" + f);
  await kv.del("pack");
}

const mb = n => (n / 1e6).toFixed(1) + " MB";
