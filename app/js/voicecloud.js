// voicecloud.js — Lodestone's natural voices,
// and writing out a recording through a provider.
//
// Answers are read aloud by a natural voice wherever one can be reached, Grok's
// Ara and Rex first, the voices the Telegram companion spoke with:
//   the conversation's own provider, so one key serves both: OpenRouter under the
//     practitioner's key (Grok, ElevenLabs or Google's voices through it), or
//     harmonism.io's hosted models on their account (lodestone-voice-api.php,
//     Harmonia's keys, a daily allowance, Grok's voices);
//   else a key given for voice alone: OpenRouter, xAI (Grok) or OpenAI.
// When none can be reached, or the practitioner chooses it, the device's own
// voices read, and nothing leaves it. Where the conversation itself stays on
// the device, its voice does too unless the practitioner gave a key for voice
// or chose the natural voice (main.js, voicePlan()).

import { speakable } from "./voice.js";

const OPENROUTER = "https://openrouter.ai/api/v1";
const XAI_TTS = "https://api.x.ai/v1/tts";
const OPENAI = "https://api.openai.com/v1";
const OR_STT = "openai/whisper-large-v3-turbo";   // quick and cheap; large v3 where the account keeps to zero retention
const headers = key => ({ Authorization: `Bearer ${key}`, "HTTP-Referer": "https://harmonism.io/lodestone", "X-Title": "Lodestone" });

/**
 * The natural voices. `via` is the routes that carry each, best first:
 * "openrouter" (a key), "xai" (a key), "openai" (a key), "account" (harmonism.io).
 * Grok's companion voices only: Leo and Sal narrate the corpus (#584).
 */
export const FAMILIES = {
  grok: { label: "Grok", voices: "Ara and Rex", female: "ara", male: "rex", via: ["openrouter", "xai", "account"], or: "x-ai/grok-voice-tts-1.0",
    note: "the voices Lodestone spoke with on Telegram; about $0.015 a thousand characters" },
  elevenlabs: { label: "ElevenLabs", voices: "Sarah and George", female: "sarah", male: "george", via: ["openrouter"], or: "elevenlabs/eleven-v3",
    note: "the most expressive, and about five times Grok's price" },
  gemini: { label: "Google Gemini", voices: "Kore and Charon", female: "Kore", male: "Charon", via: ["openrouter"], or: "google/gemini-3.8-flash-tts",
    note: "the least costly" },
  openai: { label: "OpenAI", voices: "Coral and Onyx", female: "coral", male: "onyx", via: ["openai"], model: "gpt-4o-mini-tts",
    note: "through an OpenAI key" },
};
export const ROUTE_LABEL = { openrouter: "OpenRouter", xai: "xAI", openai: "OpenAI", account: "harmonism.io" };
const XAI_LANGS = ["en", "fr", "es", "ar", "pt", "de", "ru"];

/** Which provider a key belongs to, from its shape: "openrouter", "xai", "openai", or a reason it cannot read aloud. */
export function keyKind(key) {
  const k = String(key || "").trim();
  if (/^sk-or-/.test(k)) return { kind: "openrouter" };
  if (/^xai-/.test(k)) return { kind: "xai" };
  if (/^sk-ant-/.test(k)) return { why: "That is an Anthropic key; Anthropic has no voices. An OpenRouter, xAI or OpenAI key reads aloud." };
  if (/^sk_[A-Za-z0-9]{20,}/.test(k)) return { why: "That looks like an ElevenLabs key. ElevenLabs' voices come through an OpenRouter key here." };
  if (/^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}$/.test(k)) return { kind: "openai" };
  return { why: "This key's provider is not recognised. Paste an OpenRouter (sk-or-…), xAI (xai-…) or OpenAI (sk-…) key." };
}

/** A key, proved with a request that costs nothing, before it is kept. */
export async function testVoiceKey(kind, key) {
  const url = kind === "openrouter" ? OPENROUTER + "/key" : kind === "xai" ? "https://api.x.ai/v1/api-key" : OPENAI + "/models";
  let res;
  try { res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } }); }
  catch { throw new Error(`${ROUTE_LABEL[kind]} could not be reached. Check the connection.`); }
  if (res.status === 401 || res.status === 403) throw new Error(`${ROUTE_LABEL[kind]} refused the key. Check that it is complete and still active.`);
  if (!res.ok) throw new Error(`${ROUTE_LABEL[kind]} answered ${res.status}.`);
  return true;
}

