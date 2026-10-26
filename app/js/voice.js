// voice.js — Lodestone's spoken replies, in this computer's own voices.
//
// The Telegram companion spoke through xAI (Ara, Rex): the reply text left the
// server to be rendered. Here the operating system's speech synthesis reads the
// reply on the device itself (macOS, Windows, a phone), so nothing leaves and
// nothing is downloaded. A computer with better voices installed (on a
// Mac, the Premium and Enhanced voices of System Settings → Accessibility →
// Spoken Content) is read with those, first.
//
// The modes are the Telegram ones plus two: text (silent), voice (spoken, the
// text folded away), both, and mirror (spoken when the practitioner spoke).
// Crisis replies and witness mode are never spoken unasked, as on Telegram:
// hotline numbers must stay readable, and a synthetic voice reading fresh grief
// back performs a presence Lodestone must not offer itself as.

export const MODES = ["text", "voice", "both", "mirror"];
export const available = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function";

// The novelty and low-fidelity voices macOS ships alongside the real ones.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Junior|Kathy|Organ|Pipe Organ|Princess|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Fred)\b/i;
// The speech API says nothing of a voice's register, so it is read from the name:
// the voices macOS, Windows, Android and iOS ship under these names.
const FEMALE = /\b(Samantha|Victoria|Allison|Ava|Susan|Zoe|Zoé|Joelle|Nicky|Kate|Serena|Martha|Stephanie|Karen|Catherine|Moira|Tessa|Fiona|Veena|Am[ée]lie|Audrey|Aur[ée]lie|Marie|M[óo]nica|Paulina|Marisol|Isabela|Laila|Mariam|Hoda|Salma|Amira|Anna|Petra|Helena|Hedda|Katja|Luciana|Joana|Catarina|Fernanda|Zira|Hazel|Hortense|Julie|Laura|Sabina|Maria|Heera|Linda|Jenny|Aria|Emma|Sonia|Libby|Denise|Elvira|Alice|Ellen|Sara|Yuna|Kyoko|Milena|Lekha|female|femme|mujer)\b/i;
const MALE = /\b(Alex|Daniel|Tom|Aaron|Arthur|Oliver|Evan|Nathan|Lee|Gordon|Rishi|Thomas|Jacques|Nicolas|Jorge|Juan|Diego|Carlos|Maged|Majed|Tarik|Markus|Yannick|Martin|Felipe|Joaquim|Luca|Xander|David|Mark|George|Paul|Pablo|Raul|Naayf|Stefan|Ravi|Sean|James|Guy|Eric|Christopher|Andrew|Brian|Roger|Henri|Claude|Ryan|Liam|Jamie|Hamed|male|homme|hombre)\b/i;

export function genderOf(v) {
  const n = String(v?.name || "");
  if (FEMALE.test(n)) return "female";
  if (MALE.test(n)) return "male";
  return null;
}

const langOf = v => String(v?.lang || "").toLowerCase().replace("_", "-");
const quality = v => (NOVELTY.test(v.name) ? -5 : /\(Premium\)/i.test(v.name) ? 3 : /\(Enhanced\)|Neural|Natural/i.test(v.name) ? 2 : 1) + (v.localService ? 0.5 : 0);

/** The voices, once the system has listed them (Chromium lists them late). */
export async function voices() {
  if (!available()) return [];
  let list = speechSynthesis.getVoices();
  if (list.length) return list;
  await new Promise(r => {
    const t = setTimeout(r, 1500);
    speechSynthesis.addEventListener("voiceschanged", () => { clearTimeout(t); r(); }, { once: true });
  });
  return speechSynthesis.getVoices();
}

/** The voices that speak `lang` (two letters), best first. */
export function voicesFor(list, lang) {
  return list.filter(v => langOf(v).startsWith(lang) && !NOVELTY.test(v.name)).sort((a, b) => quality(b) - quality(a) || a.name.localeCompare(b.name));
}

