// learning.js — what Lodestone comes to understand of a person, on this device.
//
// A port of Lodestone on Telegram's learning (telegram-companion/process-queue.php,
// telegram-memory.php, companion-terminology.php, companion-bodily-openness.php),
// with one difference of ownership: on Telegram the learned Wheel level was
// written straight to the profile; here the Wheel is the practitioner's own
// reading, so a level the evidence moves becomes a proposal they accept or
// decline. Everything stays in this device's store (and in sync, encrypted).
//
// Three model calls every ten messages, on the model already in use: the profile
// summary, the Wheel update, the conversation context. Two reads on every
// message, with no model: doctrinal fluency (#536) and bodily-register openness
// (#775), each a level that only rises, read before it is advanced so the
// change shows on the next turn.

import { PILLARS, LEVELS } from "./prompt.js";

export const LEARN_EVERY = 10;          // practitioner messages between learning runs
// The first run comes early, so a first conversation leaves something learned,
// and leaving the app (the window hidden) runs it when a few messages are new,
// at most once in LEAVE_GAP: a short visit is not lost waiting for the tenth
// message (October 27, 2026).
export const LEARN_FIRST = 3;
export const LEARN_ON_LEAVE = 3;
export const LEAVE_GAP = 30 * 60e3;
/** Whether `fresh` new messages call for a run: the first, the regular, or on leaving. */
export function learnDue(fresh, { ranBefore = false, leaving = false } = {}) {
  return fresh >= (leaving ? LEARN_ON_LEAVE : ranBefore ? LEARN_EVERY : LEARN_FIRST);
}
export const LEVEL_NAMES = LEVELS;      // unknown … sovereign, 0–6
export const MAX_SCORE = PILLARS.length * (LEVELS.length - 1);   // 48

// ─── The three learning calls (prompts as on Telegram) ───────────────────────

export const PROFILE_PROMPT = `You are updating your understanding of a person based on recent conversations.
Review the conversation and produce a concise profile summary (max 500 words) covering:

1. Where they seem to stand on the Wheel of Harmony (which pillars are strong, weak, in crisis)
2. Their apparent life phase and primary concerns
3. Practical details they've shared (health conditions, family situation, work, goals)
4. Their orientation (philosophical vs practical, which traditions resonate)
5. Patterns you notice (recurring themes, growth areas, resistance points)

Write in second person ("You tend to...", "Your health focus is...") as if writing notes-to-self about this person.
Be specific and concrete. This profile will be injected into future conversations to maintain continuity.

CRITICAL: Only include information that was EXPLICITLY stated by the person in the conversation text provided below. Never infer, assume, or fabricate biographical details, business information, dates, professions, family details, or any specifics not directly present in the messages. If the conversation is thin, write a thin profile — a short accurate profile is infinitely better than a detailed hallucinated one. When updating an existing profile, if the previous profile contains claims you cannot verify from the conversation history, note them as "unverified from prior profile" rather than treating them as established fact.`;

