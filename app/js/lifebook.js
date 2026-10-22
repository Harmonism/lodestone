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
//       cadence suggests keeping, shown as cards the practitioner confirms

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

Paths go in the folders People/, Health/, Practices/ or Life/, with names in the practitioner's language. Keys are the words by which the subject comes up in conversation, in the languages they use.`;

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
  const title = String(path).split("/").pop().replace(/\.md$/i, "");
  const fm = keys.length ? `---\nkeys: [${keys.map(k => /[,\[\]"']/.test(k) ? JSON.stringify(k) : k).join(", ")}]\n---\n` : "";
  return `${fm}# ${title}\n\n${String(text).trim()}\n`;
}

/** An addition to a note, under the day's date. */
export function appendedText(text, now = new Date()) {
  return `\n### ${now.toISOString().slice(0, 10)}\n\n${String(text).trim()}\n`;
}
