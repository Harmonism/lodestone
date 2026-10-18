// syncstore.js — the synced copy kept on this computer.
//
// The same records, the same rules, as harmonism.io's lodestone-sync-api.php,
// for sync that never leaves the home network: Lodestone's own window
// reaches it through the main process, a paired phone through the phone
// server (server.js, /munai-sync, with the token it was given at pairing).
// What is kept is what the devices send: ciphertext under the practitioner's
// passphrase, record names that are HMACs. This computer cannot read it either.
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
    try { this.d = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.d = null; }
    if (!this.d || typeof this.d !== "object") this.d = { space: null, rec: {} };
    return this.d;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.d), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  totals() {
    let count = 0, bytes = 0;
    for (const r of Object.values(this.load().rec)) if (r.data != null) { count++; bytes += r.data.length; }
    return { count, bytes };
  }

  /** One request, as the endpoint would answer it: { status, json }. */
  handle(method, query = "", body = null) {
    const d = this.load();
    const q = new URLSearchParams(String(query || "").replace(/^\?/, ""));
    method = String(method || "GET").toUpperCase();

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
      if (d.space && !replace) return fail(409, "exists", "Sync through this computer is already set up; enter its passphrase.");
      const now = Math.floor(Date.now() / 1000);
      this.d = { space: { epoch: crypto.randomBytes(12).toString("base64url"), salt, check, v: Number(v) || 1, seq: 0, created: now, updated: now }, rec: {} };
      this.save();
      const sp = this.d.space;
      return ok({ meta: { epoch: sp.epoch, salt, check, v: sp.v, created: now }, seq: 0 });
    }

    if (method !== "POST") return fail(405, "method", "Method not allowed");
    const sp = d.space;
    if (!sp) return fail(409, "no_space", "Sync through this computer is not set up yet.");
    if ((body || {}).epoch !== sp.epoch) return fail(409, "epoch", "The synced copy on this computer was started again with a new passphrase.");
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

module.exports = { SyncStore };