/**
 * The natural voice to read with: { route, family, ctxKey } or null.
 * `have` says which routes can be used now: { openrouter, xai, openai, account }
 * (true where a key is saved or the account is signed in); `conv` is the
 * conversation's own route ("openrouter", "account" or null), preferred so
 * that one key or one account serves both.
 */
export function chooseRoute(family, have, conv) {
  const order = fam => { const v = FAMILIES[fam].via; return conv && v.includes(conv) ? [conv, ...v.filter(r => r !== conv)] : v; };
  const pick = fam => order(fam).find(r => have[r]);
  const want = FAMILIES[family] ? family : "grok";
  // The voice chosen, else Grok, else whichever natural voice a saved key reaches.
  for (const fam of [want, "grok", ...Object.keys(FAMILIES)]) { const r = pick(fam); if (r) return { route: r, family: fam, instead: fam !== want }; }
  return null;
}

/** Which provider a conversation route offers for writing out recordings: "openrouter", "account", or null. */
export function providerOf(engine) {
  return engine?.kind === "openrouter" ? "openrouter" : engine?.kind === "hosted" ? "account" : null;
}
export const PROVIDER_LABEL = { openrouter: "OpenRouter", account: "harmonism.io", xai: "xAI", openai: "OpenAI" };

const extOf = type => (/webm/.test(type) ? "webm" : /mp4|m4a|aac/.test(type) ? "m4a" : /ogg|opus/.test(type) ? "ogg" : /wav/.test(type) ? "wav" : /mpeg|mp3/.test(type) ? "mp3" : /flac/.test(type) ? "flac" : "webm");

async function b64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A recording written out by the provider. `ctx` is { key } for OpenRouter or
 * { call } (the account's authenticated fetch) for harmonism.io. `lang` is a
 * two-letter code or null.
 */
export async function transcribe(provider, blob, lang, ctx) {
  const ext = extOf(blob.type || "");
  if (provider === "openrouter") {
    for (const model of [OR_STT, OR_STT_ZDR]) {
      if (blocked.has(model) && model !== OR_STT_ZDR) continue;
      const fd = new FormData();
      fd.append("model", model);
      fd.append("file", blob, `recording.${ext}`);
      if (lang) fd.append("language", lang);
      const res = await fetch(OPENROUTER + "/audio/transcriptions", { method: "POST", headers: headers(ctx.key), body: fd });
      const j = await res.json().catch(() => ({}));
      if (res.ok) return String(j.text || "").trim();
      const m = j.error?.message || `OpenRouter answered ${res.status}.`;
      if (!POLICY.test(m) || model === OR_STT_ZDR) throw new Error(m);
      block(model);
    }
  }
  if (provider === "account") {
    const res = await ctx.call(location.origin + "/lodestone-voice-api.php?transcribe=1", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: await b64(blob), format: ext, language: lang || undefined }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || `harmonism.io answered ${res.status}.`);
    return String(j.text || "").trim();
  }
  throw new Error("No provider on this route.");
}

// An OpenRouter account may accept only providers that keep nothing (zero data
// retention, openrouter.ai/settings/privacy). Grok's voice is not one; ElevenLabs'
// and Google's are, and so is Whisper large v3 for writing out. A model refused
// for that reason is passed over for the next, here and in later sessions.
const POLICY = /ZDR|data policy|guardrail restrictions|No endpoints found matching your data policy/i;
const OR_TTS_ORDER = ["grok", "elevenlabs", "gemini"];
const OR_STT_ZDR = "openai/whisper-large-v3";
const blocked = (() => { try { return new Set(JSON.parse(localStorage.getItem("lodestone-or-policy-blocked") || "[]")); } catch { return new Set(); } })();
function block(model) { blocked.add(model); try { localStorage.setItem("lodestone-or-policy-blocked", JSON.stringify([...blocked])); } catch {} }
let onSubstitute = () => {};
/** `fn(fromFamily, toFamily)`, told once when the account's privacy setting moves the voice. */
export function onVoiceSubstitute(fn) { onSubstitute = fn || (() => {}); }
/** Forgets what the account refused, to try again after its privacy setting changed. */
export function clearPolicyBlocks() { blocked.clear(); try { localStorage.removeItem("lodestone-or-policy-blocked"); } catch {} }

/** The family OpenRouter will read with for `family`, given what the account has refused. */
export function orFamilyFor(family) {
  const want = FAMILIES[family]?.or ? family : "grok";
  return [want, ...OR_TTS_ORDER].find(f => !blocked.has(FAMILIES[f].or)) || want;
}

