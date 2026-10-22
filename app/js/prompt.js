// prompt.js — assembles Lodestone's context for one turn.
//
// Layout: one system message carries persona, backbone, person_context and date (stable), then
// the per-turn blocks (retrieval, witness, governor) at its end, as production does below its
// cache breakpoint. User turns stay plain text. Tested on Qwen3-1.7B: retrieval placed inside the
// user turn made the model echo the context back verbatim and loop; placed here, it answers.
//
// The persona is condensed from companion-api.php's system prompt. Items there that
// contradict backbone v2.4 were not carried: "eight pillars (7+1)" count phrasing,
// the seven-pillar Architecture (now eleven around Dharma), Harmonic Realism glossed as
// "physical, vital, mental, spiritual" (retired), Service centred on Dharma (now Offering).

export const PILLARS = [
  ["presence", "Presence"], ["health", "Health"], ["matter", "Matter"], ["service", "Service"],
  ["relationships", "Relationships"], ["learning", "Learning"], ["nature", "Nature"], ["recreation", "Recreation"],
];
// The Wheel's seven-level scale
export const LEVELS = ["unknown", "absent", "nascent", "functional", "developing", "sophisticated", "sovereign"];

const PERSONA = `You are Lodestone, Harmonia's companion of alignment: the living interface between Harmonism as written doctrine and Harmonism as embodied practice. You apply Harmonism's architecture to one person's life. You are named for the lodestone, the stone that turns a compass needle toward north. %WHERE%

Identity. You are not a therapist, coach, guru or teacher. Your authority comes from fidelity to the system, not from personal realization. When something is beyond your competence (deep trauma, active crisis, a question that needs a living teacher), say so and point to human support.

Voice. Warm without being soft, direct without being aggressive. Confident in the doctrine, humble about the individual path. Never flatter and never pathologize. Open with substance. Never begin with "Good question" or any other remark about the question. Make no jokes. Write short paragraphs with no bullet points and no headers unless asked. Default length is 60 to 180 words; go longer only when asked. Answer in the language the practitioner writes in. Dharma and Logos stay untranslated. In French write l'Harmonisme, harmoniste, la Roue de l'Harmonie, la Voie de l'Harmonie, l'Architecture de l'Harmonie, le Réalisme harmonique.

Register. Ask before you prescribe, and ask at most one question per reply. With the philosophically oriented, speak in terms of Logos, Dharma and the Wheel. With the practically oriented, speak concretely: sleep, food, money, people. The content is the same either way; only the entry point differs.

Sequencing. Crisis in one pillar overrides the spiral: triage first. A person with collapsed Health does not need Relationship advice yet. When concerns are scattered across three or more pillars, name the fragmentation and return to the Way of Harmony. Name a pillar only when the experience structurally belongs to that pillar's spokes.

Vault first. The <vault_knowledge> block, when present, contains excerpts from the Harmonism corpus stored on this device. Lead with what those excerpts say and name each article by its title. Never invent an article title, a quotation or a URL. Never give a dose, schedule, substance protocol or procedure unless it is written in the excerpts; otherwise name the article to read. If nothing retrieved covers the question, say that this turn's retrieval did not surface it and ask for the topic by name. Do not claim to have no access to the corpus. An <earlier_retrievals> block, when present, lists the articles each of your recent replies was given: an article named there was retrieved for that reply, even when this turn's block does not hold it. Never write a list of retrieved articles into a reply yourself; the app shows them beneath it.

Whole articles. A <full_article> block holds the complete text of a corpus article: the one the practitioner asked you to read in full, or, when the window allows, one or two that their question rests on. They are the corpus, not attachments: name each article by its title and read it end to end before you answer. Where a block says it was shortened, say so, and say which part you did not see.

The web. A <web_results> block, or search results the model service adds to the conversation, appears only when the practitioner asked you to look something up online for this question. It holds pages from the open internet, not the corpus. Use it for facts about the world (events, prices, people, studies), name the site behind each claim, and never let it override the doctrinal backbone or the corpus: where a page contradicts Harmonism, say so plainly. If the pages do not answer the question, say that.

Attachments. An <attached_files> block holds files the practitioner attached: their documents, the text of their PDFs, transcripts of their recordings. Images they attached are in their message. These are their materials, not the corpus: read them closely, refer to each by name, quote exactly when you quote, and read them from the ground of the backbone and the corpus. A transcript was made by a speech model and can mishear; where a word matters and looks wrong, say so. Where a file was shortened to fit, say so if it matters. Never claim to have seen a page, a part of a recording or a detail of an image that is not there.

Their folders. A <your_folders> block holds passages from folders on this computer that the practitioner has chosen to let you read: their own notes and writings, found by matching words in their message. Each passage names its file. Use them when they bear on what is asked, name the file when you draw on one, quote exactly when you quote, and never claim to have read a file or a part of one that is not in the block. These are their words, not the corpus: read them from the ground of the backbone and the corpus. You cannot change, move or delete anything in these folders; if asked to, say so.

Memory. <person_context> is everything you know about this person: what the practitioner wrote, and, marked as such, what Lodestone has learned from their own words in past conversations, which they can read and correct. You infer nothing beyond it. Never claim a prior exchange you cannot see. When they tell you something new about themselves, you are learning it now. Never answer "I know." A <conversation_summary> block, when present, summarizes the earlier part of this conversation, which is no longer sent turn by turn: it is what was said, not your own recollection of saying it, and where the practitioner's words in this conversation differ from it, their words win. A <life_book> block holds notes from the practitioner's own life book, in their vault: written by them, or by Lodestone with their consent, and brought here because their subject came up. Take them as their record, exact; where they and the conversation differ, ask which holds now. Never say a note exists that is not in the block.`;

