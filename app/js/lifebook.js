// lifebook.js — the practitioner's life book, in the window.
//
// The life book is Lodestone's own folder in the practitioner's vault
// (<vault>/Lodestone/), Markdown notes the practitioner reads and edits in
// Obsidian or any editor. Lodestone Desktop reads it on every turn and writes to
// it only what the practitioner confirms (desktop/src/lifebook.js holds the
// writing; nothing outside that folder is ever written).
//
// Recall works the way SillyTavern's lore books do (public/scripts/world-info.js):
// a note carries keys in its frontmatter (`keys:`, and Obsidian's own `aliases:`
// and the note's title count too); when a key appears in the message or the last
// few messages, the note is placed in the turn's context whole, within a budget.
// A note marked `always: true` is always there. A note that came up stays for a
// few turns (sticky), and a note's own text can bring up one more level of notes
// (recursion, once). So a fact the practitioner keeps comes back word for word
// whenever its subject does, with no summary in between.
//
//   parseEntry(rel, text, mtime)   one note: title, keys, always, body
//   selectEntries(entries, texts, state, opts)   which notes this turn, in order
//   lifeBookBlock(selected, budgetTokens)        the <life_book> block
//   PROPOSE_PROMPT, proposeRequest(), parseProposals()   what the learning
//       cadence keeps, quietly (readable and correctable in Settings → Life book)

export const SCAN_DEPTH = 4, STICKY_TURNS = 3, MAX_ENTRIES = 12, BUDGET_SHARE = 0.12;

const fold = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

