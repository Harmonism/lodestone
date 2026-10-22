// care.js — the second layer of the crisis gate (1.13): what the keyword gate
// (safety.js detectCrisis, exact phrases) cannot catch, because people in
// danger rarely say it outright: "everyone would be better off without me",
// "I just want to not wake up". New York's companion law (in force since
// 5 November 2025) and California's SB 243 ask for reasonable efforts to detect
// suicidal ideation and self-harm and to refer to crisis services; a list of
// phrases is not that.
//
// Two ways, both on this device, before any model sees the message:
//   meaning   the message is embedded by the model retrieval already uses
//             (multilingual-e5-small) and compared with EXAMPLES; a close
//             match is a care moment
//   phrases   INDIRECT, the commoner indirect expressions, so the layer holds
//             where the meaning model is not loaded (keyword-only devices)
//
// A care moment is not the crisis template (the keyword gate's answer, which no
// model writes): the model answers, told to ask plainly and gently about safety
// and to stay (prompt: <care_check>), and the app itself adds the crisis line
// beneath the answer, so the referral never depends on the model.

import { normalize as norm } from "./safety.js";

// Two kinds of phrase (1.13.1, after an audit that read them against real sentences):
//   PLAIN      said outright, unambiguous: the crisis line is shown (refer);
//   INDIRECT   said around it, and sometimes about something else ("tired of
//              living in Paris", "end it all with this company"): the model is
//              told to ask (ask), and the line is shown only if the meaning
//              layer also reads it so.
export const PLAIN = {
  ideation: [
    "i want to die", "i wanna die", "want to be dead", "wish i was dead", "wish i were dead", "thinking about suicide", "thinking of suicide", "thought about suicide",
    "i am suicidal", "i'm suicidal", "im suicidal", "i feel suicidal", "feeling suicidal", "want to kill myself", "wanna kill myself", "going to kill myself", "gonna kill myself", "i will kill myself", "i'll kill myself",
    "want to end my life", "going to end my life", "thinking of ending my life", "thinking about ending my life", "want to take my own life", "je suis suicidaire",
    "don't want to live anymore", "dont want to live anymore", "don't want to be alive", "dont want to be alive",
    "better off without me", "better off if i was gone", "better off if i were gone", "better off if i wasn't here", "better off if i weren't here", "nobody would miss me if i",
    "wish i had never been born", "wish i was never born", "nothing to live for", "can't go on living", "cant go on living", "goodbye letters to everyone",
    "je veux mourir", "me suicider", "je pense au suicide", "mettre fin à mes jours", "en finir avec la vie", "envie d'en finir", "je veux en finir", "mieux sans moi", "plus envie de vivre",
    "quiero morir", "quiero morirme", "me quiero matar", "quiero matarme", "pienso en el suicidio", "quitarme la vida", "todos estarían mejor sin mí", "estarían mejor sin mí", "no quiero vivir más", "no quiero seguir viviendo",
    "أريد أن أموت", "اريد ان اموت", "أفكر في الانتحار", "افكر في الانتحار", "أريد الانتحار", "اريد الانتحار", "سأنتحر", "أفضل بدوني", "لا أريد أن أعيش",
  ],
  self_harm: [
    "been cutting myself", "keep cutting myself", "started cutting myself", "cutting myself again", "cut myself again", "cut myself on purpose",
    "hurt myself on purpose", "hurting myself again", "hurt myself again", "burned myself on purpose", "burn myself on purpose", "make myself bleed",
    "took a bunch of pills", "took too many pills", "swallowed all my pills",
    "je me scarifie", "me suis fait du mal", "me hice daño a propósito", "أؤذي نفسي", "اؤذي نفسي", "جرحت نفسي",
  ],
};
export const INDIRECT = {
  ideation: [
    "don't want to be here anymore", "dont want to be here anymore", "don't want to exist", "dont want to exist", "wish i didn't exist",
    "never wake up", "not wake up tomorrow", "go to sleep and not wake", "want it all to end", "want everything to end", "end it all", "ending it all",
    "no reason to keep living", "tired of living", "tired of being alive", "disappear forever", "disappear for good", "writing goodbye letters", "wrote goodbye letters", "giving my things away",
    "ne plus me réveiller", "ne jamais me réveiller", "fatigué de vivre", "fatiguée de vivre", "disparaître pour toujours",
    "mejor sin mí", "mejor sin mi", "no despertar nunca", "no despertar más", "acabar con todo", "no quiero vivir", "cansado de vivir", "cansada de vivir",
    "إنهاء كل شيء", "تعبت من الحياة",
    // Plain once, moved here (1.13.1): each is also said of someone else, or as a figure of speech
    // ("my brother is suicidal", "I could kill myself laughing", "envie de mourir de rire").
    "suicidal", "kill myself", "end my life", "ending my life", "take my own life", "no reason to live", "j'ai envie de mourir", "envie de mourir",
  ],
  self_harm: [
    // "I cut myself shaving", "cutting myself some slack", "il veut me faire du mal".
    "i cut myself", "cutting myself", "je me coupe", "me corto", "me faire du mal", "hacerme daño",
  ],
};

