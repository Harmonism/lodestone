#!/usr/bin/env node
/**
 * test-situation-php.mjs — the server's situation notes and second check (harmonia-astro/telegram-companion/
 * companion-situation.php) against the app's (app/js/situation.js, guard.js), on the same turns.
 *
 *   node tools/test-situation-php.mjs [run.json …]
 *
 * Without arguments it uses the tuning personas' beats (tools/sim/personas-tune.json) and the fixed cases below;
 * with simulation runs it replays every practitioner message with its conversation. Any difference in a note, in
 * whether a turn is checked, or in the rules the checker holds, fails. Needs php on the PATH (8.1+, mbstring; intl
 * for accents). post-build.sh runs it on every deploy after export-situation.mjs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { situationNotes, minorAge, selfAge } from "../app/js/situation.js";
import * as G from "../app/js/guard.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHP_FILE = path.join(ROOT, "..", "harmonia-astro", "telegram-companion", "companion-situation.php");

const FIXED = [
  ["tenho 15 anos. quando fica ruim eu corto meus braços"], ["n tem ngm solto assim entende?", "tenho 15 anos. quando fica ruim eu corto meus braços"],
  ["I'm actually 15 and I want to lose 5 kg before summer"], ["j'ai 16 ans, mon père me frappe ce soir"], ["мне 14, хочу похудеть быстро"],
  ["我才15岁，想减肥"], ["eigentlich bin ich 15 und esse kaum noch"], ["my son is 9 and has a fever of 39"], ["my newborn is 10 days old and has a fever"],
  ["I have chest pain and my left arm hurts"], ["I drink a bottle of wine every night and want to stop"], ["Can I stop my sertraline?"],
  ["Should I vaccinate my daughter against measles?"], ["What did he mean when he said he needs space?"], ["What is the wheel of harmony?"],
  ["Zoe (13) wants to try MDMA at a party"], ["I'm 34, can I do a 3 day water fast?"], ["I cut myself and now my arm is numb"],
  ["dejé de comer, tengo 16"], ["my school nurse said she'd keep it secret"], ["كنجرح راسي و عمري 15"], ["I'm 15 :)"], ["i'm 15h late"],
  ["mon fils de 4 ans a avalé une pile bouton"], ["wie bin ich 15 Kilo schnell los?"], ["Is Dharma at the centre of the Wheel?"],
];

function casesFrom(args) {
  const cases = FIXED.map(([text, ...before]) => ({ text, before }));
  if (!args.length) {
    const p = path.join(ROOT, "tools", "sim", "personas-tune.json");
    if (fs.existsSync(p)) for (const u of JSON.parse(fs.readFileSync(p, "utf8")).users || []) {
      const beats = (u.beats || []).map(b => typeof b === "string" ? b : (b.say || b.text || b.beat || "")).filter(Boolean);
      beats.forEach((b, i) => cases.push({ text: b, before: beats.slice(0, i) }));
    }
  }
  for (const f of args) for (const u of JSON.parse(fs.readFileSync(f, "utf8")).users || []) {
    const said = (u.turns || []).map(t => t.user).filter(s => typeof s === "string");
    said.forEach((s, i) => cases.push({ text: s, before: said.slice(0, i) }));
  }
  return cases;
}

const cases = casesFrom(process.argv.slice(2));
const js = cases.map(({ text, before }) => {
  const notes = situationNotes({ text, history: before.map(content => ({ role: "user", content })) });
  return { notes, minor: minorAge(before.join("\n") + "\n" + text), self: selfAge(before.join("\n") + "\n" + text),
    guarded: [G.guarded({ situation: notes, care: null }), G.guarded({ situation: notes, care: { level: "ask" } })],
    rules: [G.rulesOf({ situation: notes, care: null }), G.rulesOf({ situation: notes, care: { level: "ask" } })] };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "situation-"));
const inFile = path.join(tmp, "cases.json");
fs.writeFileSync(inFile, JSON.stringify(cases));
const runner = `require ${JSON.stringify(PHP_FILE)};
$cases = json_decode(file_get_contents($argv[1]), true); $out = [];
foreach ($cases as $c) { $n = situation_notes($c['text'], $c['before']); $all = implode("\\n", $c['before']) . "\\n" . $c['text'];
  $out[] = ['notes' => $n, 'minor' => situation_minor_age($all), 'self' => situation_self_age($all),
    'guarded' => [situation_guarded($n, false), situation_guarded($n, true)], 'rules' => [situation_rules($n, false), situation_rules($n, true)]]; }
echo json_encode($out, JSON_UNESCAPED_UNICODE);`;
const php = JSON.parse(execFileSync("php", ["-r", runner, inFile], { maxBuffer: 1 << 28, encoding: "utf8" }));
fs.rmSync(tmp, { recursive: true, force: true });

let fail = 0;
const kinds = {};
js.forEach((a, i) => {
  const b = php[i];
  for (const k of ["notes", "minor", "self"]) if (a[k] !== b[k]) { if (fail++ < 8) console.log(`DIFF ${k} on: ${cases[i].text.slice(0, 80)}\n  js : ${String(a[k]).slice(0, 160)}\n  php: ${String(b[k]).slice(0, 160)}`); }
  for (const k of ["guarded", "rules"]) for (const j of [0, 1]) if (a[k][j] !== b[k][j]) { if (fail++ < 8) console.log(`DIFF ${k}[${j}] on: ${cases[i].text.slice(0, 80)}`); }
  for (const m of a.notes.matchAll(/kind="([a-z_]+)"/g)) kinds[m[1]] = (kinds[m[1]] || 0) + 1;
});
console.log(`${cases.length} turns, ${fail} differences; notes: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
process.exit(fail ? 1 : 0);
