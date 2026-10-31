/**
 * Lodestone Extension — Options page (2.0)
 *
 * Presence settings, and the practitioner's memory: their harmonism.io
 * sign-in and Lodestone sync. The page shares the extension's storage with its
 * worker, so what is set here is what the worker uses on every page.
 */

import { ready as sessionReady, store as sessionStore } from "./session-store.js";
import { setSessionStore, hosted, signInWithPassword, secrets } from "./lib/phone.js";
import { stashPassword } from "./lib/unlock.js";
import * as held from "./lib/held.js";

setSessionStore(sessionStore);
held.configure({ base: "https://harmonism.io" });

const $ = (id) => document.getElementById(id);
const say = (text, bad) => { const el = $("memory-status"); el.textContent = text || ""; el.style.color = bad ? "#e07070" : ""; };

let remote = null, linkCtrl = null, pollT = null;
const linked = (m) => !!m && Number(m.v) >= 2;
async function renderMemory() {
  await sessionReady();
  const acct = await hosted.account().catch(() => null);
  $("acct-out").hidden = !!acct;
  $("acct-in").hidden = !acct;
  if (!acct) return;
  $("acct-email").textContent = "Signed in as " + acct.email + ".";
  // Each account has its own memory in this browser; this one is now open.
  await held.bind();
  const offer = await held.deviceOffer().catch(() => ({ offer: false }));
  $("device-offer").hidden = !offer.offer;
  const sy = held.syncer();
  const conf = await sy.conf();
  $("sync-off").hidden = !!conf.on;
  $("sync-on-box").hidden = !conf.on;
  if (conf.on) {
    $("sync-hint").textContent = (conf.error ? "Not synced: " + conf.error.message : conf.last ? "Synced " + new Date(conf.last).toLocaleString() + "." : "Syncing…")
      + " Your memory in this browser is kept in step with your other devices, encrypted.";
    $("show-recovery").hidden = !(await sy.canLink());
    drawRequests();
    clearInterval(pollT); pollT = setInterval(drawRequests, 4000);
    return;
  }
  clearInterval(pollT);
  try { remote = await sy.remote(); } catch (e) { $("sync-hint").textContent = e.message; return; }
  const has = !!remote.meta;
  $("sync-erase").hidden = !has;
  $("legacy").hidden = !(has && !linked(remote.meta));
  $("link-wait").hidden = true; $("sync-on").hidden = false;
  $("sync-on").textContent = !has ? "Turn on sync" : linked(remote.meta) ? "Bring my memory into this browser" : "Unlock and sync";
  $("sync-hint").textContent = !has ? "One switch: your other devices then join from this one. Nothing to remember."
    : linked(remote.meta) ? "Your account already syncs your memory. Let this browser in from a device already synced."
    : "Your account has a synced copy made with a passphrase. Enter it once.";
  if (conf.error) $("sync-hint").textContent += " (" + conf.error.message + ")";
}

// On a synced browser: devices waiting to be let in, each with the field for its code.
async function drawRequests() {
  const box = $("link-requests"); if (!box) return;
  const sy = held.syncer();
  const reqs = await sy.pendingLinks();
  const open = new Set([...box.querySelectorAll("[data-id]")].map((n) => n.dataset.id));
  if (reqs.length === open.size && reqs.every((q) => open.has(q.id))) return;
  box.replaceChildren(...reqs.map((q) => {
    const d = document.createElement("div"); d.className = "linkreq"; d.dataset.id = q.id;
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const hint = (text) => { const h = el("div", { className: "hint", textContent: text }); h.style.marginLeft = "0"; return h; };
    d.append(
      el("b", { textContent: "A device asks to join your memory" }),
      hint("Only if you just asked on another device of yours: type the code it shows."),
      el("input", { type: "text", placeholder: "Code shown on the new device", autocomplete: "off", spellcheck: false, maxLength: 14 }),
      el("button", { textContent: "Let it in" }), " ",
      el("button", { className: "ghost", textContent: "Decline" }),
      hint(""));
    const [inp] = d.getElementsByTagName("input"), [yes, no] = d.getElementsByTagName("button"), m = d.querySelector(".hint:last-child");
    yes.addEventListener("click", async () => { yes.disabled = true; m.textContent = "Sealing the key for that device…"; try { await sy.approveLink(q.id, inp.value); m.textContent = "Sent. The new device opens your memory in a moment if the code was right; if not, type it again."; } catch (e) { m.textContent = e.message; } yes.disabled = false; });
    no.addEventListener("click", async () => { await sy.declineLink(q.id); drawRequests(); });
    return d;
  }));
}

