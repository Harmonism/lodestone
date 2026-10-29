// shareout.js — one conversation made ready to share with Harmonia, on this device.
//
// Settings → Help Lodestone improve. The practitioner chooses a conversation;
// this module finds what could name someone (people, places, addresses,
// numbers, keys), proposes a stand-in for each, and builds the copy that
// leaves. Nothing here touches the network: main.js shows the copy in full and
// sends it only when the practitioner has read it and ticked that they have.
//
// What leaves: the words of the turns kept, with the stand-ins in place; for
// each turn who spoke, minutes since the conversation began, which model
// answered, and whether a safety gate answered instead. What never leaves:
// memory, notes, the Wheel, the Harmonic Profile, attachments, images, the
// conversation's title, the account. The server keeps no account with it.
//
// Finding names is a proposal, not a guarantee. A capitalised word that the
// published corpus does not use, and that this conversation never writes in
// lower case, is offered as a name; names in scripts without capitals (Arabic)
// are not found, and the practitioner adds them by hand. That is why the
// whole copy is shown before it goes.

import { leaveOut } from "./privacygate.js";

export const CONSENT_VERSION = "share-2026-10-23";
export const MAX_MESSAGES = 200;
export const MAX_CHARS = 16000;   // per message, after which the rest is cut and marked

export const REASONS = [
  ["held", "It held me well"],
  ["drift", "It drifted from Harmonism"],
  ["wrong", "Something it said was wrong"],
  ["missed", "It missed what I meant"],
  ["off", "Something felt off"],
];

// Titles kept in front of the stand-in ("Dr [Person B]").
const TITLES = new Set("dr dr. doctor docteur docteure doctora doktor pr pr. prof prof. professeur professor m. mr mr. mrs mrs. ms ms. mme mme. mlle madame monsieur sr sra señor señora sri sidi lalla hajj hajja haj sheikh cheikh imam father père frère sœur soeur sister brother uncle aunt oncle tante".split(" "));
// Particles inside a name ("Fatma Ben Abid", "Ibn Arabi", "da Silva").
const PARTICLES = new Set("ben bin bint ibn ould el al de da das do dos du des del della di van von der den la le".split(" "));
// Words often capitalised at the start of a sentence in the languages
// Lodestone answers in, which the English corpus does not hold in lower case.
const COMMON = new Set(`
a à au aux avec avant après alors aussi autre autres aujourd'hui bien bon bonne bonjour bonsoir bref c'est ça car ce ceci cela celle celui ces cet cette chaque chez comme comment d'abord d'accord dans de des deux dis dit donc dont du elle elles en encore enfin entre est et été être eux fais faut hier ici il ils j'ai j'avais je jusqu'à l'autre la là le les leur leurs lui ma mais même merci mes moi mon n'est ne ni non nos notre nous on ou où oui par parce pas peut peut-être plus pour pourquoi quand que quel quelle quelque qui quoi rien sa sans se ses si sinon soit son sont sous sur ta te tes toi ton tous tout toute toutes très tu un une voici voilà vos votre vous y
al algo ahora aquí así bueno cada como con cuando de del desde dónde el ella ellos en entonces era es esa ese eso esta este esto estoy fue gracias hay hola la las lo los más me mi mis muy nada no nos nosotros o para pero por porque qué que quien se ser si sí sin sobre su sus también te tengo tu tú un una uno usted y ya yo
ao aos com da das de do dos ela ele eles em então essa esse está estou eu isso mas muito na nas não no nos obrigado obrigada olá onde ou para pela pelo por porque quando que se sem também tem você vocês
aber auch auf aus bei bin bis da dann das dass dein der die doch du ein eine er es für hallo ich ihr im ist ja kein mein mit nach nein nicht noch nur oder sie so und uns von was weil wenn wie wir zu
`.split(/\s+/).filter(Boolean));

