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
// Where the session is kept: this origin's localStorage, shared with the
// website, unless a page that has none sets another (the browser extension's
// worker keeps it in its own storage).
let sessionStore = {
  keys: () => Object.keys(localStorage),
  get: k => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  del: k => localStorage.removeItem(k),
};
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
      if (/invalid|not found|revoked|already used/i.test(why)) { writeSession(null); throw new Error("Sign in to your harmonism.io account again."); }
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
  { id: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", maker: "DeepSeek", licence: "MIT", reasoning: "medium", minTokens: 4000, note: "The default on harmonism.io" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", maker: "NVIDIA", licence: "OpenMDW 1.1", reasoning: "none", minTokens: 0, note: "" },
];
// Ids that left the tested list for a successor; the same table as desktop/src/remote.js.
const RETIRED = { "deepseek/deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash-1017" };
const current = id => RETIRED[String(id || "").trim()] || id;
const recommendedFor = id => RECOMMENDED.find(m => m.id === current(id)) || null;

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
  async *stream(messages, { maxTokens, temperature = 0.7, web = false, background = false } = {}) {
    if (!this.key) await this.load();
    const ctrl = new AbortController(); if (background) this.bgUsage = null; else { this.ctrl = ctrl; this.lastUsage = null; }   // a background call (learning, a summary) is not what Stop stops (1.13.1)
    // usage.include: OpenRouter ends the stream with the turn's tokens and its cost in dollars.
    const body = { model: current(this.model), messages, stream: true, temperature, max_tokens: maxTokens, usage: { include: true } };
    // A recommended model runs as hosted Lodestone runs it: reasoning off where the
    // provider allows it, a token floor where reasoning is mandatory, and only
    // providers that do not keep the conversation for training.
    const r = profileFor(this.model);
    if (r) {
      body.reasoning = r.reasoning === "none" ? { effort: "none", exclude: true }
        : /^(low|medium|high)$/.test(r.reasoning) ? { effort: r.reasoning, exclude: true } : { exclude: true };
      if (r.minTokens && (body.max_tokens || 0) < r.minTokens) body.max_tokens = r.minTokens;
      body.provider = { data_collection: "deny" };
    }
    // Look this up: OpenRouter searches the web for this turn (Exa; about $0.007 a search).
    if (web) body.plugins = [{ id: "web", engine: "exa", max_results: 5 }];
    const res = await fetch(OPENROUTER + "/chat/completions", { method: "POST", headers: orHeaders(this.key), body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw await providerError(res, "OpenRouter");
    yield* readSSE(res, u => { if (background) this.bgUsage = u; else this.lastUsage = u; });
  }
  interrupt() { try { this.ctrl?.abort(); } catch {} }
  describe() { return `${profileFor(this.model)?.label || this.model} · openrouter.ai`; }
}
