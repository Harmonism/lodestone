// profileview.js — the Harmonic Profile as a page of Lodestone's own.
//
// Drawn on this device from the practitioner's memory: the Wheel as it stands
// now (it redraws when the Wheel moves), the assessment's code (Enneagram,
// constitution, altitude), and what Lodestone has noted per pillar. Printable,
// so "Save as PDF" is the system's print dialog. Ported from
// harmonia-astro/member/templates/harmonic-profile-data.php, whose prose tables
// it carries; the server render (member/profile-render.php) stays for pages
// that still post to it.
//
// What was given rather than measured (a type or constitution the
// practitioner knows) is said so; nothing is inferred that was not given.

const PILLARS = ["presence", "health", "matter", "service", "relationships", "learning", "nature", "recreation"];
const NAMES = { presence: "Presence", health: "Health", matter: "Matter", service: "Service", relationships: "Relationships", learning: "Learning", nature: "Nature", recreation: "Recreation" };
const LEVELS = ["unknown", "absent", "nascent", "functional", "developing", "sophisticated", "sovereign"];
const RING = ["recreation", "nature", "relationships", "matter", "health", "service", "learning"];   // the canonical figure, clockwise from the top
const COLORS = { presence: "#9B3DBE", health: "#4A9D5A", matter: "#DAA520", service: "#4A7BA7", relationships: "#E97A8F", learning: "#6B5BB5", nature: "#3A8A4A", recreation: "#E07B39" };

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ─── Enneagram ───────────────────────────────────────────────────────────────

const TYPE_NAMES = { 1: "The Reformer", 2: "The Helper", 3: "The Achiever", 4: "The Individualist", 5: "The Investigator", 6: "The Loyalist", 7: "The Enthusiast", 8: "The Challenger", 9: "The Peacemaker" };
const WINGS = {
  "1w9": "the contemplative edge: principled discernment tempered by patient equanimity.",
  "1w2": "the reformer with a helper edge: conviction expressed through service to others.",
  "2w1": "the servant edge: generosity disciplined by integrity and purpose.",
  "2w3": "the hostess edge: warmth sharpened by ambition and visible competence.",
  "3w2": "the charmer edge: drive rendered personable through relational attunement.",
  "3w4": "the professional edge: achievement deepened by introspection and distinctiveness.",
  "4w3": "the aristocrat edge: interiority channelled into polished, public expression.",
  "4w5": "the artisan edge: interiority sharpened by aesthetic intensity, prone to melancholy, capable of rare depth.",
  "5w4": "the artisan edge: interiority sharpened by aesthetic intensity, prone to melancholy, capable of rare depth.",
  "5w6": "the problem-solver edge: analysis anchored by loyalty to system and fellow investigator.",
  "6w5": "the defender edge: vigilance fortified by analytical rigour.",
  "6w7": "the buddy edge: vigilance softened by enthusiasm and optionality.",
  "7w6": "the entertainer edge: optionality anchored by loyalty and fellowship.",
  "7w8": "the realist edge: optionality hardened by appetite and decisive action.",
  "8w7": "the maverick edge: force leavened by appetite for life and fresh angles.",
  "8w9": "the bear edge: force grounded in patient, unhurried presence.",
  "9w8": "the referee edge: equanimity tempered by decisive capacity when called.",
  "9w1": "the dreamer edge: equanimity refined by principle and ordered vision.",
};
const FIXATIONS = {
  1: { name: "perfection", compulsion: "the compulsion to correct — the refusal to leave reality as it is, treating every surface as a site of reform.", to: 7, toName: "the Enthusiast", growth: "the willingness to let life happen without fixing it, to trust the unfolding, to release the grip of ought.", pillar: "Recreation" },
  2: { name: "pride in giving", compulsion: "the compulsion to be needed — attending to others as a way of remaining unseen yourself, trading self-knowledge for relational safety.", to: 4, toName: "the Individualist", growth: "the turn inward to what is particular, idiosyncratic, unmetabolized in you — honouring your own interior rather than routing it through another.", pillar: "Presence" },
  3: { name: "performance", compulsion: "the compulsion to succeed visibly — mistaking the image for the person, building an edifice of accomplishment around a core that was never met.", to: 6, toName: "the Loyalist", growth: "the commitment to what is real rather than what is impressive — loyalty to truth, to people, to processes that take more than a quarter to show fruit.", pillar: "Relationships" },
  4: { name: "melancholy", compulsion: "the compulsion of the missing — treating longing as identity, aestheticizing the wound, defending difference against the ordinariness of being met.", to: 1, toName: "the Reformer", growth: "the disciplined movement toward the good — structure, practice, daily return to what is true rather than what is felt.", pillar: "Service" },
  5: { name: "withdrawal", compulsion: "the retreat into the mind's fortress, treating information as a substitute for presence. Your path is not more information. It is the courageous exit from the head into the body, where direct knowing lives. Until the Hara is inhabited, no amount of reading will satisfy; the mental body will keep demanding more fuel precisely because it cannot be what it is trying to become.", to: 8, toName: "the Challenger", growth: "the willingness to occupy space, to act from the Hara before the thought has resolved, to meet the world with a body that does not flinch.", pillar: "Presence" },
  6: { name: "anxious loyalty", compulsion: "the compulsion to scan for threat — mistaking vigilance for competence, testing trust to destruction, mistrusting your own authority.", to: 9, toName: "the Peacemaker", growth: "the settling into what already is — unhurried, unanxious presence that does not require guarantees to act.", pillar: "Presence" },
  7: { name: "flight from limitation", compulsion: "the compulsion of optionality — keeping every door open so that the cost of any single commitment can never be paid.", to: 5, toName: "the Investigator", growth: "the willingness to go deep rather than wide, to sit with what does not entertain you, to feel what has been waiting under the activity.", pillar: "Learning" },
  8: { name: "forceful self-protection", compulsion: "the compulsion to stay in charge — preventing vulnerability by pre-emptive dominance, mistaking intensity for intimacy.", to: 2, toName: "the Helper", growth: "the tenderness that can receive as well as give, the recognition that the people around you are not threats to your sovereignty but the occasion for it.", pillar: "Relationships" },
  9: { name: "forgetting self", compulsion: "the compulsion to merge — disappearing into the background of other people's lives, mistaking peace for the absence of self-assertion.", to: 3, toName: "the Achiever", growth: "the movement into visible action — the willingness to take up space, to show up as the one who decided, to risk being seen doing the thing.", pillar: "Service" },
};