async function failed(res, who) {
  const j = await res.json().catch(() => ({}));
  const m = j.error?.message || (typeof j.error === "string" ? j.error : "") || j.detail?.message || "";
  if (res.status === 401 || res.status === 403) return new Error(`${who} refused the key${m ? `: ${m}` : "."}`);
  if (res.status === 402) return new Error(`${who} says the key has no credit left.`);
  return new Error(m || `${who} answered ${res.status}.`);
}

/**
 * One stretch of text as MP3. `route` is "openrouter", "xai", "openai" or
 * "account"; `ctx` is { key } for a key, { call } (the account's authenticated
 * fetch) or { speak } (Lodestone Desktop's, through the app) for the account.
 */
export async function synthesize(route, text, { family = "grok", gender = "female", lang = "en" } = {}, ctx = {}) {
  const fam = FAMILIES[family] || FAMILIES.grok;
  const voiceId = gender === "male" ? fam.male : fam.female;
  if (route === "openrouter") {
    const want = FAMILIES[family]?.or ? family : "grok";
    for (const f of [want, ...OR_TTS_ORDER.filter(x => x !== want)]) {
      const F = FAMILIES[f];
      if (blocked.has(F.or) && f !== OR_TTS_ORDER[OR_TTS_ORDER.length - 1]) continue;
      // OpenRouter's speech request has no language field; Grok's reads English unless
      // told, so the language goes to xAI through provider.options (only the matched
      // provider's options are forwarded). Gemini and ElevenLabs hear it from the text.
      const body = { model: F.or, input: text, voice: gender === "male" ? F.male : F.female, response_format: "mp3" };
      const xlang = XAI_LANGS.includes(lang) ? lang : null;
      const send = b => fetch(OPENROUTER + "/audio/speech", { method: "POST", headers: { ...headers(ctx.key), "Content-Type": "application/json" }, body: JSON.stringify(b) });
      let res = await send(f === "grok" && xlang ? { ...body, provider: { options: { xai: { language: xlang } } } } : body);
      if (res.status === 400 && f === "grok" && xlang) res = await send(body);   // options refused: read without them
      if (res.ok) { if (f !== want) onSubstitute(want, f); return res.blob(); }
      const err = await failed(res, "OpenRouter");
      if (!POLICY.test(err.message)) throw err;
      block(F.or);
    }
    throw new Error("Your OpenRouter account's privacy setting refuses every natural voice. Allow them at openrouter.ai/settings/privacy, or paste an xAI key for Grok's voices.");
  }
  if (route === "xai") {
    const res = await fetch(XAI_TTS, {
      method: "POST", headers: { Authorization: `Bearer ${ctx.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: gender === "male" ? FAMILIES.grok.male : FAMILIES.grok.female, language: XAI_LANGS.includes(lang) ? lang : "en",
        output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 } }),
    });
    if (!res.ok) throw await failed(res, "xAI");
    return res.blob();
  }
  if (route === "openai") {
    const res = await fetch(OPENAI + "/audio/speech", {
      method: "POST", headers: { Authorization: `Bearer ${ctx.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: FAMILIES.openai.model, input: text, voice: gender === "male" ? FAMILIES.openai.male : FAMILIES.openai.female, response_format: "mp3",
        instructions: "Speak calmly and warmly, unhurried, as someone present with the listener." }),
    });
    if (!res.ok) throw await failed(res, "OpenAI");
    return res.blob();
  }
  if (route === "account") {
    if (ctx.speak) {
      const r = await ctx.speak(text, gender, lang);
      if (!r?.ok) throw new Error(r?.message || "harmonism.io could not read the answer aloud.");
      return new Blob([r.audio], { type: "audio/mpeg" });
    }
    const res = await ctx.call(location.origin + "/lodestone-voice-api.php?speak=1", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, gender, lang }),
    });
    if (!res.ok) throw await failed(res, "harmonism.io");
    return res.blob();
  }
  throw new Error("No natural voice on this route.");
}