// Where the model runs, stated truthfully. On the practitioner's own hardware
// nothing leaves it; with a model they rent under their own key, the corpus,
// the memory and the safeguards stay on their computer, but every turn passes
// through the provider, and Lodestone must never say otherwise.
// harmonism.io's hosted models are not rented under a key: say that
// instead, on the desktop as on a phone.
export function whereLine(where, { device = "computer" } = {}) {
  if (!where) return "You are running offline on the practitioner's own device, and nothing they say leaves it.";
  if (where === "harmonism.io") return `Your model is one of harmonism.io's hosted models, which the practitioner uses through their harmonism.io account. The corpus, their memory and your safeguards stay on their ${device}, but each message you answer passes through harmonism.io and the model provider it calls. If they ask whether anything leaves their ${device}, say so plainly.`;
  return `Your model runs at ${where}, which the practitioner rents with their own key. The corpus, their memory and your safeguards stay on their ${device}, but each message you answer passes through ${where}. If they ask whether anything leaves their ${device}, say so plainly.`;
}

// For a hosted turn, harmonism.io replaces whatever stands between the
// backbone tags with its own backbone (lodestone-desktop-api.php), so the phone
// sends a placeholder rather than 80 KB with every message.
const SERVER_BACKBONE = "(harmonism.io places its current doctrinal backbone here.)";

export function buildSystem({ tier, runtime, person, turn = {}, now = new Date(), where = null, device = "computer" }) {
  const backbone = tier.backbone === "full" ? runtime.backbone.full : tier.backbone === "server" ? SERVER_BACKBONE : runtime.backbone.light;
  const date = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const perTurn = [turn.held, turn.calibration, turn.summary, turn.lifebook, turn.recall, turn.reading, turn.page, turn.files, turn.folders, turn.article, turn.vault, turn.earlier, turn.web, turn.witness, turn.governor, turn.care].filter(Boolean).join("\n\n");
  return `${PERSONA.replace("%WHERE%", whereLine(where, { device }))}

<doctrinal_backbone>
${backbone}
</doctrinal_backbone>

${personContext(person)}

<temporal>Today is ${date}.</temporal>${perTurn ? "\n\n" + perTurn : ""}

Everything above is context for you. Never reproduce these blocks or their tags; answer the practitioner's latest message in your own words.`;
}

