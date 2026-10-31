// sync.js — Lodestone's memory carried between devices through the practitioner's
// harmonism.io account. On by itself once signed in (ensure()); off on a
// device only when the person turns it off there.
//
// What travels: every conversation, the notes Lodestone keeps (profile), the
// Wheel, the practices, the Harmonic Profile, and — only when ticked — the
// OpenRouter key. Settings, the corpus and models stay on each device.
//
// How it is kept unreadable: before anything leaves, each record is encrypted
// here with AES-256-GCM under a key the practitioner's devices keep: since
// October 19, 2026 a random key handed from device to device (linked devices,
// below); before, one drawn from a sync passphrase (PBKDF2-SHA-256, 600,000
// iterations), which such a copy still accepts. Record names are HMACs of the local ids, and each ciphertext is bound
// to its name, so the server can neither read a record nor pass one off as
// another. The key is never sent in the clear; the record keys are kept on the device
// as WebCrypto keys the page itself cannot export. What
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
//
// Which devices sync (October 23, 2026): each device keeps a record of itself
// in the synced copy ("d:<id>"), sealed like the rest: its name, its kind, the
// Lodestone it runs, when it was let in and when it last synced. harmonism.io
// sees one more record and nothing of what it says. A device removed from
// another finds a mark on its own record at its next sync, stops syncing and
// says so; what it holds stays on it.

import * as store from "./store.js";
import * as unlock from "./unlock.js";

const V = 1;
const ITER = 600000;
// "companion" is website Lodestone's memory, held by the practitioner (the model-written
// profile, its Wheel, summaries, the reading canon); "hp_code" the Harmonic
// Profile as the assessment gave it, which website Lodestone reads from.
// learned: what Lodestone learned of the person (learning.js); reading: the Wisdom Canon (canon.js); outreach: when Lodestone last wrote first.
// lifebook: Lodestone Desktop's copy of the life book's notes, read on other devices, and the changes kept there for the desktop to write.
const SYNCED_KV = ["profile", "wheel", "practices", "assessment", "companion", "hp_code", "learned", "reading", "outreach", "lifebook"];
const KEYS = "sync:keys", STATE = "sync:state", CONF = "sync:conf";
// Kept with the memory, as the other "sync:" keys are: one device per memory per browser.
const DEVICES = "sync:devices", ME = "sync:device";
const SEEN_EVERY = 5 * 60 * 1000;   // how often a device's own record is written again only to say it synced
const te = new TextEncoder(), td = new TextDecoder();

export class SyncError extends Error {
  constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; }
}

// ─── this device, named ─────────────────────────────────────────────────────

/** What this device is, as a person would name it: { kind, name }. `desktop`: Lodestone Desktop's window. */
export function deviceGuess(desktop = false) {
  const nav = globalThis.navigator || {};
  const ua = nav.userAgent || "";
  const ipad = /iPad/.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  const os = /iPhone|iPod/.test(ua) ? "iPhone" : ipad ? "iPad" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "Chromebook"
    : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  const on = os ? ` on ${os}` : "";
  if (desktop) return { kind: "desktop", name: `Lodestone Desktop${on || " on a computer"}` };
  if (globalThis.Capacitor?.isNativePlatform?.()) return { kind: "app", name: `Lodestone app${on}` };
  let standalone = nav.standalone === true;
  try { standalone ||= !!globalThis.matchMedia?.("(display-mode: standalone)").matches; } catch {}
  if (standalone && (os === "iPhone" || os === "iPad")) return { kind: "home", name: `Home Screen app${on}` };
  const browser = nav.brave ? "Brave" : /Edg[A-Z]?\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  return { kind: standalone ? "installed" : "browser", name: `${browser}${on}` };
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
  catch { throw new SyncError("decrypt", "A synced record could not be decrypted with this device's key."); }
  return td.decode(await unsqueeze(pt[0], pt.subarray(1)));
}

const CHECK = "munai-sync-check";

// ─── linked devices (v2, October 19, 2026) ──────────────────────────────────
// No passphrase. Turning sync on makes a random 256-bit key on this device;
// another device receives it from one already synced, through a short-lived
// mailbox on the server (?link), sealed so the server cannot open it: an ECDH
// exchange between the two devices, mixed with a one-time code the practitioner
// reads on the new device and types on the old one (PBKDF2, 600,000 rounds, so a
// server that swapped in its own key still could not guess the code). The key
// is kept on each device wrapped under a device key the page cannot export, and
// never leaves except into such a seal, or as the recovery code if they ask for it.
// A copy made with a passphrase (v1) still opens with it.
//
// Since October 20, 2026 the password opens it too: the key is also left with the
// synced copy locked under a key stretched from the account's password
// (unlock.js), so signing in with the password on a new device lets it in with
// nothing more to do. A device that cannot (the password changed since, or it
// was signed in without typing it) is let in by a tap on a synced device, once
// the two show the same six-digit number.
const LINK_V = 2;
// Kept with the memory it syncs (store.js keeps "sync:" keys per memory). Until
// October 20, 2026 they were kept once per browser ("secret:" keys are the
// device's), so a second memory on the same browser — the device's own, or
// another account's — could overwrite or erase the key of the one that synced,
// which was then left on but unable to let any device in. Such a key is taken
// over by the memory whose synced copy it opens (Sync#root).
const ROOT = "sync:root", WRAP = "sync:wrap";
const OLD_ROOT = "secret:sync-root", OLD_WRAP = "secret:sync-wrap";
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";   // Crockford: no I, L, O, U
const LINK_TTL = 10 * 60 * 1000;