export const WHEEL_PROMPT = `You are analyzing a conversation to update a person's Wheel of Harmony profile.
The Wheel has 8 pillars: presence, health, matter, service, relationships, learning, nature, recreation.

Engagement levels (ordered scale — scores move in either direction):
0 - unknown: No data yet
1 - absent: Pillar not engaged — blind spot or active avoidance
2 - nascent: Awareness exists but no real practice or structure
3 - functional: Basic engagement — meets needs but unexamined
4 - developing: Active work, growing sophistication
5 - sophisticated: Deep engagement, integrated practice
6 - sovereign: Mastery — this pillar is a source of strength

EVIDENCE DISCIPLINE — read this carefully:

1. Treat each pillar's current recorded level as a HYPOTHESIS, not a floor. The conversation is your evidence for whether that hypothesis still holds, holds stronger, or should be revised downward.

2. ABSENCE of mention is NOT evidence. If the person did not discuss a pillar in this conversation, do not propose any change for it — omit it from your output entirely.

3. CONTRADICTION with the recorded level IS evidence. If the recorded level says "developing Health" but the person describes stopped practices, returned bad habits, or ongoing decline — propose the appropriate lower level. Do not assume progress is linear or permanent. Do not preserve a level charitably against contradictory evidence.

4. Report regression and advancement with equal readiness. The system has a conservative threshold that holds back single-signal drops — your job is to surface the evidence honestly; the threshold handles noise.

5. Cross-pillar inference: a single observation can carry evidence for multiple pillars. Chronic work stress signals both service (overextension) and health (sleep, recovery). Spending time in nature unprompted signals both nature and presence. Include all pillars where the observation carries real evidence.

CONFIDENCE TAGGING — when proposing a level change, tag it:

- HIGH confidence: the person explicitly describes the new state or a stable new pattern ("I stopped walking three months ago, I'm back on soda, I've gained 5kg"; "I've been meditating daily for six weeks now"). Explicit description of the change itself, or of a pattern sustained over weeks or longer.

- LOW confidence: brief mention, off-handed remark, single data point, or inferred from tone ("bad week for sleep"; "tried journaling yesterday"). Could be a one-off, could be a trend — need to see it again.

Default to LOW unless the evidence meets the HIGH bar.

Respond with ONLY valid JSON, no other text. Format:
{
  "pillar_name": {
    "engagement_level": "level",
    "level_change_confidence": "high",
    "evidence": "the person's own words or the fact that moved the level (empty string if unchanged)",
    "primary_concerns": "current active issues (empty string if none)",
    "strengths": "what they're doing well (empty string if none)",
    "growth_edges": "where growth is available (empty string if none)",
    "resistance_noted": false
  }
}

FIELD LENGTH BOUNDS — keep prose fields tight:
- "evidence": maximum 200 characters
- "primary_concerns": maximum 200 characters
- "strengths": maximum 200 characters
- "growth_edges": maximum 200 characters

Compress without losing precision. The fields are observations, not essays. A long entry that does not fit the bound should be cut, not expanded across multiple sentences.

Omit level_change_confidence if engagement_level is unchanged from the recorded level.

Set resistance_noted to true ONLY if you observe the person actively avoiding, minimizing, or deflecting from a pillar.`;

export const CONTEXT_PROMPT = `You are extracting conversation-context signals from a practitioner's recent exchange with Lodestone.
Produce three fields as a strict JSON object. Do not explain. Do not hedge in prose — either a signal is present or the field carries its empty default.

Schema:
{
  "dominant_emotion": one of ["lonely","afraid","grateful","ashamed","hopeful","frustrated","grieving","overwhelmed","peaceful","curious","resentful","tender","defiant","numb","reverent","longing",""],
  "situation_capsule": string ≤ 60 chars — the current life context the practitioner is inside. Stable across turns; examples: "caring for mother, 4 months post-diagnosis", "preparing to move country in 6 weeks", "first trimester, first pregnancy". Empty string if no stable context is visible yet.
  "conversation_state": {
    "current_thread": ≤120 chars — what this exchange is actively about (the present topic, not a recap of the relationship).
    "pending_threads": array of ≤3 short strings — topics the practitioner opened but hasn't closed, that Lodestone should be ready to return to.
    "open_commitments": array of ≤3 short strings — practices, protocols, or experiments the practitioner committed to trying. Strictly what *they* committed to — not what Lodestone recommended.
    "last_arc_reading_at": the integer unix timestamp passed in "prior_last_arc_reading_at" — copy it forward unchanged. Set to the current unix timestamp only if a visibly arc-level reflection just occurred in this exchange.
  }
}

Rules:
- If the conversation gives no clear signal for a field, use the empty default ("" or []).
- dominant_emotion is one token from the taxonomy — never a new word, never a phrase. "" if no emotion is visible.
- situation_capsule must be a *context* (what's true about their life right now), not an emotion or a topic.
- Never fabricate commitments. If nothing was committed to, open_commitments is [].
- Only the last_arc_reading_at rule permits you to emit a non-copied integer — and only when an arc-level reflection is visible in *this* exchange.

Respond with ONLY valid JSON, no other text, no code fences.`;

