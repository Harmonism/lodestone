// sync.js — Lodestone's memory carried between devices through the practitioner's
// harmonism.io account. Off until switched on.
//
// What travels: every conversation, the notes Lodestone keeps (profile), the
// Wheel, the practices, the Harmonic Profile, and — only when ticked — the
// OpenRouter key. Settings, the corpus and models stay on each device.
//
// How it is kept unreadable: before anything leaves, each record is encrypted
// here with AES-256-GCM under a key drawn from the practitioner's sync
// passphrase (PBKDF2-SHA-256, 600,000 iterations, a salt kept with the synced
// copy). Record names are HMACs of the local ids, and each ciphertext is bound
// to its name, so the server can neither read a record nor pass one off as
// another. The passphrase is never sent and never stored; the derived keys are
// kept on the device as WebCrypto keys the page itself cannot export. What
// harmonism.io does see: the account, how many records, how large, and when.
//
// How devices agree: the server numbers every write. Each device remembers,
// per record, the number it last saw and a hash of what it last saw; a record
// whose local hash differs has changed here. A write is accepted only when it
// names the number the server holds, so two devices never silently overwrite
// each other: the later one is handed the other's version and merges. A
// conversation merges message by message (a message is known by its time and
// role), so work done on two devices joins up. The practices merge by id;
// the notes, the Wheel and the profile keep this device's version when both
// changed. Deleting a conversation deletes it everywhere; nothing else is
// ever deleted by sync.

import * as store from "./store.js";

const V = 1;
const ITER = 600000;
// "companion" is website Lodestone's memory, held by the practitioner (the model-written
// profile, its Wheel, summaries, the reading canon); "hp_code" the Harmonic
// Profile as the assessment gave it, which website Lodestone reads from.
const SYNCED_KV = ["profile", "wheel", "practices", "assessment", "companion", "hp_code"];
const KEYS = "sync:keys", STATE = "sync:state", CONF = "sync:conf";
const te = new TextEncoder(), td = new TextDecoder();

export class SyncError extends Error {
  constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; }
}

// ─── bytes ───────────────────────────────────────────────────────────────────

export const b64u = bytes => {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = s => {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const b = atob(s), a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
};

/** JSON with keys in a fixed order, so the same content hashes the same on every device. */
export function stable(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Uint8Array || ArrayBuffer.isView(v)) return JSON.stringify({ $b: b64u(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) });
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

async function sha(text) { return b64u(await crypto.subtle.digest("SHA-256", te.encode(text))).slice(0, 27); }

const gz = typeof CompressionStream === "function";
async function squeeze(bytes) {
  if (!gz) return [0, bytes];
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  return [1, new Uint8Array(out)];
}
async function unsqueeze(flag, bytes) {
  if (flag === 0) return bytes;
  if (flag !== 1 || !gz) throw new SyncError("format", "This record was written by a newer Lodestone. Update Lodestone on this device.");
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

// ─── keys ────────────────────────────────────────────────────────────────────

export async function deriveKeys(passphrase, saltB64) {
  const base = await crypto.subtle.importKey("raw", te.encode(String(passphrase).normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64u(saltB64), iterations: ITER }, base, 512));
  const aes = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const mac = await crypto.subtle.importKey("raw", bits.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  bits.fill(0);
  return { aes, mac };
}

export async function seal(keys, text, name) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const [flag, body] = await squeeze(te.encode(text));
  const pt = new Uint8Array(body.length + 1); pt[0] = flag; pt.set(body, 1);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(name) }, keys.aes, pt));
  const out = new Uint8Array(1 + 12 + ct.length); out[0] = V; out.set(iv, 1); out.set(ct, 13);
  return b64u(out);
}

export async function open(keys, data, name) {
  const a = unb64u(data);
  if (a[0] !== V) throw new SyncError("format", "This record was written by a newer Lodestone. Update Lodestone on this device.");
  let pt;
  try { pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: a.subarray(1, 13), additionalData: te.encode(name) }, keys.aes, a.subarray(13))); }
  catch { throw new SyncError("decrypt", "A synced record could not be decrypted with this passphrase."); }
  return td.decode(await unsqueeze(pt[0], pt.subarray(1)));
}

const CHECK = "munai-sync-check";
const ridOf = async (keys, lid) => b64u(await crypto.subtle.sign("HMAC", keys.mac, te.encode("rec:" + lid))).slice(0, 43);

// ─── local records ───────────────────────────────────────────────────────────

const uidOf = m => m.uid || `${m.ts}-${m.role}`;
const cleanMsg = m => { const { id, threadId, ...rest } = m; return { ...rest, uid: uidOf(m) }; };

