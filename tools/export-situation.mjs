#!/usr/bin/env node
/**
 * export-situation.mjs — the situation notes' word lists, from app/js/situation.js, for the server.
 *
 * companion-api.php answers the browser extension and the website's Sprite, which never run the app's
 * turn pipeline; telegram-companion/companion-situation.php gives them the same notes and the same
 * second check (November 17, 2026). The lists live once, in situation.js: this writes them as JSON beside
 * the PHP, and post-build.sh runs it on every deploy so the two cannot drift. The notes' wording is
 * held by tools/test-situation-php.mjs, which runs both versions over the same turns.
 *
 *   node tools/export-situation.mjs [out.json]   (default: ../harmonia-astro/telegram-companion/situation-lexicons.json)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "app", "js", "situation.js"), "utf8");
const out = process.argv[2] || path.join(ROOT, "..", "harmonia-astro", "telegram-companion", "situation-lexicons.json");

const lists = {};
for (const m of src.matchAll(/^const ([A-Z]+) = (\[.*\]);$/gm)) lists[m[1]] = JSON.parse(m[2]);
const want = ["VACCINE", "FOOD", "ED", "WEIGHT", "RAPID", "YOUTH", "HOME", "CUT", "NUMB", "DRINK", "BENZO", "DEPEND",
  "RED", "NEWBORN", "FEVER", "DRUG", "MEDSTOP", "MEDS", "ABSENT", "DOCTRINE", "SECRET"];
const missing = want.filter(k => !Array.isArray(lists[k]));
if (missing.length) { console.error(`export-situation: situation.js no longer declares ${missing.join(", ")} on one line`); process.exit(1); }

const body = JSON.stringify({ source: "lodestone/app/js/situation.js", lists: Object.fromEntries(want.map(k => [k, lists[k]])) }, null, 0);
fs.writeFileSync(out, body + "\n");
console.log(`situation lexicons: ${want.length} lists, ${want.reduce((a, k) => a + lists[k].length, 0)} entries → ${path.relative(process.cwd(), out)}`);
