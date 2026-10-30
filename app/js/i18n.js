// i18n.js — the language of Lodestone's own words on screen (v98, October 28, 2026).
//
// The app is written in English. Rather than thread a lookup through seven thousand
// lines, the interface is translated where it is shown: every text node and every
// placeholder, title and aria-label whose whole text is a known English string is
// replaced by its translation, at start and whenever the app draws something new
// (a MutationObserver). What the practitioner and Lodestone write is never touched:
// message bodies, articles, the life book and every field a person types into are
// skipped. A string missing from the table stays English, so nothing breaks.
// Strings built with values (a greeting with a name) go through t() or PATTERNS.
//
// Choice: Settings → Display → App language (S.settings.uiLang): "auto" follows the
// phone's language, then the reply language when it is set to French.

import { FR } from "./i18n-fr.js";

const TABLES = { fr: FR };
let LANG = "en";
let table = null;

export const uiLang = () => LANG;

/** Resolve the setting to a language the app has a table for. */
export function resolve(pref = "auto", replyLang = "auto") {
  if (pref && pref !== "auto") return TABLES[pref] ? pref : "en";
  const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]).map(l => String(l).slice(0, 2).toLowerCase());
  if (TABLES[langs[0]]) return langs[0];
  if (replyLang && TABLES[replyLang]) return replyLang;
  return "en";
}

/** One string, translated when the table has it. */
export function t(s) {
  if (!table || s == null) return s;
  const k = String(s);
  if (table[k] != null) return table[k];
  for (const [re, fn] of PATTERNS[LANG] || []) { const m = k.match(re); if (m) return fn(m); }
  return k;
}

// Strings made with values. Each returns the translation or null.
const FR_PART = { "Good morning": "Bonjour", "Good afternoon": "Bon après-midi", "Good evening": "Bonsoir", "Good night": "Bonne nuit" };
const PLACE_FR = { "this device": "cet appareil", "this computer": "cet ordinateur", "your computer": "votre ordinateur" };
const PATTERNS = {
  fr: [
    [/^(Good morning|Good afternoon|Good evening|Good night)(?:, (.+))?\.$/, m => `${FR_PART[m[1]]}${m[2] ? `, ${m[2]}` : ""}.`],
    [/^Delete “(.+)” from this device\?$/, m => `Supprimer « ${m[1]} » de cet appareil ?`],
    [/^(\d+) messages?$/, m => `${m[1]} message${m[1] === "1" ? "" : "s"}`],
    [/^\((\d+) chosen\)$/, m => `(${m[1]} choisi${m[1] === "1" ? "" : "s"})`],
    [/^(.+) — ends (.+), (\d+) openings? left $/, m => `${m[1]} — prend fin le ${m[2]}, ${m[3]} ouverture${m[3] === "1" ? "" : "s"} restante${m[3] === "1" ? "" : "s"} `],
    [/^No link made: (.+)$/, m => `Aucun lien créé : ${t(m[1])}`],
    [/^Not revoked: (.+)$/, m => `Non révoqué : ${t(m[1])}`],
    [/^thinks on (.+)$/, m => `réfléchit via ${PLACE_FR[m[1]] || m[1]}`],
    [/^waking on (.+)…$/, m => `réveil via ${PLACE_FR[m[1]] || m[1]}…`],
    [/^Something failed: (.+)$/s, m => `Un problème est survenu : ${m[1]}`],
    [/^([1-6]) of 6$/, m => `${m[1]} sur 6`],
    [/^(\d+) areas are on your Wheel$/, m => `${m[1]} domaines sont dans votre Roue`],
  ],
};

const SKIP = "#chat .msg .body, .prose, .reader, [contenteditable], code, pre, .no-i18n, .lb-note-body, .pin-line, .thread-list .t-title, #profileView, .row-menu-info, .msg-files, .sources";
const ATTRS = ["placeholder", "title", "aria-label"];
const lead = /^\s*/, trail = /\s*$/;

function skip(node) {
  const e = node.nodeType === 1 ? node : node.parentElement;
  return !e || !!e.closest(SKIP);
}
function swapText(n) {
  const raw = n.nodeValue; if (!raw || !/[A-Za-z]/.test(raw)) return;
  const key = raw.trim(); if (!key) return;
  const out = t(key);
  if (out !== key) n.nodeValue = raw.match(lead)[0] + out + raw.match(trail)[0];
}
function swapAttrs(e) {
  for (const a of ATTRS) {
    const v = e.getAttribute(a); if (!v) continue;
    const out = t(v.trim()); if (out !== v.trim()) e.setAttribute(a, out);
  }
}
/** Translate everything under a node (the node included). */
export function translate(root = document.body) {
  if (!table || !root) return;
  if (root.nodeType === 3) { if (!skip(root)) swapText(root); return; }
  if (root.nodeType !== 1 || skip(root)) return;
  swapAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeType === 1 && n.matches(SKIP)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? swapText(n) : swapAttrs(n);
}

let observer = null;
/** Set the language; translate the page now and whatever the app draws later. */
export function setLanguage(lang) {
  const next = TABLES[lang] ? lang : "en";
  const was = LANG;
  LANG = next; table = TABLES[next] || null;
  document.documentElement.lang = next;
  if (!table) { observer?.disconnect(); observer = null; return was !== next; }
  translate(document.body);
  if (!observer) {
    observer = new MutationObserver(list => {
      for (const r of list) {
        if (r.type === "childList") r.addedNodes.forEach(n => translate(n));
        else if (r.type === "characterData") { if (!skip(r.target)) swapText(r.target); }
        else if (r.type === "attributes" && !skip(r.target)) swapAttrs(r.target);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  return was !== next;
}