export const normCode = s => String(s || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
export function toB32(bytes) {
  let bits = 0, val = 0, out = "";
  for (const b of bytes) { val = ((val << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function fromB32(str, n) {
  const s = normCode(str); let bits = 0, val = 0; const out = [];
  for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new SyncError("code", "That code has a character that is not in it."); val = ((val << 5) | i) & 0xffff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  if (out.length < n) throw new SyncError("code", "That code is too short.");
  return new Uint8Array(out.slice(0, n));
}
const group = (s, k) => s.match(new RegExp(`.{1,${k}}`, "g")).join("-");

export async function keysFromSecret(secret) {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: te.encode("lodestone-sync-v2"), info: te.encode("record-keys") }, base, 512));
  const aes = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const mac = await crypto.subtle.importKey("raw", bits.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  bits.fill(0);
  return { aes, mac };
}

async function wrapKey() {
  let k = await store.kv.get(WRAP);
  if (!k) { k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); await store.kv.set(WRAP, k); }
  return k;
}
async function saveRoot(secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrapKey(), secret));
  await store.kv.set(ROOT, { iv: b64u(iv), ct: b64u(ct) });
}
async function unwrapRoot(r, k) {
  if (!r || !k) return null;
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(r.iv) }, k, unb64u(r.ct))); } catch { return null; }
}
async function loadRoot() { return unwrapRoot(await store.kv.get(ROOT), await store.kv.get(WRAP)); }
/** The key as kept before October 20, 2026: once per browser. Whose it is, Sync#root checks. */
async function legacyRoot() { return unwrapRoot(await store.kv.get(OLD_ROOT), await store.kv.get(OLD_WRAP)); }

export async function linkSealKey(myPrivate, theirPublicB64, code, id) {
  const theirs = await crypto.subtle.importKey("raw", unb64u(theirPublicB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, myPrivate, 256));
  const pw = await crypto.subtle.importKey("raw", te.encode(normCode(code)), "PBKDF2", false, ["deriveBits"]);
  const stretched = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: te.encode("lodestone-link:" + id), iterations: ITER }, pw, 256));
  const ikm = new Uint8Array(64); ikm.set(shared, 0); ikm.set(stretched, 32);
  const hk = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  ikm.fill(0); shared.fill(0); stretched.fill(0);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: te.encode(id), info: te.encode("lodestone-link-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const ecdhPair = () => crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
const exportPub = async k => b64u(await crypto.subtle.exportKey("raw", k));
const ridOf = async (keys, lid) => b64u(await crypto.subtle.sign("HMAC", keys.mac, te.encode("rec:" + lid))).slice(0, 43);

// ─── the tap (linking without a code, October 20, 2026) ─────────────────────
// The new device commits to a random nonce before it sees the synced device's;
// the synced device then sends its key and nonce; the new device reveals its own.
// Both show a number drawn from the two keys and the two nonces. A server that
// put its own keys in between could match the numbers once in a million tries,
// because each side's nonce was fixed before it saw the other's. The person
// checks that the numbers match and taps; the sync key goes sealed to the
// exchange the number vouches for.
const cat = (...parts) => { const bs = parts.map(p => (typeof p === "string" ? unb64u(p) : p)); const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0)); let i = 0; for (const b of bs) { out.set(b, i); i += b.length; } return out; };
const digest = async (label, ...parts) => new Uint8Array(await crypto.subtle.digest("SHA-256", cat(te.encode(label), ...parts)));
export const commitOf = async (pub, nonce) => b64u(await digest("lodestone-link-commit", pub, nonce));
export async function linkNumber(pubNew, pubOld, nonceNew, nonceOld) {
  const h = await digest("lodestone-link-number", pubNew, pubOld, nonceNew, nonceOld);
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const d = String(n % 1000000).padStart(6, "0");
  return { number: d.slice(0, 3) + " " + d.slice(3), transcript: h };
}
async function linkKeyV2(myPrivate, theirPublicB64, id, transcript) {
  const theirs = await crypto.subtle.importKey("raw", unb64u(theirPublicB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, myPrivate, 256));
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  shared.fill(0);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: te.encode("lodestone-link:" + id), info: cat(te.encode("lodestone-link-v2"), transcript) }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const unlockAad = epoch => te.encode("lodestone-unlock:" + epoch);
// Records that keep one version: on a device's first sync after it joins, the
// synced one is taken over this device's, so a thinner copy kept here (an old
// test, another session) never replaces what the person built elsewhere.
const FIRST_THEIRS = new Set(["k:profile", "k:assessment", "k:hp_code"]);

// ─── local records ───────────────────────────────────────────────────────────

const uidOf = m => m.uid || `${m.ts}-${m.role}`;
const cleanMsg = m => { const { id, threadId, ...rest } = m; return { ...rest, uid: uidOf(m) }; };

export async function readLocal(lid, secret) {
  const [kind, name] = [lid.slice(0, 1), lid.slice(2)];
  if (kind === "t") {
    const thread = await store.threads.get(name);
    if (!thread) return null;
    const messages = (await store.messages.forThreadAll(name)).map(cleanMsg);
    return { thread, messages };
  }
  if (kind === "k") { const v = await store.kv.get(name); return v == null ? null : v; }
  if (kind === "s") { const v = secret ? await secret.get(name) : null; return v || null; }
  if (kind === "d") { const v = ((await store.kv.get(DEVICES)) || {})[name]; return v || null; }
  return null;
}

// `before`: the record as it was read at the start of this cycle. Sync holds no
// lock over its network calls (1.13.1): a message sent, or a note kept, while
// they ran is merged in rather than written over, and only messages this cycle
// saw are ever deleted.
export async function writeLocal(lid, body, secret, before = null) {
  const [kind, name] = [lid.slice(0, 1), lid.slice(2)];
  const now = await readLocal(lid, secret);
  const moved = now != null && stable(now) !== stable(before);
  if (moved && kind === "t" && before) {
    // A conversation written in meanwhile: its new messages, and those changed
    // here since (an answer still arriving), keep this device's version; the
    // rest is as merged, deletions from the other device included.
    const was = new Map((before.messages || []).map(m => [m.uid, stable(m)]));
    const mineNow = new Map(now.messages.map(m => [m.uid, m]));
    const touched = m => !was.has(m.uid) || was.get(m.uid) !== stable(m);
    const messages = body.messages.map(m => !m.deleted && mineNow.has(m.uid) && touched(mineNow.get(m.uid)) ? mineNow.get(m.uid) : m);
    const inBody = new Set(body.messages.map(m => m.uid));
    for (const m of now.messages) if (!inBody.has(m.uid) && !was.has(m.uid)) messages.push(m);
    messages.sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.uid).localeCompare(String(b.uid)));
    body = { thread: merge(lid, now, body).thread, messages };
  } else if (moved) body = merge(lid, now, body);
  if (kind === "t") {
    await store.threads.put({ ...body.thread, id: name });
    const local = await store.messages.forThreadAll(name);
    const have = new Map(local.map(m => [uidOf(m), m]));
    const want = new Set();
    const seen = new Set((before?.messages || []).map(m => m.uid));
    for (const m of body.messages || []) {
      want.add(m.uid);
      const l = have.get(m.uid);
      if (!l) await store.messages.add({ ...m, threadId: name });
      else if (stable(cleanMsg(l)) !== stable(m)) await store.messages.put({ ...m, id: l.id, threadId: name });
    }
    for (const [u, l] of have) if (!want.has(u) && seen.has(u)) await store.messages.del(l.id);
    return moved;
  }
  if (kind === "k") await store.kv.set(name, body);
  if (kind === "s") await secret?.set(name, body);
  if (kind === "d" && body && typeof body === "object") { const all = (await store.kv.get(DEVICES)) || {}; all[name] = body; await store.kv.set(DEVICES, all); }
  return moved;
}