// ─── Constitution ────────────────────────────────────────────────────────────

const DOSHA = { V: "Vata", P: "Pitta", K: "Kapha" };
const ELEMENTS = [["Wd", "Wood"], ["F", "Fire"], ["E", "Earth"], ["Mt", "Metal"], ["Wt", "Water"]];   // the generating cycle, clockwise
const ELEMENT = Object.fromEntries(ELEMENTS);
const DOSHA_PROSE = {
  V: "the air constitution. Quick, changeable, gifted with speed of perception and connection; the failure mode is overextension into fragmentation and depleted ground. Warming, oiling, and regulating practices are structural — not preference.",
  P: "the fire constitution. Quick-witted, penetrating, capable of intense focused work; the failure mode is burning the vessel through overextension. Cooling, grounding, and moistening practices are structural — not preference.",
  K: "the earth-water constitution. Steady, enduring, deep reserves of vitality; the failure mode is stagnation, accumulation, resistance to change. Warming, mobilizing, and stimulating practices are structural — not preference.",
};

// ─── Altitude ────────────────────────────────────────────────────────────────

function altitudeProse(v) {
  const r = Math.round(v * 10) / 10;
  let d, next = "";
  if (v < 3.0) { d = "the pre-rational altitudes — impulse, narrative, magical participation. The gifts are vitality, immediacy, unmediated contact with the world. The constraint is that causality has not yet become legible; reality is read through story rather than through pattern."; next = "Traditional / Mythic — the altitude at which coherent moral order and group belonging stabilize."; }
  else if (v < 4.5) { d = "the <strong>Traditional / Mythic</strong> altitude — coherent moral order, group belonging, inherited roles and codes. The gifts are discipline, devotion, reliable transmission across generations. The constraint is that authority is external; questioning the code destabilizes the self."; next = "Modern / Rational — the altitude at which analytical rigour, systems thinking, and a well-earned suspicion of inherited authority take hold."; }
  else if (v < 5.5) { d = `the <strong>Modern / Rational</strong> altitude — the measured value is <strong>${r}</strong>. The gifts are real: analytical rigour, systems thinking, a well-earned suspicion of inherited authority. The limitations are also real: a residual materialism that treats Logos as metaphor rather than as the living pattern of creation.`; next = "<strong>Postmodern / Pluralistic</strong> — the altitude at which multiple frames become visible and inherited hierarchies are suspended to hear what they obscured."; }
  else if (v < 6.5) { d = `the <strong>Postmodern / Pluralistic</strong> altitude — the measured value is <strong>${r}</strong>. The gifts: perspectival fluency, sensitivity to voice and power, refusal of false universals. The constraint: relativism refuses to name hierarchy where hierarchy is plainly present; meaning dissolves under the weight of critique.`; next = "<strong>Integral</strong> — the altitude at which multiple frames become visible without collapsing into either dogma or relativism, and where the spiritual dimensions of reality become subjects of serious inquiry rather than objects of private belief."; }
  else if (v < 7.5) { d = `the <strong>Integral</strong> altitude — the measured value is <strong>${r}</strong>. Multiple frames held at once, developmental hierarchy visible and honoured, the spiritual dimensions of reality treated as real. This is the altitude Harmonism's architecture is built for.`; next = "<strong>Trans-integral</strong> (super-integral, unity) — sustained operation from the non-dual ground rather than holding frames from outside them."; }
  else d = `the <strong>trans-integral</strong> altitudes — the measured value is <strong>${r}</strong>. Sustained operation from the non-dual ground; identity stable through seeming paradox; the Wheel inhabited rather than navigated.`;
  return `<p>You operate at ${d}</p>` + (next ? `<p>The next ceiling is ${next} Harmonism's architecture is built for this passage; the Wheel is the instrument of its practice.</p>` : "");
}