// Where a sentence ends in text still arriving.
const END = /[.!?…؟。]["'”’»)\]]*\s+|\n+/g;
function lastEnd(s) { let at = 0, m; END.lastIndex = 0; while ((m = END.exec(s))) at = m.index + m[0].length; return at; }
const MAX = 1100;   // the account endpoint takes 1,200 characters a request
function chunks(s, first) {
  const out = []; let rest = s.trim();
  while (rest) {
    const lim = out.length === 0 && first ? 260 : MAX;   // a short first piece, so the voice begins soon
    if (rest.length <= lim) { out.push(rest); break; }
    let cut = rest.lastIndexOf(". ", lim); if (cut < lim / 3) cut = rest.lastIndexOf(" ", lim); if (cut < 1) cut = lim;
    out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1).trim();
  }
  return out.filter(t => /[\p{L}\p{N}]/u.test(t));
}

/**
 * Speaks a reply through the provider as it is written, in the same shape as
 * voice.js's Speaker: start(), feed(text, final), stop(), active, key. Pieces are
 * fetched one ahead and played in turn on one audio element, unlocked by
 * prime() during the practitioner's tap (phones play no sound a page starts on its own).
 */
export class CloudSpeaker {
  constructor(onState = () => {}, onError = () => {}) { this.onState = onState; this.onError = onError; this.active = false; this.key = null; this.audio = null; }
  prime() {
    try {
      if (!this.audio) this.audio = new Audio();
      this.audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
      const p = this.audio.play(); if (p?.catch) p.catch(() => {});
    } catch {}
  }
  start({ provider, ctx, family = "grok", gender = "female", lang = "en", rate = 1, key = null } = {}) {
    this.stop();
    Object.assign(this, { provider, ctx, family, gender, lang, rate, key, said: 0, queue: [], done: false, playing: false, paused: false, active: true, gen: (this.gen || 0) + 1, first: true });
    if (!this.audio) this.audio = new Audio();
    this.onState(true, key);
  }
  feed(text, final = false) {
    if (!this.active) return;
    const rest = String(text || "").slice(this.said);
    const cut = final ? rest.length : lastEnd(rest);
    if (cut > 0) {
      this.said += cut;
      for (const c of chunks(speakable(rest.slice(0, cut)), this.first)) { this.queue.push({ text: c, audio: null }); this.first = false; }
      this.fetchAhead(); this.play();
    }
    if (final) { this.done = true; if (!this.queue.length && !this.playing) this.finish(); }
  }
  fetchAhead() {
    const gen = this.gen;
    for (const item of this.queue.slice(0, 2)) {
      if (item.audio) continue;
      item.audio = synthesize(this.provider, item.text, { family: this.family, gender: this.gender, lang: this.lang }, this.ctx)
        .catch(e => { if (gen === this.gen) { this.onError(e); this.stop(); } return null; });
    }
  }
  async play() {
    if (this.playing || this.paused || !this.active || !this.queue.length) return;
    this.playing = true;
    const gen = this.gen;
    const item = this.queue[0];
    if (!item.audio) this.fetchAhead();
    const blob = await item.audio;
    if (gen !== this.gen || !this.active) return;
    this.queue.shift();
    this.fetchAhead();
    if (blob) {
      const url = URL.createObjectURL(blob);
      try {
        await new Promise(resolve => {
          this.audio.onended = resolve; this.audio.onerror = resolve; this.stopWait = resolve;
          this.audio.src = url;
          this.audio.playbackRate = Number(this.rate) || 1;
          const p = this.audio.play(); if (p?.catch) p.catch(resolve);
        });
      } finally { URL.revokeObjectURL(url); }
    }
    if (gen !== this.gen) return;
    this.playing = false;
    if (this.paused) return;   // resume() picks up from here
    if (this.queue.length) this.play();
    else if (this.done) this.finish();
  }
  finish() { if (!this.active) return; this.active = false; this.paused = false; const k = this.key; this.key = null; this.onState(false, k); }
  /** Holds the sentence being read where it is (the next ones keep arriving); resume() goes on. */
  pause() { if (!this.active || this.paused) return; this.paused = true; try { this.audio?.pause(); } catch {} this.onState(true, this.key); }
  resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    if (this.playing) { const p = this.audio?.play(); if (p?.catch) p.catch(() => {}); }
    else if (this.queue.length) this.play();
    else if (this.done) this.finish();
    this.onState(true, this.key);
  }
  stop() {
    const was = this.active, k = this.key;
    this.active = false; this.paused = false; this.key = null; this.queue = []; this.playing = false; this.gen = (this.gen || 0) + 1;
    try { this.audio?.pause(); } catch {}
    try { this.stopWait?.(); } catch {}
    if (was) this.onState(false, k);
  }
}