async function removeLocal(lid, before = null) {
  // Only a conversation is deleted by sync; notes, practices and keys never are.
  // One written in since this cycle read it stays, and goes back up next time.
  if (!lid.startsWith("t:")) return false;
  if (stable(await readLocal(lid, null)) !== stable(before)) return false;
  await store.threads.remove(lid.slice(2));
  return true;
}

/** The Wisdom Canon's state (canon.js) from two devices, merged (arcs and check-ins by id, newest state wins; notes united; progress at its furthest). */
export function mergeReading(a, b) {
  if (!a) return b; if (!b) return a;
  const byId = (x, y, newer) => { const m = new Map(); for (const i of [...(x || []), ...(y || [])]) { const o = m.get(i.id); m.set(i.id, !o ? i : newer(o, i)); } return [...m.values()]; };
  const order = { pending: 0, queued: 1, skipped: 1, cancelled: 2 };
  const progressOut = JSON.parse(JSON.stringify(a.progress || {}));
  for (const [arc, units] of Object.entries(b.progress || {})) for (const [u, v] of Object.entries(units)) {
    const o = ((progressOut[arc] ||= {})[u] ||= { opened_at: 0, opened_count: 0, completed_at: 0 });
    o.opened_at = Math.max(o.opened_at, v.opened_at || 0); o.opened_count = Math.max(o.opened_count, v.opened_count || 0); o.completed_at = Math.max(o.completed_at, v.completed_at || 0);
  }
  return {
    arcs: byId(a.arcs, b.arcs, (o, i) => ((i.updated_at || 0) > (o.updated_at || 0) ? i : o)),
    checkins: byId(a.checkins, b.checkins, (o, i) => ((order[i.state] ?? 0) > (order[o.state] ?? 0) ? i : o)),
    notes: byId(a.notes, b.notes, o => o),
    progress: progressOut,
    seq: Math.max(a.seq || 0, b.seq || 0),
  };
}

/**
 * The life book's synced record: the notes as Lodestone Desktop last read them
 * (only the desktop writes them: the later copy holds), the changes kept on
 * another device and waiting for the desktop to write (united by id), and the
 * ids the desktop has written or answered (united), which no device queues again.
 */
export function mergeLifeBook(a, b) {
  const newer = (a.notesAt || 0) >= (b.notesAt || 0) ? a : b;
  const applied = [...new Set([...(a.applied || []), ...(b.applied || [])])].slice(-300);
  const done = new Set(applied);
  const queue = [...(a.queue || []), ...(b.queue || [])].filter((q, i, all) => q?.id && !done.has(q.id) && all.findIndex(x => x.id === q.id) === i);
  return { notesAt: newer.notesAt || 0, notes: newer.notes || [], queue, applied };
}

/**
 * Two memories in the server's shape ({ v, tables }) made one: a table this
 * device has no rows for takes the other's; a table both hold keeps this
 * device's rows and adds the other's that it lacks (same id, or same content);
 * the main clients row fills only its empty columns.
 */
// A memory carried in on purpose (from Lodestone on Telegram: the clients row's
// carried_at, set by migrate-telegram-to-held.php) is newer knowledge than what a
// device held: its profile and its Wheel stand over the older ones, and its notes
// all stay, beside the device's own (October 24, 2026).
const CARRIED_COLUMNS = ["profile_summary", "situation_capsule", "wheel_position", "display_name", "carried_at"];
export function mergeState(mine, theirs) {
  if (!theirs?.tables) return mine || null;
  if (!mine?.tables) return theirs;
  const out = { ...mine, v: Math.max(mine.v || 0, theirs.v || 0), at: Math.max(mine.at || 0, theirs.at || 0), tables: { ...mine.tables } };
  const carried = Number(theirs.tables.clients?.[0]?.carried_at || 0) > Number(mine.tables.clients?.[0]?.carried_at || 0);
  for (const [t, rows] of Object.entries(theirs.tables)) {
    const have = out.tables[t] || [];
    if (!Array.isArray(rows) || !rows.length) continue;
    if (!have.length) { out.tables[t] = rows; continue; }
    if (t === "clients") {
      const a = { ...have[0] }, b = rows[0] || {};
      for (const [k, v] of Object.entries(b)) if ((a[k] == null || a[k] === "" || a[k] === 0) && v != null && v !== "") a[k] = v;
      if (carried) for (const k of CARRIED_COLUMNS) if (b[k] != null && b[k] !== "") a[k] = b[k];
      out.tables[t] = [a, ...have.slice(1)];
      continue;
    }
    if (t === "wheel_profile" && carried) {
      const byPillar = new Map(have.map(r => [r.pillar, r]));
      for (const r of rows) byPillar.set(r.pillar, r);
      out.tables[t] = [...byPillar.values()];
      continue;
    }
    const sig = r => { const { id, client_id, ...rest } = r || {}; return JSON.stringify(rest); };
    const ids = new Set(have.map(r => r?.id).filter(x => x != null));
    const sigs = new Set(have.map(sig));
    const wheel = t === "wheel_profile" ? new Set(have.map(r => r.pillar)) : null;
    const add = rows.filter(r => wheel ? !wheel.has(r.pillar) : !sigs.has(sig(r)));
    // profile_notes is one row per category: the newer one stands.
    // Notes carried in (confidence "migrated") are many to a category: all kept, each once.
    if (t === "profile_notes") {
      const isCarried = r => r?.confidence === "migrated" || r?.confidence === "telegram";
      const byCat = new Map(have.filter(r => !isCarried(r)).map(r => [r.category, r]));
      for (const r of rows.filter(r => !isCarried(r))) { const h = byCat.get(r.category); if (!h || Number(r.updated_at || 0) > Number(h.updated_at || 0)) byCat.set(r.category, r); }
      const kept = new Map();
      for (const r of [...(carried ? [] : have.filter(isCarried)), ...rows.filter(isCarried), ...(carried ? have.filter(isCarried) : [])]) { const k = `${r.category}\u0000${r.observation}`; if (!kept.has(k)) kept.set(k, r); }
      out.tables[t] = [...byCat.values(), ...kept.values()];
      continue;
    }
    out.tables[t] = [...have, ...add.map(r => (r?.id != null && ids.has(r.id)) ? { ...r, id: undefined } : r)];
  }
  return out;
}