// ─── Edges and horizons ──────────────────────────────────────────────────────

const EDGE_TITLES = { presence: "The fortress of mind", health: "The vessel is the first instrument", matter: "Stewardship before acquisition", service: "The vocation beneath the job", relationships: "The held, not the helper", learning: "Depth before breadth", nature: "Remembering the wider field", recreation: "Joy is not a reward" };
const EDGE_BODIES = {
  presence: "The mental body will keep demanding more fuel precisely because it cannot be what it is trying to become. Practice is the courageous exit from the head into the body, where direct knowing lives.",
  health: "Before any of the spokes can refine, the fundamentals have to hold — sleep, hydration, nutrition, movement. The temptation is to optimize the sophisticated while the basic remains unmet.",
  matter: "The question is not how much you have, but what stewards you. Every possession, every account, every tool either enlarges or diminishes the sovereign you — there is no neutral.",
  service: "The distinction is between what you do and what you are for. Dharma is the shape your contribution takes when the friction of circumstance stops determining it.",
  relationships: "You know how to give. The growth edge is the reverse move — letting yourself be received, letting the other see what you have been protecting by giving first.",
  learning: "More information is not what you need. The edge is to sit with what resists understanding, to let the question remain open until it teaches you something you would not have thought to ask.",
  nature: "The body knows it belongs to the wider field; the mind forgets. The practice is not scheduled hikes but the daily act of remembering the ground beneath your feet is alive.",
  recreation: "Play is not the absence of seriousness; it is a different kind of seriousness. Without it, the other pillars harden into obligation.",
};
// v93: what already holds. The pillars where the Wheel stands highest, read for what
// they give the rest.
const STRENGTH_TITLES = { presence: "Attention that can rest", health: "The vessel holds", matter: "Stewardship over what you keep", service: "Work that carries meaning", relationships: "Bonds with real contact", learning: "A mind that keeps opening", nature: "Rooted in the wider field", recreation: "Joy kept alive" };
const STRENGTH_BODIES = {
  presence: "You can return to the centre. Attention that is not owned by every passing demand is the ground the other pillars stand on: from here, practice deepens instead of starting over.",
  health: "The fundamentals hold often enough to be trusted: sleep, food, movement. A body that holds frees attention for refinement, and for the pillars that need it more.",
  matter: "What you keep serves you more than it claims you. Resources ordered this way become leverage for the rest of the Wheel rather than a weight on it.",
  service: "Your work stands close to the shape of your contribution. Where Dharma and livelihood meet, effort feeds the person instead of draining them.",
  relationships: "Your bonds carry real contact, not only roles. Being known by others is a mirror and a support: it keeps the inner work honest.",
  learning: "You stay with a question long enough for it to change you. Sustained attention to what exceeds your categories is how understanding becomes your own.",
  nature: "You keep contact with the living world. The nervous system steadies in the conditions it was made for, and you return to them.",
  recreation: "Play still has its place. Joy is the register of a healthy field, and it keeps the other pillars from hardening into obligation.",
};
const STRENGTH_ASKS = ["How can this strength carry the pillar that needs it most?", "What keeps this one strong, and what would weaken it?", "Where else in my life could this become practice?"];
const EDGE_ASKS = ["Where in your body does this edge live?", "Walk me through the last time this showed up.", "What would change if this stopped being true?", "Name the one small practice that meets this.", "How do you know when you are in it?"];
const HORIZON_LABELS = ["This week", "Within the month", "When you are ready"];
const HORIZON_ASKS = ["Show me the first step I can take today.", "What would I need to have in place before this can hold?", "Ask me this again in three months."];
const HORIZONS = {
  presence: ["Begin at the centre. Ten minutes of sitting, twice a day — morning and evening — untying your attention from task and returning it to breath, body, the plain fact of being here.", "The practice is not a performance of stillness. It is the willingness to notice without editing. Everything else in the Wheel presupposes this attention; without it, the other pillars are merely activities."],
  health: ["Audit the fundamentals this week. Sleep — is it guarded or surrendered to the last reel? Hydration — two litres before noon, clean water, no screens during meals. Move the body daily, even briefly.", "The body is the first instrument of every other practice. Before any optimization, the basics: rest, water, whole food, sunlight, movement, silence. Unglamorous; non-negotiable."],
  matter: ["Take an inventory of what owns you. Possessions that drain more attention than they return. Commitments that have outlived their meaning. Digital subscriptions and accounts that compound quietly.", "Stewardship is the reverse of acquisition. The question is not what to add but what is already in your keeping that you are failing to honour — and what to release so the field clears."],
  service: ["Name the difference between your job and your vocation. What would the work look like if it were the shape of your contribution rather than the transaction that funds your life?", "Dharma does not mean leaving your employment. It means recognizing that the work is a form of practice — or revealing, by its discomfort, where the misalignment lives."],
  relationships: ["Identify the one relationship where you are most protected — the place where real contact has been substituted by performance of role. That is the growing edge.", "The movement is not towards better technique but towards less armour. Relationship is the crucible where every interior pattern becomes visible; avoidance there is avoidance everywhere."],
  learning: ["Choose one subject that genuinely pulls you — not the book you think you should read, the one you would read if nobody were watching. Give it thirty sustained minutes, three times a week.", "Learning at this depth is not consumption. It is the slow changing of the mind through sustained attention to what exceeds your current categories. Breadth without depth is noise."],
  nature: ["Spend thirty unstructured minutes outside this week. No podcast, no photos, no destination. Let the body remember that it belongs to the wider field.", "The nervous system knows how to regulate when given the original conditions. Most of what we call stress is the absence of contact with the ground the body evolved within."],
  recreation: ["Reclaim one activity you do purely for joy — not productivity, not content, not credential. Music, sport, drawing, gardening — whatever predates the question of usefulness.", "Joy is not a reward after the real work. It is the register of a healthy field. Without it, every other pillar hardens into obligation and the architecture collapses from the inside."],
};

