// syncwire.js — where Lodestone's synced copy is kept, and how a page reaches it.
// Shared by the app (main.js) and by website Lodestone and the
// browser extension (held.js), so every surface syncs alike.

import * as store from "./store.js";
import { hosted, secrets } from "./phone.js";
import { SyncError } from "./sync.js";
import { isNative, lanFetch, pairing } from "./native.js";

/** desktop: Lodestone Desktop's bridge (window.lodestoneDesktop), or null in a browser. */
/** opts.base: harmonism.io's address where the page is not on it (the browser extension's worker). */
export function wire(desktop = null, opts = {}) {
  const site = () => opts.base || location.origin;
  // Two places the synced copy can be kept: harmonism.io under the
  // account, or Lodestone Desktop on the practitioner's own computer. The choice is
  // the device's, saved with its sync settings; the records and the encryption
  // are the same either way.
  const syncVia = async () => ((await store.kv.get("sync:conf")) || {}).via === "computer" ? "computer" : "account";
  async function computerLabel() {
    if (desktop) return "this computer";
    if (!isNative()) return null;
    const p = await pairing.get().catch(() => null);
    return p ? p.name : null;
  }

  function accountTransport() {
    if (desktop) return {
      async request(method, query, body) {
        const r = await desktop.syncCall(method, query, body ?? null);
        if (!r?.ok) throw new SyncError(r?.code || "network", r?.message || "harmonism.io could not be reached.", r?.status || 0);
        return r.json;
      },
      account: () => desktop.syncAccount(),
    };
    return {
      async request(method, query, body) {
        const go = async force => {
          let tok;
          try { tok = await hosted.token(force); } catch (e) { throw new SyncError("auth", String(e.message || e), 401); }
          return fetch(site() + "/lodestone-sync-api.php" + query, {
            method, cache: "no-store",
            // A connection that hangs is given up after a minute, and tried on the next tick.
            signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
            headers: { Authorization: `Bearer ${tok}`, ...(body != null ? { "Content-Type": "application/json" } : {}) },
            body: body != null ? JSON.stringify(body) : undefined,
          });
        };
        let res;
        try { res = await go(false); if (res.status === 401) res = await go(true); }
        catch (e) { if (e instanceof SyncError) throw e; throw new SyncError("network", "harmonism.io could not be reached. Lodestone will sync when you are back online."); }
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new SyncError(j.error?.code || "http", j.error?.message || `harmonism.io answered ${res.status}.`, res.status);
        return j;
      },
      account: () => hosted.account(),
    };
  }

  function computerTransport() {
    if (desktop) return {
      async request(method, query, body) {
        const r = await desktop.syncLocal(method, query, body ?? null);
        if (!r?.ok) throw new SyncError(r?.code || "error", r?.message || "Sync through this computer failed.", r?.status || 0);
        return r.json;
      },
      account: async () => ({ email: "this computer", computer: true }),
    };
    return {
      async request(method, query, body) {
        const p = await pairing.get().catch(() => null);
        if (!p) throw new SyncError("auth", "This phone is no longer paired with a computer. Pair it again under Change where Lodestone thinks → My computer.", 401);
        let res;
        try {
          res = await lanFetch(p.base + "/munai-sync" + query, {
            method, cache: "no-store",
            // A connection that hangs is given up after a minute, and tried on the next tick.
            signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
            headers: { Authorization: `Bearer ${p.token}`, ...(body != null ? { "Content-Type": "application/json" } : {}) },
            body: body != null ? JSON.stringify(body) : undefined,
          });
        } catch { throw new SyncError("network", `${p.name} is not reachable. Lodestone syncs when this phone is on the same Wi-Fi and Lodestone Desktop is open.`); }
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new SyncError(j.error?.code || "http", j.error?.message || `${p.name} answered ${res.status}.`, res.status);
        return j;
      },
      account: async () => { const p = await pairing.get().catch(() => null); return p ? { email: p.name, computer: true } : null; },
    };
  }

  function syncTransport() {
    const a = accountTransport(), c = computerTransport();
    return {
      request: async (...args) => ((await syncVia()) === "computer" ? c : a).request(...args),
      account: async () => ((await syncVia()) === "computer" ? c : a).account(),
    };
  }
  const syncSecret = () => desktop
    ? { get: () => desktop.syncKeyGet(), set: (_n, v) => desktop.syncKeySet(v) }
    : { get: n => secrets.get(n), set: (n, v) => secrets.set(n, v) };

  return { syncVia, computerLabel, accountTransport, computerTransport, syncTransport, syncSecret };
}