/** The voice to speak `lang` in: the one chosen for that language, else the best in the register asked for. */
export function pickVoice(list, lang, gender = "female", chosen = "") {
  const cands = voicesFor(list, lang);
  if (!cands.length) return null;
  if (chosen) { const v = cands.find(v => v.voiceURI === chosen || v.name === chosen); if (v) return v; }
  const score = v => quality(v) + (genderOf(v) === gender ? 10 : genderOf(v) == null ? 4 : 0) + (v.default ? 0.2 : 0);
  return cands.slice().sort((a, b) => score(b) - score(a))[0];
}

/** A reply as it should sound: no markup, no addresses, no table rules. */
export function speakable(md) {
  return String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (m, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, "")
    .replace(/^\s*\|(.*)\|\s*$/gm, "$1")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/^-{3,}\s*$/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Where a sentence (or a line) ends in text still arriving.
const END = /[.!?…؟。]["'”’»)\]]*\s+|\n+/g;
function lastEnd(s) { let at = 0, m; END.lastIndex = 0; while ((m = END.exec(s))) at = m.index + m[0].length; return at; }
// Chromium can drop an utterance much past a few hundred characters: long sentences go in pieces.
function pieces(s, max = 220) {
  const out = [];
  for (let rest = s.trim(); rest; ) {
    if (rest.length <= max) { out.push(rest); break; }
    let cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf("; ", max), rest.lastIndexOf(" — ", max));
    if (cut < max / 3) cut = rest.lastIndexOf(" ", max);
    if (cut < 1) cut = max;
    out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1).trim();
  }
  return out.filter(Boolean);
}

/**
 * Speaks a reply as it is written: each finished sentence is queued as soon as
 * it exists, so the voice starts with the first sentence, not after the last.
 * `onState(speaking, key)` follows it, for the buttons that show it.
 */
export class Speaker {
  constructor(onState = () => {}) { this.onState = onState; this.active = false; this.key = null; this.held = []; this.gen = 0; }
  start({ voice = null, lang = "en", rate = 1, key = null } = {}) {
    this.stop();
    this.gen++;   // a session of its own: the cancelled one's late end events no longer count (1.13.1)
    this.voice = voice; this.lang = lang; this.rate = rate; this.key = key;
    this.rawSaid = 0; this.pending = 0; this.done = false; this.active = true; this.held = []; this.paused = false;
    this.onState(true, key);
  }
  /** `text` is the whole reply so far; `final` once it is complete. */
  feed(text, final = false) {
    if (!this.active) return;
    const rest = String(text || "").slice(this.rawSaid);
    const cut = final ? rest.length : lastEnd(rest);
    if (cut > 0) {
      this.rawSaid += cut;
      for (const p of pieces(speakable(rest.slice(0, cut)))) this.say(p);
    }
    if (final) { this.done = true; if (!this.pending) this.finish(); }
  }
  say(text) {
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang || this.lang; u.rate = this.rate;
    this.pending++;
    this.held.push(u);   // Chromium drops the end event of an utterance nothing references
    const g = this.gen;
    const end = () => { if (g !== this.gen) return; this.pending = Math.max(0, this.pending - 1); if (this.done && !this.pending) this.finish(); };
    u.onend = end; u.onerror = end;
    speechSynthesis.speak(u);
  }
  finish() { if (!this.active) return; this.active = false; this.paused = false; this.held = []; const k = this.key; this.key = null; this.onState(false, k); }
  /** Holds the voice where it is; resume() goes on from the same word. */
  pause() { if (!this.active || this.paused) return; this.paused = true; try { speechSynthesis.pause(); } catch {} this.onState(true, this.key); }
  resume() { if (!this.active || !this.paused) return; this.paused = false; try { speechSynthesis.resume(); } catch {} this.onState(true, this.key); }
  stop() {
    if (!available()) return;
    const was = this.active, k = this.key;
    this.active = false; this.paused = false; this.key = null; this.held = []; this.gen++;
    try { speechSynthesis.resume(); } catch {}   // a paused queue cancelled while paused stays paused in Chromium
    try { speechSynthesis.cancel(); } catch {}
    if (was) this.onState(false, k);
  }
}