function load() {
  renderMemory().catch((e) => say(String(e.message || e), true));
}

// Firefox treats host access as opt-in: ask inside the click.
function requestGrant() {
  return new Promise((resolve) => {
    try {
      chrome.permissions.request({ origins: ["https://harmonism.io/*", "https://www.harmonism.io/*"] },
        (granted) => resolve(!chrome.runtime.lastError && granted !== false));
    } catch (err) { resolve(true); }
  });
}

$("signin").addEventListener("click", async () => {
  if (!(await requestGrant())) { say("Permission for harmonism.io was declined; memory needs it.", true); return; }
  say("Signing in…");
  try {
    const { email } = await signInWithPassword($("email").value, $("password").value);
    await stashPassword(email, $("password").value);   // opens the synced memory with the password (unlock.js)
    $("password").value = "";
    chrome.storage.sync.set({ memoryLinked: true });
    say("");
    await held.migrate().catch(() => {});
    renderMemory();
  } catch (e) { say(e.message, true); }
});

$("signout").addEventListener("click", async () => {
  if (!confirm("Sign out? Lodestone becomes anonymous here.")) return;
  // Kept by default; a shared computer removes it unless told otherwise.
  const shared = await held.sharedComputer.get();
  const keep = shared
    ? !confirm("This is marked as a shared computer. Remove your Lodestone memory from this browser?\n\nOK: remove it. With sync on, it comes back when you sign in again.\nCancel: keep it here.")
    : confirm("Keep your Lodestone memory in this browser for when you sign in again?\n\nOK: keep it (your own computer).\nCancel: remove it (a shared computer). With sync on, it comes back when you sign in again.");
  await held.signOutHere({ keep });
  await hosted.signOut();
  chrome.storage.sync.set({ memoryLinked: false });
  renderMemory();
});

async function syncedNow(r) {
  say(r.ok ? "Sync is on." : "Sync is on, but the first sync failed: " + r.message, !r.ok);
  await held.migrate().catch(() => {});
  renderMemory();
}

$("sync-on").addEventListener("click", async () => {
  const sy = held.syncer();
  await sy.setConf({ via: "account" });
  try {
    if (!remote?.meta) { say("Encrypting and syncing…"); return syncedNow(await sy.createLinked()); }
    if (!linked(remote.meta)) { say("Unlocking…"); const r = await sy.join($("pass").value); $("pass").value = ""; return syncedNow(r); }
    // A linked copy: this browser asks to be let in, and waits.
    const req = await sy.requestLink();
    linkCtrl = new AbortController();
    $("sync-on").hidden = true; $("link-wait").hidden = false; $("link-code").textContent = req.code; say("");
    const tick = setInterval(() => { const s = Math.max(0, Math.round((req.expires - Date.now()) / 1000)); $("link-left").textContent = "Waiting… " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " left."; if (!s || linkCtrl.signal.aborted) clearInterval(tick); }, 1000);
    $("link-wait").dataset.id = req.id;
    const r = await req.wait({ signal: linkCtrl.signal });
    clearInterval(tick);
    syncedNow(r);
  } catch (e) { if (e.code !== "cancelled") say(e.message, true); }
});

