// store.js — everything the practitioner owns lives here, in IndexedDB on this device.
// Nothing in this module ever touches the network (sync.js, when switched on,
// reads and writes through it).

// One memory per person. Each harmonism.io account signed in on this device
// has its own database; the device's own memory (signed out, and every
// installation that never signs in) is "lodestone-device" ("munai-offline"
// until November 24, 2026: moved by renameDatabases() below). Which
// database is open is chosen by held.js (bind()); everything below reads and
// writes the one in use, so two people on one computer never share a memory.
// Web-storage names moved from munai- to lodestone- on November 24, 2026 (a
// kept identifier is renamed only with its migration). Each munai- key
// is carried to its lodestone- name once, unless that name is already set, then
// removed. The IndexedDB names move the same day, in renameDatabases() below.
export function renameStorage() {
  for (const area of ["localStorage", "sessionStorage"]) {
    try {
      const s = globalThis[area];
      if (!s) continue;
      const old = [];
      for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith("munai-")) old.push(k); }
      for (const k of old) {
        const n = "lodestone-" + k.slice(6);
        if (s.getItem(n) == null) s.setItem(n, s.getItem(k));
        s.removeItem(k);
      }
    } catch {}
  }
}
renameStorage();

let DEVICE_DB = "lodestone-device";
let MAP_DB = "lodestone-accounts";
const DB_VERSION = 1;
let DB_NAME = null;   // null: the device's own memory, DEVICE_DB
let dbp = null;

/** The database in use. */
export const using = () => DB_NAME || DEVICE_DB;

/** Opens another person's (or the device's) memory; what was open is closed. */
export async function use(name) {
  if (!name || name === using()) return false;
  if (dbp) { try { (await dbp).close(); } catch {} dbp = null; }
  DB_NAME = name;
  return true;
}

function open() {
  if (dbp) return dbp;
  dbp = renamed.then(() => rawOpen(using()));   // the name is read once the move has settled
  return dbp;
}

/** Opens a memory database once the names have moved (renameDatabases). */
async function openDb(name) {
  await renamed;
  return rawOpen(name);
}

