// native.js — what the Lodestone app for Android adds to the web app.
//
// The app is a Capacitor shell that opens this same page from harmonism.io;
// nothing here runs in a browser. What it adds is what a web page may not do:
//
//   - reach Lodestone Desktop on the home network (http://<computer>:47863), which
//     an https page may not fetch. The shell allows it; the desktop answers
//     this origin only on its model, pairing and sync routes. If the WebView
//     still refuses, the request goes through Capacitor's native HTTP instead
//     (whole answers then, not word by word);
//   - pairing: the six-digit code Lodestone Desktop shows under Use from Your
//     Phone, typed here or carried by a lodestone://pair link from its QR code,
//     traded for a token kept on this phone, encrypted like the OpenRouter key;
//   - lodestone:// links opening the app.

import { secrets } from "./phone.js";

export const DESKTOP_PORT = 47863;
export const isNative = () => !!globalThis.Capacitor?.isNativePlatform?.();
const plugin = name => globalThis.Capacitor?.Plugins?.[name] || null;

/** fetch for the home network: the WebView's own, else native HTTP. */
export async function lanFetch(url, init = {}) {
  try {
    return await fetch(url, init);
  } catch (e) {
    const http = plugin("CapacitorHttp");
    if (!isNative() || !http || init.signal?.aborted) throw e;
    const headers = { ...(init.headers || {}) };
    let data;
    if (init.body != null) { try { data = JSON.parse(init.body); } catch { data = init.body; } }
    const r = await http.request({ url, method: init.method || "GET", headers, data, responseType: "text", connectTimeout: 8000, readTimeout: 600000 });
    const text = typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "");
    return new Response(text, { status: r.status, headers: r.headers || {} });
  }
}

/** "192.168.1.5", "192.168.1.5:47863", "http://mac.local:47863/lodestone-app/" → "http://192.168.1.5:47863". */
export function normalizeBase(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!u.hostname) return null;
  return `${u.protocol}//${u.hostname}:${u.port || DESKTOP_PORT}`;
}

/** lodestone://pair?u=<base>&c=<code>&n=<name> → { base, code, name } */
export function parsePairLink(link) {
  try {
    const u = new URL(link);
    if (u.protocol !== "lodestone:") return null;
    const what = (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
    if (what !== "pair") return null;
    const base = normalizeBase(u.searchParams.get("u"));
    const code = (u.searchParams.get("c") || "").replace(/\D/g, "");
    return base && code.length === 6 ? { base, code, name: u.searchParams.get("n") || "" } : null;
  } catch { return null; }
}

export const pairing = {
  get: () => secrets.get("computer"),
  async forget() { await secrets.del("computer"); },
};

const deviceName = () => {
  const ua = navigator.userAgent || "";
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  return (m && m[1].trim()) || "Android phone";
};

/** Trades the code for a token and keeps it. Resolves to { base, name }. */
export async function pairWith(baseInput, code) {
  const base = normalizeBase(baseInput);
  if (!base) throw new Error("Give the computer's address as Lodestone Desktop shows it, such as 192.168.1.20.");
  code = String(code || "").replace(/\D/g, "");
  if (code.length !== 6) throw new Error("The code has six digits.");
  let res;
  try {
    res = await lanFetch(base + "/munai-pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: deviceName() }) });
  } catch {
    throw new Error(`No answer from ${base}. The phone must be on the same Wi-Fi, Lodestone Desktop open, and Let phones on this Wi-Fi reach Lodestone switched on.`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.token) throw new Error(j.error?.message || `Lodestone Desktop answered ${res.status}.`);
  const p = { base, token: j.token, name: j.name || "your computer", id: j.id || null, at: Date.now() };
  await secrets.set("computer", p);
  return p;
}

/** The computer's model, as the server tier needs it. */
export async function computerServer(p) {
  return { baseUrl: p.base + "/v1", model: "lodestone", ctx: 32768, paired: true, name: p.name };
}

/** Calls fn(link) for every lodestone:// link that opens the app, the one it was opened with included. */
export function onAppLink(fn) {
  const App = plugin("App");
  if (!isNative() || !App) return;
  App.addListener?.("appUrlOpen", e => e?.url && fn(e.url));
  App.getLaunchUrl?.().then(r => r?.url && fn(r.url)).catch(() => {});
}