async function readLocal(lid, secret) {
  const [kind, name] = [lid.slice(0, 1), lid.slice(2)];
  if (kind === "t") {
    const thread = await store.threads.get(name);
    if (!thread) return null;
    const messages = (await store.messages.forThread(name)).map(cleanMsg);
    return { thread, messages };
  }
  if (kind === "k") { const v = await store.kv.get(name); return v == null ? null : v; }
  if (kind === "s") { const v = secret ? await secret.get(name) : null; return v || null; }
  return null;
}

async function writeLocal(lid, body, secret) {
  const [kind, name] = [lid.slice(0, 1), lid.slice(2)];
  if (kind === "t") {
    await store.threads.put({ ...body.thread, id: name });
    const local = await store.messages.forThread(name);
    const have = new Map(local.map(m => [uidOf(m), m]));
    const want = new Set();
    for (const m of body.messages || []) {
      want.add(m.uid);
      const l = have.get(m.uid);
      if (!l) await store.messages.add({ ...m, threadId: name });
      else if (stable(cleanMsg(l)) !== stable(m)) await store.messages.put({ ...m, id: l.id, threadId: name });
    }
    for (const [u, l] of have) if (!want.has(u)) await store.messages.del(l.id);
    return;
  }
  if (kind === "k") return store.kv.set(name, body);
  if (kind === "s") return secret?.set(name, body);
}

async function removeLocal(lid) {
  // Only a conversation is deleted by sync; notes, practices and keys never are.
  if (lid.startsWith("t:")) await store.threads.remove(lid.slice(2));
}

function merge(lid, mine, theirs) {
  if (lid.startsWith("t:")) {
    const by = new Map();
    for (const m of theirs.messages || []) by.set(m.uid, m);
    for (const m of mine.messages || []) {
      const t = by.get(m.uid);
      if (!t || String(m.content || "").length >= String(t.content || "").length) by.set(m.uid, m);
    }
    const messages = [...by.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.uid).localeCompare(String(b.uid)));
    const newer = (mine.thread.updated || 0) >= (theirs.thread.updated || 0) ? mine.thread : theirs.thread;
    return { thread: { ...theirs.thread, ...mine.thread, title: newer.title, updated: Math.max(mine.thread.updated || 0, theirs.thread.updated || 0) }, messages };
  }
  if (lid === "k:practices" && Array.isArray(mine) && Array.isArray(theirs)) {
    const ids = new Set(mine.map(p => p.id));
    return mine.concat(theirs.filter(p => !ids.has(p.id)));
  }
  return mine;
}

// ─── the engine ──────────────────────────────────────────────────────────────

/**
 * transport: { request(method, query, body) → json, account() → {email}|null }
 * secret:    { get(name), set(name, value) } for the OpenRouter key, or null
 */
export class Sync {
  constructor({ transport, secret = null, onChange = () => {}, canRun = () => true }) {
    this.t = transport; this.secret = secret; this.onChange = onChange; this.canRun = canRun;
    this.running = null; this.keys = null;
  }

  async conf() { return (await store.kv.get(CONF)) || { on: false, key: false }; }
  async setConf(patch) { const c = { ...(await this.conf()), ...patch }; await store.kv.set(CONF, c); return c; }
  async isOn() { return !!(await this.conf()).on; }

  /** Whether the OpenRouter key travels. Switching it on takes in a key another device sent. */
  async setKey(on) {
    await this.setConf({ key: !!on });
    const st = await store.kv.get(STATE);
    if (st && on) {
      for (const [rid, k] of Object.entries(st.recs)) if (k.skip) delete st.recs[rid];
      st.seq = 0;
      await store.kv.set(STATE, st);
    }
    return this.now();
  }

  /** What the account holds: { meta|null, count, bytes }. */
  async remote() { return this.t.request("GET", "?meta=1"); }

  /** First device: a new synced copy under this passphrase. `replace` erases one already there. */
  async create(passphrase, { replace = false, key = false } = {}) {
    if (String(passphrase).length < 10) throw new SyncError("weak", "Choose a passphrase of at least ten characters; four or five ordinary words are easy to remember and hard to guess.");
    const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const keys = await deriveKeys(passphrase, salt);
    const check = await seal(keys, CHECK, "check");
    const r = await this.t.request("PUT", "", { salt, check, v: V, replace });
    await this.adopt(keys, r.meta, key);
    return this.now();
  }

