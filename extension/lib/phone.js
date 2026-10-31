// phone.js — where Lodestone thinks when the practitioner owns no model it can reach.
//
// Two engines, ported for the browser from the desktop app's main process
// (desktop/src/hosted.js and desktop/src/remote.js), so that a phone with no
// computer behind it can still speak with Lodestone:
//
//   HostedEngine      harmonism.io's hosted models, under the practitioner's
//                     harmonism.io account: ten messages a day the first month, then five, in total across
//                     the website, Telegram and Lodestone's apps. The turn
//                     goes to lodestone-desktop-api.php on this same origin, which
//                     puts the server's own doctrinal backbone in place and
//                     stores nothing.
//   OpenRouterEngine  a model the practitioner rents on OpenRouter with their
//                     own key. The recommended models are those hosted
//                     Lodestone runs on, run as hosted Lodestone runs them.
//
// As on the desktop, the crisis gate, retrieval, witness mode, memory and
// practices stay on this device and run here; only the assembled turn leaves,
// to the service named, and Lodestone says so (whereLine() in prompt.js).
//
// A browser has no keychain. The OpenRouter key is kept in this browser's own
// storage, encrypted with a key the page itself cannot export (WebCrypto,
// non-extractable). That keeps it out of an exported memory file and out of
// plain sight; it does not protect it from someone holding the unlocked phone.
// The harmonism.io sign-in is the website's own session, kept where the
// website keeps it (see Hosted). The native shell (Phase 2) moves both to the
// system keychain.

import { kv } from "./store.js";
import { readSSE, providerError } from "./sse.js";
import { CLASSIFIER_PROMPT } from "./route.js";

// ─── Secrets ─────────────────────────────────────────────────────────────────

const SECRET_KEY = "secrets-key";
async function cryptoKey() {
  let k = await kv.get(SECRET_KEY);
  if (!k) {
    k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await kv.set(SECRET_KEY, k);
  }
  return k;
}

export const secrets = {
  async get(name) {
    const v = await kv.get("secret:" + name);
    if (!v) return null;
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: v.iv }, await cryptoKey(), v.ct);
      return JSON.parse(new TextDecoder().decode(pt));
    } catch { return null; }
  },
  async set(name, value) {
    if (value == null) return kv.del("secret:" + name);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), new TextEncoder().encode(JSON.stringify(value)));
    await kv.set("secret:" + name, { iv, ct: new Uint8Array(ct) });
  },
  del: name => kv.del("secret:" + name),
};

/** Both routes need WebCrypto, which a browser gives only to a secure page (https, or localhost). */
export const phoneRoutesAvailable = () => !!(globalThis.isSecureContext && crypto?.subtle);

// ─── harmonism.io account ────────────────────────────────────────────────────

const SUPABASE_URL = "https://zccplzknsbpdczfnwkwz.supabase.co";
// Supabase's public "anon" key, the same one harmonism.io's pages carry; it
// identifies the project, it is not a secret.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpjY3Bsemtuc2JwZGN6Zm53a3d6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNjEwMTEsImV4cCI6MjA5MTgzNzAxMX0.iaNbbx4gPRQhEDtKe4yhaPjFZgMmFGOrLSbP5uVl6CM";
// Same origin as this page on harmonism.io, so no CORS is involved.
const hostedApi = () => location.origin + "/lodestone-desktop-api.php";

// One sign-in for the website and this app. On harmonism.io the app
// and the member pages share an origin, so the session supabase-js keeps for
// the website (localStorage, sb-<project>-auth-token) is the app's session
// too: signing in on the website signs Lodestone in, the Harmonic Profile
// assessment sees the same account, and signing out of one signs out of both.
// Lodestone renews an expired access token itself and writes the renewed session
// back where the website will read it. In Lodestone Desktop the window's own
// hosted sign-in lives in the main process (desktop/src/hosted.js) instead.
const SB_KEY = "sb-zccplzknsbpdczfnwkwz-auth-token";
// Where the session is kept. On harmonism.io and lodestone.harmonism.io: the
// session both addresses share, in cookies on .harmonism.io, so the app,
// the member pages and the Sprite renew one session and never two copies of it.
// Elsewhere (the desktop app's own server, a local preview): this origin's
// localStorage, as before. A page that has neither sets another (the browser
// extension's worker keeps it in its own storage).
let sessionStore = sharedSessionStore() || {
  keys: () => Object.keys(localStorage),
  get: k => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  del: k => localStorage.removeItem(k),
};

