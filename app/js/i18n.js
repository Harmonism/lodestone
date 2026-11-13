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
// November 13, 2026: the page is translated text node by text node, each trimmed before
// it is looked up, so the 57 keys written with a space at an edge (" You need a
// harmonism.io account…", "Harmonist vocabulary: ") never matched and stayed English.
// Each is also filed under its trimmed form, unless that form has its own entry.
for (const tb of Object.values(TABLES)) for (const k of Object.keys(tb)) { const tk = k.trim(); if (tk !== k && tk && !(tk in tb)) tb[tk] = String(tb[k]).trim(); }
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
const AGO_FR = s => s === "just now" ? "à l’instant" : (s.match(/^(\d+) (min|h) ago$/) ? `il y a ${s.replace(/ ago$/, "")}` : `le ${s}`);
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
    [/^One memory across your devices(?:, as ([^,]+?))?(?:, synced (.+?))?\.$/, m => `Une seule mémoire sur vos appareils${m[1] ? `, avec ${m[1]}` : ""}${m[2] ? `, synchronisée ${AGO_FR(m[2])}` : ""}.`],
    [/^Synced memory: not synced just now \((.+)\)\.$/s, m => `Mémoire synchronisée : la synchronisation n’a pas abouti (${m[1]}).`],
    [/^Through (OpenRouter|harmonism\.io|xAI|OpenAI)$/, m => `Par ${m[1]}`],
    [/^Whisper writes them out on this device; your voice goes nowhere\. Downloaded once \(about (\d+) MB\)\.$/, m => `Whisper les transcrit sur cet appareil ; votre voix ne va nulle part. Téléchargé une seule fois (environ ${m[1]} Mo).`],
    [/^Your recordings go to (OpenRouter|harmonism\.io|xAI|OpenAI)( and the transcription service it uses \(fifteen minutes a day\)|, charged to your key), which writes them out\. Nothing to download\.$/, m => `Vos enregistrements vont à ${m[1]}${m[2].startsWith(",") ? ", aux frais de votre clé" : " et au service de transcription qu’il utilise (quinze minutes par jour)"}, qui les transcrit. Rien à télécharger.`],
    [/^· downloaded once, on first use \(about (\d+) MB\)$/, m => `· téléchargé une seule fois, à la première utilisation (environ ${m[1]} Mo)`],
    [/^· (.+), on (this device|this computer)('s GPU)?$/, m => `· ${m[1]}, sur ${m[3] ? `le GPU de ${PLACE_FR[m[2]]}` : PLACE_FR[m[2]]}`],
    [/^(.+) refused the key\. Check that it is complete and still active\.$/, m => `${m[1]} a refusé la clé. Vérifiez qu’elle est complète et toujours active.`],
    [/^(.+) refused the key: (.+)$/s, m => `${m[1]} a refusé la clé : ${m[2]}`],
    [/^The key works with (\S+)\.$/, m => `La clé fonctionne avec ${m[1]}.`],
    [/^The key works with (\S+) \((.+)\)\.$/s, m => `La clé fonctionne avec ${m[1]} (${m[2]}).`],
    [/^of (\d+)$/, m => `sur ${m[1]}`],
    [/^(\d+) articles on this device · pack of (.+)$/, m => `${m[1]} articles sur cet appareil · paquet du ${m[2]}`],
    [/^(\d+) days, to (.+?)\.?\.$/, m => `${m[1]} jours, jusqu’au ${m[2]}.`],
    [/^Lodestone asks (\d+) times? in all, week by week (.+): fewer as you go, none in the last week\. Then one closing question on (.+), and it steps away\.$/, m => `Lodestone vous interroge ${m[1]} fois en tout, semaine par semaine ${m[2]} : de moins en moins, aucune la dernière semaine. Puis une question de clôture le ${m[3]}, et il se retire.`],
    [/^(\d+) notes? Lodestone reads back(?:, (\d+) switched off)?, synced, encrypted, between your devices\.$/, m => `${m[1]} note${m[1] === "1" ? "" : "s"} que Lodestone relit${m[2] ? `, ${m[2]} désactivée${m[2] === "1" ? "" : "s"}` : ""}, synchronisée${m[1] === "1" ? "" : "s"} et chiffrée${m[1] === "1" ? "" : "s"} entre vos appareils.`],
    [/^(New|Oriented|Fluent|Native) — Lodestone uses the terms as far as you have used them yourself\.$/, m => `${{ New: "Nouveau", Oriented: "Orienté", Fluent: "Familier", Native: "Natif" }[m[1]]} — Lodestone emploie les termes autant que vous les avez employés vous-même.`],
    [/^(Closed|Abstract|Direct|Domain) — Lodestone speaks of the body and sexuality only as openly as you have\.$/, m => `${{ Closed: "Fermé", Abstract: "Abstrait", Direct: "Direct", Domain: "Par domaine" }[m[1]]} — Lodestone parle du corps et de la sexualité seulement aussi ouvertement que vous.`],
    [/^Last learned (.+?)(?: · (.+) in the last 30 days)?\.$/, m => `Dernier apprentissage : ${m[1]}${m[2] ? ` · ${m[2]} sur les 30 derniers jours` : ""}.`],
    [/^For (English|French|Spanish|Arabic|Portuguese|German); each language keeps its own choice\. (\d+) voices? on (this computer|this device)\.$/, m => `Pour ${{ English: "l’anglais", French: "le français", Spanish: "l’espagnol", Arabic: "l’arabe", Portuguese: "le portugais", German: "l’allemand" }[m[1]]} ; chaque langue garde son propre choix. ${m[2]} voix sur ${PLACE_FR[m[3]]}.`],
    // A device's line in Settings: "This device · synced 5 min ago · Lodestone 1.17.9", each part in French.
    [/^(?:This device|synced |not seen since )/, m => m.input.split(" · ").map(x => x === "This device" ? "Cet appareil" : x.startsWith("synced ") ? `synchronisé ${AGO_FR(x.slice(7))}` : x.startsWith("not seen since ") ? `pas vu depuis le ${x.slice(15)}` : x).join(" · ")],
    [/^Something failed: (.+)$/s, m => `Un problème est survenu : ${m[1]}`],
    [/^([1-6]) of 6$/, m => `${m[1]} sur 6`],
    [/^(\d+) areas are on your Wheel$/, m => `${m[1]} domaines sont dans votre Roue`],
    [/^Your Wheel: (\d+) of (\d+)$/, m => `Votre Roue : ${m[1]} sur ${m[2]}`],
    [/^(.+) is on your Wheel: (.+)$/, m => `${t(m[1])} est dans votre Roue : ${t(m[2])}`],
    [/^(.+) is on your Wheel$/, m => `${t(m[1])} est dans votre Roue`],
    [/^(.+) rises to (.+)$/, m => `${t(m[1])} monte à ${t(m[2])}`],
    [/^(.+) is now (.+), ([1-6]) of 6\. The Wheel moves both ways: it shows where things stand, it is not a verdict\.$/, m => `${t(m[1])} est maintenant à ${t(m[2])}, ${m[3]} sur 6. La Roue bouge dans les deux sens : elle montre où en sont les choses, ce n’est pas un verdict.`],
    [/^About my (.+) pillar: I want to look at where it really stands\.$/, m => `À propos de mon domaine ${t(m[1])} : je veux regarder où il en est vraiment.`],
    [/^I want to look at my practice "(.+)" with you\.$/s, m => `Je veux regarder ma pratique « ${m[1]} » avec vous.`],
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
