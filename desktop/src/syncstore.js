// syncstore.js — the synced copy kept on this computer.
//
// The same records, the same rules, as harmonism.io's lodestone-sync-api.php,
// for sync that never leaves the home network: Lodestone's own window
// reaches it through the main process, a paired phone through the phone
// server (server.js, /munai-sync, with the token it was given at pairing).
// What is kept is what the devices send: ciphertext under a key the devices
// keep (handed device to device since October 19, 2026; a passphrase before),
// record names that are HMACs. This computer cannot read it either. The link
// mailbox (?link) relays one sealed handover, as the endpoint's does.
//
//   GET    ?meta=1          → { meta | null, seq, count, bytes }
//   PUT    {salt, check, v, replace?}
//   GET    ?since=N         → { records, seq, more, epoch }
//   POST   {epoch, put, del} → { written, conflicts, seq }
//   DELETE                  → erases the copy

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_RECORD = 3 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;   // a computer's disk, not a shared server
const MAX_RECORDS = 50000;
const PAGE = 400;
const PAGE_BYTES = 8 * 1024 * 1024;

const isB64 = s => typeof s === "string" && s !== "" && /^[A-Za-z0-9_-]+$/.test(s);
const isRid = s => typeof s === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(s);
const ok = json => ({ status: 200, json });
const fail = (status, code, message) => ({ status, json: { error: { code, message } } });

class SyncStore {
  constructor(file) { this.file = file; this.d = null; }

  load() {
    if (this.d) return this.d;
    let raw = null;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (e) { if (e.code !== "ENOENT") { this.d = null; throw new Error(`The phones' synced copy could not be read (${e.code}); try again in a moment.`); } }
    if (raw != null) {
      try { this.d = JSON.parse(raw); }
      catch {
        // Unreadable: kept aside, not overwritten by the next save (1.12).
        this.d = null;
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      }
    }
    if (!this.d || typeof this.d !== "object") this.d = { space: null, rec: {} };
    return this.d;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.d), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  totals() {
    let count = 0, bytes = 0;
    let d; try { d = this.load(); } catch { return { count, bytes, unreadable: true }; }
    for (const r of Object.values(d.rec)) if (r.data != null) { count++; bytes += r.data.length; }
    return { count, bytes };
  }

  /** One request, as the endpoint would answer it: { status, json }. */
  handle(method, query = "", body = null) {
    const d = this.load();
    const q = new URLSearchParams(String(query || "").replace(/^\?/, ""));
    method = String(method || "GET").toUpperCase();
    if (q.has("link")) return this.link(method, q.get("id") || "", body || {});
    // The lock a password opens belongs to the account's copy on harmonism.io; through a computer there is no password.
    if (q.has("unlock")) return method === "GET" ? ok({ unlock: null }) : fail(404, "no_unlock", "Sync through this computer has no password.");

    if (method === "GET") {
      const sp = d.space;
      if (q.has("meta")) {
        const t = this.totals();
        return ok({ meta: sp ? { epoch: sp.epoch, salt: sp.salt, check: sp.check, v: sp.v, created: sp.created } : null, seq: sp ? sp.seq : 0, ...t });
      }
      if (!sp) return fail(409, "no_space", "Sync through this computer is not set up yet.");
      const since = Math.max(0, parseInt(q.get("since") || "0", 10) || 0);
      const rows = Object.entries(d.rec).filter(([, r]) => r.seq > since).sort((a, b) => a[1].seq - b[1].seq);
      const records = []; let size = 0; let more = rows.length > PAGE;
      for (const [rid, r] of rows.slice(0, PAGE)) {
        size += (r.data || "").length;
        if (records.length && size > PAGE_BYTES) { more = true; break; }
        records.push({ rid, seq: r.seq, data: r.data ?? null });
      }
      return ok({ records, seq: sp.seq, more, epoch: sp.epoch });
    }

    if (method === "DELETE") { this.d = { space: null, rec: {} }; this.save(); return ok({ ok: true }); }

    if (method === "PUT") {
      const { salt, check, v = 1, replace } = body || {};
      if (!isB64(salt) || salt.length > 64 || !isB64(check) || check.length > 512) return fail(400, "bad_request", "A salt and a check value are required.");
      if (d.space && !replace) return fail(409, "exists", "Sync through this computer is already set up: let this device in from one already synced.");
      const now = Math.floor(Date.now() / 1000);
      this.d = { space: { epoch: crypto.randomBytes(12).toString("base64url"), salt, check, v: Number(v) || 1, seq: 0, created: now, updated: now }, rec: {} };
      this.save();
      const sp = this.d.space;
      return ok({ meta: { epoch: sp.epoch, salt, check, v: sp.v, created: now }, seq: 0 });
    }

    if (method !== "POST") return fail(405, "method", "Method not allowed");
    const sp = d.space;
    if (!sp) return fail(409, "no_space", "Sync through this computer is not set up yet.");
    if ((body || {}).epoch !== sp.epoch) return fail(409, "epoch", "The synced copy on this computer was started again. Let this device in again.");
    const puts = Array.isArray(body.put) ? body.put : [], dels = Array.isArray(body.del) ? body.del : [];
    if (puts.length + dels.length > 2000) return fail(413, "too_large", "Too many records at once.");
    // Checked whole before anything is written, as the endpoint's transaction is.
    for (const op of [...puts, ...dels]) if (!isRid(op?.rid)) return fail(400, "bad_request", "A record name is malformed.");
    for (const op of puts) if (!isB64(op.data) || op.data.length > MAX_RECORD) return fail(413, "too_large", "One conversation is too large to sync.");

    let { count, bytes } = this.totals();
    const next = { ...d.rec };
    let seq = sp.seq;
    const written = [], conflicts = [];
    for (const [op, del] of [...puts.map(p => [p, false]), ...dels.map(p => [p, true])]) {
      const have = next[op.rid];
      const haveSeq = have ? have.seq : 0;
      if (haveSeq !== (Number(op.base) || 0)) { conflicts.push({ rid: op.rid, seq: haveSeq, data: have ? (have.data ?? null) : null }); continue; }
      if (del && !have) continue;
      const oldB = have && have.data != null ? have.data.length : 0;
      const newB = del ? 0 : op.data.length;
      bytes += newB - oldB; count += (newB ? 1 : 0) - (oldB ? 1 : 0);
      if (bytes > MAX_TOTAL || count > MAX_RECORDS) return fail(413, "quota", "The synced copy on this computer has reached its limit.");
      seq++;
      next[op.rid] = { seq, data: del ? null : op.data };
      written.push({ rid: op.rid, seq });
    }
    this.d = { space: { ...sp, seq, updated: Math.floor(Date.now() / 1000) }, rec: next };
    this.save();
    return ok({ written, conflicts, seq });
  }
}

