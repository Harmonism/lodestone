// eval-retrieval.mjs — measure app/js/retrieval.js against tools/retrieval-eval.json,
// with the same pack and the same on-device retrieval model the app uses.
// Cases from tools/retrieval-eval.local (held subjects, not published) are added when present.
//
//   node tools/eval-retrieval.mjs [-v] [path/to/retrieval.js ...]
//
// Each case is a practitioner message (q), optionally the previous question (ctx),
// the articles that should answer it (want) and those that may stand beside them (ok).
// want: [] marks a question the corpus does not treat: every passage it gets is noise.
// Cases marked heldout were written after the retrieval constants were tuned.
//   hit@1      the first passage is from a wanted article
//   recall     some passage is from a wanted article
//   precision  share of passages from wanted or ok articles
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { pipeline, env } = await import("@huggingface/transformers");
env.allowRemoteModels = false; env.localModelPath = path.join(ROOT, "app/vendor/models/");
const C = path.join(ROOT, "app/corpus/");
const corpus = JSON.parse(fs.readFileSync(C + "corpus.json"));
const runtime = JSON.parse(fs.readFileSync(C + "runtime.json"));
const meta = JSON.parse(fs.readFileSync(C + "embeddings.json"));
const b = fs.readFileSync(C + "embeddings.bin"); const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const emb = { meta, q: new Int8Array(buf, 0, meta.count * meta.dims), scales: new Float32Array(buf, meta.scales_offset, meta.count) };
const ex = await pipeline("feature-extraction", meta.model, { dtype: "q8" });
const vecs = new Map();
const embedQuery = async t => { if (!vecs.has(t)) vecs.set(t, (await ex("query: " + t, { pooling: "mean", normalize: true })).data); return vecs.get(t); };
const cases = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/retrieval-eval.json")));
// Cases on held subjects live beside it in a .local file, which is never published.
const local = path.join(ROOT, "tools/retrieval-eval.local");
if (fs.existsSync(local)) cases.push(...JSON.parse(fs.readFileSync(local)));
const args = process.argv.slice(2), verbose = args.includes("-v");
const mods = args.filter(a => a !== "-v"); if (!mods.length) mods.push(path.join(ROOT, "app/js/retrieval.js"));
const has = (t, list) => list.some(w => t.startsWith(w));
for (const mod of mods) {
  const { Retriever, isFollowUp } = await import(pathToFileURL(path.resolve(mod)).href);
  const R = new Retriever({ corpus, runtime, embeddings: emb }); R.embedQuery = embedQuery;
  const lines = [];
  for (const set of [false, true]) {
    let n = 0, hit1 = 0, rec = 0, prec = 0, pn = 0, offN = 0, off = 0, noise = 0;
    for (const c of cases.filter(c => !!c.heldout === set)) {
      const follow = c.follow ?? (isFollowUp ? isFollowUp(c.q) : false);
      const prior = c.ctx ? [...new Set((await R.retrieve(c.ctx, { k: 5, maxChars: 12000 })).hits.map(h => h.article))] : [];
      const { hits } = await R.retrieve(c.q, { k: 5, maxChars: 12000, context: c.ctx || "", follow, prior });
      const ts = hits.map(h => corpus.articles[h.article].t);
      if (c.want.length) {
        n++; const h1 = ts.length > 0 && has(ts[0], c.want); hit1 += h1; rec += ts.some(t => has(t, c.want));
        const good = ts.filter(t => has(t, c.want) || has(t, c.ok)).length; if (ts.length) { prec += good / ts.length; pn++; }
        if (!h1 || good < ts.length) lines.push(`${h1 ? " " : "✘"} ${c.q}\n     ${ts.map(t => (has(t, c.want) ? "+" : has(t, c.ok) ? "~" : "-") + t.slice(0, 45)).join(" | ")}`);
      } else {
        offN++; off += ts.length; noise += ts.filter(t => !has(t, c.ok)).length;
        lines.push(`○ ${c.q}\n     ${ts.map(t => (has(t, c.ok) ? "~" : "-") + t.slice(0, 45)).join(" | ")}`);
      }
    }
    console.log(`${path.basename(mod)} ${set ? "held-out" : "tuning  "}  hit@1 ${hit1}/${n}  recall ${rec}/${n}  precision ${(prec / Math.max(1, pn) * 100).toFixed(0)}%  off-corpus: ${off} passages, ${noise} unrelated over ${offN} questions`);
  }
  if (verbose) console.log(lines.join("\n"));
}