// ─── The data ────────────────────────────────────────────────────────────────

/**
 * input: { name, wheel: {pillar: 0..6} (the Wheel as Lodestone reads it now),
 *          hp: the decoded assessment code or null, notes: {pillar: {concerns, edges, resistance}} }
 */
export function buildProfile({ name = "", wheel = {}, hp = null, notes = {}, situation = "", date = new Date() } = {}) {
  const lv = k => Math.max(0, Math.min(6, Number(wheel[k]) || 0));
  const has = PILLARS.some(k => lv(k) > 0);
  // Highest, the next step (first in the Way of Harmony below developing), resistance.
  let highest = null;
  for (const k of PILLARS) if (lv(k) > 0 && (!highest || lv(k) > lv(highest))) highest = k;
  const next = PILLARS.find(k => lv(k) < 4) || "presence";
  const resistance = PILLARS.find(k => notes[k]?.resistance) || null;

  const ranked = PILLARS.map((k, order) => ({ k, s: lv(k), order })).sort((a, b) => a.s - b.s || a.order - b.order).slice(0, 5);
  const edges = ranked.map((r, i) => ({ pillar: r.k, title: EDGE_TITLES[r.k], body: EDGE_BODIES[r.k], note: notes[r.k]?.concerns || notes[r.k]?.edges || "", ask: EDGE_ASKS[i] }));
  // The three highest, of those read above the first level; ties in the Way of Harmony's order.
  const strengths = PILLARS.map((k, order) => ({ k, s: lv(k), order })).filter(r => r.s > 1).sort((a, b) => b.s - a.s || a.order - b.order).slice(0, 3)
    .map((r, i) => ({ pillar: r.k, title: STRENGTH_TITLES[r.k], body: STRENGTH_BODIES[r.k], note: notes[r.k]?.strengths || "", ask: STRENGTH_ASKS[i] }));
  const start = PILLARS.indexOf(next);
  const horizons = [0, 1, 2].map(i => { const k = PILLARS[(start + i) % 8]; return { label: HORIZON_LABELS[i], pillar: k, p1: HORIZONS[k][0], p2: HORIZONS[k][1], ask: HORIZON_ASKS[i] }; });

  const scores = {};
  for (const k of PILLARS) { const s = hp?.w?.[k]; if (Array.isArray(s) && s.length >= 2) scores[k] = { f: Number(s[0]), d: Number(s[1]) }; }

  // Enneagram: measured, given (self), or not taken.
  let enneagram = null;
  if (hp && !hp.sk?.e && hp.e && hp.e.t) {
    const t = Number(hp.e.t), w = hp.e.w ? Number(hp.e.w) : null, f = FIXATIONS[t] || FIXATIONS[5];
    enneagram = { type: t, name: TYPE_NAMES[t] || `Type ${t}`, wing: w, wingText: w ? WINGS[`${t}w${w}`] || "" : "", stack: hp.e.i || null, health: hp.e.h != null ? Number(hp.e.h) : null, self: !!hp.e.self, fix: f };
  }

  // Constitution: the three treasures, the dosha proportions, the five elements, Yin-Yang.
  let constitution = null;
  if (hp && !hp.sk?.c && hp.c) {
    const c = hp.c, self = !!c.self, d = c.d || {};
    let pct;
    if (!self && d.V != null) pct = { V: Number(d.V), P: Number(d.P), K: Number(d.K) };
    else { pct = { V: 25, P: 25, K: 25 }; if (d.dominant) pct[d.dominant] = 50; if (d.second && d.second !== d.dominant) { pct[d.second] = 30; for (const k of "VPK") if (k !== d.dominant && k !== d.second) pct[k] = 20; } }
    // The five elements: the primary and secondary are what the assessment holds; the others are drawn even.
    const wx = {}; for (const [k] of ELEMENTS) wx[k] = 15;
    if (c.x) wx[c.x] = 34; if (c.xs && c.xs !== c.x) wx[c.xs] = 24;
    const y = c.y != null ? Number(c.y) : null;
    const jing = c.j != null ? Math.round(Number(c.j) * 10) : null;
    // Qi and Shen are not asked: derived from Jing and the dosha, as the profile always has, and said so.
    const qi = jing != null ? Math.max(20, Math.min(95, jing + Math.trunc((pct.P - 33) / 2) + 10)) : null;
    const shen = jing != null ? Math.max(20, Math.min(95, jing + Math.trunc(((pct.V + pct.P) / 2 - 33) / 2) + 20)) : null;
    constitution = { self, dominant: d.dominant || Object.entries(pct).sort((a, b) => b[1] - a[1])[0][0], second: d.second || null, pct, measuredPct: !self && d.V != null,
      x: c.x || null, xs: c.xs || null, wx, yin: y, yang: y != null ? Math.max(0, Math.min(100, Math.round(50 + y * 50))) : null,
      jing, jingLevel: c.jl || null, qi, shen };
  }

  const altitude = hp?.alt != null ? Number(hp.alt) : null;
  return { name, date, situation, has, wheel: Object.fromEntries(PILLARS.map(k => [k, lv(k)])), scores, highest, next, resistance, strengths, edges, horizons, enneagram, constitution, altitude, taken: !!hp };
}

