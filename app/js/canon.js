// canon.js — the Wisdom Canon, on this device.
//
// A port of telegram-companion/companion-reading.php (the shared reading-track
// engine) and the kind decision of reading-checkin.php, to run with no
// server: the arc, its taper, the station and the margin live in this device's
// store (and travel in sync, encrypted). It owns the covenant, the station, the
// taper and the margin, and composes no prose: the conversation does that, under
// readingBlock(). The doctrinal constraints of the PHP header hold here:
//
//   Harmonism declines textual authority. Nothing here stores or ships a
//         reading of a unit: the table of contents, the arc, the reader's notes.
//   No stored frames: nothing in the state can hold one.
//   No Qur'an track (resolveWork refuses it).
//   Self-liquidation: contact tapers on a curve fixed at covenant time. buildTaper
//         is the only writer of check-ins and runs once, when the arc is made.
//
// Dates are the practitioner's local calendar on this device.

import { CANON, PACES } from "./canon-data.js";
export { CANON, PACES };

export const SEAMS = ["text", "harmonism", "mine"];
export const CHECKIN_KINDS = ["arrival", "friction", "return", "close"];
export const CADENCES = { each_sitting: "after each sitting", twice_weekly: "twice a week", weekly: "once a week", silent: "never: the plan only" };
export const DISCUSS = { yes: "yes, raise it with me", on_demand: "only when I bring it up", no: "no, the plan only" };
const STALE_AFTER = 48 * 3600 * 1000;   // a slot more than this far past due is spent, not delivered late

export const emptyState = () => ({ arcs: [], checkins: [], progress: {}, notes: [], seq: 0 });
const nextId = st => (st.seq = (st.seq || 0) + 1) + "-" + Date.now().toString(36);

export function resolveWork(key) {
  if (["quran", "qur-an", "koran", "al-quran", "the-quran"].includes(String(key).toLowerCase())) return null;
  return CANON[key] ? { ...CANON[key], key } : null;
}

export function track(name) {
  return Object.entries(CANON).filter(([, w]) => w.track === name).map(([key, w]) => ({ ...w, key })).sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
}