$("link-cancel").addEventListener("click", () => { linkCtrl?.abort(); renderMemory(); });
$("recovery-go").addEventListener("click", async () => {
  const sy = held.syncer();
  try { linkCtrl?.abort(); if ($("link-wait").dataset.id) await sy.declineLink($("link-wait").dataset.id); syncedNow(await sy.joinWithRecovery($("recovery").value)); }
  catch (e) { say(e.message, true); }
});
$("restart").addEventListener("click", async () => {
  if (!confirm("Start the synced copy again from this browser? It replaces what is on harmonism.io with this browser's memory; your other devices then join from this one.")) return;
  const sy = held.syncer();
  try { linkCtrl?.abort(); syncedNow(await sy.createLinked({ replace: true })); } catch (e) { say(e.message, true); }
});
$("show-recovery").addEventListener("click", async () => {
  const out = $("recovery-out");
  if (!out.hidden) { out.hidden = true; return; }
  const c = await held.syncer().recoveryCode();
  if (!c) return;
  out.textContent = c; out.hidden = false;
  say("The key itself, for the day no synced device is left. Keep it with your important papers: anyone with it and your account can read your synced memory.");
});

$("adopt").addEventListener("click", async () => {
  await held.adoptDevice();
  say("That memory is now part of yours.");
  renderMemory();
});
$("decline").addEventListener("click", async () => {
  await held.declineDevice();
  renderMemory();
});

$("sync-erase").addEventListener("click", async () => {
  if (!confirm("Delete this account's synced copy from harmonism.io? Every device that syncs with it stops syncing; each keeps its own memory. This cannot be undone.")) return;
  try { await held.syncer().erase(); say("The synced copy is deleted."); }
  catch (e) { say(e.message, true); }
  renderMemory();
});

$("sync-now").addEventListener("click", async () => {
  say("Syncing…");
  const r = await held.syncer().now();
  say(r.ok ? "Synced." : r.message || "Not synced.", !r.ok);
  renderMemory();
});

$("sync-stop").addEventListener("click", async () => {
  if (!confirm("Stop syncing in this browser? The memory here stays, and the synced copy stays for your other devices.")) return;
  await held.syncer().off();
  renderMemory();
});

load();

// ─── The practitioner's own OpenRouter key (October 24, 2026) ─────────────────
// The extension reaches OpenRouter only under an optional permission the
// practitioner grants here (manifest: optional_host_permissions); with it and a
// key, held.js answers under the key. Without it nothing changes.
const OR_ORIGIN = { origins: ["https://openrouter.ai/*"] };
const hasOR = () => chrome.permissions.contains(OR_ORIGIN).catch(() => false);
async function renderByok() {
  const key = await secrets.get("openrouter").catch(() => null);
  const allowed = await hasOR();
  $("byok-allow").hidden = allowed;
  $("byok-stop").hidden = !allowed;
  $("byok-status").textContent = key && allowed ? "Lodestone answers here under your OpenRouter key."
    : key ? "A key is kept here. Let Lodestone reach OpenRouter to answer under it."
    : allowed ? "Lodestone may reach OpenRouter; it needs a key: paste one, or let one of your devices sync it."
    : "No key here yet.";
}
$("byok-save").addEventListener("click", async () => {
  const k = $("byok-key").value.trim();
  if (!/^sk-or-[A-Za-z0-9_-]{8,}/.test(k)) { $("byok-msg").textContent = "That does not look like an OpenRouter key (it begins sk-or-)."; return; }
  await secrets.set("openrouter", k);
  $("byok-key").value = "";
  $("byok-msg").textContent = "Kept in this browser, encrypted.";
  renderByok();
});
// Called straight from the click, before anything is awaited: a browser grants a permission only to a gesture.
$("byok-allow").addEventListener("click", () => {
  chrome.permissions.request(OR_ORIGIN).then(ok => {
    $("byok-msg").textContent = ok ? "Lodestone may now reach OpenRouter." : "Not allowed: Lodestone keeps answering through harmonism.io.";
    renderByok();
  }).catch(e => { $("byok-msg").textContent = "This browser would not ask: " + (e && e.message || e); });
});
$("byok-stop").addEventListener("click", async () => {
  await chrome.permissions.remove(OR_ORIGIN).catch(() => false);
  $("byok-msg").textContent = "Lodestone answers through harmonism.io again. The key stays here until you remove it.";
  renderByok();
});
renderByok();