function rawOpen(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("threads")) db.createObjectStore("threads", { keyPath: "id" });
      if (!db.objectStoreNames.contains("messages")) {
        const s = db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        s.createIndex("thread", "threadId");
        s.createIndex("ts", "ts");
      }
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── whose memory is where ───────────────────────────────────────────────────
// A small database of its own: account key → database name, and which
// database is the device's own memory.
let mapp = null;
function rawMap(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("map")) req.result.createObjectStore("map"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function mapOpen() {
  if (mapp) return mapp;
  mapp = renamed.then(() => rawMap(MAP_DB));
  return mapp;
}

// ─── the names before November 24, 2026 ──────────────────────────────────────
// Until then the device's memory was "munai-offline", the account map
// "munai-accounts" and a device memory made at sign-in "munai-device-…" (an
// account's own memory was already "lodestone-memory-…"). Once per browser,
// before anything is opened, each is copied to its lodestone- name, every store,
// and the copy counted; the map's entries are copied with the names they point
// to rewritten. The old databases are deleted only after everything has been
// copied and the move marked done. If any step fails, nothing old is deleted:
// this visit works on the old names, and the next visit tries again.
const OLD_DEVICE_DB = "munai-offline", OLD_MAP_DB = "munai-accounts";
const MOVED = "flag:names-moved";
const newNameOf = n => n === OLD_DEVICE_DB ? DEVICE_DB
  : (typeof n === "string" && n.startsWith("munai-device-") ? "lodestone-device-" + n.slice(13) : n);
const oldNameOf = n => n === DEVICE_DB ? OLD_DEVICE_DB
  : (typeof n === "string" && n.startsWith("lodestone-device-") ? "munai-device-" + n.slice(17) : n);

async function dbExists(name) {
  try { if (indexedDB.databases) return (await indexedDB.databases()).some(d => d.name === name); } catch {}
  return new Promise(res => {
    let fresh = false;
    const r = indexedDB.open(name);
    r.onupgradeneeded = e => { fresh = e.oldVersion === 0; if (fresh) r.transaction.abort(); };
    r.onsuccess = () => { r.result.close(); res(true); };
    r.onerror = () => { if (fresh) indexedDB.deleteDatabase(name); res(false); };
  });
}
function readStore(db, st) {
  return new Promise((res, rej) => {
    const t = db.transaction(st, "readonly"), s = t.objectStore(st);
    const k = s.getAllKeys(), v = s.getAll();
    t.oncomplete = () => res({ keys: k.result || [], vals: v.result || [] });
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
function writeStore(db, st, keys, vals, mapVal = v => v) {
  return new Promise((res, rej) => {
    const t = db.transaction(st, "readwrite"), s = t.objectStore(st);
    for (let i = 0; i < keys.length; i++) { const v = mapVal(vals[i], keys[i]); if (s.keyPath != null) s.put(v); else s.put(v, keys[i]); }
    t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
function countStore(db, st) {
  return new Promise((res, rej) => { const r = db.transaction(st, "readonly").objectStore(st).count(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function copyDb(from, to) {
  const src = await rawOpen(from), dst = await rawOpen(to);
  try {
    for (const st of ["kv", "threads", "messages", "blobs"]) {
      if (!src.objectStoreNames.contains(st)) continue;
      const { keys, vals } = await readStore(src, st);
      if (!keys.length) continue;
      await writeStore(dst, st, keys, vals);
      const n = await countStore(dst, st);
      if (n < keys.length) throw new Error(`${from} → ${to}: ${st} has ${n} of ${keys.length}`);
    }
  } finally { src.close(); dst.close(); }
}
async function renameDatabases() {
  if (typeof indexedDB === "undefined") return;
  const map = await rawMap(MAP_DB);
  try {
    if (await new Promise(res => { const r = map.transaction("map", "readonly").objectStore("map").get(MOVED); r.onsuccess = () => res(r.result); r.onerror = () => res(null); })) return;
    const old = new Set();
    if (await dbExists(OLD_MAP_DB)) {
      const om = await rawMap(OLD_MAP_DB);
      let entries;
      try { entries = await readStore(om, "map"); } finally { om.close(); }
      const have = new Set((await readStore(map, "map")).keys);
      const keys = [], vals = [];
      entries.keys.forEach((k, i) => {
        const v = entries.vals[i];
        if ((k === "device" || String(k).startsWith("acct:")) && typeof v === "string" && v.startsWith("munai-")) old.add(v);
        if (!have.has(k)) { keys.push(k); vals.push(v); }
      });
      await writeStore(map, "map", keys, vals, (v, k) => (k === "device" || String(k).startsWith("acct:")) ? newNameOf(v) : v);
      old.add(OLD_MAP_DB);
    }
    if (await dbExists(OLD_DEVICE_DB)) old.add(OLD_DEVICE_DB);
    try { for (const d of (await indexedDB.databases?.()) || []) if (/^munai-device-/.test(d.name)) old.add(d.name); } catch {}
    for (const n of old) {
      if (n === OLD_MAP_DB || !(await dbExists(n))) continue;
      await copyDb(n, newNameOf(n));
    }
    await writeStore(map, "map", [MOVED], [Date.now()]);
    for (const n of old) indexedDB.deleteDatabase(n);
  } finally { map.close(); }
}
const renamed = renameDatabases().catch(e => {
  // Nothing old was deleted: this visit keeps to the old names.
  console.warn("[store] memory not moved to its new name yet; this visit uses the old one:", e);
  DEVICE_DB = OLD_DEVICE_DB; MAP_DB = OLD_MAP_DB;
  if (DB_NAME) DB_NAME = oldNameOf(DB_NAME);
});
function mapTx(mode, fn) {
  return mapOpen().then(db => new Promise((resolve, reject) => {
    const t = db.transaction("map", mode); const s = t.objectStore("map"); let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  }));
}
export const accounts = {
  get: key => mapTx("readonly", s => reqP(s.get("acct:" + key))).then(v => v || null),
  set: (key, name) => mapTx("readwrite", s => { s.put(name, "acct:" + key); }),
  del: key => mapTx("readwrite", s => { s.delete("acct:" + key); }),
  device: () => mapTx("readonly", s => reqP(s.get("device"))).then(v => v || DEVICE_DB),
  setDevice: name => mapTx("readwrite", s => { s.put(name, "device"); }),
  /** A setting that belongs to this browser, not to anyone's memory (the shared-computer tick). */
  getFlag: k => mapTx("readonly", s => reqP(s.get("flag:" + k))).then(v => v ?? null),
  setFlag: (k, v) => mapTx("readwrite", s => { if (v == null) s.delete("flag:" + k); else s.put(v, "flag:" + k); }),
};

/** Deletes a whole memory database (never the one in use: it is closed first). */
export async function dropDatabase(name) {
  if (name === using() && dbp) { try { (await dbp).close(); } catch {} dbp = null; }
  await new Promise(res => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}

const ownKv = k => !/^(sync:|held:owner$)/.test(k);
/** Whether a memory database holds anything said or learned (settings and sync state aside). */
export async function holdsMemory(name) {
  const db = await openDb(name);
  try {
    const count = st => new Promise(res => { const r = db.transaction(st, "readonly").objectStore(st).count(); r.onsuccess = () => res(r.result); r.onerror = () => res(0); });
    if ((await count("messages")) > 0) return true;
    const keys = await new Promise(res => { const r = db.transaction("kv", "readonly").objectStore("kv").getAllKeys(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
    return keys.some(k => ["profile", "wheel", "assessment", "companion", "hp_code", "practices"].includes(k));
  } finally { db.close(); }
}

/** One key of another memory database, without opening it for use. */
export async function peek(name, key) {
  const db = await openDb(name);
  try { return await new Promise(res => { const r = db.transaction("kv", "readonly").objectStore("kv").get(key); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); }); }
  finally { db.close(); }
}

/**
 * Brings everything of another memory database into the one in use: its
 * conversations, and each value this one does not have yet. Sync state stays
 * behind (it belongs to the database it was made for).
 */
export async function mergeFrom(name) {
  const src = await openDb(name);
  const all = (st, fn) => new Promise(res => { const r = fn(src.transaction(st, "readonly").objectStore(st)); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
  try {
    const [ths, msgs, keys, vals] = await Promise.all([all("threads", s => s.getAll()), all("messages", s => s.getAll()), all("kv", s => s.getAllKeys()), all("kv", s => s.getAll())]);
    const have = new Set((await threads.list()).map(t => t.id));
    for (const t of ths) if (!have.has(t.id)) await threads.put(t);
    await tx("messages", "readwrite", s => { for (const m of msgs) { if (have.has(m.threadId)) continue; const { id, ...rest } = m; s.add(rest); } });
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!ownKv(k)) continue;
      if ((await kv.get(k)) == null) await kv.set(k, vals[i]);
    }
  } finally { src.close(); }
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// What belongs to the device rather than to a person: its settings (model,
// theme, language), the library it downloaded, and its saved key. They stay
// the same whoever is signed in, kept beside the account map. Read once from
// where they lived before memories were kept apart, then kept here.
const DEVICE_KEY = /^(settings|pack|caches-moved|secrets-key|secret:.+)$/;
async function oldDevice(st, k) {
  try {
    const db = await openDb(DEVICE_DB);
    try { return await new Promise(res => { const r = db.transaction(st, "readonly").objectStore(st).get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }); }
    finally { db.close(); }
  } catch { return undefined; }
}
async function deviceGet(prefix, st, k) {
  let v = await mapTx("readonly", s => reqP(s.get(prefix + k)));
  if (v === undefined) {
    v = await oldDevice(st, k);
    if (v !== undefined) await mapTx("readwrite", s => { s.put(v, prefix + k); });
  }
  return v;
}

export const kv = {
  get: (k, dflt = null) => (DEVICE_KEY.test(k) ? deviceGet("dev:", "kv", k) : tx("kv", "readonly", s => reqP(s.get(k)))).then(v => (v === undefined ? dflt : v)),
  set: (k, v) => (DEVICE_KEY.test(k) ? mapTx("readwrite", s => { s.put(v, "dev:" + k); }) : tx("kv", "readwrite", s => { s.put(v, k); })),
  del: k => (DEVICE_KEY.test(k) ? mapTx("readwrite", s => { s.delete("dev:" + k); }) : tx("kv", "readwrite", s => { s.delete(k); })),
};

// Large binary/text assets (corpus pack) when the Cache API is unavailable (plain-http LAN serving): the device's.
export const blobs = {
  get: k => deviceGet("blob:", "blobs", k),
  set: (k, v) => mapTx("readwrite", s => { s.put(v, "blob:" + k); }),
  del: k => mapTx("readwrite", s => { s.delete("blob:" + k); }),
};

export const threads = {
  list: () => tx("threads", "readonly", s => reqP(s.getAll())).then(a => a.sort((x, y) => y.updated - x.updated)),
  get: id => tx("threads", "readonly", s => reqP(s.get(id))),
  put: t => tx("threads", "readwrite", s => { s.put(t); }),
  async create(title = "New conversation") {
    const t = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(), title, created: Date.now(), updated: Date.now() };
    await threads.put(t);
    return t;
  },
  async remove(id) {
    const msgs = await messages.forThreadAll(id);
    await tx("messages", "readwrite", s => { msgs.forEach(m => s.delete(m.id)); });
    await tx("threads", "readwrite", s => { s.delete(id); });
  },
};

// v98: a message deleted by the practitioner stays as a mark ({ deleted, content: "" }),
// so a sync from another device cannot bring it back; every reader but sync and the
// cost counters (forThreadAll, allRaw) sees it gone.
const live = a => a.filter(m => !m.deleted);
export const messages = {
  forThread: threadId => messages.forThreadAll(threadId).then(live),
  forThreadAll: threadId => tx("messages", "readonly", s => reqP(s.index("thread").getAll(threadId))).then(a => a.sort((x, y) => x.ts - y.ts || x.id - y.id)),
  // The time is set on the caller's object too (1.13.1): the copy in memory and the stored one agree, and the summary's cut-off is a time.
  add: m => { if (!m.ts) m.ts = Date.now(); return tx("messages", "readwrite", s => reqP(s.add({ ...m }))); },
  put: m => tx("messages", "readwrite", s => { s.put(m); }),
  del: id => tx("messages", "readwrite", s => { s.delete(id); }),
  since: ts => tx("messages", "readonly", s => reqP(s.index("ts").getAll(IDBKeyRange.lowerBound(ts)))).then(live),
  all: () => messages.allRaw().then(live),
  allRaw: () => tx("messages", "readonly", s => reqP(s.getAll())),
};

export async function exportAll() {
  const [ths, msgs] = await Promise.all([threads.list(), messages.all()]);
  // The whole memory (1.13.1): what sync carries, not only the first five.
  const keys = ["profile", "wheel", "practices", "assessment", "settings", "companion", "hp_code", "learned", "reading", "outreach", "lifebook"];
  const kvs = {};
  for (const k of keys) kvs[k] = await kv.get(k);
  return { format: "lodestone-memory", version: 1, exported_at: new Date().toISOString(), kv: kvs, threads: ths, messages: msgs };
}

export async function importAll(data, { merge = true, mergeKv = null } = {}) {
  if (!data || (data.format !== "lodestone-memory" && data.format !== "munai-offline-memory")) throw new Error("Not a Lodestone memory file.");
  if (!merge) await wipeMemory();
  for (const [k, v] of Object.entries(data.kv || {})) {
    if (v === null || v === undefined) continue;
    if (k === "settings") continue; // compute settings are device-specific
    if (k === "practices" && merge) {
      const cur = (await kv.get("practices", [])) || [];
      const ids = new Set(cur.map(p => p.id));
      await kv.set("practices", cur.concat(v.filter(p => !ids.has(p.id))));
    } else if (merge && mergeKv) {
      // Joined with what this device holds, as sync joins them (1.13.1): an import no longer replaces the notes or the Wheel.
      const cur = await kv.get(k);
      await kv.set(k, cur == null ? v : mergeKv(k, cur, v));
    } else {
      await kv.set(k, v);
    }
  }
  const existing = new Set((await threads.list()).map(t => t.id));
  for (const t of data.threads || []) if (!existing.has(t.id)) await threads.put(t);
  await tx("messages", "readwrite", s => {
    for (const m of data.messages || []) {
      if (existing.has(m.threadId)) continue;
      const { id, ...rest } = m;
      s.add(rest);
    }
  });
}

export async function wipeMemory() {
  await tx("messages", "readwrite", s => { s.clear(); });
  await tx("threads", "readwrite", s => { s.clear(); });
  for (const k of ["profile", "wheel", "practices", "assessment", "recall:index", "recall:forgotten", "sitting"]) await kv.del(k);
}

export async function wipeEverything() {
  if (dbp) { (await dbp).close(); dbp = null; }
  if (mapp) { (await mapp).close(); mapp = null; }
  // Every memory on this device, and the device's own settings.
  const names = new Set([using(), DEVICE_DB, MAP_DB, OLD_DEVICE_DB, OLD_MAP_DB]);
  try { for (const d of (await indexedDB.databases?.()) || []) if (/^(lodestone-(device|memory-)|munai-(offline|device-|memory-))/.test(d.name)) names.add(d.name); } catch {}
  for (const n of names) await new Promise(res => { const r = indexedDB.deleteDatabase(n); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  if (self.caches) for (const k of await caches.keys()) await caches.delete(k);
}

