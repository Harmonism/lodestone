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
// and to stay (prompt: <care_check>). Who shows the crisis line (1.13.2):
//   refer   a PLAIN phrase, said outright: the app adds the line beneath the
//           answer whatever the model writes, so that referral never depends on it
//   ask     an INDIRECT phrase or the meaning layer: neither is sure enough to
//           put a crisis line under a reader's answer on its own ("I already
//           know them", at a dinner with the wife's friends, read 0.98). The
//           model, which reads the whole conversation, decides: if the moment
//           is real it ends its reply with the care mark ([[care]], presence.js)
//           and the app puts the line for their country in its place; if not,
//           it answers as asked and nothing about safety is shown.

import { normalize as norm } from "./safety.js";

// Two kinds of phrase (1.13.1, after an audit that read them against real sentences):
//   PLAIN      said outright, unambiguous: the crisis line is shown (refer);
//   INDIRECT   said around it, and sometimes about something else ("tired of
//              living in Paris", "end it all with this company"): the model is
//              told to read it (ask), and the line is shown only if the model
//              marks the moment as real (1.13.2).
export const PLAIN = {
  ideation: [
    "i want to die", "i wanna die", "want to be dead", "wish i was dead", "wish i were dead", "thinking about suicide", "thinking of suicide", "thought about suicide",
    "i am suicidal", "i'm suicidal", "im suicidal", "i feel suicidal", "feeling suicidal", "want to kill myself", "wanna kill myself", "going to kill myself", "gonna kill myself", "i will kill myself", "i'll kill myself",
    "want to end my life", "going to end my life", "thinking of ending my life", "thinking about ending my life", "want to take my own life", "je suis suicidaire",
    "don't want to live anymore", "dont want to live anymore", "don't want to be alive", "dont want to be alive",
    "wish i had never been born", "wish i was never born", "nothing to live for", "can't go on living", "cant go on living", "goodbye letters to everyone",
    "je veux mourir", "me suicider", "je pense au suicide", "mettre fin à mes jours", "en finir avec la vie", "envie d'en finir", "je veux en finir", "plus envie de vivre",
    "quiero morir", "quiero morirme", "me quiero matar", "quiero matarme", "pienso en el suicidio", "quitarme la vida", "no quiero vivir más", "no quiero seguir viviendo",
    "أريد أن أموت", "اريد ان اموت", "أفكر في الانتحار", "افكر في الانتحار", "أريد الانتحار", "اريد الانتحار", "سأنتحر", "لا أريد أن أعيش",
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
    // Plain once, moved here (1.13.2): said of a team or a meeting as well ("the team is better off without me on this").
    "better off without me", "better off if i was gone", "better off if i were gone", "better off if i wasn't here", "better off if i weren't here", "nobody would miss me if i", "mieux sans moi", "todos estarían mejor sin mí", "estarían mejor sin mí", "أفضل بدوني",
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
// leave-one-out run in tools/care-fit/).
// Refitted in 1.13.2 with 111 short replies of ordinary conversation ("nothing
// much", "I already know them", "on est au restaurant"), which the first fit had
// none of: leave-one-out at 0.5, 72 of 78 caught and 13 of 185 ordinary
// sentences mistaken. A reading this loose only ever asks:
//   ASK    (0.5) the model is told to read the moment, and to mark it if real;
//          the app shows the line only on the mark (careBlock, presence.js)
export const ASK = 0.5;
const MODEL = {"w": [-3.56196, -0.82955, 3.76125, 0.36758, 0.78508, 4.75538, 3.08309, -9.13922, -4.77406, -1.26005, -6.05743, -3.08802, -0.76157, 8.61088, -7.91455, -12.68347, 9.87143, -0.48357, -2.95867, 2.93182, 9.9037, -1.2818, -3.50632, -3.55982, 4.02344, 11.94009, -0.83087, 9.38807, 1.63234, 4.71865, 0.6845, 3.23416, -9.87414, -4.0665, 12.63078, 2.6731, -1.62486, 3.61658, 5.84991, 12.82381, 2.61919, -2.29911, 0.43071, 5.35207, -2.84017, -5.39446, -8.58796, -1.27262, 1.21417, 0.53012, -2.76424, -10.59307, 5.59772, 3.13209, 0.44299, -8.42897, -10.19622, -6.34248, 3.00828, -4.09219, 5.40592, 6.76993, -2.73965, 4.11944, -2.15094, 3.65027, 3.07506, -0.51323, 8.68138, 1.27712, 1.08238, -3.57947, -4.77154, 3.1373, -6.9293, -7.30036, -2.41745, 2.33841, 3.57822, -5.10875, 9.37108, -8.03002, 0.5937, 1.2515, 1.13731, 9.29807, 14.98661, 9.53185, -2.31611, -2.92361, 4.22278, -2.88143, -5.31991, -1.96377, -3.82367, 1.99292, 10.10911, -6.00953, 0.8225, -12.55519, -1.09729, 6.65796, 1.12257, 1.85944, -3.42279, -0.74213, 3.45374, 1.26367, -2.4631, 2.72645, -3.7533, -6.14962, -6.47064, -4.35064, 3.31264, 7.87625, 2.26023, 6.24345, -9.36987, -3.85983, 1.62629, 0.64938, -4.71027, 0.0613, -5.68918, -2.34813, 0.6012, 0.08454, 5.13524, -1.11102, 7.85006, -6.1741, -5.9389, 3.61325, 8.73833, 0.07184, -8.9868, -3.88494, -5.36977, -5.19035, -3.15637, -1.84983, -5.82267, 0.3981, -2.49996, -5.00047, 1.06737, 3.76555, -12.65619, -1.93859, 1.25594, -4.61824, 3.40741, -11.71559, 8.17643, 4.96836, 0.47218, 0.60894, 3.68562, -2.1466, -3.99003, -2.97699, -5.1027, 8.25382, -3.47958, 1.4787, 1.52226, 3.48278, 4.61084, -7.07736, -1.2279, 0.99046, 2.12495, -2.16011, -4.08961, 4.82008, -9.39172, 7.51571, -6.19488, -2.69312, -8.69746, -3.3509, -1.39916, 2.27882, 4.36025, -3.27031, 7.97451, -9.49467, 5.85809, 7.46053, 1.10229, -0.32943, 1.57552, 6.46777, 2.78574, -5.00503, -0.35386, -10.59649, 5.22054, 4.89006, 9.76873, -5.09888, -4.87154, -3.79272, -4.24221, -4.72526, -2.71626, 5.25451, -0.89738, 7.8999, -4.60866, -1.21092, -0.31413, 3.38538, -1.95388, -7.93017, 6.18052, 7.62402, 3.73161, 3.28774, 0.84195, 1.3114, -0.30454, 7.63879, -3.52483, 1.64125, 5.57594, -1.65473, -6.4115, -7.28153, -2.85938, 7.5946, -8.72516, -2.98418, -2.9798, -5.0415, -2.60586, -5.69635, 6.84569, 5.98134, 3.57138, -4.78902, -4.49689, 8.34323, 3.76699, -4.09592, -3.03821, 4.40117, 4.13856, -1.04777, 0.78729, 0.03479, -8.96158, -1.27851, -9.05363, -0.27626, -2.69415, 2.08871, -4.04891, -8.3788, 5.28216, -1.55722, -1.1528, -4.27481, -4.51981, -0.07277, -1.21353, 9.92924, -7.12413, 4.2081, 0.56732, -0.06663, -4.90828, 3.62781, -5.39756, 8.06636, -1.03889, -5.96785, -7.79381, -4.46772, 3.56464, -1.57432, 0.0545, 1.19846, 3.04295, 3.63462, 2.10654, -1.63617, -4.97901, -1.48978, 3.61077, 1.81447, 4.41647, 1.64882, -0.50094, 2.92804, 4.10141, -2.06842, 2.36386, 0.3002, 2.25838, 0.70444, 4.58484, 8.16704, -5.28554, -2.90829, -6.45452, -7.01787, 1.00703, -5.99029, 2.38522, -3.1924, -5.30844, 5.74231, 1.84416, 2.54119, 5.53854, -0.17895, -2.2857, -1.84238, -0.47435, 19.71624, -3.5181, -2.96679, 7.48326, 0.71341, 5.77441, 0.6224, 6.06597, -1.19181, -3.09032, 2.58438, 1.22989, -8.13965, -3.66012, 4.70558, -4.84795, 0.61901, 1.38717, -1.51775, 8.64669, 3.96697, -6.92869, 1.21272, -1.18296, -0.99764, 13.4057, -6.11317, -0.52387, -7.87441, 0.18978, -2.7085, -4.95742, -5.7023, -6.99196, 2.53865, 1.9134, 2.11055, -0.5548, -1.07485, -0.58032, 6.22189, 1.91413, -1.36958, 5.64029, -5.72301, 0.24225, 9.0896, 6.82485, 5.2983, 10.8709, -8.20131, 0.30381, 8.42023, 4.54106, 9.59623, -7.19185, 3.80399, -6.0414, -3.52057, -1.70906, 0.61265, -3.64917, 12.54124], "b": -9.92837};

export function careScore(vec) {
  let z = MODEL.b;
  for (let i = 0; i < MODEL.w.length; i++) z += vec[i] * MODEL.w[i];
  return 1 / (1 + Math.exp(-z));
}

/** The meaning layer: { level: "ask", how: "meaning", score } or null. `embed`: text → normalised vector (embedder.js). */
export async function meaningCare(text, embed) {
  if (!embed || !text || text.length < 12) return null;
  // A long message is read in its parts (the model sees 512 tokens at most): the
  // end, where a journal usually arrives at what weighs, and the start.
  const parts = text.length <= 1500 ? [text] : [text.slice(-1500), text.slice(0, 1500)];
  let score = 0;
  for (const p of parts) score = Math.max(score, careScore(await embed(p)));
  if (score < ASK) return null;
  return { level: "ask", how: "meaning", score: Math.round(score * 1000) / 1000 };
}

/**
 * Both layers: a plain phrase refers at once; an indirect phrase or the meaning
 * layer asks (1.13.2), and the model's mark decides whether the line is shown.
 */
export async function careCheck(text, embed) {
  const p = indirectCare(text);
  if (p?.level === "refer") return p;
  const m = embed ? await meaningCare(text, embed).catch(() => null) : null;
  if (p) return m ? { ...p, score: m.score } : p;
  return m;
}