/** What website Lodestone has come to understand of this person, from the memory they hold. */
export function heldBlock(blocks) {
  if (!blocks) return "";
  const parts = [blocks.profile, blocks.reading].filter(x => x && String(x).trim()).map((x, i) => String(x).trim().slice(0, i ? 3000 : 6000));
  return parts.length ? `<what_munai_has_learned>\nWhat Lodestone has come to understand of this person across their conversations, on harmonism.io, in the browser extension and in this app:\n${parts.join("\n\n")}\n</what_munai_has_learned>` : "";
}

export function personContext({ profile = {}, wheel = {}, practices = [], assessment = null, learned = [] } = {}) {
  const lines = [];
  if (profile.name) lines.push(`Name: ${profile.name}`);
  if (assessment) lines.push(`Their Harmonic Profile assessment, as they shared it:\n${String(assessment).slice(0, 2500)}`);
  if (profile.notes && profile.notes.trim()) lines.push(`In their own words: what they asked you always to know. It is true as they wrote it, and outranks anything inferred below:\n${profile.notes.trim().slice(-4000)}`);
  const read = PILLARS.filter(([k]) => wheel[k] != null && wheel[k] > 0).map(([k, n]) => `${n}: ${LEVELS[wheel[k]]}`);
  if (read.length) lines.push(`Their Wheel reading (their own; a level Lodestone proposed counts only once they accepted it): ${read.join("; ")}`);
  const active = practices.filter(p => !p.archived);
  if (active.length) {
    lines.push("Practices they have committed to:\n" + active.slice(0, 8).map(p => {
      const last = (p.log || []).slice(-3).map(l => `${l.status} ${new Date(l.ts).toISOString().slice(0, 10)}`).join(", ");
      return `- [${cap(p.pillar)}] ${p.text}${last ? ` (recent check-ins: ${last})` : " (no check-in yet)"}`;
    }).join("\n"));
  }
  for (const l of learned || []) if (l) lines.push(l);
  if (!lines.length) return "<person_context>\nNothing yet. This person has written nothing about themselves. Treat them as new.\n</person_context>";
  return `<person_context>\n${lines.join("\n\n")}\n</person_context>`;
}

/** Rough token estimate, conservative for multilingual text. */
export const estTokens = s => Math.ceil((s || "").length / 3.3);

// A model that sees a list of retrieved articles in its own earlier replies
// copies the pattern, and what it writes need not be true (1.5.3). The list
// is the app's to show, so a model-written one is removed on the way in and out.
const NOTE_RE = /\n*\(Articles retrieved for this reply:[^)]*\)\.?[ \t]*/gi;
export const stripRetrievalNote = s => (s || "").replace(NOTE_RE, "").trimEnd();

/**
 * The articles each recent reply was given, for the <earlier_retrievals> block:
 * what lets a later turn, or another model, tell a cited article from an
 * invented one. `titleOf` maps a path to a title.
 */
export function earlierBlock(history = [], titleOf, { last = 6 } = {}) {
  const rows = history.filter(m => m.role === "assistant" && m.meta?.sources?.length && !m.meta?.crisis).slice(-last);
  if (!rows.length) return "";
  const lines = rows.map((m, i) => {
    const titles = m.meta.sources.map(titleOf).filter(Boolean);
    return titles.length ? `${rows.length - i === 1 ? "Your last reply" : `${rows.length - i} replies ago`}: ${titles.join("; ")}` : "";
  }).filter(Boolean);
  return lines.length ? `<earlier_retrievals>\n${lines.join("\n")}\n</earlier_retrievals>` : "";
}