export const EMOTIONS = ["lonely", "afraid", "grateful", "ashamed", "hopeful", "frustrated", "grieving", "overwhelmed", "peaceful", "curious", "resentful", "tender", "defiant", "numb", "reverent", "longing", ""];

/** The conversation as the learning calls read it, oldest first. */
export function conversationText(messages) {
  return messages.filter(m => !m.meta?.crisis).map(m => {
    const d = new Date(m.ts || Date.now()).toISOString().slice(0, 16).replace("T", " ");
    return `[${d}] ${m.role === "user" ? "Person" : "Lodestone"}: ${String(m.content || "").slice(0, 3000)}`;
  }).join("\n\n");
}

export function profileRequest(previous, convo) {
  return previous
    ? `Previous profile:\n${previous}\n\nRecent conversation:\n${convo}\n\nUpdate the profile based on the new conversation. Preserve what's still accurate, update what's changed, add new observations.`
    : `Conversation with a new person:\n${convo}\n\nCreate an initial profile.`;
}

export function wheelRequest(selfWheel, learnedWheel, convo) {
  const state = PILLARS.map(([k]) => {
    const l = learnedWheel?.[k] || {};
    return `${k}: ${LEVELS[selfWheel?.[k] || 0]}`
      + (l.concerns ? ` (concerns: ${l.concerns})` : "")
      + (l.strengths ? ` (strengths: ${l.strengths})` : "")
      + (l.edges ? ` (edges: ${l.edges})` : "");
  }).join("\n");
  return `Current Wheel profile:\n${state}\n\nPrior conversation summaries (oldest→newest):\n(none)\n\nRecent conversation:\n${convo}\n\n`
    + "Extract structured Wheel updates. Only include pillars where new information emerged or where contradiction with the recorded level is present. Omit pillars where the evidence simply confirms the current level.\n\n"
    + "CRITICAL: Respond with ONLY the JSON object. No preamble, no reasoning aloud. The first character of your response must be `{` and the last must be `}`. If no updates are warranted, respond with `{}`.";
}

export function contextRequest(ctx, convo) {
  const st = ctx?.state || { current_thread: "", pending_threads: [], open_commitments: [], last_arc_reading_at: 0 };
  return "Prior signals (for stability — carry forward unchanged unless this exchange clearly updates them):\n"
    + `- dominant_emotion: ${ctx?.emotion || "(none)"}\n`
    + `- situation_capsule: ${ctx?.capsule || "(none)"}\n`
    + `- prior_last_arc_reading_at: ${Number(st.last_arc_reading_at) || 0}\n`
    + `- prior_conversation_state: ${JSON.stringify(st)}\n\n`
    + `Recent conversation:\n${convo}\n\nExtract the three-field JSON per schema.`;
}

