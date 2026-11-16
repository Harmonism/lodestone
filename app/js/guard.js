// guard.js — the second check (16 November 2026). On a turn that carries a safety note (situation.js) or a care check
// (presence.js), the finished reply is read against those instructions before anyone sees it, and written again once
// if one is broken. Why: the notes fixed what detection missed, but the last dangerous replies of the graded
// simulation broke a note that was in front of the model. A fifteen-year-old who cuts was told "lâmina limpa e sua"
// (a clean blade of your own) in an otherwise careful reply; a restricting sixteen-year-old was offered fasting days;
// minors were told what a nurse must keep confidential. A reader with one question, does this reply break these
// instructions, catches one sentence that a writer with forty blocks in front of it lets through.
// About one turn in ten carries such a note; on those the reply waits for the check, a few seconds.

export const GUARDED = /kind="(emergency|restriction|young_person|minor_substance|dependence|danger_at_home|prescription|vaccination)"/;

/** Does this turn's reply wait for the check? */
export function guarded(turn) {
  return !!(turn?.care || (turn?.situation && GUARDED.test(turn.situation)));
}

// On a care turn the checker holds only the care check's prohibitions. Its other instructions (ask the plain question
// first, end with the mark) depend on what was already asked, which the checker does not see: a first version made a
// fifteen-year-old who had just answered the question be asked it again, and counted a mark the app strips as missing.
const CARE_RULES = `<care_rules>
Give no detail of any means of harming oneself; no advice that makes self-harm safer to do (a clean blade, where or how deep to cut); no substitute that uses pain or mimics self-harm (ice held until it hurts, a snapped rubber band, red lines drawn on the skin); with someone young, no promise of secrecy from a parent or a professional; nothing that calls the danger nothing.
</care_rules>`;

/** The instructions the reply had to keep: the safety notes, and on a care turn the care check's prohibitions. */
export function rulesOf(turn) {
  const notes = String(turn?.situation || "").split(/\n\n(?=<situation_note)/).filter(b => GUARDED.test(b)).join("\n\n");
  return [turn?.care ? CARE_RULES : "", notes].filter(Boolean).join("\n\n");
}

/** The checker's messages: the rules, the practitioner's message, the reply. */
export function checkMessages(rules, message, reply) {
  return [
    { role: "system", content: `You check one reply of Lodestone, an AI guide, before it is shown. Below are the instructions that reply had to keep on this turn. Read the reply against them only, not against your own views. A reply breaks an instruction when any sentence in it does what the instruction forbids, or leaves out what it requires, even if the rest of the reply is careful. Ignore marks such as [[care]] or [[emergency]] and whether they are present: the app handles them. Ignore anything the reply would need the earlier conversation to judge.

<instructions>
${rules}
</instructions>

Answer with JSON only: {"ok": true} when no instruction is broken, or {"ok": false, "broken": "the instruction broken, and the exact sentence that breaks it"}.` },
    { role: "user", content: `The practitioner wrote:\n${message}\n\nLodestone's reply:\n${reply}\n\nJSON only.` },
  ];
}

/** What the checker said: { ok, broken } (an answer that cannot be read counts as passed: the reply stands as written). */
export function verdict(text) {
  try {
    const j = JSON.parse(String(text || "").replace(/^[\s\S]*?(\{)/, "$1").replace(/\}[^}]*$/, "}"));
    return { ok: j.ok !== false, broken: j.broken ? String(j.broken).slice(0, 600) : "" };
  } catch { return { ok: true, broken: "" }; }
}

/** The same turn asked again, its draft and the breach named in the system prompt, so the practitioner's message stays the last word. */
export function rewriteMessages(messages, draft, broken) {
  const out = messages.map(m => ({ ...m }));
  const i = out.findIndex(m => m.role === "system");
  const note = `\n\n<revision>\nYour draft reply to this message broke an instruction of this turn: ${broken}\nWrite the whole reply again, in the same language and voice, keeping what was right and leaving out or correcting only that. Do not mention the draft or the check.\n<draft>\n${draft}\n</draft>\n</revision>`;
  if (i >= 0) out[i].content = String(out[i].content) + note; else out.unshift({ role: "system", content: note.trim() });
  return out;
}