// The link mailbox, in memory: a handover lasts minutes and need not survive a restart.
// The same steps as the endpoint's (lodestone-sync-api.php): by a tap, {pub, commit},
// {apub, anonce}, {nonce}, {apub, box}; from an older Lodestone, {pub} and {pub, box}.
SyncStore.prototype.link = function (method, id, body) {
  const now = Math.floor(Date.now() / 1000), TTL = 600;
  this.links = (this.links || []).filter(l => l.created >= now - TTL);
  if (id && !/^[A-Za-z0-9_-]{16,32}$/.test(id)) return fail(400, "bad_request", "A link id is malformed.");
  const short = (v, max) => isB64(v) && v.length <= max;
  const find = () => this.links.find(l => l.id === id);
  if (method === "GET" && !id) return ok({ requests: this.links.map(l => ({ id: l.id, pub: l.pub, commit: l.commit, apub: l.apub, anonce: l.anonce, nonce: l.nonce, created: l.created, answered: !!l.box })) });   // listed until opened or expired: a mistyped code can be typed again
  if (method === "GET") { const l = find(); if (!l) return fail(404, "expired", "This request has expired. Ask again."); return ok(l.box ? { pub: l.apub, box: l.box } : { waiting: true, apub: l.apub, anonce: l.anonce }); }
  if (method === "POST") {
    if (!id) {
      if (!short(body.pub, 200)) return fail(400, "bad_request", "A public key is required.");
      if (body.commit != null && !short(body.commit, 64)) return fail(400, "bad_request", "A commitment is malformed.");
      if (this.links.length >= 5) return fail(429, "too_many", "Too many devices are waiting to be let in. Wait ten minutes and ask again.");
      const l = { id: crypto.randomBytes(16).toString("base64url"), pub: body.pub, commit: body.commit || null, apub: null, anonce: null, nonce: null, box: null, created: now };
      this.links.push(l); return ok({ id: l.id, expires: now + TTL });
    }
    const l = find(); if (!l) return fail(404, "expired", "This request has expired. Ask again on the new device.");
    if (body.nonce != null) {
      if (!short(body.nonce, 64)) return fail(400, "bad_request", "A nonce is malformed.");
      if (!l.anonce) return fail(409, "early", "No device has begun to answer yet.");
      if (l.nonce && l.nonce !== body.nonce) return fail(409, "taken", "This request has already been answered.");
      l.nonce = body.nonce; return ok({ ok: true });
    }
    if (body.anonce != null) {
      if (!l.commit) return fail(409, "old", "That device runs an older Lodestone: type the code it shows.");
      if (!short(body.apub, 200) || !short(body.anonce, 64)) return fail(400, "bad_request", "A public key and a nonce are required.");
      if (l.apub && l.apub !== body.apub) return fail(409, "taken", "Another of your devices is answering that request.");
      l.apub = body.apub; l.anonce = body.anonce; return ok({ ok: true });
    }
    if (!short(body.box, 400)) return fail(400, "bad_request", "A sealed key is required.");
    if (body.apub != null) {
      if (l.apub !== body.apub || !l.nonce) return fail(409, "taken", "That request was not begun from this device.");
      l.box = body.box; return ok({ ok: true });
    }
    if (!short(body.pub, 200)) return fail(400, "bad_request", "A public key is required.");
    l.apub = body.pub; l.box = body.box; return ok({ ok: true });
  }
  if (method === "DELETE") { if (!id) return fail(400, "bad_request", "Which request?"); this.links = this.links.filter(l => l.id !== id); return ok({ ok: true }); }
  return fail(405, "method", "Method not allowed");
};

module.exports = { SyncStore };
