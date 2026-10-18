// held.js — website Lodestone and the browser extension on the practitioner's own
// memory.
//
// Website Lodestone used to keep what it learned of a practitioner on the server.
// It now keeps it here, in the same memory the Lodestone app keeps (IndexedDB
// "munai-offline", shared by every page of harmonism.io because they share
// an origin), carried between devices by Lodestone sync, encrypted. A website or
// extension turn sends this memory along (`held`), the server runs the turn
// on it in a database that lives for that request only, and hands back the
// updated memory at the end of the stream (`munai_state`), which is kept here.
//
//   heldFetch(url, init, ctx)  a drop-in for fetch() to companion-api.php:
//                              adds the memory, keeps the turn and the state
//   migrate()                  takes a member's memory off the server once,
//                              and asks for the server's copy to be deleted
//                              when it is safely synced
//   heldCall(path, body)       the reading canon and the learning jobs, on
//                              this memory (member/reading-api.php, lodestone-learn.php)
//
// Nothing here runs for a visitor who is not signed in: an anonymous turn is
// sent as it always was, and kept nowhere.
//
// One memory per person: each account signed in on this device opens its
// own (store.js keeps one database per account), so people who share a
// computer never see, send or sync each other's. Signed out, the device's own
// memory is open (the app's, for whoever uses it without an account). bind()
// chooses before anything is read; every export here calls it.

import * as store from "./store.js";
import { Sync } from "./sync.js";
import { wire } from "./syncwire.js";
import { hosted } from "./phone.js";
import { isHPCode, parseHP } from "./hp.js";

export const COMPANION = "companion";        // kv: { state, blocks, at }
export const WEB_THREAD = "web-harmonism";   // the website's own conversation
const RECENT = 160;
const HP_PENDING = "munai-hp-pending";
const ANON_IMPORT = "munai-held-import";

let base = (typeof location !== "undefined" && /^https?:/.test(location.protocol)) ? location.origin : "https://harmonism.io";
let auth = () => hosted.token();
let account = () => hosted.account();
let post = null;   // Lodestone Desktop carries these calls through its main process, which holds the account
/** The extension's worker answers from chrome-extension://, so it names the site and its own sign-in. */
export function configure(o = {}) {
  if (o.base) base = o.base.replace(/\/+$/, "");
  if (o.token) auth = o.token;
  if (o.account) account = o.account;
  if (o.post) post = o.post;
}

let SY = null;
export function syncer() {
  if (!SY) { const w = wire(null, { base }); SY = new Sync({ transport: w.syncTransport(), secret: w.syncSecret() }); }
  return SY;
}

export const available = () => !!(globalThis.crypto?.subtle && globalThis.indexedDB);
export async function signedIn() { return !!(await account().catch(() => null)); }

// ─── whose memory ────────────────────────────────────────────────────────────

const emailOf = (a) => (a && !a.computer && a.email ? String(a.email).trim().toLowerCase() : null);
async function keyOf(email) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("lodestone-account:" + email)));
  return Array.from(d.slice(0, 12), b => b.toString(16).padStart(2, "0")).join("");
}
const newName = (prefix) => prefix + "-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, "0")).join("");

let bound = { email: undefined, name: null };
/**
 * Opens the memory of whoever is signed in: theirs if they are, the device's
 * if no one is. A first sign-in on this device gets a memory of its own,
 * except where the device's memory is already known to be theirs (it was
 * used under this account before memories were kept apart). Returns
 * { account, name, changed }.
 */
export async function bind() {
  // Without WebCrypto (the app served over plain http on a home network) there is no account here.
  const email = globalThis.crypto?.subtle ? emailOf(await account().catch(() => null)) : null;
  if (email === bound.email && store.using() === bound.name) return { account: email, name: bound.name, changed: false };
  let name;
  if (!email) name = await store.accounts.device();
  else {
    const key = await keyOf(email);
    name = await store.accounts.get(key);
    if (!name) {
      const device = await store.accounts.device();
      if ((await store.peek(device, "held:owner").catch(() => null)) === email) {
        // This device's memory was this account's: it becomes theirs, and the
        // device begins a memory of its own.
        name = device;
        await store.accounts.setDevice(newName("munai-device"));
      } else name = newName("lodestone-memory");
      await store.accounts.set(key, name);
    }
  }
  const changed = await store.use(name);
  if (changed) SY = null;                       // sync settings and keys live in each memory
  bound = { email, name };
  return { account: email, name, changed };
}

/**
 * The device's memory, held from before this account signed in here, that
 * the account may say is theirs: { offer, device }. Asked once per account.
 */
