// hp.js — the Harmonic Profile code (HP::…) the assessment on harmonism.io
// gives for pasting into Lodestone. Port of the Telegram bot's parser
// (telegram-companion/telegram-bot.php), so a practitioner who took the
// assessment can carry the result into Lodestone on their own computer: the
// Wheel reading fills from it and the summary joins what Lodestone knows.

const PILLARS = ["presence", "health", "matter", "service", "relationships", "learning", "nature", "recreation"];
// The Wheel's seven-level scale; index into prompt.js LEVELS.
function levelOf(f, d) {
  const avg = (f + d) / 2;
  if (avg >= 8.5) return 6; if (avg >= 7) return 5; if (avg >= 5) return 4;
  if (avg >= 3) return 3; if (avg >= 1.5) return 2; return 1;
}

export const isHPCode = text => /^HP::[A-Za-z0-9+/=]+$/.test(String(text || "").trim());

/** Returns { wheel, summary } or throws when the code is not a readable profile. */
export function parseHP(text) {
  let p;
  try {
    const b64 = String(text).trim().slice(4);
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    p = JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new Error("This Harmonic Profile code could not be read. Copy it again from the end of the assessment."); }
  if (!p || ![1, 2].includes(p.v)) throw new Error("This Harmonic Profile code is from a version Lodestone does not know.");
  const wheel = {}, lines = [];
  for (const k of PILLARS) {
    const s = p.w?.[k];
    if (!Array.isArray(s) || s.length < 2) continue;
    const f = Number(s[0]), d = Number(s[1]);
    wheel[k] = levelOf(f, d);
    lines.push(`${k[0].toUpperCase() + k.slice(1)} F=${f}/10 D=${d}/10${f > d + 2 ? " (functional outpaces developmental)" : d > f + 2 ? " (growth edge)" : ""}`);
  }
  let summary = `Altitude ${p.alt ?? "?"}/10. Wheel: ${lines.join("; ")}.`;
  if (!p.sk?.e && p.e) summary += `\nEnneagram: ${p.e.t}w${p.e.w} ${p.e.i} (health ${p.e.h}/5).`;
  else summary += "\nEnneagram: not completed — do not infer type.";
  const DOSHA = { V: "Vata", P: "Pitta", K: "Kapha" }, WX = { Wd: "Wood", F: "Fire", E: "Earth", Mt: "Metal", Wt: "Water" };
  if (!p.sk?.c && p.c) {
    const y = Number(p.c.y || 0);
    summary += `\nConstitution: ${DOSHA[p.c.d?.dominant] || p.c.d?.dominant || "?"} (${p.c.d?.V}%V/${p.c.d?.P}%P/${p.c.d?.K}%K), ${WX[p.c.x] || p.c.x || "?"}, ${y < -0.5 ? "Yin-dominant" : y < 0 ? "slightly Yin" : y > 0.5 ? "Yang-dominant" : "slightly Yang"}, Jing ${p.c.jl ?? "?"} (${p.c.j ?? "?"}/10).`;
  } else summary += "\nConstitution: not completed — do not infer.";
  if (p.bio) {
    const b = p.bio, bits = [b.g, b.a && `age ${b.a}`, b.p, b.rel, b.ch && `children: ${String(b.ch).replace("yes-", "")}`, b.work && `work: ${String(b.work).replace(/-/g, " ")}`, b.loc && `country: ${b.loc}`].filter(Boolean);
    if (bits.length) summary += `\nAbout them: ${bits.join(", ")}.`;
    if (b.note) summary += `\nIn their words: ${String(b.note).slice(0, 500)}`;
  }
  if (p.intent) {
    const i = p.intent;
    if (i.goals) summary += `\nGoals: ${String(i.goals).slice(0, 500)}`;
    if (i.challenge) summary += `\nBiggest challenge: ${String(i.challenge).slice(0, 500)}`;
    if (i.resolve) summary += `\nWants to resolve: ${String(i.resolve).slice(0, 500)}`;
    if (Array.isArray(i.style) && i.style.length) summary += `\nPreferred coaching style: ${i.style.join(", ")}`;
  }
  return { wheel, summary, country: p.bio?.loc || null };
}
