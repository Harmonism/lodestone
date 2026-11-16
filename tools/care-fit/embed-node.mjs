// embed-node.mjs — embed.py without a browser (16 November 2026): the same model (multilingual-e5-small, q8,
// "query: " prefix, mean pooling, normalised), as embed-worker.js runs it in the app, through Node.
//   python3 -B -c "import json,data; print(json.dumps(data.POS+data.NEG+data.TEST_POS+data.TEST_NEG))" | node embed-node.mjs
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, "../..");
const { pipeline, env } = await import("@huggingface/transformers");
env.allowRemoteModels = false; env.localModelPath = path.join(ROOT, "app/vendor/models/");
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "app/corpus/embeddings.json")));
const ex = await pipeline("feature-extraction", meta.model, { dtype: "q8" });
const texts = JSON.parse(fs.readFileSync(0, "utf8")), vecs = [];
for (const t of texts) vecs.push(Array.from((await ex("query: " + t, { pooling: "mean", normalize: true })).data).map(x => Math.round(x * 1e6) / 1e6));
fs.writeFileSync(path.join(HERE, "vecs.json"), JSON.stringify({ texts, vecs }));
console.log(vecs.length, vecs[0].length);