export async function deviceOffer() {
  const { account: email, name } = await bind();
  if (!email) return { offer: false };
  const device = await store.accounts.device();
  if (device === name) return { offer: false };
  if (await store.kv.get("held:deviceAnswered")) return { offer: false };
  const owner = await store.peek(device, "held:owner").catch(() => null);
  if (owner && owner !== email) return { offer: false };          // someone else's
  return { offer: await store.holdsMemory(device).catch(() => false), device };
}

/** "Yes, it's mine": the device's memory joins this account's, and the device begins anew. */
export async function adoptDevice() {
  const { device, offer } = await deviceOffer();
  if (!offer) return false;
  const { name } = await bind();
  if (!(await store.holdsMemory(name).catch(() => false))) {
    // Nothing here yet: the device's memory simply becomes this account's.
    const key = await keyOf(bound.email);
    await store.accounts.set(key, device);
    await store.accounts.setDevice(newName("munai-device"));
    await store.dropDatabase(name);
    bound = { email: undefined, name: null };
    await bind();
  } else {
    await store.mergeFrom(device);
    await store.dropDatabase(device);
    await store.accounts.setDevice(newName("munai-device"));
  }
  await store.kv.set("held:deviceAnswered", "adopted");
  syncSoon();
  return true;
}

/** "No, it isn't": left where it is, and not asked again for this account. */
export async function declineDevice() { await bind(); await store.kv.set("held:deviceAnswered", "declined"); }

/**
 * Signing out of this device. keep (the default): the memory stays here for
 * the next sign-in. Not kept (a shared computer): it is deleted from this
 * device; a synced copy stays on the account and returns at the next sign-in.
 */
export async function signOutHere({ keep = true } = {}) {
  const { account: email, name } = await bind();
  if (email && !keep) {
    await store.dropDatabase(name);
    await store.accounts.del(await keyOf(email));
  }
  bound = { email: undefined, name: null };
}

/** This browser's own setting: a shared computer removes memory at sign-out unless told otherwise. */
// (The website's sign-in page sets it in localStorage before any of this is loaded.)
export const sharedComputer = {
  async get() {
    try { const v = localStorage.getItem("munai-shared-computer"); if (v != null) return v === "1"; } catch {}
    return !!(await store.accounts.getFlag("shared").catch(() => null));
  },
  async set(on) {
    try { localStorage.setItem("munai-shared-computer", on ? "1" : "0"); } catch {}
    await store.accounts.setFlag("shared", on ? 1 : null);
  },
};

/** e.g. t•••@proton.me */
export function masked(email) {
  const [u, d] = String(email || "").split("@");
  return d ? `${u.slice(0, 1)}•••@${d}` : "another account";
}

// ─── memory ──────────────────────────────────────────────────────────────────

export async function load() { await bind(); return (await store.kv.get(COMPANION)) || null; }

export async function apply(evt) {
  if (!evt || !evt.state) return;
  await bind();
  await store.kv.set(COMPANION, { state: evt.state, blocks: evt.blocks || {}, at: Date.now() });
}

/** The latest messages of the whole memory, oldest first, under their timestamps (the server's ids). */
export async function recent(limit = RECENT) {
  const c = await load();
  const cons = Number(c?.state?.tables?.clients?.[0]?.last_consolidation_id || 0);
  // Since the last consolidation (an id that is a timestamp in newer memories), and at least the last weeks.
  const since = cons > 1e12 ? Math.min(cons, Date.now() - 14 * 864e5) : Date.now() - 365 * 864e5;
  const msgs = (await store.messages.since(since)).sort((a, b) => a.ts - b.ts).slice(-limit);
  const out = []; let last = 0;
  for (const m of msgs) {
    if (m.meta?.crisis) continue;
    const id = Math.max(Number(m.ts) || Date.now(), last + 1); last = id;
    // The page a turn was about (the website, the extension): the reading trail.
    out.push({ id, role: m.role, content: String(m.content || "").slice(0, 12000), page_title: m.meta?.page || "" });
  }
  return out;
}

/** A Harmonic Profile the assessment left in this browser joins the memory (and Lodestone's app reads it too). */
export async function takePending() {
  let code = null;
  try { code = localStorage.getItem(HP_PENDING); } catch {}
  if (!code || !isHPCode(code)) return false;
  try { localStorage.removeItem(HP_PENDING); } catch {}
  try {
    const r = parseHP(code);
    const wheel = { ...((await store.kv.get("wheel")) || {}), ...r.wheel };
    await store.kv.set("wheel", wheel);
    await store.kv.set("assessment", r.summary);
    await store.kv.set("hp_code", code.trim());
    await store.kv.set("hp_fresh", true);
    return true;
  } catch { return false; }
}

