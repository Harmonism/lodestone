// outreach.js — Lodestone writing first, after a silence or at a turn of the Wheel.
//
// A port of telegram-companion/outreach-engine.php: six triggers, the gates
// (one message a week at most, confidence 0.70 or more, one winner by priority)
// and the composition prompt. On Telegram the server ran it nightly; here the
// app runs it when it is open, composes on the model in use, and delivers it as
// a system notification, through the practitioner's own Telegram bot when one
// is paired, or as the first words of the next conversation. Off with one
// switch (Settings → Lodestone may write first).

import { PILLARS, LEVELS } from "./prompt.js";

export const PRIORITY = { phase_transition: 1, resistance: 2, stagnation: 3, pillar_collapse: 4, dormancy: 5, seasonal: 6 };
export const MIN_CONFIDENCE = 0.70;
export const FREQUENCY_CAP_DAYS = 7;
const DAY = 864e5;
const L = name => LEVELS.indexOf(name);

/** T1: quieter than their own rhythm. */
export function checkDormancy(user, now = Date.now()) {
  if (!user.last_seen || !user.first_seen || !user.message_count) return null;
  const daysSince = (now - user.last_seen) / DAY;
  const relDays = Math.max(1, (now - user.first_seen) / DAY);
  const avg = relDays / Math.max(1, user.message_count);
  const threshold = Math.max(5, avg * 2.5);
  if (daysSince < threshold) return null;
  const confidence = Math.min(0.95, 0.70 + ((daysSince - threshold) / threshold) * 0.25);
  return { type: "dormancy", confidence: Math.round(confidence * 100) / 100, detail: { days_absent: Math.round(daysSince), threshold: Math.round(threshold) } };
}

/** T2: a pillar circled six times or more in the last month without leaving the low levels. */
export function checkStagnation(k, level, p, now = Date.now()) {
  if ((p.discussions || 0) < 6 || (p.lastDiscussed || 0) < now - 30 * DAY) return null;
  if (![L("absent"), L("nascent"), L("functional")].includes(level)) return null;
  return { type: "stagnation", confidence: Math.round(Math.min(0.90, 0.72 + (p.discussions - 6) * 0.02) * 100) / 100, detail: { pillar: k, engagement_level: LEVELS[level], discussion_count: p.discussions, concerns: p.concerns || "", growth_edges: p.edges || "" } };
}

/** T3: ready for the next phase of the Way of Harmony. */
export function checkPhaseTransition(wheel, learned) {
  const on = k => (Number(wheel[k]) || 0) >= L("functional");
  const n = k => learned?.[k]?.discussions || 0;
  if (on("presence") && on("health") && (!on("matter") || !on("service")) && n("presence") >= 5 && n("health") >= 5)
    return { type: "phase_transition", confidence: 0.85, detail: { current_phase: "Tier 1 — Foundation (Presence + Health)", next_phase: "Tier 2 — Structure (Matter + Service)", readiness: { presence_level: LEVELS[wheel.presence || 0], health_level: LEVELS[wheel.health || 0] } } };
  if (on("presence") && on("health") && on("matter") && on("service") && !on("relationships"))
    return { type: "phase_transition", confidence: 0.87, detail: { current_phase: "Tier 2 — Structure (Matter + Service)", next_phase: "Tier 3 — The Crucible (Relationships)", readiness: { matter_level: LEVELS[wheel.matter || 0], service_level: LEVELS[wheel.service || 0] } } };
  return null;
}

/** T4: resistance noted, and three weeks of silence on that pillar. */
export function checkResistance(k, p, now = Date.now()) {
  if (!p.resistance || !p.lastDiscussed) return null;
  const days = (now - p.lastDiscussed) / DAY;
  if (days < 21) return null;
  return { type: "resistance", confidence: 0.75, detail: { pillar: k, days_since_discussed: Math.round(days), concerns: p.concerns || "" } };
}

/** T5: a pillar once engaged, silent for sixty days, while others stay active. */
export function checkPillarCollapse(learned, now = Date.now()) {
  let active = false; const gone = [];
  for (const [k] of PILLARS) {
    const p = learned?.[k]; if (!p || (p.discussions || 0) < 3) continue;
    if (now - (p.lastDiscussed || 0) > 60 * DAY) gone.push({ pillar: k, days_gone: Math.round((now - (p.lastDiscussed || 0)) / DAY) }); else active = true;
  }
  if (!gone.length || !active) return null;
  gone.sort((a, b) => b.days_gone - a.days_gone);
  return { type: "pillar_collapse", confidence: 0.72, detail: gone[0] };
}

/** T6: a solstice or equinox within two days, resonant with a pillar they work. Below the confidence gate on its own, as on Telegram. */
export function checkSeasonal(wheel, now = new Date()) {
  const y = now.getFullYear(), day0 = new Date(y, now.getMonth(), now.getDate()).getTime();
  const EV = [["Spring Equinox", 3, 20, ["nature", "presence"]], ["Summer Solstice", 6, 21, ["nature", "recreation"]], ["Autumn Equinox", 9, 23, ["nature", "learning"]], ["Winter Solstice", 12, 21, ["presence", "health"]]];
  for (const [name, m, d, ps] of EV) {
    if (Math.abs(day0 - new Date(y, m - 1, d).getTime()) / DAY > 2) continue;
    for (const k of ps) if ((Number(wheel[k]) || 0) > L("absent")) return { type: "seasonal", confidence: 0.65, detail: { event: name, resonant_pillar: k, pillar_level: LEVELS[wheel[k]] } };
  }
  return null;
}