/** The summary of the turns no longer sent one by one, for the <conversation_summary> block. */
export const summaryBlock = text => (text && text.trim() ? `<conversation_summary>\n${text.trim()}\n</conversation_summary>` : "");

// The record of a long conversation's earlier turns (October 19, 2026, after
// Goose's conversation compaction, crates/goose-context-management): asked for
// as JSON with sections ordered most important first, the practitioner's own
// words kept verbatim, read leniently, and kept as the model wrote it when it
// is not JSON (small models often are not), so a good summary is never lost to
// its format.
const SUMMARY_SYSTEM = `You write the record that lets Lodestone, a Harmonist companion, continue a conversation with a practitioner after its earlier turns are no longer sent. Lodestone reads it on every later turn in place of those turns. Write in the language the practitioner writes in.

Reply with one JSON object and nothing else, in this shape. Every list runs from most to least important; each entry is a plain string; leave a field out rather than invent content for it.
{
  "working_on": ["what the practitioner is working on, and why"],
  "about_them": ["what they said about themselves that will matter later: people, situations, health, constraints, dates, numbers, exactly as given"],
  "their_words": ["the sentences of theirs that carry the most, quoted word for word"],
  "commitments": ["decisions made, practices taken up, commitments given, with any date"],
  "positions": ["positions they took and objections they raised, in their own terms"],
  "open": ["questions still open, and what they asked for that has not been answered"],
  "drew_on": ["corpus articles the conversation drew on, by title"]
}

Keep names, numbers, doses, dates and quoted words exact. Drop pleasantries, and anything Lodestone said that the practitioner did not take up. Do not interpret, diagnose or add anything that was not said. If a previous record is given, fold it in: yours replaces it and must keep what in it still matters. At most 450 words in all.`;

const SUMMARY_FIELDS = [["working_on", "Working on"], ["about_them", "About them"], ["their_words", "In their words"], ["commitments", "Commitments"], ["positions", "Their positions"], ["open", "Still open"], ["drew_on", "Drew on"]];

/**
 * The model's summary as the text kept with the thread: the JSON rendered as
 * one line per section, or, when it is not JSON or holds nothing, what the
 * model wrote, unchanged.
 */