// ─── dates ───────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, "0");
export const today = (now = Date.now()) => { const d = new Date(now); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parse = s => { const [y, m, d] = String(s).split("-").map(Number); return { y, m, d }; };
export function addDays(date, days) { const { y, m, d } = parse(date); const t = new Date(Date.UTC(y, m - 1, d, 12) + days * 864e5); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
export function daysBetween(a, b) { const A = parse(a), B = parse(b); return Math.round((Date.UTC(B.y, B.m - 1, B.d, 12) - Date.UTC(A.y, A.m - 1, A.d, 12)) / 864e5); }
export function timestampFor(date, hour) { const { y, m, d } = parse(date); return new Date(y, m - 1, d, Math.max(0, Math.min(23, hour)), 0, 0).getTime(); }
export function formatDate(date) { const { y, m, d } = parse(date); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }

// ─── the covenant ────────────────────────────────────────────────────────────
export const arcDays = (units, num, days) => Math.max(1, Math.ceil(units * Math.max(1, days) / Math.max(1, num)));

/** Messages per week for each week of the arc. The last week is always silent. */
export function taperSeries(weeks, cadence) {
  if (cadence === "silent" || weeks < 1) return Array(Math.max(weeks, 0)).fill(0);
  const start = cadence === "each_sitting" ? 7 : cadence === "twice_weekly" ? 2 : 1;
  if (weeks === 1) return [start];
  const s = [];
  for (let i = 0; i < weeks; i++) {
    if (i === weeks - 1) { s.push(0); continue; }
    const frac = i / (weeks - 1);
    // PHP's round() rounds halves away from zero; Math.round agrees for the positive values here.
    let v = Math.round(start * (1 - Math.pow(frac, 0.85)));
    if (i === 0) v = start;
    else if (v < 1 && frac < 0.8) v = 1;   // a floor of one until the last fifth: a taper, not an abandonment
    s.push(Math.max(v, 0));
  }
  return s;
}

/** The plan as the reader sees it before the first page: days, weeks, contact per week, the end date. */
export function preview({ units, pace_num, pace_days, cadence, discuss, start_date = today() }) {
  const c = discuss === "no" ? "silent" : cadence;
  const days = arcDays(units, pace_num, pace_days), weeks = Math.max(1, Math.ceil(days / 7));
  const series = taperSeries(weeks, c);
  return { days, weeks, series, contacts: series.reduce((a, b) => a + b, 0), end: addDays(start_date, days - 1), close: addDays(start_date, days) };
}

/** Make an arc and its taper. One active arc at a time: a new one releases the old. */
export function createArc(st, opts, now = Date.now()) {
  const workKey = opts.work_key || "custom";
  const work = workKey === "custom" ? null : resolveWork(workKey);
  if (workKey !== "custom" && !work) throw new Error("That work is not in the canon.");
  const title = String(opts.title || work?.title || "").trim() || "Untitled reading";
  const units = Math.max(1, Math.min(400, Number(opts.units || work?.units) || 1));
  const pace_num = Math.max(1, Number(opts.pace_num) || 1), pace_days = Math.max(1, Number(opts.pace_days) || 1);
  let sitting_hour = Number.isInteger(Number(opts.sitting_hour)) ? Number(opts.sitting_hour) : -1;
  if (sitting_hour < -1 || sitting_hour > 23) sitting_hour = -1;
  let cadence = CADENCES[opts.cadence] ? opts.cadence : "each_sitting";
  const discuss = DISCUSS[opts.discuss] ? opts.discuss : "yes";
  if (discuss === "no") cadence = "silent";   // honoured completely: the plan runs, contact does not
  const started_on = opts.start_date || today(now);
  const days = arcDays(units, pace_num, pace_days);
  for (const a of st.arcs) if (a.state === "active") closeArc(st, a.id, "released", now);
  const arc = {
    id: nextId(st), work_key: workKey, title, author: work?.author || opts.author || "", units, unit_label: String(opts.unit_label || work?.unit_label || "chapters"),
    pace_num, pace_days, sitting_hour, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", cadence, discuss,
    started_on, projected_end: addDays(started_on, days - 1), state: "active", closed_reason: "", created_at: now, updated_at: now,
  };
  st.arcs.push(arc);
  buildTaper(st, arc.id, now);
  return arc;
}

export const activeArc = st => [...(st.arcs || [])].reverse().find(a => a.state === "active") || null;
export const getArc = (st, id) => (st.arcs || []).find(a => a.id === id) || null;

/** `completed` is the handoff; `released` the reader stopping. Pending check-ins are cancelled either way. */
export function closeArc(st, id, reason = "completed", now = Date.now()) {
  const a = getArc(st, id); if (!a) return;
  a.state = "closed"; a.closed_reason = reason; a.updated_at = now;
  for (const c of st.checkins) if (c.arc_id === id && c.state === "pending") c.state = "cancelled";
}

// ─── the taper ───────────────────────────────────────────────────────────────
/** Materialise the arc's check-ins. Refuses to run twice for one arc; nothing else adds a slot. */
export function buildTaper(st, arcId, now = Date.now()) {
  if (st.checkins.some(c => c.arc_id === arcId)) return 0;
  const a = getArc(st, arcId); if (!a) return 0;
  const days = arcDays(a.units, a.pace_num, a.pace_days), weeks = Math.max(1, Math.ceil(days / 7));
  const series = taperSeries(weeks, a.cadence);
  // No fixed sitting hour: the check-in falls in the evening, after a day in which the reading could have happened.
  const hour = a.sitting_hour >= 0 ? Math.min(23, a.sitting_hour + 1) : 20;
  let n = 0;
  for (let w = 0; w < weeks; w++) {
    const k = series[w]; if (k < 1) continue;
    const step = 7 / k;
    for (let i = 0; i < k; i++) {
      const off = Math.floor(w * 7 + i * step);
      if (off >= days) break;
      st.checkins.push({ id: nextId(st), arc_id: arcId, kind: "arrival", week_index: w, due_at: timestampFor(addDays(a.started_on, off), hour), state: "pending", created_at: now });
      n++;
    }
  }
  // The Close fires once, the day after the last day, whatever the cadence: the handoff, not a check-in.
  st.checkins.push({ id: nextId(st), arc_id: arcId, kind: "close", week_index: weeks, due_at: timestampFor(addDays(a.started_on, days), hour), state: "pending", created_at: now });
  return n + 1;
}

export function taperRemaining(st, arcId) {
  const mine = st.checkins.filter(c => c.arc_id === arcId);
  return { pending: mine.filter(c => c.state === "pending").length, sent: mine.filter(c => c.state === "queued").length };
}

/** The earliest pending slot that has come due for the active arc (the website's pull delivery). Stale slots are spent. */
export function dueCheckin(st, now = Date.now()) {
  const a = activeArc(st); if (!a) return null;
  const due = st.checkins.filter(c => c.arc_id === a.id && c.state === "pending" && c.due_at <= now).sort((x, y) => x.due_at - y.due_at);
  for (const c of due) {
    if (c.kind !== "close" && now - c.due_at > STALE_AFTER) { c.state = "skipped"; continue; }
    return c;
  }
  return null;
}

export function markCheckin(st, id, state, kind = "") {
  const c = st.checkins.find(x => x.id === id); if (!c) return;
  c.state = state; if (kind && CHECKIN_KINDS.includes(kind)) c.kind = kind; c.delivered_at = Date.now();
}

/** Which of the four kinds a slot is: the taper fixed the slot, live state decides what fills it. */
export function decideKind(st, arc, slotKind, now = Date.now()) {
  if (slotKind === "close") return "close";
  const prog = progress(st, arc, now);
  if (prog.finished) return "close";
  if (stalledUnit(st, arc.id, now)) return "friction";
  const ret = returnCandidate(st, arc.id, prog.current);
  if (ret && prog.completed >= 3) { const sent = taperRemaining(st, arc.id).sent; if (sent > 0 && sent % 3 === 0) return "return"; }
  return "arrival";
}

// ─── the station ─────────────────────────────────────────────────────────────
export function progress(st, arc, now = Date.now()) {
  const days = arcDays(arc.units, arc.pace_num, arc.pace_days);
  const elapsed = daysBetween(arc.started_on, today(now));
  const dayIndex = Math.max(1, elapsed + 1);
  const dueUnit = Math.max(1, Math.min(arc.units, Math.floor(elapsed * arc.pace_num / arc.pace_days) + 1));
  const p = st.progress[arc.id] || {};
  const doneUnits = Object.entries(p).filter(([, v]) => v.completed_at > 0).map(([k]) => Number(k));
  const lastDone = doneUnits.length ? Math.max(...doneUnits) : 0;
  const current = Math.min(arc.units, Math.max(1, lastDone + 1));
  return { day_index: Math.min(dayIndex, days + 1), total_days: days, due_unit: dueUnit, current, completed: doneUnits.length, units: arc.units, behind: Math.max(0, dueUnit - current), finished: doneUnits.length >= arc.units };
}

/** Reference data for a unit: its number, its verified title if any, the adjacent Harmonist ground. Never a reading of it. */
export function station(arc, unit) {
  unit = Math.max(1, Math.min(arc.units, unit));
  const work = arc.work_key === "custom" ? null : resolveWork(arc.work_key);
  const t = work?.titles?.[unit - 1] || null;
  const label = String(arc.unit_label).replace(/s$/, "");
  const name = t?.[0] || "";
  return { unit_index: unit, units: arc.units, heading: `${label.charAt(0).toUpperCase()}${label.slice(1)} ${unit}${name ? ` — ${name}` : ""}`, name, native: t?.[1] || "", range: t?.[2] || "", unit_label: label, anchors: work?.anchors || [], translations: work?.translations || [], has_toc: !!work?.titles?.length };
}

export function openStation(st, arcId, unit, now = Date.now()) {
  const p = (st.progress[arcId] ||= {}); const u = (p[unit] ||= { opened_at: 0, opened_count: 0, completed_at: 0 });
  u.opened_at = now; u.opened_count++;
}

export function markRead(st, arc, unit, now = Date.now()) {
  unit = Math.max(1, Math.min(arc.units, unit));
  const p = (st.progress[arc.id] ||= {}); const u = (p[unit] ||= { opened_at: now, opened_count: 1, completed_at: 0 });
  u.completed_at = now;
  return progress(st, arc, now);
}

export function unmarkRead(st, arc, unit) { const u = st.progress[arc.id]?.[unit]; if (u) u.completed_at = 0; return progress(st, arc); }

/** Opened three or more times over more than a day and still unfinished: friction, distinct from a gap, which is not chased. */
export function stalledUnit(st, arcId, now = Date.now()) {
  const p = st.progress[arcId] || {};
  const row = Object.entries(p).map(([k, v]) => ({ unit_index: Number(k), ...v })).filter(v => !v.completed_at && v.opened_count >= 3).sort((a, b) => a.unit_index - b.unit_index)[0];
  return row && now - row.opened_at >= 864e5 ? row : null;
}

// ─── the margin ──────────────────────────────────────────────────────────────
export function addNote(st, arcId, unit, seam, body, cite = "", now = Date.now()) {
  body = String(body || "").trim().slice(0, 4000); if (!body) return null;
  const n = { id: nextId(st), arc_id: arcId, unit_index: Math.max(0, Number(unit) || 0), seam: SEAMS.includes(seam) ? seam : "mine", body, cite: String(cite || "").trim(), created_at: now };
  st.notes.push(n); return n;
}
export const notes = (st, arcId, limit = 50, unit = -1) => st.notes.filter(n => n.arc_id === arcId && (unit < 0 || n.unit_index === unit)).sort((a, b) => b.created_at - a.created_at).slice(0, limit);
export function noteCounts(st, arcId) { const o = { text: 0, harmonism: 0, mine: 0, total: 0 }; for (const n of st.notes) if (n.arc_id === arcId) { o[n.seam]++; o.total++; } return o; }
/** The reader's own most recent note from an earlier unit, for the Return check-in. Deliberately simple. */
export const returnCandidate = (st, arcId, current) => st.notes.filter(n => n.arc_id === arcId && n.seam === "mine" && n.unit_index > 0 && n.unit_index < current).sort((a, b) => b.created_at - a.created_at)[0] || null;

// ─── the instruction (readingSystemPromptBlock, verbatim in substance) ───────
export function checkinPrompt(kind, st, returnNote = null) {
  switch (kind) {
    case "friction": return `Compose a FRICTION check-in. They have opened ${st.heading} several times over more than a day without finishing it. Ask, in one or two sentences, whether the text is hard or the pace is wrong — and make plain that changing the pace is the ordinary thing to do, not a concession. Do not encourage, do not reassure, do not mention how many days it has been.`;
    case "return": return `Compose a RETURN check-in. Quote back their own earlier margin note — "${returnNote ? returnNote.body : ""}" — and ask whether what they saw there shows up in ${st.heading}. Their words, not yours. One question, then stop.`;
    case "close": return "Compose the CLOSE. The arc is finished. Ask them, without preamble, what they now think the book is about, in one sentence, without looking. Then hand them back to the text: name the second reading as the real one, suggest a different translation if the work has one worth naming, and say plainly that you are not scheduling that reading and will not be alongside it unless they ask. Do not congratulate. Do not summarise the arc. Do not offer a next book.";
    default: return `Compose an ARRIVAL check-in for ${st.heading}. One question, pointed at their own life rather than at the text, arising from what this unit is structurally doing in the work. Two sentences at most. Do not summarise the unit. Do not tell them what it means.`;
  }
}

export function readingBlock(state, arc, due = null) {
  const prog = progress(state, arc), stn = station(arc, prog.current), counts = noteCounts(state, arc.id), recent = notes(state, arc.id, 6);
  const L = ["<reading_arc>", "The practitioner is walking a reading arc with you.", `Text: ${arc.title}`,
    `Position: day ${prog.day_index} of ${prog.total_days}, ${stn.heading}, ${prog.completed} of ${prog.units} complete.`];
  if (prog.behind > 0) L.push(`They are ${prog.behind} behind the pace they set. Do not chase this. It matters only if they raise it.`);
  L.push(`Margin: ${counts.total} notes (${counts.text} text, ${counts.harmonism} harmonism, ${counts.mine} their own).`);
  if (stn.anchors.length) L.push(`Adjacent Harmonist ground for this unit: ${stn.anchors.join("; ")}. Offer it AFTER the unit is read, never before, and name it as adjacency rather than as the text's own claim.`);
  if (stn.translations.length) L.push(`Translations you may name: ${stn.translations.join("; ")}.`);
  if (recent.length) { L.push("Their most recent margin notes, newest first:"); for (const n of recent) L.push(`  [${n.seam.toUpperCase()} · unit ${n.unit_index}] ${n.body.slice(0, 300)}`); }
  L.push("", "HOW YOU ACCOMPANY A READING — this governs every reply while an arc is active:",
    "1. You supply sequence, question, and frame. You do not supply the reading.",
    "2. Harmonism declines textual authority categorically. Never say what a passage means, what it teaches, or how Harmonism reads it. When asked directly for a meaning, return the question to their own encounter with the passage, and offer the tradition's own best readers by name rather than standing in for them.",
    "3. Structural facts about the text are permitted and welcome: where a unit sits in the work's architecture, what a term is in the original, where translations diverge. That is scholarship. Reading the passage for them is not.",
    "4. Your questions point at their life, not at the text. Not \"what does this chapter argue\" — the chapter answers that.",
    "5. Ask one thing. Then stop. A reader who spends longer talking to you than reading has been badly served, and the ratio is your responsibility, not theirs.",
    "6. When they write something worth keeping, tell them to put it in the margin in their own words before it settles into yours.",
    "7. Never praise consistency, never mark a streak, never treat a missed day as a lapse. The arc is theirs.");
  if (arc.discuss === "no") L.push("8. They asked for the plan and no questions. Honour it completely: answer what they raise, volunteer nothing about the reading, ask nothing about it.");
  else if (arc.discuss === "on_demand") L.push("8. They asked you to speak about the reading only when they open it. Do not raise the arc yourself.");
  if (due) {
    L.push("", "A check-in from their taper is due and has not been delivered. Fold it into your reply to whatever they have just said — do not open with it, do not stack it on top of an answer they are waiting for, and drop it entirely if what they wrote is heavier than the reading. The instruction: "
      + checkinPrompt(due.kind, stn, returnCandidate(state, arc.id, prog.current)));
  }
  L.push("</reading_arc>");
  return L.join("\n");
}

// The merge of two devices' reading states lives in sync.js, which must stay free of feature modules
// (the browser extension copies it on its own); re-exported here for callers of canon.js.
export { mergeReading as mergeStates } from "./sync.js";