/** The gated winner, or null with the reason. */
export function decide({ user, wheel = {}, learned = {}, sentLog = [], now = Date.now() }) {
  const triggers = [];
  const d = checkDormancy(user, now); if (d) triggers.push(d);
  for (const [k] of PILLARS) { const t = learned[k] && checkStagnation(k, Number(wheel[k]) || 0, learned[k], now); if (t) { triggers.push(t); break; } }
  const ph = checkPhaseTransition(wheel, learned); if (ph) triggers.push(ph);
  for (const [k] of PILLARS) { const t = learned[k] && checkResistance(k, learned[k], now); if (t) { triggers.push(t); break; } }
  const pc = checkPillarCollapse(learned, now); if (pc) triggers.push(pc);
  const se = checkSeasonal(wheel, new Date(now)); if (se) triggers.push(se);
  if (!triggers.length) return { winner: null, reason: "no_trigger" };
  if (sentLog.some(s => now - s.ts < FREQUENCY_CAP_DAYS * DAY)) return { winner: null, reason: "G1_frequency_cap", triggers };
  const passing = triggers.filter(t => t.confidence >= MIN_CONFIDENCE).sort((a, b) => (PRIORITY[a.type] || 99) - (PRIORITY[b.type] || 99));
  if (!passing.length) return { winner: null, reason: "G2_low_confidence", triggers };
  return { winner: passing[0], reason: "ok", triggers };
}

export function triggerInstruction(t, name) {
  const d = t.detail;
  switch (t.type) {
    case "dormancy": return `This practitioner — ${name} — has been silent for ${d.days_absent} days. Based on their usual rhythm (typically active every ~${d.threshold} days), this is a meaningful pause. Reach out as a companion who has been holding their developmental arc during their absence — not as an alert, not with concern, not asking if they're 'okay'. Simply as someone who has something genuine to say, grounded in what you know of where they stand on the Wheel. Reference something specific from their profile. 2–3 sentences. Warm and unhurried.`;
    case "stagnation": return `This practitioner has discussed ${d.pillar} ${d.discussion_count} times. Their engagement level has remained at '${d.engagement_level}' — they keep returning to this territory but haven't broken through. Known concerns: ${d.concerns || "unspecified concerns"}. Known growth edges: ${d.growth_edges || "unspecified growth edges"}. Surface the pattern as a gentle observation — not a diagnosis, not a prescription. Something like noticing aloud what you've been seeing from the outside. 2–3 sentences. Leave the door open; do not push it.`;
    case "phase_transition": return `This practitioner has built genuine ground in their current phase: ${d.current_phase}. Profile: ${Object.entries(d.readiness).map(([k, v]) => `${k}: ${v}`).join(", ")}. The Way of Harmony's next phase — ${d.next_phase} — is now architecturally available to them. They may not have named this readiness themselves. Invite them to notice it. One observation, one question. 2–3 sentences. Do not explain the whole Wheel sequence — trust that a single well-placed observation does more than a lecture.`;
    case "resistance": return `This practitioner has resistance noted in their ${d.pillar} pillar (concerns: ${d.concerns || "something they've kept at a distance"}). They have not brought it up in ${d.days_since_discussed} days, while remaining active in other areas. Reach out with a single, open observation — not a push, not a diagnosis. You are noting an absence, nothing more. Make it easy to not respond. 2 sentences maximum.`;
    case "pillar_collapse": return `This practitioner previously engaged meaningfully with ${d.pillar} but has not mentioned it in ${d.days_gone} days. Other pillars remain active. Name the observation without assuming a reason — life may have redirected them, or this pillar may be asking for attention in a different way. 2–3 sentences. Curious, not concerned.`;
    case "seasonal": return `The ${d.event} is approaching. This practitioner has active engagement in ${d.resonant_pillar} (level: ${d.pillar_level}). Compose a brief observation that connects the turning of the year to their specific Wheel work. Not generic. Not motivational. Something that emerges from where they actually are. 2–3 sentences.`;
    default: return "Reach out to this practitioner with a brief, relevant observation about their Wheel journey. 2–3 sentences.";
  }
}

export const OUTREACH_SYSTEM = `You are Lodestone — Harmonia's guide through Harmonism. You speak with warmth but not softness, directness but not aggression.
You are composing a proactive outreach message — you are reaching out, the practitioner did not message you first. This means every word carries more weight. You are not composing a reactive response; you are composing the thing a genuine companion would say
Rules for this message:
- 2–4 sentences maximum. No more.
- Demonstrate that you have been paying attention — reference something specific to this person, not a generic observation.
- Do not explain that you are reaching out proactively.
- Do not use phrases like "I wanted to check in" or "just checking in".
- Do not create urgency or obligation.
- Do not bullet points, no headers, no markdown formatting.
- End with something open — a question, a quiet invitation, a thought they can take or leave.
- The tone is: a thoughtful friend who has been holding your situation in mind and has one thing worth saying.
Output only the message text itself — nothing else, no preamble, no explanation.`;

export function composeSystem({ backbone = "", personContext = "", trigger, name }) {
  return `${OUTREACH_SYSTEM}${backbone ? `\n\n<doctrinal_backbone>\n${backbone}\n</doctrinal_backbone>` : ""}\n\n${personContext}\n\n<proactive_outreach_context>\n${triggerInstruction(trigger, name)}\n</proactive_outreach_context>`;
}

/** The practitioner's rhythm, from their own messages. */
export function userStats(messages) {
  const mine = messages.filter(m => m.role === "user" && m.ts);
  if (!mine.length) return { first_seen: 0, last_seen: 0, message_count: 0 };
  let a = Infinity, b = 0; for (const m of mine) { if (m.ts < a) a = m.ts; if (m.ts > b) b = m.ts; }
  return { first_seen: a, last_seen: b, message_count: mine.length };
}