/** What a request carries: the memory, the latest messages, the profile the apps hold. */
export async function prepare() {
  const c = await load();
  const hp = await store.kv.get("hp_code");
  const fresh = await store.kv.get("hp_fresh");
  return { state: c?.state || null, recent: await recent(), ...(hp ? { hp_code: hp } : {}), ...(fresh ? { hp_fresh: true } : {}) };
}

export async function record({ threadId = WEB_THREAD, title = "On harmonism.io", user, assistant, page = {}, source = "website" }) {
  await bind();
  const now = Date.now();
  let t = await store.threads.get(threadId);
  if (!t) t = { id: threadId, title, created: now, updated: now, source };
  const meta = { source, ...(page.title ? { page: String(page.title).slice(0, 200) } : {}), ...(page.url ? { url: String(page.url).slice(0, 500) } : {}) };
  if (user) await store.messages.add({ threadId, role: "user", content: user, ts: now, meta });
  if (assistant) await store.messages.add({ threadId, role: "assistant", content: assistant, ts: now + 1, meta: { ...meta, model: "harmonism.io" } });
  t.updated = now + 1;
  await store.threads.put(t);
}

async function clearThread(threadId) {
  for (const m of await store.messages.forThread(threadId)) await store.messages.del(m.id);
}

export async function syncSoon() {
  try { if (await syncer().isOn()) syncer().now(); } catch {}
}

/**
 * Before a turn: what other devices added since the last sync comes in first
 * (a conversation just had on the phone), if that sync is more than half a
 * minute old. Waits five seconds at most; a turn is never held up longer.
 */
export async function freshen() {
  try {
    await bind();
    const sy = syncer();
    if (!(await sy.isOn())) return;
    const c = await sy.conf();
    if (c.last && Date.now() - c.last < 30000) return;
    await Promise.race([sy.now(), new Promise(r => setTimeout(r, 5000))]);
  } catch {}
}

// ─── a turn ──────────────────────────────────────────────────────────────────

/**
 * fetch() for companion-api.php. ctx: { source: "website" | "dashboard" | "extension",
 * threadId, title, page: { title, url } }.
 */
export async function heldFetch(url, init = {}, ctx = {}) {
  let body;
  try { body = JSON.parse(init.body); } catch { return fetch(url, init); }
  if (!body || body.anonymous || !available()) return fetch(url, init);
  let tok;
  try { if (!(await signedIn())) return fetch(url, init); tok = await auth(); } catch { return fetch(url, init); }
  await bind();
  try { await migrate(); } catch (e) { console.warn("[held] migration later:", e?.message || e); }
  await freshen();
  await takePending();
  const lastUser = [...(body.messages || [])].reverse().find(m => m.role === "user")?.content || "";
  body.held = await prepare();
  delete body.clientId; delete body.email;
  const headers = { ...(init.headers || {}), "Content-Type": "application/json", Authorization: "Bearer " + tok };
  const res = await fetch(url, { ...init, headers, body: JSON.stringify(body) });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.includes("event-stream") || !res.body) return res;
  const [mine, theirs] = res.body.tee();
  watch(theirs, { lastUser, ctx }).catch(e => console.warn("[held] turn not kept:", e?.message || e));
  return new Response(mine, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function watch(stream, { lastUser, ctx }) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", stateEvt = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      let evt; try { evt = JSON.parse(line.slice(6)); } catch { continue; }
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") text += evt.delta.text;
      else if (evt.type === "munai_state") stateEvt = evt;
    }
  }
  if (buf.startsWith("data: ")) { try { const evt = JSON.parse(buf.slice(6)); if (evt.type === "munai_state") stateEvt = evt; } catch {} }
  if (stateEvt) await apply(stateEvt);
  if (stateEvt?.flags?.reset) { await clearThread(ctx.threadId || WEB_THREAD); await syncSoon(); return; }
  if (text) {
    await record({ threadId: ctx.threadId || WEB_THREAD, title: ctx.title || "On harmonism.io", user: lastUser, assistant: text.replace(/\n\n_— response continues; say "go on" to continue —_$/, ""), page: ctx.page || {}, source: ctx.source || "website" });
    if (stateEvt) await store.kv.del("hp_fresh");
  }
  await syncSoon();
}

// ─── the reading canon and the learning jobs ─────────────────────────────────