// The codec of harmonia-astro/public/js/shared-session.js, the same behaviour:
// session JSON URI-encoded in cookies hs-sb.0 and hs-sb.1 on .harmonism.io,
// capped at 4,800 characters (identities left out past it; a session too large
// even so stays on this address, hs-sb-local); hs-sb-v marks the shared cookie
// as existing (before it, this origin's own localStorage session is adopted
// once); localStorage[SB_KEY] kept as a mirror; sb-access-token kept for the
// PHP pages. Change both together.
function sharedSessionStore() {
  try {
    if (typeof document === "undefined" || typeof location === "undefined") return null;
    if (!/(^|\.)harmonism\.io$/.test(location.hostname) || location.protocol !== "https:") return null;
  } catch { return null; }
  const NAME = "hs-sb", MARK = "hs-sb-v", LOCAL = "hs-sb-local", CHUNK = 2400, MAXCHUNKS = 2, AGE = 60 * 60 * 24 * 400;
  const ATTR = "; domain=.harmonism.io; path=/; SameSite=Lax; Secure";
  const getCookie = n => { const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + n.replace(/[.\-]/g, "\\$&") + "=([^;]*)")); return m ? m[1] : null; };
  const setCookie = (n, v, age) => { document.cookie = n + "=" + v + ATTR + "; max-age=" + age; };
  const lsGet = () => { try { return localStorage.getItem(SB_KEY); } catch { return null; } };
  const lsSet = v => { try { if (v == null) localStorage.removeItem(SB_KEY); else if (localStorage.getItem(SB_KEY) !== v) localStorage.setItem(SB_KEY, v); } catch {} };
  const localOnly = on => { try { if (on) localStorage.setItem(LOCAL, "1"); else localStorage.removeItem(LOCAL); } catch {} };
  const isLocalOnly = () => { try { return localStorage.getItem(LOCAL) === "1"; } catch { return false; } };
  const valid = v => !!v && /"refresh_token"\s*:\s*"[^"]+"/.test(v);
  const readCookie = () => {
    const parts = [];
    for (let i = 0; i < MAXCHUNKS; i++) { const c = getCookie(NAME + "." + i); if (c == null || c === "") break; parts.push(c); }
    if (!parts.length) return null;
    try { return decodeURIComponent(parts.join("")); } catch { return null; }
  };
  const fit = v => {
    try {
      let enc = encodeURIComponent(v);
      if (enc.length <= CHUNK * MAXCHUNKS) return enc;
      const s = JSON.parse(v);
      if (s && s.user && s.user.identities) {
        delete s.user.identities;
        enc = encodeURIComponent(JSON.stringify(s));
        if (enc.length <= CHUNK * MAXCHUNKS) return enc;
      }
    } catch {}
    return null;
  };
  const writeCookie = v => {
    let enc = v == null ? "" : fit(v), n = 0;
    const ok = enc != null;
    if (!ok) enc = "";
    for (let i = 0; i < enc.length; i += CHUNK) setCookie(NAME + "." + (n++), enc.slice(i, i + CHUNK), AGE);
    for (let j = n; j < MAXCHUNKS; j++) if (getCookie(NAME + "." + j) != null) setCookie(NAME + "." + j, "", 0);
    setCookie(MARK, "1", AGE);
    return ok;
  };
  const accessCookie = v => {
    let t = ""; try { t = v ? (JSON.parse(v).access_token || "") : ""; } catch {}
    document.cookie = "sb-access-token=" + t + ATTR + "; max-age=" + (t ? 60 * 60 * 24 * 7 : 0);
    document.cookie = "sb-access-token=; path=/; max-age=0";
  };
  const get = () => {
    let v = readCookie();
    if (v == null) {
      if (isLocalOnly()) return lsGet();
      if (getCookie(MARK) == null) {
        const old = lsGet();
        if (valid(old)) {
          if (writeCookie(old)) { v = readCookie(); accessCookie(v); }
          else { localOnly(true); return old; }
        }
      }
    } else if (isLocalOnly()) localOnly(false);
    lsSet(v);
    return v;
  };
  const set = v => {
    if (v == null) { writeCookie(null); localOnly(false); }
    else if (writeCookie(v)) { localOnly(false); setCookie("hs-sb-forget", "", 0); }   // signed in again: nothing left to remove
    else { localOnly(true); try { console.warn("[shared-session] session too large to share; kept on this address only"); } catch {} }
    lsSet(v); accessCookie(v);
  };
  return { keys: () => [SB_KEY], get: () => get(), set: (k, v) => set(v), del: () => set(null) };
}
export function setSessionStore(store) { sessionStore = store; }
const sessionKey = () => {
  try { return sessionStore.keys().find(k => k.startsWith("sb-") && k.endsWith("-auth-token")) || SB_KEY; } catch { return SB_KEY; }
};
function readSession() {
  try {
    const raw = sessionStore.get(sessionKey());
    const s = raw ? JSON.parse(raw) : null;
    return s && s.refresh_token ? s : null;
  } catch { return null; }
}
function writeSession(s) {
  try { if (s) sessionStore.set(sessionKey(), JSON.stringify(s)); else sessionStore.del(sessionKey()); } catch {}
}