  /** Another device: join the synced copy with its passphrase. */
  async join(passphrase, { key = false } = {}) {
    const r = await this.remote();
    if (!r.meta) throw new SyncError("no_space", "There is no synced copy on this account yet.");
    const keys = await deriveKeys(passphrase, r.meta.salt);
    try { if (await open(keys, r.meta.check, "check") !== CHECK) throw 0; }
    catch { throw new SyncError("passphrase", "That passphrase does not open the synced copy."); }
    await this.adopt(keys, r.meta, key);
    return this.now();
  }

  async adopt(keys, meta, key) {
    this.keys = keys;
    await store.kv.set(KEYS, keys);
    await store.kv.set(STATE, { epoch: meta.epoch, seq: 0, recs: {} });
    await this.setConf({ on: true, key: !!key, since: Date.now(), last: null, error: null, account: await this.accountEmail() });
  }

  /** The harmonism.io account this device syncs as; null through a computer, which has no account. */
  async accountEmail() {
    const a = await Promise.resolve(this.t.account?.()).catch(() => null);
    return a && !a.computer && a.email ? String(a.email).trim().toLowerCase() : null;
  }

  /** Stops syncing on this device; the synced copy stays for the others. */
  async off() {
    this.keys = null;
    await store.kv.del(KEYS); await store.kv.del(STATE);
    await this.setConf({ on: false, last: null, error: null });
  }

  /** Erases the synced copy from harmonism.io; each device keeps its own memory. */
  async erase() { await this.t.request("DELETE", ""); await this.off(); }

  async loadKeys() { if (!this.keys) this.keys = await store.kv.get(KEYS); return this.keys; }

  /** One sync, or the one already running. Resolves to a summary; never throws. */
  now() {
    if (this.running) return this.running;
    // One sync at a time across this browser's pages: the app, an article
    // page and the dashboard share this memory.
    const go = () => this.run();
    const locked = globalThis.navigator?.locks?.request ? () => navigator.locks.request("lodestone-sync", go) : go;
    this.running = locked().finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    const conf = await this.conf();
    if (!conf.on) return { ok: false, off: true };
    if (!this.canRun()) return { ok: false, busy: true };
    // This memory syncs with one account. Signed in as another, nothing is
    // pushed or pulled: one account's memory never reaches another's copy.
    const acct = await this.accountEmail();
    if (acct && conf.account && acct !== conf.account) {
      const message = "This memory syncs with another harmonism.io account. Sign in as that account to sync it.";
      await this.setConf({ error: { code: "account", message, at: Date.now() } });
      return { ok: false, code: "account", message };
    }
    if (acct && !conf.account) await this.setConf({ account: acct });
    try {
      const out = await this.cycle(conf);
      await this.setConf({ last: Date.now(), error: null, count: out.count, bytes: out.bytes });
      if (out.changed.size) this.onChange(out.changed);
      return { ok: true, ...out };
    } catch (e) {
      const code = e.code || "network";
      const message = String(e.message || e);
      // The copy was erased, or started again under a new passphrase, elsewhere:
      // this device stops and says so rather than writing under the old keys.
      if (code === "gone" || code === "epoch" || code === "no_space") await this.off();
      await this.setConf({ error: { code, message, at: Date.now() } });
      return { ok: false, code, message };
    }
  }

  async locals(keys, conf) {
    const ids = (await store.threads.list()).map(t => "t:" + t.id);
    for (const k of SYNCED_KV) ids.push("k:" + k);
    if (conf.key && this.secret) ids.push("s:openrouter");
    const out = new Map();
    for (const lid of ids) {
      const body = await readLocal(lid, this.secret);
      if (body == null) continue;
      const text = stable({ lid, body });
      out.set(await ridOf(keys, lid), { lid, body, text, h: await sha(text) });
    }
    return out;
  }