const IMPERATIVE = /-(?:moi|toi|la|le|les|lui|leur|nous|vous|en|y|ce|il|elle|on|je|tu|me|te)$/u;
const WORD = /[\p{Lu}][\p{Ll}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
const LOWER_WORD = /[\p{Ll}][\p{Ll}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
const CORPUS_COMMON = 8;
const norm = s => s.toLocaleLowerCase().normalize("NFC");

/**
 * What the published corpus writes, built once per pack: the words it uses in
 * lower case (ordinary words), and the capitalised words it uses (doctrine,
 * places and public figures it names, which identify no one).
 */
export function vocabulary(articles = []) {
  const lower = new Set(), caps = new Map();
  for (const a of articles) {
    // Addresses and file names left out: "tahirzniber" in a link is not the word "tahir".
    const text = `${a.t || ""}\n${a.x || ""}`.replace(/\S*(?:https?:\/\/|www\.|@|\.md\b|\/)\S*/g, " ");
    for (const m of text.matchAll(LOWER_WORD)) lower.add(norm(m[0]));
    for (const m of text.matchAll(WORD)) { const n = norm(m[0]); caps.set(n, (caps.get(n) || 0) + 1); }
  }
  // A capitalised word the corpus uses often is its own term or a public name;
  // one it uses rarely may be anyone's first name, and is still offered.
  for (const [n, c] of caps) if (c < CORPUS_COMMON) caps.delete(n);
  return { lower, caps: new Set(caps.keys()) };
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bounded = phrase => new RegExp(`(?<![\\p{L}\\p{N}])${esc(phrase).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");

/**
 * The names a conversation seems to hold: [{ key, phrase, forms, count, known, sure }].
 * `sure` (ticked at first): a capitalised word met at least once after a
 * lower-case word, a digit or a comma,
 * that the corpus does not use as its own term and this conversation never
 * writes in lower case. Offered but not ticked: one met only where any word
 * takes a capital (a sentence's first word). `known`: the practitioner's own
 * name, from memory, always taken out.
 */
export function findNames(messages, vocab = { lower: new Set(), caps: new Set() }, known = []) {
  const allText = messages.map(m => m.content || "").join("\n");
  const lowerHere = new Set([...allText.matchAll(LOWER_WORD)].map(m => norm(m[0])));
  // 0: not a name; 1: perhaps; 2: likely.
  const weight = w => {
    const n = norm(w);
    if (n.length < 3 || COMMON.has(n) || TITLES.has(n) || PARTICLES.has(n) || vocab.caps.has(n) || lowerHere.has(n)) return 0;
    if (IMPERATIVE.test(n) || /ment$/.test(n)) return 0;   // "Dis-moi", "Appelle-la", "Apparemment"
    return vocab.lower.has(n) ? 1 : 2;
  };
  const found = new Map();   // phrase → { count, mid, w }
  for (const m of messages) {
    const text = m.content || "";
    const words = [...text.matchAll(WORD)];
    for (let i = 0; i < words.length; i++) {
      // The run of capitalised words from here, with the particles inside it.
      const run = [{ w: words[i][0], at: words[i].index }];
      let j = i, end = words[i].index + words[i][0].length;
      while (j + 1 < words.length) {
        const gap = text.slice(end, words[j + 1].index);
        const particle = gap.match(/^\s+([\p{Ll}]+)\s+$/u);
        if (!/^ +$/.test(gap) && !(particle && PARTICLES.has(particle[1]))) break;
        j++; end = words[j].index + words[j][0].length;
        run.push({ w: (particle ? particle[1] + " " : "") + words[j][0], at: words[j].index });
      }
      i = j;
      // Ordinary words and titles at either end are not part of the name ("Appelle le Dr Fatma", "Fanny Est-ce").
      while (run.length > 1 && weight(run[0].w.split(" ").pop()) < 2) run.shift();
      while (run.length > 1 && weight(run[run.length - 1].w.split(" ").pop()) < 2) run.pop();
      if (run.length === 1 && weight(run[0].w.split(" ").pop()) === 0) continue;
      if (!run.length) continue;
      run[0].w = run[0].w.replace(/^\p{Ll}+ /u, "");   // a leading particle belongs to the word before
      const phrase = run.map(r => r.w).join(" ");
      const before = text.slice(0, run[0].at).replace(/\s+$/, "");
      const mid = /[\p{Ll}\p{N},]$/u.test(before);
      const w = Math.max(...run.map(r => weight(r.w.split(" ").pop())));
      const f = found.get(phrase) || { count: 0, mid: false, w };
      f.count++; f.mid ||= mid; found.set(phrase, f);
    }
  }
  // One person, one stand-in: "Stella Smahane" and "Stella", "Fatma Ben Abid" and "Fatma".
  const groups = [];
  const toksOf = phrase => phrase.split(/\s+/).filter(t => weight(t) > 0).map(norm);
  const ordered = [...found.entries()].sort((a, b) => b[0].split(" ").length - a[0].split(" ").length || b[1].count - a[1].count);
  for (const [phrase, f] of ordered) {
    const toks = toksOf(phrase);
    const g = groups.find(x => x.toks.some(t => toks.includes(t)));
    if (g) { g.forms.add(phrase); g.count += f.count; g.mid ||= f.mid; g.w = Math.max(g.w, f.w); g.toks.push(...toks); }
    else groups.push({ phrase, forms: new Set([phrase]), count: f.count, mid: f.mid, w: f.w, toks });
  }
  for (const k of known) {
    const name = String(k || "").trim(); if (name.length < 2) continue;
    const toks = name.split(/\s+/).map(norm);
    let g = groups.find(x => x.toks.some(t => toks.includes(t)));
    if (!g) { g = { phrase: name, forms: new Set(), count: 0, mid: true, w: 2, toks: [] }; groups.unshift(g); }
    g.known = true;
    for (const t of name.split(/\s+/)) { g.forms.add(t); g.toks.push(norm(t)); }
    g.forms.add(name);
  }
  return groups
    .map(g => ({ key: g.toks[0] || norm(g.phrase), phrase: g.phrase, forms: [...g.forms].sort((a, b) => b.length - a.length), count: g.count, known: !!g.known, sure: !!g.known || g.mid }))
    .sort((a, b) => b.known - a.known || b.sure - a.sure || b.count - a.count);
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Stand-ins: "[me]" for the practitioner, then "[Name A]", "[Name B]"… (a person or a place: the reviewer is told which only if the practitioner renames it). */
export function standIns(names) {
  let n = 0;
  return names.map(x => ({ ...x, include: x.sure, stand: x.known ? "[me]" : `[Name ${LETTERS[n % 26]}${n >= 26 ? Math.floor(n / 26) : ""}]`, _n: x.known ? 0 : n++ }));
}

// What is always taken out, whatever the practitioner ticks.
const ALWAYS = [
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]"],
  [/\bhttps?:\/\/(?!(?:www\.)?harmonism\.io\b|[a-z]{2}\.wikipedia\.org\b)[^\s)>\]]+/gi, "[link]"],
  [/\b(?:bc1|tb1)[a-z0-9]{25,90}\b|\b0x[a-fA-F0-9]{40}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, "[address]"],
  // A phone number: eight digits or more, with the usual separators.
  [/(?<![\w])(?:\+|00)?\d[\d ().-]{6,}\d(?![\w])/g, m => (m.replace(/\D/g, "").length >= 8 && !/^\d{4}-\d{2}-\d{2}$/.test(m) ? "[phone]" : m)],
];
/** The text with the chosen stand-ins in place, and keys, cards, emails, links and numbers taken out. */
export function anonymize(text, chosen = []) {
  let s = leaveOut(String(text ?? ""));
  for (const [re, rep] of ALWAYS) s = s.replace(re, rep);
  // Longest forms first, so "Fatma Ben Abid" goes before "Fatma".
  const forms = chosen.flatMap(c => c.forms.map(f => [f, c.stand])).sort((a, b) => b[0].length - a[0].length);
  for (const [f, stand] of forms) s = s.replace(bounded(f), stand);
  return s;
}

const day = ts => new Date(ts).toISOString().slice(0, 10);
/** What a stored message says of the model that wrote it. */
const modelOf = m => m.meta?.modelLabel || m.meta?.model || null;

/**
 * The copy that leaves. `messages`: the conversation as stored; `keep`: the ids
 * of the turns kept; `chosen`: the stand-ins ticked. Nothing of memory is read here.
 */
export function buildShare({ messages, keep, chosen, reasons = [], note = "", client = {} }) {
  const kept = messages.filter(m => keep.has(m.id) && (m.role === "user" || m.role === "assistant") && !m.notice);
  const t0 = kept[0]?.ts || Date.now();
  const out = kept.slice(-MAX_MESSAGES).map(m => {
    let text = anonymize(m.content, chosen);
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + " […cut]";
    const files = m.meta?.files?.length || 0;
    return {
      role: m.role,
      text,
      min: Math.round((m.ts - t0) / 60000),
      ...(m.role === "assistant" && modelOf(m) ? { model: String(modelOf(m)).slice(0, 120) } : {}),
      ...(m.meta?.crisis ? { gate: "crisis:" + m.meta.crisis } : m.meta?.care ? { gate: "care:" + m.meta.care } : {}),
      ...(files ? { attachments: files } : {}),
      ...(m.meta?.stopped ? { stopped: true } : {}),
    };
  });
  return {
    v: 1,
    consent: CONSENT_VERSION,
    reasons: reasons.filter(r => REASONS.some(([k]) => k === r)),
    note: anonymize(String(note || "").slice(0, 4000), chosen),
    began: kept.length ? day(t0) : null,
    cut: kept.length > MAX_MESSAGES ? kept.length - MAX_MESSAGES : 0,
    client,
    messages: out,
  };
}

/** For the preview: the text split around stand-ins and markers (odd parts), to mark them. */
export function marks(text, stands = []) {
  const own = [...new Set(stands)].filter(Boolean).sort((a, b) => b.length - a.length).map(esc);
  const re = new RegExp(`(${[...own, "\\[(?:me|Name [A-Z]\\d*|email|link|address|phone|[^\\]]{1,40}, left out)\\]"].join("|")})`, "g");
  return String(text).split(re);
}
