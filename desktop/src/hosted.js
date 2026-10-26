// hosted.js — Lodestone desktop thinking with harmonism.io's hosted models, under
// the practitioner's harmonism.io account.
//
// For the practitioner whose computer cannot hold a model and who has no key
// of their own. As with a rented model, the corpus, the retrieval, the crisis
// gate, witness mode, the memory and the practices live on this computer and
// run here; the assembled turn goes to harmonism.io/lodestone-desktop-api.php,
// which sends it to the hosted model with the server's own doctrinal backbone
// and stores nothing of it. A free account has ten messages a day the first month, then five, in total
// across harmonism.io, Telegram and this app; the server counts them.
//
// Sign-in is the website's own (Supabase, email and password). The refresh
// token is kept encrypted by the operating system's keychain (main.js); the
// short-lived access token is held in memory only and renewed when it expires.

const SUPABASE_URL = "https://zccplzknsbpdczfnwkwz.supabase.co";
// Supabase's public "anon" key, the same one harmonism.io's pages carry; it
// identifies the project, it is not a secret.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpjY3Bsemtuc2JwZGN6Zm53a3d6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNjEwMTEsImV4cCI6MjA5MTgzNzAxMX0.iaNbbx4gPRQhEDtKe4yhaPjFZgMmFGOrLSbP5uVl6CM";
const API = "https://harmonism.io/lodestone-desktop-api.php";
const BASE = "https://harmonism.io";

class Hosted {
  /**
   * @param {{ fetch: Function, load: () => ({email:string, refresh:string}|null), save: (v: {email:string, refresh:string}|null) => void,
   *           api?: string, supabaseUrl?: string }} o
   */
  constructor(o) {
    this.fetch = o.fetch;
    this.load = o.load;
    this.save = o.save;
    this.onExpired = o.onExpired || (() => {});
    this.api = o.api || API;
    this.supabaseUrl = o.supabaseUrl || SUPABASE_URL;
    this.access = null;       // { token, exp }
    this.cached = null;       // { at, value } of the last status
  }

  account() { const a = this.load(); return a && a.refresh ? { email: a.email } : null; }
  signedIn() { return !!this.account(); }

  async auth(grant, body) {
    const res = await this.fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(body),
    });
    let j = {};
    try { j = await res.json(); } catch {}
    if (!res.ok || !j.access_token) {
      const why = j.error_description || j.msg || j.error || "";
      // A saved sign-in the account no longer honours (expired, revoked, used
      // elsewhere): forget it, so the app asks for the password again instead
      // of failing every call as if harmonism.io were unreachable.
      if (grant === "refresh_token" && res.status >= 400 && res.status < 500) {
        const was = this.load()?.email || null;
        this.access = null; this.cached = null; this.save(null);
        if (was) this.onExpired(was);
        const e = new Error("Your harmonism.io sign-in on this computer has expired. Sign in again.");
        e.code = "auth"; throw e;
      }
      if (/invalid login|invalid_grant|invalid credentials/i.test(why)) throw new Error(grant === "password" ? "That email and password do not match a harmonism.io account." : "Sign in to your harmonism.io account again.");
      if (/email not confirmed/i.test(why)) throw new Error("Confirm your email first: harmonism.io sent you a link when you signed up.");
      throw new Error(`harmonism.io could not sign you in${why ? `: ${why}` : "."}`);
    }
    this.access = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000 };
    const email = String(j.user?.email || body.email || this.load()?.email || "").toLowerCase();
    this.save({ email, refresh: j.refresh_token });
    this.cached = null;
    return { email };
  }

  async signIn(email, password) {
    email = String(email || "").trim(); password = String(password || "");
    if (!email || !password) throw new Error("Give the email and password of your harmonism.io account.");
    return this.auth("password", { email, password });
  }

  signOut() { this.access = null; this.cached = null; this.save(null); }

  async token(force = false) {
    if (!force && this.access && Date.now() < this.access.exp) return this.access.token;
    // One renewal at a time: a refresh token is single-use, and two calls
    // renewing with the same one leave the second refused (and the sign-in lost).
    if (!this.renewing) this.renewing = (async () => {
      const a = this.load();
      if (!a?.refresh) { const e = new Error("Sign in to your harmonism.io account first."); e.code = "auth"; throw e; }
      await this.auth("refresh_token", { refresh_token: a.refresh });
      return this.access.token;
    })().finally(() => { this.renewing = null; });
    return this.renewing;
  }

  /** Calls the endpoint with the access token, renewing it once if the server refuses it. */
  async call(init) {
    let res = await this.fetch(init.url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await this.token()}` } });
    if (res.status === 401) res = await this.fetch(init.url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await this.token(true)}` } });
    return res;
  }

  /** { email, status, cap, remaining, reset_at, models }. Cached for a minute unless `fresh`. */
  async status(fresh = false) {
    if (!fresh && this.cached && Date.now() - this.cached.at < 60000) return this.cached.value;
    const res = await this.call({ url: this.api + "?status=1", method: "GET" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || `harmonism.io answered ${res.status}.`);
    this.cached = { at: Date.now(), value: j };
    return j;
  }

  /** One turn, OpenAI-shaped in and out (server-sent events). */
  async chat(o, model, signal) {
    const { chat_template_kwargs, ...rest } = o;
    const res = await this.call({ url: this.api, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...rest, model, stream: true }), signal });
    this.cached = null;
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error?.message || `harmonism.io answered ${res.status}.`);
    }
    return res;
  }
}

module.exports = { Hosted, BASE, API };