function listValue(v) {
  v = String(v || "").trim();
  if (!v) return [];
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  return v.split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** Frontmatter as a map: scalars, inline lists, and "- item" lists. */
export function frontmatter(text) {
  const m = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: String(text || "") };
  const fm = {}; let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { fm[listKey].push(item[1].trim().replace(/^["']|["']$/g, "")); continue; }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) { listKey = null; continue; }
    const [, k, v] = kv;
    if (v === "") { fm[k] = []; listKey = k; } else { fm[k] = v.startsWith("[") ? listValue(v) : v.replace(/^["']|["']$/g, ""); listKey = null; }
  }
  return { fm, body: String(text).slice(m[0].length) };
}

/** One note of the life book. `rel` is its path inside Lodestone/. */
export function parseEntry(rel, text, mtime = 0) {
  const { fm, body } = frontmatter(text);
  const title = (body.match(/^#\s+(.+)$/m) || [])[1]?.trim() || String(rel).split("/").pop().replace(/\.md$/i, "");
  const keys = [...new Set([...listValue(Array.isArray(fm.keys) ? fm.keys.join(",") : fm.keys), ...listValue(Array.isArray(fm.aliases) ? fm.aliases.join(",") : fm.aliases), title]
    .map(k => k.trim()).filter(k => k.length >= 2))];
  const always = /^(true|yes|1)$/i.test(String(fm.always || ""));
  const off = /^(false|no|0)$/i.test(String(fm.recall ?? "true"));
  return { rel, title, keys, always, off, body: body.trim(), text, mtime };
}

const keyRe = new Map();
function hasKey(hay, key) {
  let re = keyRe.get(key);
  if (!re) {
    const k = fold(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    re = new RegExp(`(?<![\\p{L}\\p{N}])${k}(?![\\p{L}\\p{N}])`, "u");
    keyRe.set(key, re);
  }
  return re.test(hay);
}

/**
 * The notes for this turn. `texts` are the current message and the last few
 * messages, newest first. `state` is the thread's sticky map (rel → turns left),
 * updated in place. Order: always-on notes, then notes whose key came up (most
 * recent message first), then sticky ones, then those brought up by another
 * note's text.
 */
export function selectEntries(entries, texts, state = new Map(), { depth = SCAN_DEPTH, max = MAX_ENTRIES } = {}) {
  const live = entries.filter(e => !e.off);
  const scan = texts.slice(0, depth + 1).map(fold);
  const out = [], seen = new Set();
  const add = (e, why) => { if (!seen.has(e.rel) && out.length < max) { seen.add(e.rel); out.push({ ...e, why }); } };
  for (const e of live) if (e.always) add(e, "always");
  for (const hay of scan) for (const e of live) if (e.keys.some(k => hasKey(hay, k))) add(e, "key");
  for (const [rel, left] of state) { const e = live.find(x => x.rel === rel); if (e && left > 0) add(e, "sticky"); }
  // One level of recursion: what the selected notes say can bring up another note.
  const said = fold(out.map(e => e.body).join("\n"));
  for (const e of live) if (!seen.has(e.rel) && e.keys.some(k => hasKey(said, k))) add(e, "linked");
  // Sticky bookkeeping: a note that came up by key stays for STICKY_TURNS more turns.
  for (const [rel, left] of [...state]) { if (left <= 1) state.delete(rel); else state.set(rel, left - 1); }
  for (const e of out) if (e.why === "key") state.set(e.rel, STICKY_TURNS);
  return out;
}

const est = s => Math.ceil(String(s || "").length / 3.3);

/** The <life_book> block, within `budget` tokens; a note that does not fit whole is cut and says so. */
export function lifeBookBlock(selected, budget) {
  if (!selected.length || budget < 60) return "";
  const parts = []; let used = 30;
  for (const e of selected) {
    const head = `[${e.title} — Lodestone/${e.rel}]`;
    const room = budget - used - est(head) - 8;
    if (room < 40) break;
    let body = e.body;
    if (est(body) > room) body = body.slice(0, Math.floor(room * 3.3)) + "\n[… the rest of this note did not fit]";
    parts.push(`${head}\n${body}`);
    used += est(head) + est(body) + 8;
  }
  return parts.length ? `<life_book>\n${parts.join("\n\n")}\n</life_book>` : "";
}

// ─── Proposals: what to keep, confirmed by the practitioner ──────────────────

export const PROPOSE_PROMPT = `You keep a practitioner's life book: Markdown notes in their own vault, in Lodestone's folder, which Lodestone reads back whenever a note's subject comes up. From the conversation below, propose at most three changes worth keeping: facts they stated about their life that will matter later — people, health (conditions, medications and doses, results, appointments), practices, commitments, dates.

Only what the practitioner said, in their terms and with their numbers exact. Never your advice, interpretation or diagnosis, and nothing Lodestone said that they did not confirm. Prefer adding to an existing note over making a new one; propose nothing already in the notes. If nothing is worth keeping, propose nothing.

Reply with one JSON object and nothing else:
{"changes": [
  {"op": "create", "path": "People/Mother.md", "keys": ["mother", "maman"], "text": "One line saying what this note holds.\\n\\nWhat they said."},
  {"op": "append", "path": "Health/Medications.md", "text": "What to add."},
  {"op": "replace", "path": "Health/Medications.md", "find": "the exact text now in the note", "replace": "what it should now say"}
], "why": "one line on why these are worth keeping"}

Follow the life book's own layout. When it has notes under Wheel/ (one per pillar of the Wheel of Harmony: Presence, Health, Relationships, Matter, Service, Learning, Nature, Recreation) and People/ (one per person), a fact goes into the pillar note it belongs to and what concerns a person into that person's note. Otherwise paths go in the folders People/, Health/, Practices/ or Life/. Names are in the practitioner's language. Keys are the words by which the subject comes up in conversation, in the languages they use.`;

/** The request: the notes there are (titles and keys, and the text of those the conversation touches), then the conversation. */
export function proposeRequest(entries, convo, { touched = [], maxNote = 1500 } = {}) {
  const index = entries.map(e => `- ${e.rel}: ${e.keys.join(", ")}`).join("\n") || "(none yet)";
  const texts = touched.map(e => `[${e.rel}]\n${e.body.slice(0, maxNote)}`).join("\n\n");
  return `Notes in the life book:\n${index}${texts ? `\n\nThe notes this conversation touches, as they stand:\n${texts}` : ""}\n\nThe conversation:\n${convo}`;
}

const SAFE_PATH = /^(?!.*(?:^|\/)\.)(?!.*\.\.)[^\\:*?"<>|\u0000-\u001f]{1,160}\.md$/i;

/** The model's proposals, checked against the notes as they stand. Malformed ones are dropped, never repaired by guess. */
export function parseProposals(raw, entries) {
  const s = String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return [];
  let obj; try { obj = JSON.parse(s.slice(a, b + 1)); } catch { return []; }
  const byRel = new Map(entries.map(e => [e.rel.toLowerCase(), e]));
  const out = [];
  for (const c of (Array.isArray(obj?.changes) ? obj.changes : []).slice(0, 3)) {
    if (!c || typeof c !== "object") continue;
    let path = String(c.path || "").trim().replace(/^\/+/, "").replace(/^Lodestone\//i, "");
    if (!/\.md$/i.test(path)) path += ".md";
    if (!SAFE_PATH.test(path)) continue;
    const have = byRel.get(path.toLowerCase());
    let op = String(c.op || "");
    if (op === "create" && have) op = "append";
    if (op === "create") {
      const text = String(c.text || "").trim();
      if (text.length < 8 || text.length > 4000) continue;
      const keys = (Array.isArray(c.keys) ? c.keys : []).map(k => String(k).trim()).filter(k => k.length >= 2 && k.length <= 60).slice(0, 12);
      out.push({ op, path, keys, text });
    } else if (op === "append" && have) {
      const text = String(c.text || "").trim();
      if (text.length < 4 || text.length > 4000 || have.body.includes(text)) continue;
      out.push({ op, path: have.rel, text, mtime: have.mtime });
    } else if (op === "replace" && have) {
      const find = String(c.find || ""), replace = String(c.replace || "");
      if (!find || find === replace || have.text.split(find).length !== 2 || replace.length > 4000) continue;
      out.push({ op, path: have.rel, find, replace, mtime: have.mtime });
    }
  }
  return out;
}

/** A new note's file: keys in the frontmatter, the title as a heading, then the text. */
export function newNoteText(path, keys, text) {
  const name = String(path).split("/").pop().replace(/\.md$/i, "");
  // Kept answers are the practitioner's to reread, not memory Lodestone reads back (1.14.1).
  const kept = /^Kept\//i.test(path);
  const title = kept ? `Kept answers — ${name}` : name;
  const fm = [];
  if (keys.length) fm.push(`keys: [${keys.map(k => /[,\[\]"']/.test(k) ? JSON.stringify(k) : k).join(", ")}]`);
  if (kept) fm.push("recall: false");
  return `${fm.length ? `---\n${fm.join("\n")}\n---\n` : ""}# ${title}\n\n${String(text).trim()}\n`;
}

/** An addition to a note, under the day's date. */
export function appendedText(text, now = new Date()) {
  return `\n### ${now.toISOString().slice(0, 10)}\n\n${String(text).trim()}\n`;
}

// ─── The life book on every device (October 24, 2026) ────────────────────────
// A phone or a browser keeps notes too, not only Lodestone Desktop. What any
// device keeps goes into the synced record's queue; every device reads the
// desktop's notes with the queue laid over them, so a kept note is live at
// once everywhere, and Lodestone Desktop writes it into the vault's Lodestone/
// folder when it next opens (then it arrives back as one of the desktop's
// notes and leaves the queue). Without a desktop the queue simply is the life
// book. Two devices keeping at once lose nothing: sync unites the queues.

/** One change applied to notes [{rel, text, mtime}], as the desktop would write it, forgivingly: create on an existing note appends, append to a missing note creates it, a replace whose passage is not there once is left out. */
export function applyChange(notes, change, ts = Date.now()) {
  const path = String(change?.path || "");
  if (!SAFE_PATH.test(path)) return notes;
  const i = notes.findIndex(n => n.rel.toLowerCase() === path.toLowerCase());
  const out = notes.slice();
  if (change.op === "create" || (change.op === "append" && i < 0)) {
    if (i < 0) out.push({ rel: path, text: change.op === "create" ? String(change.text || "") : newNoteText(path, [], String(change.text || "")), mtime: ts, pending: true });
    else out[i] = { ...out[i], text: out[i].text.replace(/\s*$/, "\n") + appendedText(parseEntry(path, String(change.text || "")).body, new Date(ts)), pending: true };
  } else if (change.op === "append") {
    out[i] = { ...out[i], text: out[i].text.replace(/\s*$/, "\n") + String(change.text || ""), pending: true };
  } else if (change.op === "replace" && i >= 0) {
    const find = String(change.find || "");
    if (find && out[i].text.split(find).length === 2) out[i] = { ...out[i], text: out[i].text.replace(find, () => String(change.replace ?? "")), pending: true };
  }
  return out;
}

/** The life book as every device reads it: the desktop's notes, then what was kept elsewhere and not yet written. */
export function withPending(record) {
  const done = new Set(record?.applied || []);
  let notes = (record?.notes || []).map(n => ({ ...n }));
  for (const q of [...(record?.queue || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0))) if (q?.change && !done.has(q.id)) notes = applyChange(notes, q.change, q.ts);
  return notes;
}

/** A note's file with its frontmatter. */
export function noteText(path, { keys = [], always = false } = {}, body = "") {
  const fm = [];
  if (keys.length) fm.push(`keys: [${keys.map(k => /[,\[\]"':]/.test(k) ? JSON.stringify(k) : k).join(", ")}]`);
  if (always) fm.push("always: true");
  const title = String(path).split("/").pop().replace(/\.md$/i, "");
  return `${fm.length ? `---\n${fm.join("\n")}\n---\n` : ""}# ${title}\n\n${String(body).trim()}\n`;
}

// Capitalised words that name nothing of the person's own.
const NOT_NAMES = new Set(("Lodestone Telegram Harmonism Harmonia Harmonic Wheel Profile Presence Health Matter Service Relationships Learning Nature Recreation " +
  "The She He Her His They Their This That These Those When While After Before Since During Until Also Only Once Each Every Both Never Always Still " +
  "Takes Prefers Follow Lives Works Uses Has Had Was Is Not Mother Father Son Daughter Wife Husband Elle Il Ils Elles Son Sa Ses Leur Leurs Cette Ce Ces Quand Depuis Avant Après Pendant Mais Aussi Toujours Jamais Une Un Les Des Le La " +
  "January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday " +
  "Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Janv Févr Avr Juil Déc MAD EUR USD " +
  "First Last Earlier Later Pattern Came Asked Said Told Birth Aunt Uncle Tante Oncle Reports Report Taper Spike Prof Sons Heart Brain Dossier Clinique Foundation Note Notes " +
  "Janvier Février Mars Avril Mai Juin Juillet Août Septembre Octobre Novembre Décembre Lundi Mardi Mercredi Jeudi Vendredi Samedi Dimanche").split(" "));

function namesIn(texts, { loose = false } = {}) {
  // A capitalised word inside a sentence is a name; one that opens a sentence
  // counts when it comes back (names do: "Jad …", "… with Jad") or also stands inside one.
  const inner = new Map(), opening = new Map();
  for (const t of texts) for (const sentence of String(t).split(/(?<=[.!?;:])\s+|\n+/)) {
    const words = sentence.trim().match(/[\p{L}\p{M}'’-]+/gu) || [];
    words.forEach((w0, i) => {
      if (!/^\p{Lu}/u.test(w0)) return;
      const w = w0.replace(/['’]s$/, "").replace(/[-'’]+$/, "");
      if (w.length < 3 || NOT_NAMES.has(w) || (w === w.toUpperCase() && w.length > 6)) return;
      const m = i === 0 ? opening : inner;
      m.set(w, (m.get(w) || 0) + 1);
    });
  }
  // Among people (loose), a name often opens the only sentence it is in: taken unless it is a common word in lower case elsewhere.
  const all = texts.join("\n");
  const asCommonWord = w => new RegExp(`(^|[^\\p{L}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u").test(all);
  for (const [w, n] of opening) if (n >= 2 || inner.has(w) || (loose && !asCommonWord(w))) inner.set(w, (inner.get(w) || 0) + n);
  return [...inner.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

const SEED_GROUPS = [
  { file: "How to speak with me", cats: ["register", "preference"], always: true, keys: [] },
  { file: "Open threads", cats: ["open_thread"], always: true, keys: [] },
  { file: "Health", cats: ["health", "medication"], keys: ["health", "santé", "medication", "médicament", "traitement", "treatment", "doctor", "médecin", "symptom", "symptôme"] },
  { file: "People", cats: ["family", "people"], keys: ["family", "famille"], loose: true },
  { file: "Practices and goals", cats: ["practice", "goal"], keys: ["practice", "pratique", "goal", "objectif", "méditation", "meditation"] },
  { file: "Life", cats: ["history", "logistics"], keys: [] },
];

/**
 * Notes for a new life book, from the facts a carried memory holds (profile_notes
 * rows, as migrate-telegram-to-held.php writes them): one note per kind, keyed by
 * the names and subjects in it, so each comes back word for word when its
 * subject does. `folder` is where they go inside Lodestone/.
 */
export function seedNotes(rows, folder = "From Telegram", { self = [] } = {}) {
  const own = new Set(self.flatMap(n => String(n || "").split(/\s+/)).filter(Boolean).map(fold));
  const notes = [];
  const used = new Set();
  for (const g of [...SEED_GROUPS, { file: "Other", cats: null, keys: [] }]) {
    const mine = rows.filter(r => r?.observation && !used.has(r) && (g.cats ? g.cats.includes(String(r.category)) : true));
    mine.forEach(r => used.add(r));
    if (!mine.length) continue;
    const obs = mine.map(r => String(r.observation).trim());
    const keys = g.always ? [] : [...new Set([...g.keys, ...namesIn(obs, { loose: !!g.loose }).filter(w => !own.has(fold(w))).slice(0, 40)])];
    const path = `${folder}/${g.file}.md`;
    notes.push({ path, keys, always: !!g.always, count: obs.length, text: noteText(path, { keys, always: !!g.always }, obs.map(o => `- ${o}`).join("\n")) });
  }
  return notes;
}


// ─── Organizing the life book (October 24, 2026) ─────────────────────────────
// One action lays the whole life book out again — by default one note per pillar
// of the Wheel of Harmony, one per person, and the two notes that are always
// there — and is kept, like everything else, only with Keep. The model only
// MOVES lines: every line of the new notes is a line of the old ones, word for
// word, or a heading it adds; a line it invents is dropped, a line it leaves out
// goes to Unsorted.md. The old notes are switched off (recall: false), never
// deleted, so the life book as it was is still there to read. `lifebook: 2` in a
// note's frontmatter names the layout, for a later upgrade to recognise.

export const LAYOUT_VERSION = 2;
export const PILLARS = ["Presence", "Health", "Relationships", "Matter", "Service", "Learning", "Nature", "Recreation"];
const PILLAR_KEYS = {
  Presence: ["presence", "méditation", "meditation", "prière", "prayer", "spiritualité", "spirituality", "silence", "breath", "souffle"],
  Health: ["health", "santé", "médecin", "doctor", "medication", "médicament", "traitement", "treatment", "sleep", "sommeil", "symptôme", "symptom"],
  Relationships: ["relationships", "relations", "family", "famille", "friend", "ami", "amie", "couple"],
  Matter: ["money", "argent", "finance", "home", "maison", "appartement", "work", "travail", "contract", "contrat"],
  Service: ["service", "work", "travail", "métier", "vocation", "association", "project", "projet"],
  Learning: ["learning", "apprendre", "book", "livre", "lecture", "reading", "study", "études", "language", "langue"],
  Nature: ["nature", "garden", "jardin", "walk", "marche", "sea", "mer", "forest", "forêt", "animals", "animaux"],
  Recreation: ["recreation", "loisir", "travel", "voyage", "music", "musique", "dance", "danse", "film", "sport", "game", "jeu"],
};

export const ORGANIZE_PROMPT = `You lay out a practitioner's life book again: the Markdown notes Lodestone reads back, word for word, whenever a note's subject comes up. Rearrange ALL of its lines into this layout:

- "How to speak with me.md": how they want to be spoken to (always present).
- "Open threads.md": what is pending, promised or awaited, with dates (always present).
- "Wheel/<Pillar>.md" for each pillar of the Wheel of Harmony that has something: Presence, Health, Relationships, Matter, Service, Learning, Nature, Recreation. Health holds conditions, medications with doses, results, practitioners, symptoms; Relationships holds the life of their relationships as such.
- "People/<Name>.md" for each person who matters to them, named as they name that person, with the person's other names and roles as keys (e.g. ["Mimi", "Mariam", "ma fille"]).

The one rule: MOVE lines, never write them. Every line you place must be copied character for character from the notes below. You may add headings of your own ("## Medications", "### 2026-08"), and a line may go in two notes when it truly belongs to both (a person's health in People and in Health). Keep each line's date heading with it when the date matters. Leave out nothing; drop nothing; do not merge, shorten, correct or translate. Do not include the notes' own frontmatter or titles.

Reply with one JSON object and nothing else:
{"notes": [
  {"path": "Wheel/Health.md", "keys": ["health", "santé", "Levothyrox"], "always": false, "lines": ["## Medications", "- an exact line from the notes", "..."]},
  {"path": "People/Mimi.md", "keys": ["Mimi", "Mariam"], "lines": ["..."]}
]}`;

const norm = l => String(l || "").replace(/\s+/g, " ").trim();
const isHeading = l => /^#{1,6}\s+\S/.test(String(l).trim());

/** The lines of the life book that carry something (not titles, not blank, not frontmatter). */
export function bookLines(entries) {
  const out = [];
  for (const e of entries.filter(x => !x.off)) for (const raw of String(e.body).split(/\r?\n/)) {
    const l = raw.replace(/\s+$/, "");
    if (!norm(l) || isHeading(l)) continue;
    out.push({ line: l, from: e.rel });
  }
  return out;
}

/** The request: every note, whole, under its path. */
export function organizeRequest(entries) {
  return entries.filter(e => !e.off).map(e => `[${e.rel}]${e.always ? " (always)" : ""}${e.keys.length ? ` keys: ${e.keys.join(", ")}` : ""}\n${e.body}`).join("\n\n");
}

/**
 * The model's layout, made safe: lines not found word for word in the book are
 * dropped (counted), headings kept, keys checked, the always notes marked, and
 * every line it left out gathered in Unsorted.md. Returns
 * { notes: [{path, keys, always, text, lines}], invented, unsorted, moved } or null.
 */
export function parseOrganize(raw, entries) {
  const s = String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let obj; try { obj = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const source = bookLines(entries);
  const known = new Map(source.map(x => [norm(x.line), x.line]));
  const placed = new Set();
  let invented = 0;
  const notes = [];
  for (const n of (Array.isArray(obj?.notes) ? obj.notes : [])) {
    let path = String(n?.path || "").trim().replace(/^\/+/, "").replace(/^Lodestone\//i, "");
    if (!/\.md$/i.test(path)) path += ".md";
    if (!SAFE_PATH.test(path) || notes.some(x => x.path.toLowerCase() === path.toLowerCase())) continue;
    const lines = [];
    for (const l of (Array.isArray(n.lines) ? n.lines : [])) {
      const t = String(l ?? "");
      if (isHeading(t) && t.length <= 100) { lines.push(t.trim()); continue; }
      const hit = known.get(norm(t));
      if (hit == null) { if (norm(t)) invented++; continue; }
      lines.push(hit); placed.add(norm(t));
    }
    if (!lines.some(l => !isHeading(l))) continue;
    const file = path.split("/").pop().replace(/\.md$/i, "");
    const always = /^(how to speak with me|open threads)$/i.test(file) || n.always === true;
    const pillar = path.startsWith("Wheel/") && PILLARS.find(p => p.toLowerCase() === file.toLowerCase());
    const own = always ? [] : [...new Set((Array.isArray(n.keys) ? n.keys : []).map(k => String(k).trim()).filter(k => k.length >= 2 && k.length <= 60))];
    const keys = always ? [] : [...new Set([...(pillar ? PILLAR_KEYS[pillar] : []), ...own])].slice(0, 40);
    notes.push({ path, keys, own, always, lines, text: layoutNoteText(path, { keys, always }, lines) });
  }
  const left = [];
  for (const x of source) if (!placed.has(norm(x.line)) && !left.some(y => norm(y) === norm(x.line))) left.push(x.line);
  if (left.length) {
    const path = "Unsorted.md";
    notes.push({ path, keys: [], always: false, unsorted: true, lines: left, text: layoutNoteText(path, { keys: [] }, ["Lines the sorting did not place, kept as they were, to sort by hand.", "", ...left]) });
  }
  if (!notes.length) return null;
  return { notes, invented, unsorted: left.length, moved: placed.size };
}

// ─── Where a kept line goes (1.14.1) ──────────────────────────────────────────
// What the practitioner keeps about themselves goes to the pillar of the Wheel it
// concerns (Wheel/<Pillar>.md), or to Unsorted.md for the next Organize; an
// answer of Lodestone's they keep goes to Kept/<Pillar>.md, a shelf to reread
// that Lodestone does not read back (recall: false), so its memory holds facts
// about them and not its own past words.

/** The pillar a text is most about, by the pillars' own words; null when none is named. */
export function guessPillar(text) {
  const hay = fold(text);
  let best = null, top = 0;
  for (const p of PILLARS) {
    const n = PILLAR_KEYS[p].filter(k => hasKey(hay, k)).length;
    if (n > top) { top = n; best = p; }
  }
  return best;
}
/** The keys a new Wheel/<Pillar>.md note starts with, so it comes back when its subject does. */
export function keysForPath(path) {
  const m = String(path).match(/^Wheel\/([^/]+)\.md$/i);
  const p = m && PILLARS.find(x => x.toLowerCase() === m[1].toLowerCase());
  return p ? [...PILLAR_KEYS[p]] : [];
}

function layoutNoteText(path, { keys = [], always = false }, lines) {
  const fm = [`lifebook: ${LAYOUT_VERSION}`];
  if (keys.length) fm.push(`keys: [${keys.map(k => /[,\[\]"':]/.test(k) ? JSON.stringify(k) : k).join(", ")}]`);
  if (always) fm.push("always: true");
  const title = String(path).split("/").pop().replace(/\.md$/i, "");
  return `---\n${fm.join("\n")}\n---\n# ${title}\n\n${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/**
 * The changes that put a layout in place over the notes there are: each new note
 * created, or rewritten whole when its path is taken; each old note not kept by
 * path switched off with recall: false in its frontmatter. Nothing is deleted.
 */
export function organizeChanges(layout, entries) {
  const changes = [];
  const byRel = new Map(entries.map(e => [e.rel.toLowerCase(), e]));
  const keep = new Set(layout.notes.map(n => n.path.toLowerCase()));
  for (const n of layout.notes) {
    const have = byRel.get(n.path.toLowerCase());
    changes.push(have ? { op: "replace", path: have.rel, find: have.text, replace: n.text, ...(have.pending ? {} : { mtime: have.mtime }) } : { op: "create", path: n.path, text: n.text });
  }
  for (const e of entries) {
    if (keep.has(e.rel.toLowerCase()) || e.off) continue;
    const m = String(e.text).match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const mt = e.pending ? {} : { mtime: e.mtime };
    if (m) {
      const block = m[0];
      const next = /^recall:/m.test(block) ? block.replace(/^recall:.*$/m, "recall: false") : block.replace(/\r?\n---\r?\n?$/, "\nrecall: false\n---\n");
      changes.push({ op: "replace", path: e.rel, find: block, replace: next, ...mt });
    } else {
      const first = String(e.text).split(/\r?\n/)[0];
      if (first && String(e.text).split(first).length === 2) changes.push({ op: "replace", path: e.rel, find: first, replace: `---\nrecall: false\n---\n${first}`, ...mt });
    }
  }
  return changes;
}

// ─── A large life book, laid out in parts ────────────────────────────────────
// One pass has to write every line back, so its size is bounded by what one
// answer may hold. A larger book is cut into parts of whole notes (a note too
// large for a part is cut between its lines); each part is laid out into the
// same layout, told the notes the earlier parts made so it reuses their paths,
// and the parts' layouts are merged into one plan, kept with one Keep.

/** Parts of at most `maxChars` characters, of whole notes where they fit. */
export function organizeBatches(entries, maxChars = 40000) {
  const live = entries.filter(e => !e.off);
  const parts = []; let cur = [], size = 0;
  const flush = () => { if (cur.length) parts.push(cur); cur = []; size = 0; };
  for (const e of live) {
    const len = e.body.length + e.rel.length + 40;
    if (len > maxChars) {
      // a note too large for one part: its lines, in pieces, each read as that note
      flush();
      let piece = [], n = 0, k = 1;
      for (const l of String(e.body).split(/\r?\n/)) {
        if (n + l.length + 1 > maxChars && piece.length) { parts.push([{ ...e, rel: e.rel, body: piece.join("\n"), piece: k++ }]); piece = []; n = 0; }
        piece.push(l); n += l.length + 1;
      }
      if (piece.length) parts.push([{ ...e, body: piece.join("\n"), piece: k }]);
      continue;
    }
    if (size + len > maxChars) flush();
    cur.push(e); size += len;
  }
  flush();
  return parts;
}

/** The request for one part: the notes the earlier parts made, then this part's notes. */
export function organizeBatchRequest(part, made = [], index = 0, count = 1) {
  const head = count > 1 ? `This is part ${index + 1} of ${count} of the life book; lay out only the lines below.${made.length ? ` Notes the earlier parts made (reuse these paths for the same pillar or person): ${made.join(", ")}.` : ""}\n\n` : "";
  return head + organizeRequest(part);
}

/** Several parts' layouts as one: notes of one path joined (each line once), keys united, counts added. */
export function mergeLayouts(layouts) {
  const byPath = new Map(); let invented = 0, unsorted = 0, moved = 0;
  for (const L of layouts.filter(Boolean)) {
    invented += L.invented; unsorted += L.unsorted; moved += L.moved;
    for (const n of L.notes) {
      const k = n.path.toLowerCase();
      const have = byPath.get(k);
      if (!have) { byPath.set(k, { ...n, lines: [...n.lines], keys: [...n.keys], own: [...(n.own || [])] }); continue; }
      const seen = new Set(have.lines.filter(l => !isHeading(l)).map(norm));
      for (const l of n.lines) { if (isHeading(l) ? have.lines.includes(l) : seen.has(norm(l))) continue; have.lines.push(l); if (!isHeading(l)) seen.add(norm(l)); }
      have.keys = [...new Set([...have.keys, ...n.keys])].slice(0, 40);
      have.own = [...new Set([...have.own, ...(n.own || [])])];
      have.always = have.always || n.always;
    }
  }
  const intro = "Lines the sorting did not place, kept as they were, to sort by hand.";
  const notes = [...byPath.values()].map(n => ({ ...n, text: layoutNoteText(n.path, { keys: n.always ? [] : n.keys, always: n.always }, n.unsorted ? [intro, "", ...n.lines] : n.lines) }));
  // Unsorted last
  notes.sort((a, b) => (a.unsorted ? 1 : 0) - (b.unsorted ? 1 : 0));
  return notes.length ? { notes, invented, unsorted, moved } : null;
}