// Whole words only (1.13.1): "end my life" is not in "spend my life". Arabic,
// whose small words join the next ("وأريد"), is still looked for anywhere.
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = p => /[\u0600-\u06FF]/.test(p) ? { test: n => n.includes(p) } : new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc(p)}(?=$|[^\\p{L}\\p{N}])`, "u");
const PLAIN_N = Object.entries(PLAIN).flatMap(([kind, l]) => l.map(p => [kind, pattern(norm(p)), p]));
const INDIRECT_N = Object.entries(INDIRECT).flatMap(([kind, l]) => l.map(p => [kind, pattern(norm(p)), p]));

/** The phrase layer: { kind, how: "phrase", level, match } or null. Read whole, however long. */
export function indirectCare(text) {
  const n = norm(text);
  if (!n) return null;
  for (const [kind, p, raw] of PLAIN_N) if (p.test(n)) return { kind, how: "phrase", level: "refer", match: raw };
  for (const [kind, p, raw] of INDIRECT_N) if (p.test(n)) return { kind, how: "phrase", level: "ask", match: raw };
  return null;
}

// The meaning layer is a linear reading of the message's embedding, fitted on
// 152 sentences in English, French, Spanish and Arabic: suicidal thoughts and
// self-harm said indirectly, against ordinary talk that comes close (tired of a
// job, a grandmother's death, killing a process, the ego's death in practice,
// burning the toast). Left-one-out it caught 75 of 78 and mistook 8 of 74 hard
// ordinary sentences at 0.5; at 0.8, 3 of 74 (the data, the fit and the
// leave-one-out run in tools/care-fit/). Two levels:
//   ASK    (0.5) the model is told to ask plainly about safety, if the message
//          is about that, and otherwise answer as asked
//   REFER  (0.8, or a phrase) the app also adds the crisis line under the answer
export const ASK = 0.5, REFER = 0.8;
const MODEL = {"w": [0.38773, -0.71199, 2.07421, -0.93759, -0.57054, 3.47491, 2.97745, -3.32208, -2.79858, -1.45795, -5.59751, 1.63135, -1.92998, 5.71112, -6.8122, -8.58403, 6.81551, 1.07704, -4.24474, 1.64887, 10.78422, -1.29934, -4.4598, -3.78087, 9.41825, 9.69861, -0.19695, 12.68745, 1.94967, 3.82302, -0.05694, 4.63845, -8.86399, -2.10467, 13.54964, 4.40657, -1.24424, 4.0274, 5.26613, 12.49736, 1.14183, -3.04927, 1.65887, 2.25188, 4.82107, -6.77596, -9.88201, -2.56265, -0.25963, 1.69033, 1.90796, -8.38747, 7.63046, 0.09572, 1.72759, -6.50005, -8.79019, -8.69891, 1.59458, -6.86695, 9.104, 4.53874, -2.80993, 0.70964, -2.60733, 1.74224, 3.09687, -2.01924, 8.16648, 2.93811, 4.39901, 2.57813, -1.32474, 2.592, -7.4742, -5.78223, -1.55598, 6.25845, 3.94573, -7.88085, 7.90693, -6.11068, 1.22424, -5.59605, 4.23768, 8.36979, 11.64759, 4.94402, 0.39146, -6.5323, 6.81442, -0.68118, -5.54121, 2.03737, -3.50618, 3.53605, 15.56412, -5.5156, -2.70911, -13.30508, 1.82713, 2.10879, 3.43449, -0.07797, 2.83959, 0.04921, 1.71537, 0.44964, -2.47697, 4.6826, -1.84325, -4.63296, -7.57094, -2.65607, 1.53351, 7.41596, 1.73854, 5.16621, -6.3006, -8.09759, 0.76024, 5.52383, -6.06652, -4.20439, -4.57468, 0.39442, 5.47191, 3.14492, 4.23882, -1.87546, 9.48457, -3.78503, -8.18968, 3.81251, 11.50808, -7.23017, -8.00822, -1.49151, -1.78871, -3.79875, 0.26519, 0.81862, -4.39763, 1.67918, -4.78616, -7.46547, -0.01489, 3.28031, -10.65241, -4.289, 1.64328, -5.42747, 5.13295, -8.44092, 6.53186, 11.05424, 0.87384, 4.10071, 4.42238, 2.85812, -4.02247, -1.71663, -7.84339, 5.42694, -4.2331, 1.31225, -0.98086, 1.90996, 4.46988, -7.89725, 0.27619, 0.26196, -0.27866, -4.99158, -7.13692, 4.6004, -12.72013, 1.37406, -8.26585, -3.90312, -9.40481, -3.69896, -4.50916, 1.90223, 8.05197, -0.99207, 8.04161, -5.8577, 1.82047, 6.59082, 1.31208, -1.71334, 3.3719, 6.52355, 1.73978, -4.03645, -5.18834, -7.65163, 7.90988, 2.04701, 9.77229, -6.80373, -5.83903, -9.62602, -0.25273, -3.1132, -0.72218, -1.14751, 1.75456, 6.75024, -6.12393, 0.06152, -0.58524, 4.87596, -4.30597, -11.20446, 4.77968, 5.2432, 4.41553, -0.48956, 1.69206, 3.62441, 1.6756, 13.43964, -7.12254, 1.48808, 5.4873, 0.54028, -8.77635, -1.93061, -6.42161, 5.04406, -6.95886, -1.92547, 3.1813, -7.58077, -3.49737, -8.3751, 7.04883, 6.97456, 5.3224, -4.79311, -5.06637, 6.35748, -0.70884, 0.37125, -8.34513, 2.04726, 7.975, 1.84437, -2.1622, -3.57113, -5.42645, -0.52229, -7.22791, -1.24338, -0.4255, 3.36956, -3.63771, -6.35193, 5.32747, -2.28351, -3.69241, -4.20907, -5.78268, 2.15352, 3.39897, 9.78969, -3.54905, 8.57489, -1.13781, 1.53362, -0.2632, 6.18606, -5.66081, 7.99624, 2.54579, -5.49459, -5.60609, -1.82277, 4.73581, 0.28612, -2.56649, 4.1366, 0.70294, 2.99298, -2.3715, -2.49089, 0.47245, -2.75473, 4.51736, 2.67486, 4.04465, -0.7301, -1.03748, 3.14331, 2.62173, -5.94184, -0.54417, 3.35599, 0.70878, 3.12524, 6.18028, 3.6204, -0.42816, -3.9112, -2.04327, -7.97317, -0.76861, -9.92759, 1.95513, -6.95777, -9.88451, 4.89552, 2.16613, 5.12453, 3.07328, -0.1711, -0.88106, 2.2583, 2.84601, 16.76758, -4.25107, 3.66327, 7.56847, -0.30063, 5.40053, -0.13422, 7.16488, -11.81149, -5.45216, 4.07211, -1.35564, -4.0274, -1.64132, 2.37424, -4.11359, -1.72981, 2.06421, -2.12491, 5.88883, 4.16316, -6.51879, -1.33425, -2.91433, 0.73476, 8.5277, -3.24518, -1.08734, -8.13039, -4.31577, 3.19009, -4.97444, -5.02076, -6.19558, -1.30729, -2.0636, 3.83719, -1.28688, 3.80132, -0.79763, 2.69863, 3.99953, -0.72946, 4.70205, -6.29524, -2.98953, 7.07, 4.37175, 3.26984, 15.93356, -8.8838, -1.19514, 6.2665, 2.7705, 6.07598, -7.81193, 0.57276, -5.25839, -2.72917, -2.76956, -0.96221, -4.39176, 6.22494], "b": -5.79432};

export function careScore(vec) {
  let z = MODEL.b;
  for (let i = 0; i < MODEL.w.length; i++) z += vec[i] * MODEL.w[i];
  return 1 / (1 + Math.exp(-z));
}

/** The meaning layer: { level: "ask" | "refer", how: "meaning", score } or null. `embed`: text → normalised vector (embedder.js). */
export async function meaningCare(text, embed) {
  if (!embed || !text || text.length < 12) return null;
  // A long message is read in its parts (the model sees 512 tokens at most): the
  // end, where a journal usually arrives at what weighs, and the start.
  const parts = text.length <= 1500 ? [text] : [text.slice(-1500), text.slice(0, 1500)];
  let score = 0;
  for (const p of parts) score = Math.max(score, careScore(await embed(p)));
  if (score < ASK) return null;
  return { level: score >= REFER ? "refer" : "ask", how: "meaning", score: Math.round(score * 1000) / 1000 };
}

/**
 * Both layers: a plain phrase refers at once; an indirect one asks, and refers
 * if the meaning agrees, or if there is no meaning layer to ask (no embedder, or
 * it failed): unsure, the line is shown.
 */
export async function careCheck(text, embed) {
  const p = indirectCare(text);
  if (p?.level === "refer") return p;
  let failed = !embed;
  const m = embed ? await meaningCare(text, embed).catch(() => { failed = true; return null; }) : null;
  if (p) return m?.level === "refer" ? { ...p, level: "refer", score: m.score } : failed ? { ...p, level: "refer" } : p;
  return m;
}