  async cycle(conf) {
    const keys = await this.loadKeys();
    if (!keys) throw new SyncError("epoch", "Enter your sync passphrase on this device again.");
    const st = (await store.kv.get(STATE)) || { seq: 0, recs: {} };
    const meta = await this.t.request("GET", "?meta=1");
    if (!meta.meta) throw new SyncError("gone", "The synced copy was deleted from another device. Your memory here is untouched; turn sync on again to start a new one.");
    if (meta.meta.epoch !== st.epoch) throw new SyncError("epoch", "The synced copy was started again with a new passphrase on another device. Enter the new passphrase here.");

    const changed = new Set();
    const keyRid = await ridOf(keys, "s:openrouter");
    let local = await this.locals(keys, conf);

    // A record from the server, pulled or handed back as a conflict.
    const take = async (rid, rec) => {
      const known = st.recs[rid];
      if (known && known.seq >= rec.seq) return;
      const loc = local.get(rid);
      const changedHere = loc ? (!known || loc.h !== known.h) : false;
      if (rec.data == null) {
        // The key withdrawn from sync on another device: it stops travelling
        // from here too, and stays on this device.
        if (rid === keyRid) { conf.key = false; await this.setConf({ key: false }); local.delete(rid); st.recs[rid] = { seq: rec.seq, h: null }; return; }
        if (loc && !changedHere) { await removeLocal(loc.lid); local.delete(rid); changed.add(loc.lid); }
        st.recs[rid] = { seq: rec.seq, h: null };
        return;
      }
      const obj = JSON.parse(await open(keys, rec.data, rid));
      if (!obj || typeof obj.lid !== "string" || await ridOf(keys, obj.lid) !== rid) throw new SyncError("decrypt", "A synced record does not match its name.");
      if (obj.lid.startsWith("s:") && !(conf.key && this.secret)) { st.recs[rid] = { seq: rec.seq, h: null, skip: true }; return; }
      const body = loc && changedHere ? merge(obj.lid, loc.body, obj.body) : obj.body;
      await writeLocal(obj.lid, body, this.secret);
      changed.add(obj.lid);
      const now = await readLocal(obj.lid, this.secret);
      const text = stable({ lid: obj.lid, body: now });
      const h = await sha(text);
      // Merged: remember the server's version, so the merge is sent back up.
      st.recs[rid] = { seq: rec.seq, h: loc && changedHere ? await sha(stable({ lid: obj.lid, body: obj.body })) : h };
      local.set(rid, { lid: obj.lid, body: now, text, h });
    };

    // Pull
    let cursor = st.seq || 0;
    for (let guard = 0; guard < 500; guard++) {
      const r = await this.t.request("GET", `?since=${cursor}`);
      if (r.epoch && r.epoch !== st.epoch) throw new SyncError("epoch", "The synced copy was started again with a new passphrase on another device. Enter the new passphrase here.");
      for (const rec of r.records || []) await take(rec.rid, rec);
      cursor = r.more && r.records?.length ? r.records[r.records.length - 1].seq : Math.max(cursor, r.seq || 0);
      st.seq = cursor;
      await store.kv.set(STATE, st);
      if (!r.more) break;
    }

    // Push, taking in whatever another device wrote meanwhile
    for (let round = 0; round < 4; round++) {
      const puts = [], dels = [];
      for (const [rid, loc] of local) {
        const k = st.recs[rid];
        if (!k || k.h !== loc.h) puts.push({ rid, base: k?.seq || 0, loc });
      }
      for (const [rid, k] of Object.entries(st.recs)) {
        // A conversation deleted here is deleted everywhere; the key, when
        // it is no longer ticked, is taken off the server.
        if (k.h && !local.has(rid) && (k.lid?.startsWith("t:") || rid === keyRid)) dels.push({ rid, base: k.seq });
      }
      if (!puts.length && !dels.length) break;
      const conflicts = [];
      let batch = { put: [], del: dels.slice(), size: 0 };
      const flush = async () => {
        if (!batch.put.length && !batch.del.length) return;
        const r = await this.t.request("POST", "", { epoch: st.epoch, put: batch.put.map(({ rid, base, data }) => ({ rid, base, data })), del: batch.del });
        const sent = new Map(batch.put.map(p => [p.rid, p]));
        for (const w of r.written || []) {
          const p = sent.get(w.rid);
          st.recs[w.rid] = p ? { seq: w.seq, h: p.loc.h, lid: p.loc.lid } : { seq: w.seq, h: null };
        }
        conflicts.push(...(r.conflicts || []));
        await store.kv.set(STATE, st);
        batch = { put: [], del: [], size: 0 };
      };
      for (const p of puts) {
        const data = await seal(keys, p.loc.text, p.rid);
        if (batch.size + data.length > 6e6) await flush();
        batch.put.push({ rid: p.rid, base: p.base, data, loc: p.loc });
        batch.size += data.length;
      }
      await flush();
      if (!conflicts.length) break;
      for (const c of conflicts) {
        if (st.recs[c.rid]) st.recs[c.rid].seq = Math.min(st.recs[c.rid].seq, c.seq - 1);
        await take(c.rid, c);
        if (c.data == null && local.has(c.rid)) st.recs[c.rid] = { seq: c.seq, h: null };
      }
    }
    // A record's local id is remembered once known, so a deletion here can be sent.
    for (const [rid, loc] of local) if (st.recs[rid]) st.recs[rid].lid = loc.lid;
    await store.kv.set(STATE, st);
    const totals = await this.t.request("GET", "?meta=1").catch(() => ({}));
    return { changed, count: totals.count ?? null, bytes: totals.bytes ?? null };
  }
}