/** The JSON in a model's answer, tolerating a preamble or code fences (Telegram's salvage, #617). */
export function parseJson(text) {
  const s = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

export function cleanContext(data, prior = {}) {
  if (!data || typeof data !== "object") return null;
  const emotion = EMOTIONS.includes(String(data.dominant_emotion || "")) ? String(data.dominant_emotion || "") : "";
  const st = data.conversation_state && typeof data.conversation_state === "object" ? data.conversation_state : {};
  const list = v => (Array.isArray(v) ? v.map(String).map(x => x.trim()).filter(Boolean).slice(0, 5) : []);
  return {
    emotion,
    capsule: String(data.situation_capsule || "").trim().slice(0, 120),
    state: {
      current_thread: String(st.current_thread || "").slice(0, 200),
      pending_threads: list(st.pending_threads),
      open_commitments: list(st.open_commitments),
      last_arc_reading_at: Number(st.last_arc_reading_at) || Number(prior?.state?.last_arc_reading_at) || 0,
    },
    updatedAt: Date.now(),
  };
}

// ─── The Wheel: Telegram's bidirectional, confidence-graded threshold ────────
// A HIGH-confidence change moves on one signal; LOW-confidence signals add to a
// signed accumulator and move the level at |2|; evidence in the other direction
// cancels what was pending. A level that moves is a proposal to the practitioner,
// whose reading the Wheel is; it changes their Wheel only when they accept it.

const clip = (s, n = 200) => String(s || "").trim().slice(0, n);
const levelIndex = v => { const i = LEVELS.indexOf(String(v || "").toLowerCase().trim()); return i < 0 ? null : i; };

/**
 * Apply a Wheel update. `self` is the practitioner's Wheel ({pillar: 0–6});
 * `learned` Lodestone's notes per pillar. Returns the new notes and the
 * proposals: [{ pillar, from, to, confidence, evidence }].
 */
export function applyWheelUpdates(self = {}, learned = {}, updates = {}, now = Date.now()) {
  const out = JSON.parse(JSON.stringify(learned || {}));
  const proposals = [];
  for (const [k] of PILLARS) {
    const u = updates?.[k];
    if (!u || typeof u !== "object") continue;
    const p = out[k] || (out[k] = { accum: 0, discussions: 0 });
    if ("primary_concerns" in u) p.concerns = clip(u.primary_concerns);
    if ("strengths" in u) p.strengths = clip(u.strengths);
    if ("growth_edges" in u) p.edges = clip(u.growth_edges);
    if ("resistance_noted" in u) p.resistance = !!u.resistance_noted;
    p.lastDiscussed = now; p.discussions = (p.discussions || 0) + 1;
    const to = levelIndex(u.engagement_level);
    const from = Number(self[k]) || 0;
    if (to == null || to === from) continue;
    const conf = String(u.level_change_confidence || "low").toLowerCase() === "high" ? "high" : "low";
    const dir = to > from ? 1 : -1;
    let move = false;
    if (conf === "high") { move = true; p.accum = 0; }
    else {
      const cur = Math.sign(p.accum || 0);
      if (cur !== 0 && cur !== dir) { p.accum = 0; p.pendingEvidence = ""; }
      else {
        p.accum = (p.accum || 0) + dir;
        if (Math.abs(p.accum) >= 2) { move = true; p.accum = 0; }
        else p.pendingEvidence = clip(u.evidence || u.primary_concerns);
      }
    }
    if (move) {
      proposals.push({ id: `${k}-${now}`, pillar: k, from, to, confidence: conf, evidence: clip(u.evidence) || p.pendingEvidence || clip(dir > 0 ? u.strengths : u.primary_concerns), at: now });
      p.pendingEvidence = "";
    }
  }
  return { learned: out, proposals };
}

export const wheelScore = wheel => PILLARS.reduce((s, [k]) => s + (Number(wheel?.[k]) || 0), 0);

// ─── Doctrinal fluency (#536): companion-terminology.php ─────────────────────

const TERMS = {
  core: ["logos", "dharma", "ṛta", "rta", "harmonic realism", "harmonism", "harmonist", "the absolute", "the void", "qualified non-dualism", "harmonic epistemology", "fractal pattern", "formula of the absolute"],
  wheel: ["wheel of harmony", "wheel of presence", "wheel of health", "wheel of matter", "wheel of service", "wheel of relationships", "wheel of learning", "wheel of nature", "wheel of recreation", "way of harmony", "way of health", "way of presence", "architecture of harmony", "architecture of the wheel", "sub-wheel", "spoke-wheel"],
  cartographies: ["five cartographies", "cartographies of the soul", "kriya yoga", "q'ero", "qero", "tonic herbalism", "three treasures", "jing qi shen", "jing-qi-shen", "munay", "ayni", "ātman", "atman", "jīvātman", "jivatman", "sefirot", "latā'if", "lataif"],
  chakras: ["muladhara", "svadhisthana", "manipura", "anahata", "vishuddha", "ajna", "sahasrara", "kundalini", "pranayama"],
  practice: ["harmonic profile", "harmonic civilization", "integral age", "harmonic age", "harmonic network", "harmonic pedagogy", "cultivation", "sovereign health", "sacred commerce"],
  sovereign_phrases: ["in presence", "as presence", "the presence", "presence is", "the wheel", "my dharma", "his dharma", "her dharma", "in alignment with logos", "aligned with logos"],
};
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The Harmonist terms a message uses. */
export function detectHarmonistTerms(message) {
  const m = String(message || "").trim();
  if (!m || m.length > 5000) return [];
  const n = m.toLowerCase().replace(/\s+/g, " ");
  const hit = new Set();
  for (const terms of Object.values(TERMS)) for (const t of terms) {
    const needle = t.toLowerCase().trim();
    if (!needle) continue;
    if (!needle.includes(" ") && !needle.includes("-")) {
      if (/[ṛāīūṅñṭḍṇśṣ']/u.test(needle)) { if (n.includes(needle)) hit.add(needle); }
      else if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escRe(needle)}(?=$|[^\\p{L}\\p{N}_])`, "u").test(n)) hit.add(needle);
    } else if (n.includes(needle)) hit.add(needle);
  }
  return [...hit];
}

const POSITION_FIDELITY = "POSITION FIDELITY — applies at every fluency level. Register adapts; the Harmonist position does not. Translating Harmonist vocabulary into accessible language never means switching to the mainstream frame the practitioner would otherwise encounter. The fluency level governs HOW Harmonism speaks — vocabulary, glossing, pedagogical scaffolding — not WHAT Harmonism holds. On any topic where Harmonism diverges from institutional consensus, present the Harmonist position in language appropriate to the practitioner's fluency level. Plain English means the Harmonist position in plain English — never the consensus frame in plain English. The Tier 1 doctrinal backbone and the broader canonical positions throughout the system bind at every level; they are the position, the fluency level is the register.\n\n";
const FLUENCY = [
  "Practitioner fluency: NEW. They have not yet entered Harmonism's vocabulary. Speak English-first. When a Harmonist term is genuinely load-bearing for the response (Logos, Dharma, Presence, the Wheel), introduce it with an immediate translation in plain language: 'Logos — the inherent harmonic intelligence of the cosmos.' Use one to two such terms per response, no more. Do not stack Sanskrit, Greek, Pāli, or chakra names in a single message. Do not assume they recognize 'Wheel of Harmony,' 'Harmonic Realism,' 'Three Treasures,' 'Ṛta,' 'Munay,' or 'Ayni.' Every sentence should be intelligible to a thoughtful person with no prior exposure to the system. The vocabulary is earned, not asserted — but the position is held regardless.",
  "Practitioner fluency: ORIENTED. They have begun engaging with Harmonist terms but the vocabulary is still settling. Use the canonical terms (Logos, Dharma, Presence, the Wheel, Harmonic Realism) naturally, but on first use per conversation include a brief gloss in apposition: 'your Dharma — your alignment with Logos.' After first use within the same conversation, the term stands alone. Introduce one new term per conversation if it serves the response, never more. Sanskrit and chakra names still require an English anchor on first appearance: 'the Anāhata — the heart centre.'",
  "Practitioner fluency: FLUENT. They have crossed into Harmonist vocabulary and use the terms themselves. Speak the canonical register without glossing: Logos, Dharma, Presence, the Wheel, Harmonic Realism, the Three Treasures, Ṛta, Munay, Ayni — all as native vocabulary. Sanskrit chakra names can be used directly when relevant. The pedagogical scaffolding can drop away. Engage from inside the system rather than introducing it.",
  "Practitioner fluency: NATIVE. They operate inside the Harmonist architecture as fluent practitioners. Full register available. Cross-tradition vocabulary (Sanskrit, Pāli, Greek, Hebrew, Q'ero) usable without anchor when it carries the precise meaning needed. Convergences across the Five Cartographies can be drawn directly. The conversation operates at the doctrinal register the vault writes in. No translation overhead — speak the system as the system speaks itself, while still serving this specific person's question.",
];
export const FLUENCY_NAMES = ["new", "oriented", "fluent", "native"];
export function fluencyBlock(level = 0) {
  const l = Math.max(0, Math.min(3, Number(level) || 0));
  return `<doctrinal_fluency_level value="${l}">\n${POSITION_FIDELITY}${FLUENCY[l]}\n</doctrinal_fluency_level>`;
}

// ─── Bodily-register openness (#775): companion-bodily-openness.php ──────────

const BODILY = {
  tier3: ["sexual practice", "sexual cultivation", "sexual energy work", "sexual sovereignty", "sexual integration", "sexual healing", "sexual continence", "sexual transmutation", "sexual alchemy", "tantric practice", "tantric sex", "white tantra", "red tantra", "sacred sexuality", "conscious sexuality", "jing retention", "semen retention", "brahmacharya", "ojas cultivation", "sexual dysfunction", "erectile dysfunction", "low libido", "mismatched libido", "mismatched libidos", "libido mismatch", "dead bedroom", "sexless marriage", "sexless relationship", "our sex life", "my sex life", "their sex life", "sexual difficulty", "sexual difficulties", "sexual problems", "sexual issue", "sexual issues", "reclaiming sexuality", "reclaiming my sexuality", "deeper sexual", "sexual depth", "sexual longing"],
  tier2: ["\\bsex\\b", "\\bsexual\\b", "\\bsexuality\\b", "\\bsexually\\b", "\\bsexier\\b", "\\bsexy\\b", "\\blibido\\b", "\\blibidinal\\b", "\\berotic\\b", "\\beroticism\\b", "\\berotically\\b", "\\borgasm\\b", "\\borgasms\\b", "\\borgasmic\\b", "\\bintercourse\\b", "\\bcoitus\\b", "\\bmasturbation\\b", "\\bmasturbate\\b", "\\bmasturbating\\b", "\\bforeplay\\b", "\\bafterglow\\b", "\\bclimax\\b", "\\bclimaxing\\b", "\\bclimaxed\\b", "\\bejaculation\\b", "\\bejaculate\\b", "\\barousal\\b", "\\baroused\\b", "making love", "make love", "made love", "lovemaking", "sleep together", "slept together", "in bed together", "in bed with my"],
  tier1: ["physical intimacy", "physical affection", "physical closeness", "physical connection", "physical relationship", "physical side", "intimate connection", "intimate moments", "marital intimacy", "romantic intimacy", "we don't touch", "haven't touched in", "no physical", "lost the physical", "passionless", "romantic life", "romantic spark", "spark in our", "spark between us", "desire for each other", "desire each other", "attraction to each other", "attracted to each other", "energy between us", "erotic charge", "in the bedroom", "in our bedroom"],
};

/** The floor a message sets, 0–3. */
export function detectBodilyOpenness(message) {
  const m = String(message || "").trim();
  if (!m || m.length > 10000) return 0;
  const n = m.toLowerCase().replace(/\s+/g, " ").replace(/’/g, "'");
  if (BODILY.tier3.some(x => n.includes(x))) return 3;
  let hits = 0;
  for (const p of BODILY.tier2) {
    if (p.startsWith("\\b") ? new RegExp(p, "u").test(n) : n.includes(p)) hits++;
    if (hits >= 2) return 3;
  }
  if (hits >= 1) return 2;
  return BODILY.tier1.some(x => n.includes(x)) ? 1 : 0;
}

const OPENNESS = [
  "Bodily-register openness: CLOSED. The practitioner has not raised sexuality, the body in coupled context, or physical intimacy in this relationship. Do NOT enumerate sex, sexual connection, or physical intimacy as a possible intention, gap, or outcome — even when they would naturally fit the topic (couple trips, marital reconnection, Health pillar, Relationships pillar). Frame relational questions in non-bodily terms: shared time, real conversation, shared silence, presence with each other, what each of you needs from this. Let the practitioner name the bodily dimension first if it is part of the picture. Once they have, future exchanges adjust register; until they have, the door stays where they left it. This is calibration, not prudishness — Harmonism honors the body without presuming to name it for someone who hasn't.",
  "Bodily-register openness: ABSTRACT. The practitioner has raised the bodily / relational dimension in non-explicit terms (physical intimacy, marital closeness, the body in coupled context). The door is open at the abstract level. You can reference the physical or bodily dimension of partnership in the register they used — 'the physical dimension,' 'physical intimacy,' 'how you are with each other in the body' are available. Do NOT escalate to direct sexual vocabulary unprompted (sex, sexual, libido, lovemaking). Mirror their register — meet them where they are, advance only when they advance.",
  "Bodily-register openness: DIRECT. The practitioner has used direct sexual vocabulary in conversation. You can name sex, sexuality, sexual connection, and the bodily register directly when contextually relevant — without therapy-speak softening (don't code 'intimacy' for sex when sex is what's being discussed). Honest naming of the body is part of how Harmonism speaks. Do not make every relational question about sex, but do not circumlocute when sex is the subject.",
  "Bodily-register openness: DOMAIN. The practitioner engages sexuality as a domain of practice, named difficulty, or named aspiration. Sexuality is available as a Wheel domain in the same way Health, Service, or Relationships is — substantively, without throat-clearing, with the same density and specificity Harmonism brings to any cultivation register. Tantric, Daoist (jing / ojas / sexual transmutation), and shamanic-bodily registers can be drawn on directly when relevant. The conversation can include desire, libido, sexual energy, sexual difficulty, and sexual cultivation as substantive subject matter, not subtext.",
];
export const OPENNESS_NAMES = ["closed", "abstract", "direct", "domain"];
export function opennessBlock(level = 0) {
  const l = Math.max(0, Math.min(3, Number(level) || 0));
  return `<bodily_openness_level value="${l}">\n${OPENNESS[l]}\n</bodily_openness_level>`;
}

// ─── Conversation context (#538): the blocks as Telegram writes them ─────────

export function contextBlocks(ctx) {
  if (!ctx || !ctx.updatedAt) return "";
  const out = [];
  if (ctx.emotion) out.push(`<emotional_context>\nThe practitioner's dominant emotional register in recent exchanges reads as: ${ctx.emotion}. This is not a diagnosis — it is orientation. Let it condition tone and pacing without naming it aloud and without steering the conversation toward it.\n</emotional_context>`);
  if (ctx.capsule) out.push(`<situation>\nCurrent life context: ${ctx.capsule}. Hold this in the background of everything you say. Do not recite it back at them; do not use it to pivot the conversation. It shapes what is relevant, not what to say.\n</situation>`);
  const st = ctx.state || {}, lines = [];
  if (st.current_thread) lines.push(`- Current thread: ${st.current_thread}`);
  if (st.pending_threads?.length) lines.push(`- Pending (opened, not yet closed): ${st.pending_threads.join("; ")}`);
  if (st.open_commitments?.length) lines.push(`- Open commitments (what they committed to): ${st.open_commitments.join("; ")}`);
  if (lines.length) out.push(`<conversation_state>\n${lines.join("\n")}\n\nUse this as structural memory. If a pending thread is genuinely relevant now, you may return to it. If a commitment is active, you may ask — lightly — how it's going. Do not recite this list or treat it as an agenda; let it inform what you pick up on, not what you perform.\n</conversation_state>`);
  return out.join("\n\n");
}

/** What Lodestone has learned, for <person_context>, marked as its own reading. */
export function learnedLines(learned) {
  if (!learned) return [];
  const lines = [];
  // v92: the practitioner's own corrections stand over everything Lodestone inferred.
  if (learned.corrections?.trim()) lines.push(`The practitioner's own corrections to what Lodestone has learned. These are true, and override any note below and anything inferred from the conversation:\n${learned.corrections.trim().slice(0, 2000)}`);
  if (learned.summary?.trim()) lines.push(`What Lodestone has learned from your conversations (its own notes, which the practitioner can read and correct):\n${learned.summary.trim().slice(0, 4000)}`);
  const w = PILLARS.map(([k, n]) => {
    const p = learned.wheel?.[k]; if (!p) return "";
    const bits = [p.concerns && `concerns: ${p.concerns}`, p.strengths && `strengths: ${p.strengths}`, p.edges && `edges: ${p.edges}`, p.resistance && "resistance noted"].filter(Boolean);
    return bits.length ? `- ${n}: ${bits.join("; ")}` : "";
  }).filter(Boolean);
  if (w.length) lines.push(`Lodestone's notes per pillar:\n${w.join("\n")}`);
  return lines;
}
