// safety.js — deterministic gates that run before any model sees a message.
// Libraries come from the corpus pack, parsed at build time from the production PHP
// (crisis-patterns.json, companion-crisis-detector.php, companion-classifier.php),
// so the offline companion and the live one share one source of truth.

const LANGS = ["en", "fr", "es", "ar"];
// One form for the message and the patterns alike (1.13.1): accents and Arabic
// marks (harakat, hamza seats, tatweel) gone, the alif and ya forms folded,
// typographic apostrophes (an iPhone's ’) made plain. Without it "I’m going to
// kill myself", typed on a phone, matched none of the patterns.
// Apostrophes first: NFKD makes "´" a space and an accent, and the accent goes.
export const normalize = s => String(s || "").replace(/[’‘ʼ´`]/g, "'").normalize("NFKD").replace(/\p{M}/gu, "")
  .replace(/\u0640/g, "").replace(/[ٱ]/g, "ا").replace(/ى/g, "ي").toLowerCase().replace(/\s+/gu, " ").trim();

export function detectLang(text, preferred = "auto") {
  if (preferred !== "auto" && LANGS.includes(preferred)) return preferred;
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  const words = normalize(text).replace(/[’]/g, "'").split(/[^\p{L}']+/u);
  const FR = new Set("je j' tu vous il elle est suis sommes les des une un pas ne pour avec mon ma mes ton ta c'est qu' que qui être très veux peux dans sur mais aussi comment pourquoi quoi moi me".split(" "));
  const ES = new Set("yo tú usted él ella está estoy soy los las una por para con mi mis tu qué que quién muy pero cómo por qué quiero puedo también ya no".split(" "));
  // "me" is French and English: with English's commonest words here too, "everyone would be better off without me" reads as English (1.13).
  const EN = new Set("i you he she the is am are and with my your what how why this that it's i'm want can not me be would to of a an in on for we was were have has do don't off without just so but if all they them there feel been will could should".split(" "));
  let fr = 0, es = 0, en = 0;
  for (const w of words) {
    if (!w) continue;
    if (FR.has(w) || w.startsWith("j'") || w.startsWith("c'") || w.startsWith("qu'") || w.startsWith("n'") || w.startsWith("l'")) fr++;
    if (ES.has(w)) es++;
    if (EN.has(w)) en++;
  }
  if (/[ñ¿¡]/.test(text)) es += 2;
  if (/[çœ]|[àèù]\b/.test(text)) fr += 1;
  if (fr > en && fr >= es && fr >= 1) return "fr";
  if (es > en && es > fr && es >= 1) return "es";
  return "en";
}

/** Port of detectCrisis(). Production checks the detected language plus English; offline language
 *  detection is heuristic, so every language's patterns are checked and the reply follows the
 *  language of the pattern that matched. A missed crisis costs more than a wrong-language template. */
export function detectCrisis(message, lang, library) {
  if (!message) return null;   // no upper bound (1.13.1): a long journal ending in a crisis is read to its end
  const n = normalize(message);
  const order = [lang, ...LANGS.filter(l => l !== lang)].filter(l => LANGS.includes(l));
  for (const [category, def] of Object.entries(library.patterns.categories || {})) {
    for (const l of order) {
      for (const p of (def.patterns && def.patterns[l]) || []) {
        const needle = normalize(p);
        if (needle && n.includes(needle)) return { category, severity: def.severity || "high", lang: l };
      }
    }
  }
  return null;
}

/** Port of buildCrisisResponse(): deterministic template, regional line when the country is known. */
export function buildCrisisResponse(category, country, lang, library) {
  const key = LANGS.includes(lang) ? lang : "en";
  const table = library.resources || {};
  const res = country ? table[String(country).toUpperCase().trim()] : null;
  const befrienders = "Befrienders Worldwide — https://www.befrienders.org (find a helpline in your country)";
  let block;
  if (res) {
    const em = key === "fr" ? `Urgences : ${res.emergency}` : key === "es" ? `Emergencias: ${res.emergency}` : key === "ar" ? `الطوارئ: ${res.emergency}` : `Emergency: ${res.emergency}`;
    block = `📞 ${res.name}:\n• ${res.hotline}\n• ${em}`;
  } else {
    const label = key === "fr" ? "Lignes d'écoute internationales :" : key === "es" ? "Líneas de escucha internacionales:" : key === "ar" ? "خطوط استماع دوليّة:" : "International helplines:";
    block = `📞 ${label}\n• ${befrienders}`;
  }
  const cat = library.templates[category] || library.templates.active_suicidal_ideation;
  return (cat[key] || cat.en).replace("%RESOURCE%", block);
}

/**
 * The crisis line alone (1.13), for a care moment the second layer found
 * (care.js): shown by the app beneath the model's answer, never written by it.
 */
export function crisisLine(country, lang, library) {
  const key = LANGS.includes(lang) ? lang : "en";
  const res = country ? (library.resources || {})[String(country).toUpperCase().trim()] : null;
  const lead = {
    en: "If you are thinking of ending your life or of harming yourself, please speak with someone now:",
    fr: "Si vous pensez à mettre fin à vos jours ou à vous faire du mal, parlez-en à quelqu'un maintenant :",
    es: "Si estás pensando en quitarte la vida o en hacerte daño, habla con alguien ahora:",
    ar: "إذا كنت تفكر في إنهاء حياتك أو إيذاء نفسك، تحدث إلى أحد الآن:",
  }[key];
  const em = res ? ({ fr: "Urgences", es: "Emergencias", ar: "الطوارئ" }[key] || "Emergency") : null;
  const line = res ? `📞 ${res.name}: ${res.hotline}${em ? ` · ${em}: ${res.emergency}` : ""}` : "📞 Befrienders Worldwide — https://www.befrienders.org (a helpline in your country)";
  return `${lead}\n${line}`;
}

/** Port of detectWitnessMode(): acute activation markers; 2+ distinct = strong. All languages checked. */
export function detectWitness(message, lang, patterns) {
  if (!message) return null;   // no upper bound (1.13.1): a long journal ending in a crisis is read to its end
  const n = normalize(message);
  const pats = LANGS.flatMap(l => patterns[l] || []);
  const markers = [...new Set(pats.filter(p => { const s = normalize(p); return s && n.includes(s); }))];
  if (!markers.length) return null;
  return { strength: markers.length >= 2 ? "strong" : "moderate", markers: markers.slice(0, 5) };
}

// Witness block text carried from companion-api.php (witness_mode_active), trimmed of
// production-only references (the 15-message counter).
export function witnessBlock(strength) {
  return `<witness_mode_active strength="${strength}">
This person's most recent message carries acute emotional activation — fresh grief, overwhelm, rupture, trauma, or severe distress. Right now they need to be witnessed, not reframed.
For this response (and likely the next 2–4 exchanges, until the activation softens):
• Mirror the emotional content back clearly and simply. Let them feel met.
• Ask at most ONE gentle, open clarifying question if something is unclear. Often no question is the right move — presence is enough.
• Do NOT reach for Logos, Dharma, the Wheel, Harmonic Realism, or any doctrinal vocabulary. Do NOT offer architecture. Do NOT assign practices or protocols.
• Do NOT problem-solve, sequence, or reframe.
• Speak plainly. Short paragraphs. Human sentences. No bullet points. No headers. No bold emphasis.
When the activation softens — their sentences lengthen, they begin asking what is happening, they reach for understanding rather than relief — Harmonism's architecture can begin to surface, still gently.
</witness_mode_active>`;
}

/** Soft governor: bands on messages in the last 24 hours. Offline has no tiers, so no caps. */
export function governorBlock(count24h) {
  if (count24h >= 20) {
    return `<engagement_band value="substitution_risk">The practitioner has sent ${count24h} messages in the last day. Answer fully, then close with one plain sentence that returns them to their own ground — the practice, the body, the people who require them. Invite nothing further.</engagement_band>`;
  }
  if (count24h >= 10) {
    return `<engagement_band value="frequent">Answer fully. Do not end with an invitation to elaborate or continue.</engagement_band>`;
  }
  return "";
}
