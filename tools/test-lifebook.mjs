// test-lifebook.mjs — the life book without a window: recall (lifebook.js in app/js)
// and the writer (desktop/src/lifebook.js), in a temporary vault.
//   node tools/test-lifebook.mjs
import fs from "fs"; import os from "os"; import path from "path"; import { createRequire } from "module";
import { fileURLToPath } from "url";
import { parseEntry, selectEntries, lifeBookBlock, parseProposals, newNoteText, appendedText, proposeRequest } from "../app/js/lifebook.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const { LifeBook } = createRequire(import.meta.url)(path.join(here, "..", "desktop", "src", "lifebook.js"));
let pass = 0, fail = 0; const ok = (c, w) => { if (c) pass++; else { fail++; console.log("FAIL", w); } };

// ── recall ──
const mother = parseEntry("People/Mother.md", "---\nkeys: [mother, maman, \"ma mère\"]\naliases:\n  - Salwa\n---\n# Mother\n\nIn chemotherapy since August; cycle 3 on 2 November. Her oncologist is Dr. Benali.\n", 1);
const meds = parseEntry("Health/Medications.md", "# Medications\n\nMagnesium glycinate 400 mg at night.\n", 2);
const chemo = parseEntry("Health/Chemotherapy.md", "---\nkeys: [chemotherapy, chimio]\n---\nWhat the oncologist said about cycles.\n", 3);
const allergy = parseEntry("Health/Allergies.md", "---\nalways: true\n---\n# Allergies\n\nPenicillin.\n", 4);
const muted = parseEntry("Life/Old.md", "---\nkeys: [old]\nrecall: false\n---\nNot recalled.\n", 5);
const all = [mother, meds, chemo, allergy, muted];
ok(mother.keys.includes("ma mère") && mother.keys.includes("Salwa") && mother.keys.includes("Mother"), "keys from keys, aliases and title: " + mother.keys);
ok(allergy.always && muted.off, "always and recall:false read");
const st = new Map();
let sel = selectEntries(all, ["How is Maman doing this week?", "hello"], st);
ok(sel[0].rel === "Health/Allergies.md" && sel[0].why === "always", "always-on note first");
ok(sel.some(e => e.rel === "People/Mother.md" && e.why === "key"), "accent-insensitive whole-word key (Maman)");
ok(sel.some(e => e.rel === "Health/Chemotherapy.md" && e.why === "linked"), "a note named in a selected note comes up once removed: " + sel.map(e => e.rel + ":" + e.why));
ok(!sel.some(e => e.rel === "Life/Old.md"), "recall:false never comes up");
ok(!selectEntries(all, ["my grandmothers garden"], new Map()).some(e => e.rel === "People/Mother.md"), "no match inside another word");
// sticky: Mother stays 3 turns after it came up, then leaves
let s2 = new Map(); selectEntries(all, ["about maman"], s2);
const turns = [1, 2, 3, 4].map(() => selectEntries(all, ["something else"], s2).some(e => e.rel === "People/Mother.md"));
ok(JSON.stringify(turns) === "[true,true,true,false]", "sticky for three turns: " + JSON.stringify(turns));
// scan depth: a key four messages back still counts, six back does not
ok(selectEntries(all, ["a", "b", "c", "d", "magnesium? medications"], new Map()).some(e => e.rel === "Health/Medications.md"), "key within scan depth");
ok(!selectEntries(all, ["a", "b", "c", "d", "e", "medications"], new Map()).some(e => e.rel === "Health/Medications.md"), "key beyond scan depth ignored");
const block = lifeBookBlock(selectEntries(all, ["Salwa and her chimio"], new Map()), 2000);
ok(block.startsWith("<life_book>") && block.includes("[Mother — Lodestone/People/Mother.md]") && block.includes("cycle 3 on 2 November"), "block carries the note verbatim");
const tiny = lifeBookBlock([{ ...mother, body: "x".repeat(5000) }], 300);
ok(tiny.includes("did not fit") && tiny.length < 1200, "a note over budget is cut and says so");