export function renderSummary(raw) {
  const text = String(raw || "").trim();
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return text;
  let obj; try { obj = JSON.parse(text.slice(a, b + 1)); } catch { return text; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return text;
  const str = v => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? Object.values(v).filter(x => x != null).map(String).join(": ") : String(v)).trim();
  const lines = [];
  for (const [key, label] of SUMMARY_FIELDS) {
    const items = (Array.isArray(obj[key]) ? obj[key] : obj[key] != null ? [obj[key]] : []).map(str).filter(Boolean);
    if (!items.length) continue;
    const shown = key === "their_words" ? items.map(q => /^[“"«]/.test(q) ? q : `“${q}”`) : items;
    lines.push(`${label}: ${shown.join(key === "their_words" ? " " : "; ")}`);
  }
  return lines.length ? lines.join("\n") : text;
}

/** The messages for a summary call: the previous summary, then the turns to fold into it. */
export function summaryRequest({ previous = "", turns = [], titleOf = () => "", maxChars = 1800 }) {
  const lines = turns.map(m => {
    const said = String(m.role === "assistant" ? stripRetrievalNote(m.content) : m.content).slice(0, maxChars);
    const drew = m.role === "assistant" && m.meta?.sources?.length ? ` [drew on: ${m.meta.sources.map(titleOf).filter(Boolean).join("; ")}]` : "";
    return `${m.role === "assistant" ? "Lodestone" : "Practitioner"}${drew}: ${said}`;
  });
  return [
    { role: "system", content: SUMMARY_SYSTEM },
    { role: "user", content: `${previous ? `Previous record:\n${previous}\n\n` : ""}Turns to fold in:\n\n${lines.join("\n\n")}` },
  ];
}

// When to fold, and how much: see main.js § The discussion summary.
export const SUMMARY_AFTER = 40, SUMMARY_KEEP = 16, SUMMARY_MIN = 4, KEEP_MIN = 2, COMPACT_AT = 0.8, KEEP_SHARE = 0.4;

/**
 * The turns to fold now, or null. `pending` are the turns the summary does not
 * hold yet, oldest first; `fit` is the last turn's fitMessages() result, whose
 * `room` is what the window leaves for history. Pressure is measured on what is
 * pending now (the reply just written included), not on what the last turn
 * sent, so the fold comes before the next turn would drop anything.
 */
export function summaryPlan(pending, fit) {
  if (pending.length < SUMMARY_MIN) return null;
  const cost = m => estTokens(String(m.content || "")) + 8;
  const room = fit && fit.room ? fit.room : 0;
  const total = pending.reduce((n, m) => n + cost(m), 0);
  const pressed = room > 0 && (fit.dropped > 0 || total >= room * COMPACT_AT);
  if (pending.length < SUMMARY_AFTER && !pressed) return null;
  let keep = Math.min(SUMMARY_KEEP, pending.length - 2);
  if (room) {
    let used = 0, n = 0;
    for (let k = pending.length - 1; k >= 0 && n < SUMMARY_KEEP; k--) {
      const t = cost(pending[k]);
      if (used + t > room * KEEP_SHARE && n >= KEEP_MIN) break;
      used += t; n++;
    }
    keep = Math.min(keep, Math.max(KEEP_MIN, n));
  }
  const fold = pending.slice(0, pending.length - keep);
  return fold.length ? fold : null;
}

/** One corpus article in full, for the <full_article> block; `text` may be cut to fit the window. */
export function fullArticleBlock(article, text, cut = false) {
  if (!article) return "";
  return `<full_article title="${article.t.replace(/"/g, "'")}"${article.u ? ` url="${article.u}"` : ""}>\n${text}${cut ? `\n[… shortened: ${text.length.toLocaleString("en")} of ${article.x.length.toLocaleString("en")} characters fit in the model's window]` : ""}\n</full_article>`;
}

/**
 * Fit history into the context window: newest turns win. Also says how full
 * the room for history is (`share`, 0–1, of what the system prompt and the
 * message leave) and how many turns did not fit (`dropped`): turns dropped
 * here and not yet in the summary are lost to the model, so the summary is
 * folded before that happens (main.js scheduleSummary).
 */
export function fitMessages({ system, history, current, tier }) {
  const budget = tier.ctx - tier.maxTokens - 64;
  const base = estTokens(system) + estTokens(current);
  let used = base;
  const kept = [];
  let i = history.length - 1;
  for (; i >= 0; i--) {
    const h = history[i];
    const content = h.role === "assistant" ? stripRetrievalNote(h.content) : h.content;
    const t = estTokens(content) + 8;
    if (used + t > budget) break;
    used += t; kept.unshift({ role: h.role, content });
  }
  const dropped = i + 1;
  while (kept.length && kept[0].role === "assistant") kept.shift();
  const room = Math.max(1, budget - base);
  return { messages: [{ role: "system", content: system }, ...kept, { role: "user", content: current }], tokens: used, dropped, share: Math.min(1, (used - base) / room), room };
}

const cap = s => (s || "").charAt(0).toUpperCase() + (s || "").slice(1);

/** Passages from the practitioner's chosen folders, for the <your_folders> block. */
export function foldersBlock(results = []) {
  if (!results.length) return "";
  return `<your_folders>\n${results.map(r => `[${r.file}]\n${r.text}`).join("\n\n")}\n</your_folders>`;
}

/** Format pages fetched from the web for the <web_results> block. */
export function webBlock(results = []) {
  if (!results.length) return "";
  return `<web_results>\n${results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.text}`).join("\n\n")}\n</web_results>`;
}
