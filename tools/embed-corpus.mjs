#!/usr/bin/env node
/**
 * embed-corpus.mjs — optional semantic layer for the Lodestone corpus pack.
 *
 * Reads app/corpus/corpus.json (from build-corpus.py) and writes:
 *   app/corpus/embeddings.bin   int8 [chunks × 384], one scale per row
 *   app/corpus/embeddings.json  { model, dims, count, corpus_hash, scales_offset }
 *
 * Model: intfloat multilingual-e5-small (ONNX, q8) — open weights, multilingual,
 * so a French or Arabic question ranks against the English canon the same way
 * production's EN-canonical retrieval does. The app loads the same model
 * in the browser to embed the practitioner's question; nothing leaves the device.
 *
 * Usage (from lodestone/):  npm i && node tools/embed-corpus.mjs
 */
import { pipeline, env } from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.argv[2] || path.join(ROOT, "app", "corpus");
const MODEL = "Xenova/multilingual-e5-small";
const DIMS = 384;
const BATCH = 32;

env.allowLocalModels = false;

const corpus = JSON.parse(fs.readFileSync(path.join(DIR, "corpus.json"), "utf8"));
const runtime = JSON.parse(fs.readFileSync(path.join(DIR, "runtime.json"), "utf8"));
const { articles, chunks } = corpus;
const N = chunks.length;

// e5 convention: "passage: " prefix; title + heading give the chunk its address
const passage = (arts, [a, h, s, e]) => `passage: ${arts[a].t}${h ? " — " + h : ""}\n${arts[a].x.slice(s, e)}`.slice(0, 2000);

// Reuse vectors for passages whose text did not change since the previous pack
// (build-corpus.py keeps corpus.prev.json). A routine re-embed then takes seconds.
const q = new Int8Array(N * DIMS);
const scales = new Float32Array(N);
const todo = [];
{
  const prevC = path.join(DIR, "corpus.prev.json"), prevB = path.join(DIR, "embeddings.bin"), prevM = path.join(DIR, "embeddings.json");
  let reused = 0;
  if (fs.existsSync(prevC) && fs.existsSync(prevB) && fs.existsSync(prevM)) {
    const pm = JSON.parse(fs.readFileSync(prevM, "utf8"));
    const pc = JSON.parse(fs.readFileSync(prevC, "utf8"));
    if (pm.model === MODEL && pm.dims === DIMS && pm.count === pc.chunks.length) {
      const pb = fs.readFileSync(prevB);
      const pq = new Int8Array(pb.buffer, pb.byteOffset, pm.count * DIMS);
      const ps = new Float32Array(pb.buffer.slice(pb.byteOffset + pm.scales_offset, pb.byteOffset + pm.scales_offset + pm.count * 4));
      const index = new Map();
      pc.chunks.forEach((c, i) => index.set(passage(pc.articles, c), i));
      chunks.forEach((c, i) => {
        const j = index.get(passage(articles, c));
        if (j === undefined) { todo.push(i); return; }
        q.set(pq.subarray(j * DIMS, (j + 1) * DIMS), i * DIMS); scales[i] = ps[j]; reused++;
      });
    } else chunks.forEach((_, i) => todo.push(i));
  } else chunks.forEach((_, i) => todo.push(i));
  console.log(`reused ${reused} vectors, embedding ${todo.length} passages`);
}

const extractor = todo.length ? await pipeline("feature-extraction", MODEL, { dtype: "q8" }) : null;
const t0 = Date.now();

for (let k = 0; k < todo.length; k += BATCH) {
  const idx = todo.slice(k, k + BATCH);
  const batch = idx.map(i => passage(articles, chunks[i]));
  const out = await extractor(batch, { pooling: "mean", normalize: true });
  const data = out.data; // Float32Array [b × DIMS]
  idx.forEach((i, b) => {
    let max = 1e-9;
    for (let d = 0; d < DIMS; d++) max = Math.max(max, Math.abs(data[b * DIMS + d]));
    const sc = 127 / max;
    scales[i] = 1 / sc;
    for (let d = 0; d < DIMS; d++) q[i * DIMS + d] = Math.round(data[b * DIMS + d] * sc);
  });
  if ((k / BATCH) % 20 === 0) {
    const rate = (k + idx.length) / ((Date.now() - t0) / 1000);
    process.stdout.write(`\r  ${k + idx.length}/${todo.length}  ${rate.toFixed(0)} chunks/s   `);
  }
}

const bin = Buffer.concat([Buffer.from(q.buffer), Buffer.from(scales.buffer)]);
fs.writeFileSync(path.join(DIR, "embeddings.bin"), bin);
fs.writeFileSync(path.join(DIR, "embeddings.json"), JSON.stringify({
  model: MODEL, dtype: "q8", dims: DIMS, count: N,
  corpus_hash: runtime.pack.corpus_hash,
  scales_offset: N * DIMS,
  built_at: new Date().toISOString(),
}));
console.log(`\nembeddings: ${N} × ${DIMS} int8 → ${(bin.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
try { fs.unlinkSync(path.join(DIR, "corpus.prev.json")); } catch {}