// ─── The drawing ─────────────────────────────────────────────────────────────

function radar(wheel) {
  const R = 120, ns = [];
  const pts = [];
  for (let lv = 1; lv <= 6; lv++) ns.push(`<circle r="${R * lv / 6}" fill="none" class="pv-grid"/>`);
  RING.forEach((k, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / RING.length, c = Math.cos(a), s = Math.sin(a), v = wheel[k] / 6;
    ns.push(`<line x1="0" y1="0" x2="${(R * c).toFixed(1)}" y2="${(R * s).toFixed(1)}" class="pv-grid"/>`);
    pts.push(`${(R * v * c).toFixed(1)},${(R * v * s).toFixed(1)}`);
    ns.push(`<circle cx="${(R * v * c).toFixed(1)}" cy="${(R * v * s).toFixed(1)}" r="4.5" fill="${COLORS[k]}"><title>${NAMES[k]}: ${LEVELS[wheel[k]]}</title></circle>`);
    const anchor = Math.abs(c) < 0.2 ? "middle" : c > 0 ? "start" : "end";
    ns.push(`<text x="${((R + 12) * c).toFixed(1)}" y="${((R + 12) * s + 4).toFixed(1)}" text-anchor="${anchor}" fill="${COLORS[k]}" class="pv-label">${NAMES[k]}</text>`);
  });
  ns.push(`<polygon points="${pts.join(" ")}" class="pv-area"/>`);
  ns.push(`<circle r="${(8 + 20 * wheel.presence / 6).toFixed(1)}" fill="${COLORS.presence}" fill-opacity="0.35" stroke="${COLORS.presence}"><title>Presence: ${LEVELS[wheel.presence]}</title></circle>`);
  return `<svg class="pv-radar" viewBox="-230 -150 460 300" role="img" aria-label="The Wheel of Harmony as it stands">${ns.join("")}</svg>`;
}

