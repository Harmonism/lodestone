// fidelity-context.mjs — the library context Lodestone would give each question of the
// fidelity suite on a rented or hosted model, built by the app's own code: retrieval.js
// for the passages and main.js's rule for the articles read whole (named in the question,
// or retrieved at two passages or more; at most two, 200,000 characters), formatted by
// prompt.js and retrieval.js as the turn carries them. A first message: no history.
//
//   node tools/fidelity-context.mjs questions.json [--canon] > context.json
//
// --canon adds the <canon> block (Doctrinal Fidelity Architecture, layer 1): the Canon
// statements (canon/statements.json, tools/build-canon.py) the question touches, retrieved by the
// same retrieval.js, placed last, nearest the question.
//
// questions.json is {id: text}; the output is {id: {blocks, articles, passages}}, where
// blocks is what buildSystem appends after the date line (turn.article, then turn.vault).
// harmonia-astro/scripts/lodestone-fidelity-suite.py --rag calls this.
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
const { Retriever, wantsWhole, isFollowUp } = await import(pathToFileURL(path.join(ROOT, "app/js/retrieval.js")).href);
const { fullArticleBlock } = await import(pathToFileURL(path.join(ROOT, "app/js/prompt.js")).href);
const R = new Retriever({ corpus, runtime, embeddings: emb });
R.embedQuery = async t => (await ex("query: " + t, { pooling: "mean", normalize: true })).data;
const rag = { k: 5, maxChars: 12000 };   // engine.js, the hosted and OpenRouter tiers
const arts = corpus.articles, CAP = 200000;
const questions = JSON.parse(fs.readFileSync(process.argv[2], "utf-8")), out = {};
const withCanon = process.argv.includes("--canon");
const noWhole = process.argv.includes("--no-whole");   // passages only: no article read whole unless asked for
let CR = null, canon = null;
if (withCanon) {
  canon = JSON.parse(fs.readFileSync(path.join(ROOT, "canon/statements.json")));
  const N = canon.articles.length, D = meta.dims;
  const cacheF = path.join(ROOT, "canon/vectors.json");
  const cache = fs.existsSync(cacheF) ? JSON.parse(fs.readFileSync(cacheF)) : {};
  const q = new Int8Array(N * D), scales = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = canon.articles[i];
    let v = cache[a.p];
    if (!v) { v = Array.from((await ex(`passage: ${a.t}\n${a.x}`, { pooling: "mean", normalize: true })).data); cache[a.p] = v; }
    let max = 0; for (const x of v) max = Math.max(max, Math.abs(x));
    const sc = 127 / (max || 1); scales[i] = 1 / sc;
    for (let d = 0; d < D; d++) q[i * D + d] = Math.round(v[d] * sc);
  }
  fs.writeFileSync(cacheF, JSON.stringify(Object.fromEntries(canon.articles.map(a => [a.p, cache[a.p]]))));
  CR = new Retriever({ corpus: canon, runtime, embeddings: { meta: { ...meta, count: N }, q, scales } });
  CR.embedQuery = R.embedQuery;
}
const canonBlock = hits => !hits.length ? "" :
  `<canon>\nStatements of the doctrine this message touches, word for word from the backbone and the Glossary. Where one defines a term or states a position, carry its wording into your answer, in your own voice, rather than a paraphrase. Never contradict one, and add no specific beyond what they and the excerpts say.\n\n${hits.map((h, n) => `[c${n + 1}] (${canon.articles[h.article].t})\n${h.text}`).join("\n\n")}\n</canon>`;
for (const [id, text] of Object.entries(questions)) {
  const follow = isFollowUp(text) && !R.asked(text).length;
  let { hits, none } = await R.retrieve(text, { ...rag, context: "", follow, prior: [] });
  let full = [], budget = 0;
  if (wantsWhole(text)) {
    const idx = R.asked(text)[0];
    if (idx >= 0) { full = [idx]; hits = []; budget = arts[idx].x.length; }
  } else if (!noWhole) {
    const named = R.asked(text), depth = new Map();
    for (const h of hits) depth.set(h.article, (depth.get(h.article) || 0) + 1);
    let total = 0;
    for (const a of [...new Set([...named, ...hits.map(h => h.article)])]) {
      if (full.length >= 2) break;
      if (!named.includes(a) && depth.get(a) < 2) continue;
      if (full.length && total + arts[a].x.length > CAP) continue;
      full.push(a); total += arts[a].x.length;
    }
    budget = Math.min(total, CAP);
    hits = hits.filter(h => !full.includes(h.article));
  }
  let left = budget;
  const article = full.map(a => { const t = arts[a].x.slice(0, Math.max(0, left)); left -= t.length; return t.length ? fullArticleBlock(arts[a], t, t.length < arts[a].x.length) : ""; }).filter(Boolean).join("\n\n");
  const vault = none && !full.length ? R.formatNone() : R.format(hits);
  let cblock = "", cids = [];
  if (CR) {
    const r = await CR.retrieve(text, { k: 6, maxChars: 4000, context: "", follow: false, prior: [] });
    cblock = canonBlock(r.hits); cids = r.hits.map(h => canon.articles[h.article].p);
  }
  out[id] = { blocks: [article, vault, cblock].filter(Boolean).join("\n\n"), articles: full.map(a => arts[a].t), passages: hits.map(h => arts[h.article].t), canon: cids };
}
process.stdout.write(JSON.stringify(out));