// ── proposals ──
const raw = '<think>…</think>{"changes":[{"op":"create","path":"People/Brother.md","keys":["brother","Karim"],"text":"Karim, his brother, lives in Lyon."},{"op":"append","path":"Health/Medications.md","text":"Vitamin D 2000 IU since 15 October."},{"op":"replace","path":"Health/Medications.md","find":"400 mg","replace":"200 mg"},{"op":"create","path":"../etc/passwd","text":"no"}],"why":"x"}';
const pr = parseProposals(raw, all);
ok(pr.length === 3 && pr[0].op === "create" && pr[1].op === "append" && pr[2].op === "replace", "three valid proposals: " + JSON.stringify(pr.map(p => p.op + ":" + p.path)));
ok(!pr.some(p => p.path.includes("..")), "path leaving the folder dropped");
ok(parseProposals('{"changes":[{"op":"create","path":"Health/Medications.md","text":"Extra line here."}]}', all)[0].op === "append", "create on an existing note becomes append");
ok(parseProposals('{"changes":[{"op":"replace","path":"Health/Medications.md","find":"not there","replace":"y"}]}', all).length === 0, "replace of a passage not in the note dropped");
ok(parseProposals("I think you should keep this.", all).length === 0, "prose: no proposal");
ok(/Notes in the life book:\n- People\/Mother.md: mother/.test(proposeRequest(all, "convo", { touched: [mother] })), "request lists notes and keys");

// ── the writer, in a temporary vault ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lifebook-")); const vault = path.join(tmp, "Vault"); fs.mkdirSync(vault);
fs.writeFileSync(path.join(vault, "Outside.md"), "do not touch\n");
const lb = new LifeBook(() => vault);
ok(lb.entries().length === 0, "no folder yet: no notes");
let r = lb.write({ op: "create", path: "People/Mother.md", text: newNoteText("People/Mother.md", ["mother", "maman"], "In chemotherapy since August.") });
ok(r.rel === "People/Mother.md" && fs.readFileSync(path.join(vault, "Lodestone/People/Mother.md"), "utf8").startsWith("---\nkeys: [mother, maman]\n---\n# Mother"), "create writes inside Lodestone/");
const e1 = lb.entries().find(e => e.rel === "People/Mother.md");
r = lb.write({ op: "append", path: "People/Mother.md", text: appendedText("Cycle 3 on 2 November.", new Date("2026-10-19T10:00:00Z")), mtime: e1.mtime });
ok(r.after.endsWith("### 2026-10-19\n\nCycle 3 on 2 November.\n") && r.backup && fs.existsSync(path.join(vault, "Lodestone", r.backup)), "append under the date, backup kept: " + r.backup);
const e2 = lb.entries().find(e => e.rel === "People/Mother.md");
r = lb.write({ op: "replace", path: "People/Mother.md", find: "since August", replace: "since 12 August", mtime: e2.mtime });
ok(r.after.includes("since 12 August") && !r.after.includes("since August."), "replace one passage");
let threw = m => { try { m(); return false; } catch (e) { return e.message; } };
ok(/not a note path/.test(threw(() => lb.write({ op: "create", path: "../Outside.md", text: "x" }))), "parent path refused");
r = lb.write({ op: "create", path: "/Life/Abs.md", text: "x" });
ok(r.rel === "Life/Abs.md" && fs.existsSync(path.join(vault, "Lodestone/Life/Abs.md")), "a leading slash stays inside the folder");
ok(/not a note path/.test(threw(() => lb.write({ op: "create", path: "People/.hidden.md", text: "x" }))), "hidden file refused");
ok(/not a note path/.test(threw(() => lb.write({ op: "create", path: "People/x.txt", text: "x" }))), "non-Markdown refused");
fs.symlinkSync(tmp, path.join(vault, "Lodestone", "Escape"));
ok(/link/.test(threw(() => lb.write({ op: "create", path: "Escape/evil.md", text: "x" }))), "a link inside the folder is not followed: " + threw(() => lb.write({ op: "create", path: "Escape/evil.md", text: "x" })));
ok(!fs.existsSync(path.join(tmp, "evil.md")), "nothing written through the link");
ok(/changed since/.test(threw(() => lb.write({ op: "append", path: "People/Mother.md", text: "y", mtime: 1 }))), "a note changed elsewhere is not overwritten");
ok(/exactly once/.test(threw(() => lb.write({ op: "replace", path: "People/Mother.md", find: "zzz", replace: "y" }))), "replace of an absent passage refused");
ok(/already exists/.test(threw(() => lb.write({ op: "create", path: "People/Mother.md", text: "x" }))), "create over an existing note refused");
ok(fs.readFileSync(path.join(vault, "Outside.md"), "utf8") === "do not touch\n", "nothing outside Lodestone/ changed");
ok(lb.entries().every(e => !e.rel.startsWith(".backups")), "backups are not read as notes");
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