function pentagon(wx, primary) {
  const R = 90, pts = [], parts = [];
  ELEMENTS.forEach(([k, n], i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / 5, c = Math.cos(a), s = Math.sin(a), v = wx[k] / 40;
    parts.push(`<line x1="0" y1="0" x2="${(R * c).toFixed(1)}" y2="${(R * s).toFixed(1)}" class="pv-grid"/>`);
    pts.push(`${(R * v * c).toFixed(1)},${(R * v * s).toFixed(1)}`);
    parts.push(`<text x="${((R + 12) * c).toFixed(1)}" y="${((R + 12) * s + 4).toFixed(1)}" text-anchor="${Math.abs(c) < 0.2 ? "middle" : c > 0 ? "start" : "end"}" class="pv-label${k === primary ? " pv-strong" : ""}">${n}</text>`);
  });
  const outline = ELEMENTS.map((_, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; return `${(R * Math.cos(a)).toFixed(1)},${(R * Math.sin(a)).toFixed(1)}`; }).join(" ");
  return `<svg class="pv-pentagon" viewBox="-160 -120 320 230" role="img" aria-label="The five elements"><polygon points="${outline}" fill="none" class="pv-grid"/>${parts.join("")}<polygon points="${pts.join(" ")}" class="pv-area"/></svg>`;
}

const bar = (label, value, note = "") => value == null ? "" :
  `<div class="pv-bar"><span>${esc(label)}</span><div class="pv-track"><div class="pv-fill" style="width:${Math.max(0, Math.min(100, value))}%"></div></div><b>${value}</b>${note ? `<small>${esc(note)}</small>` : ""}</div>`;

const ask = q => `<button type="button" class="pv-ask" data-ask="${esc(q)}">Ask Lodestone: ${esc(q)}</button>`;

