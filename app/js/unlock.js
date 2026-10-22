// unlock.js — the key a practitioner's password opens their synced memory with
// (October 20, 2026). No other module is needed: harmonism.io's sign-in pages
// import this file too (member/login.php, member/update-password.php), so a
// person who signs in there with a password finds Lodestone already able to
// open their memory, here or on any new device.
//
// The password is never kept. At sign-in it is stretched, with the account's
// email as salt, into a key (PBKDF2-SHA-256, 600,000 rounds) that this browser
// keeps as a WebCrypto key nothing can export, in its own small database. sync.js
// locks the sync key under it and leaves that lock with the synced copy; a new
// device signed in with the same password opens the lock, and is in. Lodestone
// Desktop stretches the password in its main process (the same rounds, the same
// salt) and hands the result over once (stashRaw).

const DB = "lodestone-unlock", ST = "keys", ITER = 600000;
const te = new TextEncoder();
const norm = e => String(e || "").trim().toLowerCase();

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(ST)) r.result.createObjectStore(ST); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const t = d.transaction(ST, mode); const s = t.objectStore(ST); let out;
      const q = fn(s); if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    });
  } finally { d.close(); }
}

/** The salt: one per account, the same on every device. */
export const saltFor = email => te.encode("lodestone-unlock-v1:" + norm(email));

/** The password, stretched into the unlock key's 32 bytes. */
export async function stretch(email, password) {
  const base = await crypto.subtle.importKey("raw", te.encode(String(password).normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltFor(email), iterations: ITER }, base, 256));
}

const keyOf = raw => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

/** Kept from a stretched password: a key that cannot be exported, and when it was made. */
export async function stashRaw(email, raw, at = Date.now()) {
  if (!norm(email) || !raw || raw.length !== 32) return false;
  const key = await keyOf(raw);
  raw.fill?.(0);
  await tx("readwrite", s => s.put({ key, at }, norm(email)));
  return true;
}

/** At sign-in with a password: stretch it and keep the key. Never throws. */
export async function stashPassword(email, password) {
  try {
    if (!norm(email) || !password || !globalThis.crypto?.subtle || !globalThis.indexedDB) return false;
    return await stashRaw(email, await stretch(email, password));
  } catch (e) { console.warn("[unlock]", e?.message || e); return false; }
}

/** { key, at } for this account, or null. */
export async function take(email) {
  if (!norm(email) || !globalThis.indexedDB) return null;
  try { const v = await tx("readonly", s => s.get(norm(email))); return v?.key ? v : null; } catch { return null; }
}

/** At sign-out. */
export async function forget(email) {
  try { if (norm(email)) await tx("readwrite", s => s.delete(norm(email))); } catch {}
}