/** Signs in with the harmonism.io account's email and password (where the website's own sign-in page cannot be used). */
export async function signInWithPassword(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: String(email || "").trim(), password: String(password || "") }),
  });
  let j = {};
  try { j = await res.json(); } catch {}
  if (!res.ok || !j.access_token) {
    const why = j.error_description || j.msg || j.error || "";
    if (/invalid login|invalid_grant|invalid credentials/i.test(why)) throw new Error("That email and password do not match a harmonism.io account.");
    if (/email not confirmed/i.test(why)) throw new Error("Confirm your email first: harmonism.io sent you a link when you signed up.");
    throw new Error(`harmonism.io could not sign you in${why ? `: ${why}` : "."}`);
  }
  writeSession({ ...j, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600) });
  return { email: String(j.user?.email || email).toLowerCase() };
}

/** Where to sign in or make an account, coming back to this page afterwards. */
export const accountLinks = () => ({
  signIn: "/member/login.php?return=lodestone",
  register: "/member/register.php?return=lodestone",
});

class Hosted {
  constructor() { this.cached = null; }

  /** { email } when the website holds a session on this device, else null. */
  async account() {
    const s = readSession();
    const email = s?.user?.email;
    return email ? { email: String(email).toLowerCase() } : null;
  }

  async refresh(s) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    let j = {};
    try { j = await res.json(); } catch {}
    if (!res.ok || !j.access_token) {
      const why = j.error_description || j.msg || j.error || "";
      if (/invalid|not found|revoked|already used/i.test(why)) {
        // Renewed meanwhile on the other address (one shared session): take that one.
        const now = readSession();
        if (now && now.refresh_token !== s.refresh_token) { this.cached = null; return now; }
        writeSession(null); throw new Error("Sign in to your harmonism.io account again.");
      }
      throw new Error(`harmonism.io could not renew the sign-in${why ? `: ${why}` : "."}`);
    }
    const next = { ...s, ...j, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600) };
    writeSession(next);
    this.cached = null;
    return next;
  }

  async signOut() { this.cached = null; writeSession(null); }

  async token(force = false) {
    let s = readSession();
    if (!s) throw new Error("Sign in to your harmonism.io account first.");
    if (force || !s.access_token || !s.expires_at || s.expires_at * 1000 < Date.now() + 60000) s = await this.refresh(s);
    return s.access_token;
  }

  /** Calls the endpoint with the access token, renewing it once if the server refuses it. */
  async call(url, init = {}) {
    const go = async force => fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await this.token(force)}` } });
    let res = await go(false);
    if (res.status === 401) res = await go(true);
    return res;
  }

  /** { email, status, cap, remaining, reset_at, models }. Cached for a minute unless `fresh`. */
  async status(fresh = false) {
    if (!fresh && this.cached && Date.now() - this.cached.at < 60000) return this.cached.value;
    const res = await this.call(hostedApi() + "?status=1", { method: "GET" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || `harmonism.io answered ${res.status}.`);
    this.cached = { at: Date.now(), value: j };
    if (Array.isArray(j.models) && j.models.length) this.models = j.models;   // kept for names, past the minute's cache
    return j;
  }
}

export const hosted = new Hosted();

export class HostedEngine {
  constructor(tier, { model } = {}) {
    this.tier = tier; this.model = model || ""; this.kind = "hosted"; this.where = "harmonism.io"; this.ctrl = null;
  }
  async isCached() { return true; }
  async load() { if (!(await hosted.account())) throw new Error("Not signed in to harmonism.io."); }
  async *stream(messages, { maxTokens, temperature = 0.7, web = false, background = false } = {}) {
    const ctrl = new AbortController(); if (background) this.bgUsage = null; else { this.ctrl = ctrl; this.lastUsage = null; }   // a background call (learning, a summary) is not what Stop stops (1.13.1)
    const body = { messages, stream: true, temperature, max_tokens: maxTokens };
    if (this.model) body.model = this.model;
    if (web) body.web = true;   // the server adds OpenRouter's web search for this turn
    const res = await hosted.call(hostedApi(), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    hosted.cached = null;
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw Object.assign(new Error(j.error?.message || `harmonism.io answered ${res.status}.`), { code: j.error?.code || null });
    }
    yield* readSSE(res, u => { if (background) this.bgUsage = u; else this.lastUsage = u; });
  }
  interrupt() { try { this.ctrl?.abort(); } catch {} }
  /** The model's name, not its id: from the account's list, else the tested list; "" is the server's default. */
  label() {
    const list = hosted.models || [];
    const m = this.model ? list.find(x => x.id === this.model) || recommendedFor(this.model) : list.find(x => x.default);
    return m?.label || this.model || "hosted Lodestone";
  }
  describe() { return `${this.label()} · harmonism.io`; }
}

// ─── OpenRouter, under the practitioner's own key ────────────────────────────

const OPENROUTER = "https://openrouter.ai/api/v1";
// Each OpenRouter model's window and input price, from OpenRouter's public list (no key), asked once
// a session; null until it has arrived, or for a model it does not list (main.js windowFor then uses
// OPEN_CTX; main.js compactRoom, COMPACT_ROOM).
let orWindows = null, orPrices = null, orMaxOuts = null, orParams = null, orList = null, orWindowsAsked = null;
export function orContext(id) {
  if (!orWindowsAsked) orWindowsAsked = fetch(OPENROUTER + "/models").then(r => r.ok ? r.json() : null)
    .then(j => { if (!j?.data) { orWindowsAsked = null; return; } orWindows = new Map(j.data.filter(m => m.id && Number.isFinite(m.context_length)).map(m => [m.id, m.context_length]));
      orPrices = new Map(j.data.filter(m => m.id && Number(m.pricing?.prompt) > 0).map(m => [m.id, Number(m.pricing.prompt)]));
      orMaxOuts = new Map(j.data.filter(m => m.id && Number(m.top_provider?.max_completion_tokens) > 0).map(m => [m.id, Number(m.top_provider.max_completion_tokens)]));
      orParams = new Map(j.data.filter(m => m.id && Array.isArray(m.supported_parameters)).map(m => [m.id, new Set(m.supported_parameters)]));
      orList = j.data.filter(m => m.id && !/:free$/.test(m.id) && (m.architecture?.output_modalities || ["text"]).includes("text")).map(m => ({ id: m.id, name: m.name || m.id, created: Number(m.created) || 0, price: Number(m.pricing?.prompt) || 0 })); })
    .catch(() => { orWindowsAsked = null; });
  return orWindows?.get(current(String(id || "").trim())) || null;
}
/** The most a model may write in one answer, as OpenRouter lists it; null when not known (1.17.1). */
export function orMaxOut(id) { orContext(id); return orMaxOuts?.get(current(String(id || "").trim())) || null; }
/** Dollars per input token, as OpenRouter lists it; null when not known. */
export function orPrice(id) { orContext(id); return orPrices?.get(current(String(id || "").trim())) || null; }
/** Whether a model takes OpenRouter's reasoning setting; null until the list has arrived or for a model it does not list (v107). */
export function orThinks(id) { orContext(id); const p = orParams?.get(current(String(id || "").trim())); return p ? p.has("reasoning") : null; }

// ─── The hybrid (v107): a light model of the same maker for the turns that need no depth ───
// As MunAI on Telegram ran Haiku beside Opus. The light model is found in OpenRouter's
// own list, the newest of the maker's light line, so no id is written here to go stale.
// Offered only where the chosen model costs enough for it to matter (from $1 per million
// input tokens): never for DeepSeek V4.1 Flash, the default, which costs a fraction of that.
const LIGHT_LINE = { anthropic: /\bhaiku\b/i, openai: /-mini\b/i, google: /\bflash\b(?!-lite)/i, "x-ai": /\b(fast|mini)\b/i, mistralai: /\b(small|medium)\b/i };
export const HYBRID_FROM = 1e-6;   // dollars per input token
export function lightFor(id) {
  orContext(id);
  const mid = current(String(id || "").trim()), maker = mid.split("/")[0], line = LIGHT_LINE[maker];
  if (!line || !orList || line.test(mid)) return null;
  const price = orPrice(mid);
  if (!price || price < HYBRID_FROM) return null;
  const pick = orList.filter(m => m.id.startsWith(maker + "/") && line.test(m.id) && m.price > 0 && m.price < price / 3 && orThinks(m.id) !== null)
    .sort((a, b) => b.created - a.created)[0];
  return pick ? { id: pick.id, label: pick.name.replace(/^[^:]{1,40}:\s*/, "") } : null;
}
/** The model's display name from OpenRouter's list, else its id. */
export function orName(id) { orContext(id); const m = orList?.find(x => x.id === current(String(id || "").trim())); return m ? m.name.replace(/^[^:]{1,40}:\s*/, "") : String(id || ""); }

// Prompt caching (v107). Anthropic's models through OpenRouter cache only what is marked.
// The persona, the doctrinal backbone and what the person wrote about themselves open
// every system prompt and change rarely; the hour and the passages of the turn follow
// from <temporal> on. The mark goes just before <temporal>, as Lodestone Desktop's own
// Anthropic route has always cut it (desktop/src/remote.js anthropicBody), else just
// after the backbone. A cached read costs a tenth of the input price; a write a quarter more.
const BACKBONE_END = "</doctrinal_backbone>", TEMPORAL = "\n\n<temporal>";
export function cacheBreak(mid, messages) {
  if (!/^anthropic\//.test(mid) || !Array.isArray(messages)) return messages;
  const i = messages.findIndex(m => m.role === "system" && typeof m.content === "string" && m.content.includes(BACKBONE_END));
  if (i < 0) return messages;
  const s = messages[i].content, cut = s.includes(TEMPORAL) ? s.indexOf(TEMPORAL) : s.indexOf(BACKBONE_END) + BACKBONE_END.length;
  const content = [{ type: "text", text: s.slice(0, cut), cache_control: { type: "ephemeral" } }];
  if (s.slice(cut).trim()) content.push({ type: "text", text: s.slice(cut) });
  return messages.map((m, k) => (k === i ? { ...m, content } : m));
}
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";

// The models hosted Lodestone runs on, each passed through the doctrinal-fidelity
// suite on the current backbone. The same list as desktop/src/remote.js; a
// newer one is read from this site's published model catalog when the
// practitioner opens the OpenRouter setup.
//   reasoning "none" asks the provider to answer without deliberating;
//   "low" / "medium" / "high" ask for that much deliberation;
//   ""  leaves reasoning on where the provider makes it mandatory, with
//       minTokens as the floor so the reasoning does not eat the answer.
// The default wherever Lodestone runs: on the account or under the practitioner's own key.
export const DEFAULT_REMOTE = "deepseek/deepseek-v4.1-flash-1017";
export const RECOMMENDED = [
  { id: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", maker: "DeepSeek", licence: "MIT", reasoning: "medium", minTokens: 16000, note: "The default on harmonism.io" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", maker: "NVIDIA", licence: "OpenMDW 1.1", reasoning: "none", minTokens: 0, note: "" },
];
// Ids that left the tested list for a successor; the same table as desktop/src/remote.js.
const RETIRED = { "deepseek/deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash-1017" };
const current = id => RETIRED[String(id || "").trim()] || id;
const recommendedFor = id => RECOMMENDED.find(m => m.id === current(id)) || null;
// v107: "More info" under the model choice. Cost measured in the fidelity suite of
// October 24, 2026 (Harmonia's fidelity suite, 40 models, Lodestone's
// backbone and retrieval, data_collection deny): $0.0009 an answer for V4.1 Flash 1017,
// $0.2092 for Claude Opus 5.5. Same text in desktop/src/remote.js MODEL_INFO.
const MODEL_INFO = { "deepseek/deepseek-v4.1-flash-1017": "About a tenth of a cent an answer, some forty times less than Claude Opus 5.5 on the same questions (about 4 cents an answer, and 21 to 25 cents for a conversation\u2019s first message), from Lodestone\u2019s own questions on October 24, 2026, at OpenRouter\u2019s prices. Open weights under MIT, and it held the doctrinal backbone in every test. Through OpenRouter, Lodestone sends it only to providers that keep nothing and train on nothing." };
export const modelInfo = id => MODEL_INFO[current(String(id || "").trim())] || "";

// Closed-weight models are never listed (October 26, 2026): they drift from the
// doctrine and their weights are not published. A practitioner may still type one
// under their own key, and assess() labels it "closed weights · not tested
// against the doctrine". Kept empty, and identical to desktop/src/remote.js.
export const OFFERED = [];
const offeredFor = id => OFFERED.find(m => m.id === String(id || "").trim()) || null;
// How a turn is run: a recommended model's settings, else an offered one's.
const profileFor = id => recommendedFor(id) || offeredFor(id);

/** Take the recommended list from the published catalog, if it can be read. */
export async function refreshRecommended() {
  try {
    const r = await fetch(new URL("../models/catalog.json", import.meta.url), { cache: "no-store" });
    if (!r.ok) return false;
    const list = (await r.json()).recommended;
    if (Array.isArray(list) && list.length && list.every(m => m && typeof m.id === "string" && typeof m.label === "string")) {
      RECOMMENDED.splice(0, RECOMMENDED.length, ...list);
      return true;
    }
  } catch {}
  return false;
}

// Closed-weight families, kept identical to desktop/src/remote.js.
const CLOSED_ID = /^(anthropic\/|x-ai\/|claude|grok|o\d)|^(openai\/)?(gpt-(?!oss)|chatgpt|o\d)|^(google\/)?gemini/i;
/** How Lodestone regards a model: tested with the doctrine, or not; closed weights, or not. */
export function assess(id) {
  id = String(id || "").trim();
  const tested = RECOMMENDED.some(m => m.id === id);
  const closed = CLOSED_ID.test(id);
  const offered = !tested && !!offeredFor(id);
  return { tested, closed, offered, note: tested ? "tested with Lodestone" : offered ? "not recommended · doctrinal fidelity" : closed ? "closed weights · not tested against the doctrine" : "not tested against the doctrine" };
}

const orHeaders = key => ({ "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://harmonism.io/lodestone", "X-Title": "Lodestone" });

/** A short, real request, to prove the key and the model before they are saved. */
export async function testOpenRouter(key, model) {
  key = String(key || "").trim();
  if (!key) throw new Error("Paste the API key first.");
  if (!model) throw new Error("Choose a model first.");
  const e = new OpenRouterEngine({ ctx: 32768 }, { model }, key);
  let out = "";
  for await (const t of e.stream([{ role: "user", content: "Reply with the single word: ready" }], { maxTokens: 10, temperature: 0 })) out = t;
  if (!out.trim()) throw new Error("OpenRouter answered, but with nothing. Try another model.");
  return out.trim();
}

export class OpenRouterEngine {
  /** `key` is given only for the setup test; otherwise it is read from the encrypted store. */
  constructor(tier, { model } = {}, key = null) {
    this.tier = tier; this.model = model || ""; this.key = key; this.kind = "openrouter"; this.where = "openrouter.ai"; this.ctrl = null;
  }
  async isCached() { return true; }
  async load() {
    if (!this.key) this.key = await secrets.get("openrouter");
    if (!this.key) throw new Error("No OpenRouter key is saved.");
    if (!this.model) throw new Error("No model is chosen.");
  }
  // v107: a turn whose thinking spent the whole cap before a word of answer is asked
  // again once, by itself, at low effort with twice the cap (never past the model's own
  // output limit). Nothing was shown yet, so the practitioner sees only "Thinking…" run on.
  async *stream(messages, opts = {}) {
    try { yield* this.once(messages, opts); }
    catch (e) { if (!e?.spent) throw e; yield* this.once(messages, { ...opts, lighter: true }); }
  }
  // v107 options: `model` runs this turn on another model (the hybrid's light turns);
  // `depth` "light" | "deep" sets how much an untested thinking model deliberates;
  // `onThinking` receives the model's thinking as it arrives (Settings → Display).
  async *once(messages, { maxTokens, temperature = 0.7, web = false, background = false, lighter = false, model = null, depth = "deep", onThinking = null } = {}) {
    if (!this.key) await this.load();
    const ctrl = new AbortController(); if (background) this.bgUsage = null; else { this.ctrl = ctrl; this.lastUsage = null; }   // a background call (learning, a summary) is not what Stop stops (1.13.1)
    const mid = current(String(model || this.model || "").trim());
    const exclude = !onThinking;
    // usage.include: OpenRouter ends the stream with the turn's tokens and its cost in dollars.
    const body = { model: mid, messages: cacheBreak(mid, messages), stream: true, temperature, max_tokens: maxTokens, usage: { include: true } };
    // A recommended model runs as hosted Lodestone runs it: reasoning off where the
    // provider allows it, a token floor where reasoning is mandatory, and only
    // providers that do not keep the conversation for training.
    const r = profileFor(mid);
    if (r) {
      body.reasoning = r.reasoning === "none" ? { effort: "none", exclude: true }
        : /^(low|medium|high)$/.test(r.reasoning) ? { effort: r.reasoning, exclude } : { exclude };
      if (r.minTokens && (body.max_tokens || 0) < r.minTokens) body.max_tokens = r.minTokens;
    } else {
      if ((body.max_tokens || 0) < 16000) body.max_tokens = Math.min(16000, orMaxOut(mid) || 16000);
      // v107: whether the model takes a reasoning setting is read from OpenRouter's list
      // (supported_parameters), no longer guessed from Anthropic's name; the name is the
      // fallback until the list has arrived. Medium for a turn that needs depth, low for
      // a light one and for background calls (learning, summaries, tidying, outreach).
      const thinks = orThinks(mid) ?? /^anthropic\//.test(mid);
      if (thinks) body.reasoning = { effort: background || depth === "light" ? "low" : "medium", exclude };
    }   // an untested model may deliberate by default; the cap must hold reasoning and answer (remote.js UNTESTED_FLOOR)
    if (lighter) {
      body.reasoning = { effort: "low", exclude };
      const twice = 2 * (body.max_tokens || 16000), top = orMaxOut(mid);
      body.max_tokens = Math.max(body.max_tokens || 0, top ? Math.min(top, twice) : twice);
    }
    // v107: every model, tested or not, only through providers that do not keep the
    // conversation or train on it (OpenRouter's data_collection "deny"; before, tested models alone).
    body.provider = { data_collection: "deny" };
    // Look this up: OpenRouter searches the web for this turn (Exa; about $0.007 a search).
    if (web) body.plugins = [{ id: "web", engine: "exa", max_results: 5 }];
    const res = await fetch(OPENROUTER + "/chat/completions", { method: "POST", headers: orHeaders(this.key), body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw await providerError(res, "OpenRouter");
    yield* readSSE(res, u => { if (background) this.bgUsage = u; else this.lastUsage = u; }, onThinking);
  }
  // v107: the hybrid's classifier, for a turn route.js could not place: the light model
  // answers SIMPLE or DEEP in a word, within five seconds; anything else counts as deep.
  async classify(text, model) {
    if (!this.key) await this.load();
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const mid = current(String(model || "").trim());
      const body = { model: mid, messages: [{ role: "system", content: CLASSIFIER_PROMPT }, { role: "user", content: String(text || "").slice(0, 2000) }], max_tokens: 16, temperature: 0, provider: { data_collection: "deny" } };
      if (orThinks(mid)) body.reasoning = { effort: "none", exclude: true };
      const res = await fetch(OPENROUTER + "/chat/completions", { method: "POST", headers: orHeaders(this.key), body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) return "deep";
      const j = await res.json();
      return /\bSIMPLE\b/i.test(String(j.choices?.[0]?.message?.content || "")) ? "light" : "deep";
    } catch { return "deep"; }
    finally { clearTimeout(timer); }
  }
  interrupt() { try { this.ctrl?.abort(); } catch {} }
  describe(model = null) { const id = model || this.model; return `${profileFor(id)?.label || (model ? orName(id) : id)} · openrouter.ai`; }
}
