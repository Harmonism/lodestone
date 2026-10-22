// test-prompt.mjs — the summary record and its trigger (prompt.js), without a browser.
//   node tools/test-prompt.mjs
import { renderSummary, fitMessages, summaryPlan, summaryRequest } from "../app/js/prompt.js";
let pass=0, fail=0; const ok=(c,w)=>{ if(c) pass++; else { fail++; console.log("FAIL",w); } };
// renderSummary
const j = '```json\n{"working_on":["sleep, after the move"],"about_them":["mother in chemo, cycle 3 on Nov 2","takes 400 mg magnesium"],"their_words":["I wake at 3 every night"],"commitments":[{"what":"no screens after 21:00","since":"Oct 12"}],"open":["whether to fast"],"drew_on":["Wheel of Health"],"extra":["x"]}\n```';
const r = renderSummary(j);
ok(/^Working on: sleep, after the move$/m.test(r), "working_on line: "+r);
ok(/About them: mother in chemo, cycle 3 on Nov 2; takes 400 mg magnesium/.test(r), "facts exact");
ok(/In their words: “I wake at 3 every night”/.test(r), "quote verbatim, quoted");
ok(/Commitments: no screens after 21:00: Oct 12/.test(r), "object entry stringified, not lost");
ok(!/extra/.test(r) && !/Their positions/.test(r), "unknown and empty fields left out");
ok(renderSummary("She is working on sleep and wakes at 3.") === "She is working on sleep and wakes at 3.", "prose kept as written");
ok(renderSummary("{not json at all}") === "{not json at all}", "broken JSON kept as written");
ok(renderSummary('{"working_on":[]}') === '{"working_on":[]}', "empty JSON falls back to raw");
// fitMessages: dropped and share
const tier = { ctx: 8192, maxTokens: 700 };
const big = "x".repeat(3300); // ~1000 tokens
const hist = Array.from({length: 12}, (_, i) => ({ role: i%2 ? "assistant":"user", content: big }));
const f = fitMessages({ system: "s".repeat(3300*2), history: hist, current: "hi", tier });
ok(f.dropped > 0 && f.share > 0.8, `dropped ${f.dropped} share ${f.share.toFixed(2)}`);
const f2 = fitMessages({ system: "short", history: hist.slice(0,2), current: "hi", tier });
ok(f2.dropped === 0 && f2.share < 0.5, `small history: dropped ${f2.dropped} share ${f2.share.toFixed(2)}`);
// summaryPlan
const pend = n => Array.from({length:n}, (_, i) => ({ id: i+1, role: i%2?"assistant":"user", content: big }));
ok(summaryPlan(pend(10), { dropped: 0, share: 0.3, room: 70000 }) === null, "no pressure, under 40: no fold");
const p1 = summaryPlan(pend(10), { dropped: 0, share: 0.5, room: 5000 });
ok(p1 && p1.length === 8, "pending tokens over 0.8 of room: fold all but KEEP_MIN (" + (p1&&p1.length) + ")");
ok(summaryPlan(pend(3), { dropped: 3, share: 1, room: 5000 }) === null, "under SUMMARY_MIN: no fold");
ok(summaryPlan(pend(4), { dropped: 0, share: 0.1, room: 50000 }) === null, "pending well inside the room: no fold");
const small = Array.from({length:44}, (_, i) => ({ id:i+1, role: i%2?"assistant":"user", content: "short reply" }));
const p2 = summaryPlan(small, { dropped: 0, share: 0.2, room: 20000 });
ok(p2 && p2.length === 44 - 16, "count trigger keeps SUMMARY_KEEP (" + (p2&&p2.length) + ")");
ok(summaryPlan(small, null).length === 28, "no fit info: old behaviour");
// summaryRequest maxChars
const req = summaryRequest({ previous: "Working on: x", turns: [{role:"user",content:"y".repeat(5000)}], maxChars: 400 });
ok(req[1].content.includes("Previous record:") && !req[1].content.includes("y".repeat(401)), "maxChars cuts turns");
ok(/"their_words"/.test(req[0].content), "structured system prompt");
console.log(`${pass} passed, ${fail} failed`);