/** One device's record from two devices: a removal holds; the later name holds; the latest sync is kept. */
export function mergeDevice(a, b) {
  const named = (a.namedAt || 0) >= (b.namedAt || 0) ? a : b;
  const gone = a.removed ? a : b.removed ? b : null;
  const out = { ...b, ...a, name: named.name, namedAt: named.namedAt || 0, seen: Math.max(a.seen || 0, b.seen || 0),
    since: Math.min(a.since || Infinity, b.since || Infinity) };
  if (!Number.isFinite(out.since)) delete out.since;
  if (gone) { out.removed = gone.removed; out.removedBy = gone.removedBy || null; } else { delete out.removed; delete out.removedBy; }
  return out;
}

export function merge(lid, mine, theirs) {
  if (lid.startsWith("t:")) {
    const by = new Map();
    for (const m of theirs.messages || []) by.set(m.uid, m);
    for (const m of mine.messages || []) {
      const t = by.get(m.uid);
      // v98: a deletion on either device holds (the mark carries no text); a pin
      // or an unpin carries its own time (pinSet), and the later one holds.
      if (t && (t.deleted || m.deleted)) { by.set(m.uid, t.deleted ? t : m); continue; }
      const keep = !t || String(m.content || "").length >= String(t.content || "").length ? m : t;
      const other = keep === m ? t : m;
      if (other && (other.pinSet || 0) > (keep.pinSet || 0)) by.set(m.uid, { ...keep, pinned: other.pinned || 0, pinSet: other.pinSet });
      else by.set(m.uid, keep);
    }
    const messages = [...by.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.uid).localeCompare(String(b.uid)));
    const newer = (mine.thread.updated || 0) >= (theirs.thread.updated || 0) ? mine.thread : theirs.thread;
    // A rename and a pin carry their own time (titled, pinSet): the later one holds, whichever device is busier.
    const named = (mine.thread.titled || 0) || (theirs.thread.titled || 0)
      ? ((mine.thread.titled || 0) >= (theirs.thread.titled || 0) ? mine.thread : theirs.thread) : newer;
    const pinned = (mine.thread.pinSet || 0) >= (theirs.thread.pinSet || 0) ? mine.thread : theirs.thread;
    // The summary and how far it reaches travel together, from the later summary.
    const summed = (mine.thread.summaryAt || 0) >= (theirs.thread.summaryAt || 0) ? mine.thread : theirs.thread;
    const summary = {}; if (mine.thread.summaryAt || theirs.thread.summaryAt) for (const k of ["summary", "summaryThrough", "summaryThroughTs", "summaryAt"]) summary[k] = summed[k];
    return { thread: { ...theirs.thread, ...mine.thread, ...summary, title: named.title, titled: named.titled || 0, pinned: pinned.pinned || 0, pinSet: pinned.pinSet || 0, updated: Math.max(mine.thread.updated || 0, theirs.thread.updated || 0) }, messages };
  }
  if (lid.startsWith("d:") && mine && theirs) return mergeDevice(mine, theirs);
  if (lid === "k:reading" && mine && theirs) return mergeReading(mine, theirs);
  // Website Lodestone's memory (held.js): two devices' learning joins, nothing is dropped.
  if (lid === "k:companion" && mine && theirs) {
    const newer = (mine.at || 0) >= (theirs.at || 0) ? mine : theirs;
    return { ...newer, state: mergeState(newer.state, newer === mine ? theirs.state : mine.state), at: Math.max(mine.at || 0, theirs.at || 0) };
  }
  // The Wheel: each pillar this device has a level for keeps it; the other's fill the rest.
  if (lid === "k:wheel" && mine && theirs && typeof mine === "object" && typeof theirs === "object") {
    const out = { ...theirs };
    for (const [k, v] of Object.entries(mine)) if (Number(v) > 0 || out[k] == null) out[k] = v;
    return out;
  }
  if (lid === "k:learned" && mine && theirs) {
    const newer = (mine.updatedAt || 0) >= (theirs.updatedAt || 0) ? mine : theirs, older = newer === mine ? theirs : mine;
    // The later learning wins; the levels only rise, so each device's floor is kept; proposals and the Wheel's history are united.
    const ids = new Set((newer.history || []).map(h => h.id));
    return { ...newer, fluency: Math.max(mine.fluency || 0, theirs.fluency || 0), bodily: Math.max(mine.bodily || 0, theirs.bodily || 0),
      history: [...(newer.history || []), ...(older.history || []).filter(h => !ids.has(h.id))].sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-500),
      costLog: [...(newer.costLog || []), ...(older.costLog || []).filter(c => !(newer.costLog || []).some(x => x.ts === c.ts))].slice(-500) };
  }
  if (lid === "k:lifebook" && mine && theirs) return mergeLifeBook(mine, theirs);
  if (lid === "k:outreach" && mine && theirs) {
    const log = [...(mine.sentLog || []), ...(theirs.sentLog || [])].filter((x, i, a) => a.findIndex(y => y.ts === x.ts) === i).sort((a, b) => a.ts - b.ts).slice(-50);
    // The weekly reviews (1.13) are united too, so a device that has not seen this week's does not write it again.
    const reviews = [...(mine.reviews || []), ...(theirs.reviews || [])].filter((x, i, a) => a.findIndex(y => y.ts === x.ts && y.via === x.via) === i).sort((a, b) => a.ts - b.ts).slice(-30);
    return { ...theirs, ...mine, sentLog: log, ...(reviews.length ? { reviews } : {}) };
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
  constructor({ transport, secret = null, onChange = () => {}, canRun = () => true, device = () => deviceGuess() }) {
    this.t = transport; this.secret = secret; this.onChange = onChange; this.canRun = canRun; this.device = device;
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

  /** A synced copy made with linked devices (no passphrase). */
  static linked(meta) { return !!meta && Number(meta.v) >= LINK_V; }

  /** First device, linked: a random key, made and kept here. Nothing to type. `replace` starts the copy again. */
  async createLinked({ replace = false, key = false } = {}) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const keys = await keysFromSecret(secret);
    const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));   // the endpoint keeps a salt; v2 does not use it
    const check = await seal(keys, CHECK, "check");
    const r = await this.t.request("PUT", "", { salt, check, v: LINK_V, replace });
    await saveRoot(secret);
    secret.fill(0);
    await this.adopt(keys, r.meta, key);
    await this.keepLock().catch(() => {});   // the new copy opens with the password at once
    return this.now();
  }

  /**
   * The key of the synced copy, as this memory keeps it, or null. A key kept
   * the earlier way (once per browser) is taken over only when it opens this
   * account's synced copy; looked for once per copy, not at every call.
   */
  async root() {
    const s = await loadRoot();
    if (s) return s;
    const conf = await this.conf();
    if (!conf.on) return null;
    const epoch = (await store.kv.get(STATE))?.epoch || null;
    if (this.noLegacy && this.noLegacy === epoch) return null;
    const old = await legacyRoot();
    if (old) {
      try {
        const r = await this.remote();
        if (r.meta && Sync.linked(r.meta) && r.meta.epoch === epoch && await open(await keysFromSecret(old), r.meta.check, "check") === CHECK) { await saveRoot(old); return old; }
      } catch {}
      old.fill(0);
    }
    this.noLegacy = epoch;
    return null;
  }

  /** Whether this device holds the key and can let another device in (one that joined with a passphrase, or lost its key, cannot). */
  async canLink() { const s = await this.root(); if (s) s.fill(0); return !!s; }

  /**
   * A device that syncs but holds no key becomes the one that does: it syncs
   * first, so it holds everything the copy held, then starts the copy again
   * from its memory under a new key. Nothing is removed from any device; the
   * others leave the old copy and join this one, adding what they hold.
   */
  async takeOver() {
    const first = await this.now();
    if (!first.ok) throw new SyncError(first.code || "network", `This device could not sync first, so it does not start the copy again: ${first.message || "try again in a moment."}`);
    return this.createLinked({ replace: true, key: !!(await this.conf()).key });
  }

  /** The recovery code: the key itself, for when no synced device is left. Shown only when asked. */
  async recoveryCode() { const s = await this.root(); if (!s) return null; const c = group(toB32(s), 4); s.fill(0); return c; }

  /** A new device joins with the recovery code. */
  async joinWithRecovery(code, { key = false } = {}) {
    const r = await this.remote();
    if (!r.meta) throw new SyncError("no_space", "There is no synced copy on this account yet.");
    if (!Sync.linked(r.meta)) throw new SyncError("passphrase", "This synced copy was made with a passphrase: enter the passphrase instead.");
    const secret = fromB32(code, 32);
    const keys = await keysFromSecret(secret);
    try { if (await open(keys, r.meta.check, "check") !== CHECK) throw 0; } catch { secret.fill(0); throw new SyncError("code", "That recovery code does not open the synced copy."); }
    await saveRoot(secret); secret.fill(0);
    await this.adopt(keys, r.meta, key);
    await this.keepLock().catch(() => {});
    return this.now();
  }

  /**
   * A new device asks to be let in. Returns { id, code, expires, wait }: `code`
   * is shown here, to be typed on a synced device; wait({ signal }) resolves
   * once that device has answered with the right code, and this one then syncs.
   */
  async requestLink({ key = false } = {}) {
    const r0 = await this.remote();
    if (!r0.meta) throw new SyncError("no_space", "There is no synced copy on this account yet: turn sync on here to start one.");
    if (!Sync.linked(r0.meta)) throw new SyncError("passphrase", "This synced copy was made with a passphrase: enter it once, or start the copy again from a device that has it.");
    const pair = await ecdhPair();
    const code = toB32(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10);   // 50 bits: typed only on an older Lodestone
    const pub = await exportPub(pair.publicKey);
    const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const { id, expires } = await this.t.request("POST", "?link=1", { pub, commit: await commitOf(pub, nonce) });
    // onNumber(number): the number to show, once a synced device has begun to answer.
    const wait = async ({ signal, onNumber = () => {} } = {}) => {
      let seen = "", tap = null;
      const end = Math.min(Date.now() + LINK_TTL, expires ? expires * 1000 : Infinity);
      while (Date.now() < end) {
        if (signal?.aborted) { this.t.request("DELETE", `?link=1&id=${id}`).catch(() => {}); throw new SyncError("cancelled", "Cancelled."); }
        let a = null;
        try { a = await this.t.request("GET", `?link=1&id=${id}`); }
        catch (e) { if (e.code === "expired") throw new SyncError("expired", "Your other device said no, or the request expired. Ask again."); }
        // A synced device began to answer by a tap: reveal this side's nonce, show the number.
        if (a?.apub && a?.anonce && (!tap || tap.apub !== a.apub)) {
          await this.t.request("POST", `?link=1&id=${id}`, { nonce }).catch(() => {});
          const { number, transcript } = await linkNumber(pub, a.apub, nonce, a.anonce);
          tap = { apub: a.apub, transcript };
          try { onNumber(number); } catch {}
        }
        if (a?.box && a.box !== seen) {
          seen = a.box;
          try {
            const k = tap && a.pub === tap.apub ? await linkKeyV2(pair.privateKey, a.pub, id, tap.transcript) : await linkSealKey(pair.privateKey, a.pub, code, id);
            const raw = unb64u(a.box);
            const secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: te.encode("link:" + id) }, k, raw.subarray(12)));
            const keys = await keysFromSecret(secret);
            const r = await this.remote();
            if (await open(keys, r.meta.check, "check") !== CHECK) throw 0;
            await saveRoot(secret); secret.fill(0);
            await this.adopt(keys, r.meta, key);
            this.t.request("DELETE", `?link=1&id=${id}`).catch(() => {});
            // Let in after a password change: the lock left with the copy takes the new password now.
            await this.keepLock().catch(() => {});
            return this.now();
          } catch { /* the code was typed wrong on the other device: it can answer again */ }
        }
        await new Promise(res => setTimeout(res, 2500));
      }
      throw new SyncError("expired", "Ten minutes passed without an answer. Ask again.");
    };
    return { id, code: group(code, 5), expires: expires ? expires * 1000 : Date.now() + LINK_TTL, wait };
  }

  // ─── the password (unlock.js) ─────────────────────────────────────────────

  /** The key stretched from this account's password at its last sign-in here: { key, at } or null. */
  async passwordKey() { const email = await this.accountEmail(); return email ? unlock.take(email) : null; }

  /** Leaves the sync key with the synced copy, locked under the password's key. */
  async lockWithPassword(pk) {
    const st = await store.kv.get(STATE);
    if (!st?.epoch || !pk?.key) return false;
    const secret = await this.root();
    if (!secret) return false;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: unlockAad(st.epoch) }, pk.key, secret));
    secret.fill(0);
    await this.t.request("PUT", "?unlock=1", { epoch: st.epoch, box: b64u(cat(iv, ct)) });
    await this.setConf({ lockAt: pk.at, lockEpoch: st.epoch });
    return true;
  }

  /**
   * On a synced device that holds the key: the lock is placed again whenever the
   * password's key here is newer than the one it was last locked under (the
   * password changed, or was typed here for the first time), or the copy was
   * started again. Through a computer there is no account and no password.
   */
  async keepLock() {
    const conf = await this.conf();
    if (!conf.on || conf.via === "computer") return false;
    const pk = await this.passwordKey();
    if (!pk) return false;
    const st = await store.kv.get(STATE);
    if (conf.lockAt === pk.at && conf.lockEpoch === st?.epoch) return false;
    return this.lockWithPassword(pk);
  }

  /** Whether the synced copy carries a lock this device's password key opens; for the page to say what to do. */
  async passwordState() {
    const pk = await this.passwordKey();
    let u = null; try { u = (await this.t.request("GET", "?unlock=1"))?.unlock || null; } catch {}
    return { here: !!pk, locked: !!u?.box };
  }

  /** A new device, signed in with the password: opens the lock left with the copy and joins. Null when it cannot. */
  async unlockWithPassword({ key = false } = {}) {
    const pk = await this.passwordKey();
    if (!pk) return null;
    const r = await this.remote();
    if (!r.meta || !Sync.linked(r.meta)) return null;
    let u = null;
    try { u = (await this.t.request("GET", "?unlock=1"))?.unlock || null; } catch { return null; }
    if (!u?.box || u.epoch !== r.meta.epoch) return null;
    let secret;
    try {
      const raw = unb64u(u.box);
      secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: unlockAad(r.meta.epoch) }, pk.key, raw.subarray(12)));
    } catch { return null; }   // locked under another password: changed since
    const keys = await keysFromSecret(secret);
    try { if (await open(keys, r.meta.check, "check") !== CHECK) throw 0; } catch { secret.fill(0); return null; }
    await saveRoot(secret); secret.fill(0);
    await this.adopt(keys, r.meta, key);
    await this.setConf({ lockAt: pk.at, lockEpoch: r.meta.epoch });
    return this.now();
  }

  /** How many things this device would sync (conversations, and each kind of note it holds): to weigh against the copy's count. */
  async localCount() {
    let n = (await store.threads.list()).length;
    for (const k of SYNCED_KV) if ((await store.kv.get(k)) != null) n++;
    return n;
  }

  /**
   * On a synced device: begin letting a waiting device in by a tap. Returns
   * { number, letIn(), refuse() } once both devices can show the number; letIn()
   * sends the key. A request from an older Lodestone (no commitment) is answered
   * with its code instead (approveLink).
   */
  async answerLink(q, { signal } = {}) {
    if (!q?.commit) throw new SyncError("old", "That device runs an older Lodestone: type the code it shows.");
    const secret0 = await this.root();
    if (!secret0) throw new SyncError("no_root", "This device syncs, but does not hold the key that lets another device in.");
    secret0.fill(0);
    const pair = await ecdhPair();
    const apub = await exportPub(pair.publicKey);
    const anonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const commit = q.commit;   // fixed before this device's nonce is sent
    await this.t.request("POST", `?link=1&id=${q.id}`, { apub, anonce });
    let nonce = null;
    for (const end = Date.now() + 120000; Date.now() < end && !nonce; ) {
      if (signal?.aborted) throw new SyncError("cancelled", "Cancelled.");
      await new Promise(res => setTimeout(res, 1500));
      const mine = (await this.pendingLinks()).find(x => x.id === q.id);
      if (!mine) throw new SyncError("expired", "That request is no longer waiting. Ask again on the new device.");
      if (mine.apub && mine.apub !== apub) throw new SyncError("taken", "Another of your devices is answering that request.");
      nonce = mine.nonce || null;
    }
    if (!nonce) throw new SyncError("expired", "The new device did not answer. Is it still waiting? Ask again there.");
    if (await commitOf(q.pub, nonce) !== commit) throw new SyncError("mismatch", "The new device's answer did not match what it promised. Nothing was sent; ask again.");
    const { number, transcript } = await linkNumber(q.pub, apub, nonce, anonce);
    return {
      number,
      letIn: async () => {
        const secret = await this.root();
        if (!secret) throw new SyncError("no_root", "This device no longer holds the key.");
        const k = await linkKeyV2(pair.privateKey, q.pub, q.id, transcript);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode("link:" + q.id) }, k, secret));
        secret.fill(0);
        await this.t.request("POST", `?link=1&id=${q.id}`, { apub, box: b64u(cat(iv, ct)) });
        return true;
      },
      refuse: () => this.declineLink(q.id),
    };
  }

  /** Requests from devices waiting to be let in: [{ id, pub, commit?, created, apub?, anonce?, nonce?, answered }]. */
  async pendingLinks() { const r = await this.t.request("GET", "?link=1").catch(() => null); return Array.isArray(r?.requests) ? r.requests : []; }

  /** Let a waiting device in, with the code it shows: the key goes to it sealed to that device and that code. */
  async approveLink(id, code) {
    if (normCode(code).length < 10) throw new SyncError("code", "Type the ten characters the new device shows.");
    const req = (await this.pendingLinks()).find(r => r.id === id);
    if (!req) throw new SyncError("expired", "That request is no longer waiting. Ask again on the new device.");
    const secret = await this.root();
    if (!secret) throw new SyncError("no_root", "This device syncs, but does not hold the key that lets another device in.");
    const pair = await ecdhPair();
    const k = await linkSealKey(pair.privateKey, req.pub, code, id);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode("link:" + id) }, k, secret));
    secret.fill(0);
    const box = new Uint8Array(12 + ct.length); box.set(iv, 0); box.set(ct, 12);
    await this.t.request("POST", `?link=1&id=${id}`, { pub: await exportPub(pair.publicKey), box: b64u(box) });
    return true;
  }

  async declineLink(id) { await this.t.request("DELETE", `?link=1&id=${id}`).catch(() => {}); }

  async adopt(keys, meta, key) {
    this.keys = keys; this.noLegacy = null;
    await store.kv.set(KEYS, keys);
    await store.kv.set(STATE, { epoch: meta.epoch, seq: 0, recs: {}, fresh: true });
    // Each copy joined, a device is new to it: the records of the devices of an earlier copy are not carried in.
    // The name the person gave this device stays with it.
    const prev = ((await store.kv.get(DEVICES)) || {})[(await store.kv.get(ME))?.id] || (await store.kv.get(ME));
    await store.kv.del(DEVICES);
    await store.kv.set(ME, { id: b64u(crypto.getRandomValues(new Uint8Array(12))), ...(prev?.namedAt ? { name: prev.name, namedAt: prev.namedAt } : {}) });
    await this.setConf({ on: true, auto: true, key: !!key, since: Date.now(), last: null, error: null, account: await this.accountEmail() });
  }

  // ─── the devices ──────────────────────────────────────────────────────────

  async me() {
    let me = await store.kv.get(ME);
    if (!me?.id) { me = { id: b64u(crypto.getRandomValues(new Uint8Array(12))) }; await store.kv.set(ME, me); }
    return me;
  }

  /** This device's own record, written again when what it says changed, or every few minutes to say it synced. */
  async touchDevice() {
    const me = await this.me();
    const all = (await store.kv.get(DEVICES)) || {};
    const was = all[me.id];
    if (was?.removed) return;
    let g = {}; try { g = (await this.device()) || {}; } catch {}
    const now = Date.now();
    const named = was?.namedAt ? was : me.namedAt ? me : null;
    const next = { id: me.id, kind: g.kind || was?.kind || "browser", name: named ? named.name : (g.name || was?.name || "A device"),
      namedAt: named?.namedAt || 0, version: g.version ?? was?.version ?? null, since: was?.since || (await this.conf()).since || now, seen: now };
    if (was && was.kind === next.kind && was.name === next.name && was.version === next.version && now - (was.seen || 0) < SEEN_EVERY) return;
    all[me.id] = next;
    await store.kv.set(DEVICES, all);
  }

  /** The devices that sync this memory, this one first: [{ id, name, kind, version, since, seen, here }]. */
  async devices() {
    const me = await this.me();
    const all = (await store.kv.get(DEVICES)) || {};
    return Object.values(all).filter(d => d?.id && !d.removed).map(d => ({ ...d, here: d.id === me.id }))
      .sort((a, b) => (b.here - a.here) || (b.seen || 0) - (a.seen || 0));
  }

  /** A sync that begins after this call, so a change just made is in it. */
  async syncAfter() { if (this.running) await this.running.catch(() => {}); return this.now(); }

  /** Renames this device, on every device. */
  async renameDevice(name) {
    name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name) throw new SyncError("name", "Give this device a name.");
    await this.touchDevice();
    const me = await this.me(), all = (await store.kv.get(DEVICES)) || {};
    const namedAt = Date.now();
    all[me.id] = { ...all[me.id], name, namedAt };
    await store.kv.set(DEVICES, all);
    await store.kv.set(ME, { ...me, name, namedAt });
    return this.syncAfter();
  }

  /** Removes another device: at its next sync it stops syncing and says so. What it holds stays on it. */
  async removeDevice(id) {
    const me = await this.me(), all = (await store.kv.get(DEVICES)) || {};
    if (id === me.id) throw new SyncError("self", "To stop syncing on this device, turn sync off here.");
    if (!all[id]) throw new SyncError("gone", "That device is no longer listed.");
    all[id] = { ...all[id], removed: Date.now(), removedBy: all[me.id]?.name || null };
    await store.kv.set(DEVICES, all);
    return this.syncAfter();
  }

  /** The harmonism.io account this device syncs as; null through a computer, which has no account. */
  async accountEmail() {
    const a = await Promise.resolve(this.t.account?.()).catch(() => null);
    return a && !a.computer && a.email ? String(a.email).trim().toLowerCase() : null;
  }

  /**
   * Stops syncing on this device; the synced copy stays for the others.
   * `auto`: whether sync may come back on by itself. A person turning it
   * off, or a copy deleted, says no; a copy started again elsewhere says yes,
   * and this device then asks to be let in again.
   */
  async off({ auto = false } = {}) {
    this.keys = null;
    await store.kv.del(KEYS); await store.kv.del(STATE); await store.kv.del(ROOT);
    await this.setConf({ on: false, auto, last: null, error: null });
  }

  /**
   * Sync without a switch. Signed in to harmonism.io, a device whose
   * account has no synced copy starts one at once, with nothing to press; a
   * device whose account already syncs elsewhere is reported as waiting to be
   * let in, for the page to offer. Turned off here by the person, or carried
   * through a computer, it is left alone. Never throws. Returns
   * { state: "on" | "join" | "passphrase" | "off" | "signed-out" | "error", bytes? }.
   */
  async ensure() {
    try {
      const conf = await this.conf();
      if (conf.on) { await this.keepLock().catch(() => {}); return { state: "on" }; }
      // Turned off before sync came on by itself (it had been on) counts as turned off by the person.
      if (conf.via === "computer" || conf.auto === false || (conf.auto === undefined && conf.since)) return { state: "off" };
      if (!(await this.accountEmail())) return { state: "signed-out" };
      let r = await this.remote();
      if (!r.meta) {
        // Started without a press: the next page that can speak says so once (conf.announce).
        try { await this.createLinked({ key: true }); await this.setConf({ announce: true }); return { state: "on", started: true }; }
        catch (e) { if (e.code !== "exists") throw e; r = await this.remote(); }   // another device started it a moment ago
      }
      // Signed in with the password: the copy opens with it, nothing to approve.
      if (Sync.linked(r.meta) && await this.unlockWithPassword({ key: true }).catch(() => null)) { await this.setConf({ announce: "joined" }); return { state: "on", joined: true }; }
      return { state: Sync.linked(r.meta) ? "join" : "passphrase", bytes: r.bytes ?? null, count: r.count ?? null, password: !!(await this.passwordKey()) };
    } catch (e) { return { state: "error", message: String(e?.message || e) }; }
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
      // The copy was erased, or started again, elsewhere:
      // this device stops and says so rather than writing under the old keys.
      if (code === "gone" || code === "epoch" || code === "no_space" || code === "removed") await this.off({ auto: code === "epoch" });
      await this.setConf({ error: { code, message, at: Date.now() } });
      return { ok: false, code, message };
    }
  }

  async locals(keys, conf) {
    const ids = (await store.threads.list()).map(t => "t:" + t.id);
    for (const k of SYNCED_KV) ids.push("k:" + k);
    for (const id of Object.keys((await store.kv.get(DEVICES)) || {})) ids.push("d:" + id);
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
    if (!keys) throw new SyncError("epoch", "This device has lost its sync key: turn sync on here again to let it back in.");
    const st = (await store.kv.get(STATE)) || { seq: 0, recs: {} };
    // A key passed over before this device could take it (it had none, and the
    // tick was off) is pulled again now that a device without a key takes it.
    if (!conf.key && this.secret && Object.values(st.recs).some(k => k.skip) && !(await this.secret.get("openrouter").catch(() => null))) {
      for (const [rid, k] of Object.entries(st.recs)) if (k.skip) delete st.recs[rid];
      st.seq = 0;
    }
    const meta = await this.t.request("GET", "?meta=1");
    if (!meta.meta) throw new SyncError("gone", "The synced copy was deleted from another device. Your memory here is untouched; turn sync on again to start a new one.");
    if (meta.meta.epoch !== st.epoch) throw new SyncError("epoch", "The synced copy was started again on another device. Turn sync on here again to let this device back in.");

    const changed = new Set();
    const keyRid = await ridOf(keys, "s:openrouter");
    await this.touchDevice();
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
        if (loc && !changedHere && await removeLocal(loc.lid, loc.body)) { local.delete(rid); changed.add(loc.lid); }
        st.recs[rid] = { seq: rec.seq, h: null };
        return;
      }
      const obj = JSON.parse(await open(keys, rec.data, rid));
      if (!obj || typeof obj.lid !== "string" || await ridOf(keys, obj.lid) !== rid) throw new SyncError("decrypt", "A synced record does not match its name.");
      if (obj.lid.startsWith("s:") && !(conf.key && this.secret)) {
        // A device with no key of its own takes the one another device sent:
        // signing in and letting the device in is all it should take. A device
        // that has its own key keeps it, and the synced one waits for the tick.
        const own = this.secret ? await this.secret.get(obj.lid.slice(2)).catch(() => null) : null;
        if (!this.secret || own) { st.recs[rid] = { seq: rec.seq, h: null, skip: true }; return; }
        conf.key = true; await this.setConf({ key: true });
      }
      const mergeIt = loc && changedHere && !(st.fresh && FIRST_THEIRS.has(obj.lid));
      const body = mergeIt ? merge(obj.lid, loc.body, obj.body) : obj.body;
      const moved = await writeLocal(obj.lid, body, this.secret, loc ? loc.body : null);
      changed.add(obj.lid);
      const now = await readLocal(obj.lid, this.secret);
      const text = stable({ lid: obj.lid, body: now });
      const h = await sha(text);
      // Merged: remember the server's version, so the merge is sent back up.
      st.recs[rid] = { seq: rec.seq, h: mergeIt || moved ? await sha(stable({ lid: obj.lid, body: obj.body })) : h };
      local.set(rid, { lid: obj.lid, body: now, text, h });
    };

    // Pull
    let cursor = st.seq || 0;
    for (let guard = 0; guard < 500; guard++) {
      const r = await this.t.request("GET", `?since=${cursor}`);
      if (r.epoch && r.epoch !== st.epoch) throw new SyncError("epoch", "The synced copy was started again on another device. Turn sync on here again to let this device back in.");
      for (const rec of r.records || []) await take(rec.rid, rec);
      cursor = r.more && r.records?.length ? r.records[r.records.length - 1].seq : Math.max(cursor, r.seq || 0);
      st.seq = cursor;
      await store.kv.set(STATE, st);
      if (!r.more) break;
    }

    // Removed from another device: this one stops before it writes anything.
    const self = ((await store.kv.get(DEVICES)) || {})[(await this.me()).id];
    if (self?.removed) throw new SyncError("removed", `This device was removed from your synced memory${self.removedBy ? ` on ${self.removedBy}` : ""}. Its memory here is kept; turn sync on again to let it back in.`);

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
    delete st.fresh;   // the first sync after joining is done
    await store.kv.set(STATE, st);
    const totals = await this.t.request("GET", "?meta=1").catch(() => ({}));
    return { changed, count: totals.count ?? null, bytes: totals.bytes ?? null };
  }
}
