// holdout.mjs — the current meaning layer (care.js MODEL) against a refit (weights.json) on sentences neither was
// trained on: HOLD_POS/HOLD_NEG from data.py and every user message of the simulation scripts.
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import { execSync } from "child_process";
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, "../..");
const { pipeline, env } = await import("@huggingface/transformers");
env.allowRemoteModels = false; env.localModelPath = path.join(ROOT, "app/vendor/models/");
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "app/corpus/embeddings.json")));
const ex = await pipeline("feature-extraction", meta.model, { dtype: "q8" });
const src = fs.readFileSync(path.join(ROOT, "app/js/care.js"), "utf8");
const OLD = JSON.parse(src.match(/const MODEL = (\{.*?\});/)[1]), NEW = JSON.parse(fs.readFileSync(path.join(HERE, "weights.json")));
const p = (m, v) => { let z = m.b; for (let i = 0; i < v.length; i++) z += v[i] * m.w[i]; return 1 / (1 + Math.exp(-z)); };
const hold = JSON.parse(execSync(`python3 -B -c "import json,data; print(json.dumps([data.HOLD_POS, data.HOLD_NEG]))"`, { cwd: HERE }));
const sims = [];
for (const f of ["simulation-users.json", "simulation-users-2.json", "simulation-users-3.json"]) for (const u of JSON.parse(fs.readFileSync(path.join(ROOT, "tools", f))).users) for (const m of u.turns) sims.push([u.id, typeof m === "string" ? m : m.text]);
const rows = [];
for (const [label, set] of [["HOLD_POS", hold[0].map(t => ["+", t])], ["HOLD_NEG", hold[1].map(t => ["-", t])], ["SIM", sims]])
  for (const [tag, t] of set) { const v = (await ex("query: " + t, { pooling: "mean", normalize: true })).data; rows.push({ label, tag, t, o: p(OLD, v), n: p(NEW, v) }); }
const sum = (l, f) => rows.filter(r => r.label === l && f(r)).length;
console.log("HOLD_POS recall old", sum("HOLD_POS", r => r.o >= .5), "new", sum("HOLD_POS", r => r.n >= .5), "/", sum("HOLD_POS", () => 1));
console.log("HOLD_NEG fp     old", sum("HOLD_NEG", r => r.o >= .5), "new", sum("HOLD_NEG", r => r.n >= .5), "/", sum("HOLD_NEG", () => 1));
console.log("SIM asks        old", sum("SIM", r => r.o >= .5), "new", sum("SIM", r => r.n >= .5), "/", sum("SIM", () => 1));
for (const r of rows) if (r.label !== "HOLD_NEG" && (r.o >= .5 || r.n >= .5) || r.label === "HOLD_POS" && r.n < .5) console.log(r.label, r.tag, r.o.toFixed(2), r.n.toFixed(2), r.t.slice(0, 110));