/** The page's HTML (its styles come from the app's stylesheet: .pv-*). */
export function renderProfile(d) {
  const when = d.date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const out = [];
  out.push(`<header class="pv-cover"><p class="pv-kicker">Harmonic Profile</p><h1>${esc(d.name || "Your profile")}</h1><p class="pv-date">As it stands on ${esc(when)}${d.taken ? "" : " · the assessment not yet taken"}</p>${d.situation ? `<p class="pv-capsule">${esc(d.situation)}</p>` : ""}</header>`);

  // The Wheel
  const rows = Object.keys(NAMES).map(k => `<tr><td style="color:${COLORS[k]}">${NAMES[k]}</td><td>${LEVELS[d.wheel[k]]}</td><td>${d.scores[k] ? `F ${d.scores[k].f} · D ${d.scores[k].d}` : ""}</td></tr>`).join("");
  out.push(`<section class="pv-section"><h2>The Wheel</h2>${d.has ? radar(d.wheel) : `<p class="pv-muted">No Wheel reading yet: take the assessment, or set your Wheel under Your path.</p>`}
    <table class="pv-table"><thead><tr><th>Pillar</th><th>Where you stand</th><th>Assessment (functional · developmental, of 10)</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="pv-facts"><span>Strongest: <b>${d.highest ? NAMES[d.highest] : "—"}</b></span><span>Next in the Way of Harmony: <b>${NAMES[d.next]}</b></span><span>Tends to avoid: <b>${d.resistance ? NAMES[d.resistance] : "none"}</b></span></p>
    <p class="pv-muted">The Wheel here is the one Lodestone reads now: it moves with your life, as you set it or confirm a change, and this page moves with it. The assessment's scores are from the day you took it.</p></section>`);

  // Altitude
  out.push(`<section class="pv-section"><h2>Developmental altitude</h2>${d.altitude != null ? `<p class="pv-big">${d.altitude}<small>/10</small></p>${altitudeProse(d.altitude)}` : `<p class="pv-muted">Derived from the Wheel layer of the assessment, once it is taken.</p>`}</section>`);

  // Enneagram
  const e = d.enneagram;
  out.push(`<section class="pv-section"><h2>The Enneagram</h2>${e ? `<p class="pv-big">${e.type}${e.wing ? `w${e.wing}` : ""} <small>${esc(e.name)}${e.self ? " · as you know it" : ""}</small></p>
    <p class="pv-facts"><span>Wing: <b>${e.wing ? `${e.type}w${e.wing}` : "—"}</b></span><span>Instinctual stack: <b>${e.stack ? esc(e.stack.replace(/\//g, " / ")) : "not assessed"}</b></span><span>Health: <b>${e.health != null ? `${e.health}/5` : "not assessed"}</b></span></p>
    ${e.wingText ? `<p>With the ${e.type}w${e.wing} wing: ${esc(e.wingText)}</p>` : ""}
    <h3>The compulsion, read clearly</h3><p>The fixation is ${esc(e.fix.name)} — ${esc(e.fix.compulsion)}</p>
    <h3>Growth direction — Type ${e.fix.to}, ${esc(e.fix.toName)}</h3><p>Integration runs toward ${esc(e.fix.growth)} The pillar where this lives in the Wheel is <strong>${esc(e.fix.pillar)}</strong>.</p>`
    : `<p class="pv-muted">Not taken. The assessment's second layer reads your type, wing, instinctual stack and level of health, or takes the type you already know.</p>`}</section>`);

  // Constitution
  const c = d.constitution;
  if (c) {
    const seg = k => `<div class="pv-dosha pv-${k}" style="flex:${c.pct[k]}">${DOSHA[k]} ${c.pct[k]}%</div>`;
    out.push(`<section class="pv-section"><h2>Constitution</h2>
      <h3>The three treasures</h3>
      ${c.jing != null ? bar("Jing", c.jing, c.jingLevel ? `${c.jingLevel} reserve` : "") + bar("Qi", c.qi, "derived from Jing and constitution") + bar("Shen", c.shen, "derived from Jing and constitution") : `<p class="pv-muted">Jing not assessed${c.self ? ": the Jing questions were left out" : ""}. Qi and Shen are read from it.</p>`}
      <h3>Dosha — ${DOSHA[c.dominant]}${c.second ? `-${DOSHA[c.second]}` : ""}</h3>
      <div class="pv-doshas">${seg("V")}${seg("P")}${seg("K")}</div>
      ${c.measuredPct ? "" : `<p class="pv-muted">Your constitution as you know it yourself. The proportions drawn are indicative, not measured.</p>`}
      <p>You carry ${esc(DOSHA_PROSE[c.dominant] || DOSHA_PROSE.P)}</p>
      <h3>The five elements — ${esc(ELEMENT[c.x] || "—")}${c.xs ? ` with ${esc(ELEMENT[c.xs])}` : ""}</h3>
      ${pentagon(c.wx, c.x)}
      <p>The Wu Xing reading shows <strong>${esc(ELEMENT[c.x] || "—")}</strong> as the primary element — the phase that governs your seasonal tendency, your clock of activation, and the register in which your vital force most naturally expresses. Working with your constitution is not a diet or a regimen; it is learning to live in the shape your body already is.</p>
      <p class="pv-muted">The assessment holds your primary${c.xs ? " and secondary" : ""} element; the other points are drawn even.</p>
      <h3>Yin and Yang</h3>
      ${c.yang != null ? `<div class="pv-yy"><span>Yin</span><div class="pv-track"><div class="pv-pointer" style="left:${c.yang}%"></div></div><span>Yang</span></div><p>${c.yin < -0.5 ? "Yin-dominant" : c.yin < 0 ? "Slightly Yin" : c.yin > 0.5 ? "Yang-dominant" : "Slightly Yang"}: ${c.yin < 0 ? "your energy tends inward, toward conservation and internal processing." : "your energy tends outward, toward expression and active engagement."}</p>` : `<p class="pv-muted">Not assessed.</p>`}
      </section>`);
  } else out.push(`<section class="pv-section"><h2>Constitution</h2><p class="pv-muted">Not taken. The assessment's third layer reads your dosha, your Wu Xing element, Yin and Yang, and your Jing, from which Qi and Shen are read; or takes the constitution you already know.</p></section>`);

  // Strengths (v93), then the edges
  out.push(`<section class="pv-section"><h2>Your strengths</h2>${d.strengths.length ? `<p class="pv-muted">The pillars where the Wheel stands highest now: what already holds, and what the rest can lean on.</p>
    <div class="pv-cards">${d.strengths.map(x => `<article class="pv-card" style="--pc:${COLORS[x.pillar]}"><p class="pv-kicker">${NAMES[x.pillar]} · ${LEVELS[d.wheel[x.pillar]]}</p><h3>${esc(x.title)}</h3><p>${esc(x.body)}</p>${x.note ? `<p><em>What Lodestone has noted: ${esc(x.note.replace(/[.\s]+$/, ""))}.</em></p>` : ""}${ask(x.ask)}</article>`).join("")}</div>` : `<p class="pv-muted">None read yet: a strength shows here once a pillar of your Wheel stands above its first level. Set your Wheel in Your path, or take the assessment.</p>`}</section>`);
  out.push(`<section class="pv-section"><h2>Your edges</h2><p class="pv-muted">The five pillars where the Wheel stands lowest now, in the Way of Harmony's order where they are level.</p>
    <div class="pv-cards">${d.edges.map(x => `<article class="pv-card" style="--pc:${COLORS[x.pillar]}"><p class="pv-kicker">${NAMES[x.pillar]} · ${LEVELS[d.wheel[x.pillar]]}</p><h3>${esc(x.title)}</h3><p>${esc(x.body)}${x.note ? ` <em>${esc(x.note)}</em>` : ""}</p>${ask(x.ask)}</article>`).join("")}</div></section>`);

  // Horizons
  out.push(`<section class="pv-section"><h2>Horizons</h2><p class="pv-muted">The Way of Harmony from where you stand: ${NAMES[d.next]} first.</p>
    ${d.horizons.map(h => `<div class="pv-horizon"><p class="pv-kicker">${esc(h.label)} · ${NAMES[h.pillar]}</p><p>${esc(h.p1)}</p><p>${esc(h.p2)}</p>${ask(h.ask)}</div>`).join("")}</section>`);

  out.push(`<footer class="pv-foot">Drawn by Lodestone on this device from your memory. The Harmonic Profile is a reading, not a verdict: retake the assessment when your life has moved.</footer>`);
  return out.join("\n");
}
