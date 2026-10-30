// seal.js — a document sealed on this device for a link (Share with your guide).
//
// AES-GCM with a 256-bit key made here. The server gets the ciphertext and the
// IV; the key travels only in the link's fragment (#id.key), which browsers never
// send to a server, so Harmonia holds what it cannot read. The guide's page
// (guide.html) opens it with the same functions. Base64url throughout, so the
// link and the JSON carry it as it is.
//
// With a passphrase, the key that seals is drawn from two secrets: the
// link's key and the passphrase, stretched by PBKDF2 (SHA-256, 600,000 rounds,
// a salt made here) and joined by HKDF. The salt rides in the fragment as a third
// part (#id.key.salt), which tells the guide's page to ask. The link alone then
// opens nothing: someone who reads it where it was sent (a mail or chat provider,
// a forwarded message) needs the passphrase too, which the practitioner gives
// another way. It does not guard against an altered page, which could read the
// passphrase as it is typed, exactly as it could read the key.

const enc = new TextEncoder(), dec = new TextDecoder();
export const PASS_ROUNDS = 600000;
const INFO = enc.encode("lodestone-guide-v1");

export function b64u(bytes) {
  let s = ""; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The passphrase as typed, made the same on every device: Unicode NFKC, spaces folded, no case. */
export const normPass = p => String(p || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** The AES key: the link's key alone, or the link's key and the stretched passphrase together. */
async function aesKey(raw, use, pass, salt) {
  if (!pass) return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [use]);
  const pk = await crypto.subtle.importKey("raw", enc.encode(normPass(pass)), "PBKDF2", false, ["deriveBits"]);
  const stretched = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PASS_ROUNDS }, pk, 256));
  const both = new Uint8Array(64); both.set(raw, 0); both.set(stretched, 32);
  const hk = await crypto.subtle.importKey("raw", both, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO }, hk, { name: "AES-GCM", length: 256 }, false, [use]);
}

/** Seal an object: { iv, data } for the server, the key (and with a passphrase, the salt) for the link. */
export async function seal(obj, { passphrase = "" } = {}) {
  const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = passphrase ? crypto.getRandomValues(new Uint8Array(16)) : null;
  const key = await aesKey(raw, "encrypt", passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64u(iv), data: b64u(ct), key: b64u(raw), salt: salt ? b64u(salt) : null };
}

/** Open what seal() made; throws when the key or the passphrase is wrong, or the bytes were changed. */
export async function unseal({ iv, data }, keyB64u, { passphrase = "", salt = null } = {}) {
  const raw = unb64u(keyB64u);
  if (raw.length !== 32) throw new Error("key");
  if (salt && !passphrase) throw new Error("passphrase");
  const key = await aesKey(raw, "decrypt", salt ? passphrase : "", salt ? unb64u(salt) : null);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, key, unb64u(data));
  return JSON.parse(dec.decode(pt));
}

export const GUIDE_BASE = "https://lodestone.harmonism.io/guide";
export const linkFor = (id, key, salt = null) => `${GUIDE_BASE}#${id}.${key}${salt ? "." + salt : ""}`;
/** id, key and (with a passphrase) the salt from a link's fragment, or null. */
export function parseFragment(hash) {
  const m = String(hash || "").replace(/^#/, "").match(/^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]{22}))?$/);
  return m ? { id: m[1], key: m[2], salt: m[3] || null } : null;
}

/** A passphrase easy to say aloud: three groups of four letters and digits, with none that sound alike (about 58 bits). */
export function makePassphrase() {
  const A = "abcdefghjkmnpqrstuvwxyz23456789";   // no i, l, o, 0, 1
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map(x => A[x % A.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