/** POSTs to an endpoint that runs on this memory and hands it back. */
export async function heldCall(path, body = {}) {
  await freshen();
  const { withRecent, ...rest } = body;
  const payload = { ...rest, held: { state: (await load())?.state || null, ...(withRecent ? { recent: await recent() } : {}) } };
  let ok, status, j;
  if (post) {
    const r = await post(path.replace(/^\/+/, ""), payload);
    ok = !!r?.ok; status = r?.status || 0; j = r?.json || {};
    if (!r?.ok && r?.message && !j.error) j.error = r.message;
  } else {
    const tok = await auth();
    const res = await fetch(`${base}/${path.replace(/^\/+/, "")}`, {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify(payload),
    });
    ok = res.ok; status = res.status; j = await res.json().catch(() => ({}));
  }
  if (j.munai_state) await apply(j.munai_state);
  else if (j.state) await apply({ state: j.state, blocks: j.blocks });
  if (j.state || j.munai_state) syncSoon();
  if (!ok || j.error) { const e = new Error(j.error || `harmonism.io answered ${status}.`); e.code = j.error; e.status = status; throw e; }
  return j;
}

// ─── moving off the server (P4) ──────────────────────────────────────────────

let migrating = null;
export function migrate() {
  if (!migrating) migrating = runMigrate().finally(() => { migrating = null; });
  return migrating;
}

async function runMigrate() {
  await bind();
  let m = await store.kv.get("held:migrated");
  if (!m) {
    const tok = await auth();
    const res = await fetch(`${base}/member/memory-export.php`, { headers: { Authorization: "Bearer " + tok }, cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(j.error || `harmonism.io answered ${res.status}.`);
    if (!j.empty) {
      if (!(await load())) await store.kv.set(COMPANION, { state: j.state, blocks: {}, at: Date.now() });
      const msgs = j.messages || [];
      if (msgs.length) {
        let t = await store.threads.get(WEB_THREAD);
        const first = Number(msgs[0].timestamp) * 1000 || Date.now();
        if (!t) t = { id: WEB_THREAD, title: "On harmonism.io", created: first, updated: first, source: "website" };
        const have = new Set((await store.messages.forThread(WEB_THREAD)).map(x => `${x.ts}-${x.role}`));
        let i = 0;
        for (const x of msgs) {
          // A stable time for each message, the same on every device that takes it in.
          const ts = Number(x.timestamp) * 1000 + (i++ % 1000);
          if (have.has(`${ts}-${x.role}`)) continue;
          await store.messages.add({ threadId: WEB_THREAD, role: x.role, content: x.content, ts, meta: { source: "website", imported: true, ...(x.page_title ? { page: x.page_title } : {}) } });
          t.updated = Math.max(t.updated, ts);
        }
        await store.threads.put(t);
      }
    }
    m = { at: Date.now(), clients: j.clients || [], confirmed: !!j.empty || !(j.clients || []).length };
    await store.kv.set("held:migrated", m);
  }
  await takeAnonymous();
  await confirmIfSynced(m);
}

/** The conversation of an anonymous visit that ended in signing in (member/login.php leaves it here). */
async function takeAnonymous() {
  let raw = null;
  try { raw = localStorage.getItem(ANON_IMPORT); localStorage.removeItem(ANON_IMPORT); } catch {}
  if (!raw) return;
  let list = []; try { list = JSON.parse(raw); } catch {}
  const now = Date.now() - list.length * 1000;
  let t = await store.threads.get(WEB_THREAD);
  if (!t) t = { id: WEB_THREAD, title: "On harmonism.io", created: now, updated: now, source: "website" };
  let i = 0;
  for (const x of list.slice(-100)) {
    if (!x || !["user", "assistant"].includes(x.role) || !x.content) continue;
    const ts = now + 1000 * i++;
    await store.messages.add({ threadId: WEB_THREAD, role: x.role, content: String(x.content), ts, meta: { source: "website", anonymous: true } });
    t.updated = ts;
  }
  await store.threads.put(t);
}

/** The server's copy goes only once this memory is synced, so it is never the only copy that was lost. */
async function confirmIfSynced(m) {
  if (!m || m.confirmed || !m.clients?.length) return;
  const sy = syncer();
  if (!(await sy.isOn())) return;
  const r = await sy.now();
  if (!r.ok) return;
  const tok = await auth();
  const res = await fetch(`${base}/member/memory-export.php`, {
    method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
    body: JSON.stringify({ action: "confirm", clients: m.clients }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok && !j.error) await store.kv.set("held:migrated", { ...m, confirmed: Date.now() });
}

/** For a page to say where the memory is: { synced, migrated, confirmed }. */
export async function status() {
  await bind();
  const m = await store.kv.get("held:migrated");
  const conf = await syncer().conf();
  return { synced: !!conf.on, last: conf.last || null, migrated: !!m, confirmed: !!m?.confirmed };
}
