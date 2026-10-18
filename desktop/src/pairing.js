// pairing.js — the Lodestone app for Android paired with this computer.
//
// Under Use from Your Phone the computer shows a six-digit code, good for ten
// minutes and five tries; a phone on the same Wi-Fi trades it for a token, of
// which only a hash is kept. Five wrong tries end the code, and only that
// window makes a new one, so the code cannot be guessed from the network. The
// token opens the synced copy kept on this computer (syncstore.js).

const crypto = require("crypto");

const LIFE = 10 * 60 * 1000;
const TRIES = 5;
const tokenHash = t => crypto.createHash("sha256").update(String(t)).digest("hex");

/**
 * @param {{ sync: import("./syncstore").SyncStore, hello: () => object,
 *           load: () => Array<{id,name,hash,created,seen}>, save: (list) => void, now?: () => number }} o
 */
function createPhoneAccess(o) {
  const now = o.now || Date.now;
  let pairing = null;                                  // { code, exp, tries }
  const live = () => !!pairing && now() < pairing.exp && pairing.tries < TRIES;
  const fail = message => ({ status: 403, json: { error: { code: "code", message } } });

  return {
    sync: o.sync,
    hello: o.hello,
    /** The code the window shows: the current one, or a new one when it has expired or been spent. */
    code() {
      if (!live()) pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, "0"), exp: now() + LIFE, tries: 0 };
      return { code: pairing.code, exp: pairing.exp };
    },
    pair(body) {
      const code = String(body?.code ?? "").replace(/\D/g, "");
      if (!live()) return fail("No pairing code is open. On the computer, open Lodestone → Use from Your Phone… and use the code shown there.");
      const a = Buffer.from(code.padEnd(6, "x").slice(0, 12)), b = Buffer.from(pairing.code);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        pairing.tries++;
        return fail(live() ? "That is not the code Lodestone Desktop shows. Check it and try again." : "Too many wrong codes. Open Use from Your Phone… on the computer again for a new one.");
      }
      pairing = null;
      const token = crypto.randomBytes(32).toString("base64url");
      const name = String(body?.name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "Android phone";
      const id = crypto.randomBytes(6).toString("hex");
      o.save([...o.load(), { id, name, hash: tokenHash(token), created: now(), seen: now() }]);
      return { status: 200, json: { token, id, ...o.hello() } };
    },
    authorized(token) {
      if (!token) return false;
      const h = tokenHash(token);
      const list = o.load();
      const d = list.find(x => x.hash === h);
      if (!d) return false;
      if (now() - (d.seen || 0) > 60000) { d.seen = now(); o.save(list); }
      return true;
    },
    paired: () => o.load().map(({ id, name, created, seen }) => ({ id, name, created, seen })),
    forget(id) { o.save(o.load().filter(d => d.id !== id)); },
  };
}

module.exports = { createPhoneAccess, tokenHash };
